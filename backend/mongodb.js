/**
 * Central MongoDB setup for Railway + Atlas.
 * Covers: env aliases, URI cleanup, retries, disconnect-before-retry, optional dbName, health ping.
 */

const mongoose = require('mongoose');

const ENV_KEYS = [
  'MONGODB_URI',
  'DATABASE_URL',
  'MONGO_URI',
  'MONGO_URL',
];

function normalizeMongoUri(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  let u = raw.trim();
  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }
  u = u.replace(/[\r\n\t]/g, '').trim();
  return u || null;
}

function resolveMongoUri() {
  for (const key of ENV_KEYS) {
    const v = normalizeMongoUri(process.env[key]);
    if (v) return v;
  }
  return null;
}

/** Atlas drivers expect retryWrites + w=majority; append if user pasted a short URI. */
function ensureAtlasQueryParams(uri) {
  if (!uri || (!uri.startsWith('mongodb+srv://') && !uri.startsWith('mongodb://'))) {
    return uri;
  }
  if (/[?&]retryWrites=/.test(uri)) return uri;
  const sep = uri.includes('?') ? '&' : '?';
  return `${uri}${sep}retryWrites=true&w=majority`;
}

function sanitizeForClient(msg) {
  if (msg == null) return undefined;
  let s = String(msg);
  s = s.replace(/mongodb(\+srv)?:\/\/([^:@/]+):([^@/]+)@/gi, 'mongodb$1://***:***@');
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

let lastMongoFailure = null;

function recordMongoFailure(err) {
  if (!err) return;
  lastMongoFailure = {
    at: new Date().toISOString(),
    code: err.name || 'Error',
    driverCode: typeof err.code === 'number' || typeof err.code === 'string' ? err.code : undefined,
    message: sanitizeForClient(err.message),
  };
}

function clearMongoFailure() {
  lastMongoFailure = null;
}

function getLastMongoFailure() {
  return lastMongoFailure;
}

function buildConnectOptions() {
  const opts = {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS || 45000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 30000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120000),
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    retryWrites: true,
  };
  if (process.env.MONGODB_FORCE_IPV4 === '1') {
    opts.family = 4;
  }
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  if (dbName) {
    opts.dbName = dbName;
  }
  return opts;
}

let connectInFlight = null;

function missingUriError() {
  const err = new Error(
    `Set one of: ${ENV_KEYS.join(', ')} (full Atlas connection string)`,
  );
  err.name = 'MissingMongoConfiguration';
  return err;
}

async function disconnectClean() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Single entry: idempotent, serialized, with retries (Atlas / DNS cold starts).
 */
async function ensureConnected(resolvedUri) {
  if (!resolvedUri) {
    throw missingUriError();
  }
  if (mongoose.connection.readyState === 1) {
    return;
  }
  if (connectInFlight) {
    await connectInFlight;
    if (mongoose.connection.readyState === 1) return;
  }

  const uri = ensureAtlasQueryParams(resolvedUri);
  const options = buildConnectOptions();
  const retries = Math.max(1, Math.min(8, Number(process.env.MONGO_CONNECT_RETRIES || 5)));
  const delayMs = Math.max(500, Number(process.env.MONGO_CONNECT_RETRY_DELAY_MS || 2500));

  connectInFlight = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await disconnectClean();
      try {
        await mongoose.connect(uri, options);
        await mongoose.connection.db.admin().command({ ping: 1 });
        clearMongoFailure();
        return;
      } catch (err) {
        lastErr = err;
        recordMongoFailure(err);
        console.error(`MongoDB connect attempt ${attempt}/${retries} failed:`, err.message);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr;
  })();

  try {
    await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

async function pingDb() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return false;
  }
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    return true;
  } catch (err) {
    recordMongoFailure(err);
    return false;
  }
}

module.exports = {
  ENV_KEYS,
  resolveMongoUri,
  normalizeMongoUri,
  ensureAtlasQueryParams,
  sanitizeForClient,
  recordMongoFailure,
  clearMongoFailure,
  getLastMongoFailure,
  buildConnectOptions,
  ensureConnected,
  pingDb,
  missingUriError,
};

/**
 * Central MongoDB setup (Atlas-compatible URIs, env aliases, retries, optional dbName, health ping).
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

/**
 * Append standard Atlas query params if missing (short pasted URIs often omit them).
 * authSource=admin: Atlas database users authenticate against the admin DB by default.
 */
function ensureAtlasQueryParams(uri) {
  if (!uri || (!uri.startsWith('mongodb+srv://') && !uri.startsWith('mongodb://'))) {
    return uri;
  }
  let u = uri;
  const addParam = (key, value) => {
    const re = new RegExp(`[?&]${key}=`, 'i');
    if (re.test(u)) return;
    u += (u.includes('?') ? '&' : '?') + `${key}=${value}`;
  };
  addParam('retryWrites', 'true');
  addParam('w', 'majority');
  if (uri.startsWith('mongodb+srv://')) {
    addParam('authSource', 'admin');
  }
  return u;
}

/** True if URI has ...mongodb.net/<dbname> before ? */
function uriHasDatabasePath(uri) {
  if (!uri) return false;
  return /\.mongodb\.net\/[^/?]+/i.test(uri);
}

/** Safe flags for /api/health (no secrets). */
function getUriDiagnostics(resolvedUri) {
  if (!resolvedUri) {
    return { mongoUriPresent: false };
  }
  return {
    mongoUriPresent: true,
    looksLikeAtlas: /\.mongodb\.net/i.test(resolvedUri),
    databaseNameInUriPath: uriHasDatabasePath(resolvedUri),
    mongodbDbNameEnvSet: Boolean(process.env.MONGODB_DB_NAME?.trim()),
  };
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
  if (!uriHasDatabasePath(resolvedUri) && !process.env.MONGODB_DB_NAME?.trim()) {
    console.warn(
      '[mongo] URI has no /database before ? — set MONGODB_DB_NAME or use ...net/yourDbName?...',
    );
  }
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
  uriHasDatabasePath,
  getUriDiagnostics,
  sanitizeForClient,
  recordMongoFailure,
  clearMongoFailure,
  getLastMongoFailure,
  buildConnectOptions,
  ensureConnected,
  pingDb,
  missingUriError,
};

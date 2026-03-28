const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  || 'https://interviewly-d5eb7.web.app,http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

function resolveMongoUri() {
  const v = process.env.MONGODB_URI?.trim()
    || process.env.DATABASE_URL?.trim()
    || process.env.MONGO_URI?.trim();
  return v || null;
}

const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const MONGODB_URI = resolveMongoUri()
  || (isRailway ? null : 'mongodb://localhost:27017/interview-qna');

/** Redact credentials from driver error text (safe to show in JSON). */
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

function buildMongooseOptions() {
  const opts = {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 20000,
  };
  // Opt-in: some stacks need IPv4; others break if family is forced — default off
  if (process.env.MONGODB_FORCE_IPV4 === '1') {
    opts.family = 4;
  }
  return opts;
}

const mongooseOptions = buildMongooseOptions();

function missingUriError() {
  const err = new Error('MONGODB_URI (or DATABASE_URL) is not set');
  err.name = 'MissingMongoConfiguration';
  return err;
}

async function ensureMongoConnected() {
  if (!MONGODB_URI) {
    throw missingUriError();
  }
  if (mongoose.connection.readyState === 1) return;
  try {
    await mongoose.connect(MONGODB_URI, mongooseOptions);
  } catch (err) {
    recordMongoFailure(err);
    throw err;
  }
}

// Eager connect so first request is fast when DB is healthy
if (MONGODB_URI) {
  ensureMongoConnected()
    .then(() => {
      console.log('MongoDB connected');
      lastMongoFailure = null;
    })
    .catch((err) => console.error('MongoDB connection error:', err));
} else if (isRailway) {
  console.error('Railway: set MONGODB_URI or DATABASE_URL to your Atlas connection string');
}

app.get('/api/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  res.status(mongoOk ? 200 : 503).json({
    ok: mongoOk,
    mongoUriConfigured: Boolean(MONGODB_URI),
    mongoState: mongoose.connection.readyState,
    mongoStates: { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' },
    lastMongoFailure: mongoOk ? null : lastMongoFailure,
    mongodbForceIpv4: process.env.MONGODB_FORCE_IPV4 === '1',
  });
});

async function mongoGate(req, res, next) {
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  try {
    await ensureMongoConnected();
    next();
  } catch (err) {
    console.error('mongoGate:', err.message);
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    const missing = err.name === 'MissingMongoConfiguration';
    recordMongoFailure(err);
    res.status(503).json({
      error: 'Database unavailable',
      code: err.name || 'MongoError',
      reason: missing ? 'MISSING_MONGODB_URI' : 'CONNECTION_FAILED',
      mongoUriConfigured: Boolean(MONGODB_URI),
      detail: sanitizeForClient(err.message),
      hint: missing
        ? 'In Railway → Variables, add MONGODB_URI (or DATABASE_URL) with your Atlas string'
        : 'Atlas → Network Access: allow 0.0.0.0/0. URI password must be URL-encoded. Open GET /api/health for lastMongoFailure.',
    });
  }
}

// Routes
app.use('/api/qna', mongoGate, require('./routes/qnaRoutes'));

function isMongoInfraError(err) {
  const name = err.name || '';
  if (name === 'CastError' || name === 'ValidationError') return false;
  if (name.startsWith('Mongo')) return true;
  if (name === 'MongooseError') return true;
  return false;
}

function errorPayload(err) {
  const mongo = isMongoInfraError(err);
  const payload = {
    error: mongo ? 'Database error' : 'Something went wrong!',
    code: err.name || 'Error',
  };
  if (typeof err.code === 'number' || typeof err.code === 'string') {
    payload.driverCode = err.code;
  }
  if (mongo) {
    payload.detail = sanitizeForClient(err.message);
    recordMongoFailure(err);
  }
  if (process.env.API_ERROR_DETAILS === '1') {
    payload.message = err.message;
  }
  return payload;
}

// Error handling middleware (include CORS so browsers show API errors, not generic CORS failures)
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  const mongoErr = isMongoInfraError(err);
  const status = mongoErr ? 503 : 500;
  res.status(status).json(errorPayload(err));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

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

const mongooseOptions = {
  serverSelectionTimeoutMS: 15000,
  // Atlas + Railway: some regions resolve SRV/IPv6 poorly; IPv4 often fixes ECONNREFUSED / timeouts
  family: 4,
};

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
  await mongoose.connect(MONGODB_URI, mongooseOptions);
}

// Eager connect so first request is fast when DB is healthy
if (MONGODB_URI) {
  ensureMongoConnected()
    .then(() => console.log('MongoDB connected'))
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
    res.status(503).json({
      error: 'Database unavailable',
      code: err.name || 'MongoError',
      reason: missing ? 'MISSING_MONGODB_URI' : 'CONNECTION_FAILED',
      mongoUriConfigured: Boolean(MONGODB_URI),
      hint: missing
        ? 'In Railway → Variables, add MONGODB_URI (or DATABASE_URL) with your Atlas string'
        : 'Atlas → Network Access: allow 0.0.0.0/0 (or your IP). Check password is URL-encoded in the URI.',
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
  const payload = {
    error: isMongoInfraError(err) ? 'Database error' : 'Something went wrong!',
    code: err.name || 'Error',
  };
  if (typeof err.code === 'number' || typeof err.code === 'string') {
    payload.driverCode = err.code;
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

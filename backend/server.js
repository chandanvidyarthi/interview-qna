const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const mongo = require('./mongodb');

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
app.use(express.json({ limit: '2mb' }));

const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const MONGODB_URI = mongo.resolveMongoUri()
  || (isRailway ? null : 'mongodb://localhost:27017/interview-qna');

// Warm-up connection (retries happen inside ensureConnected)
if (MONGODB_URI) {
  mongo.ensureConnected(MONGODB_URI)
    .then(() => console.log('MongoDB connected and ping OK'))
    .catch((err) => console.error('MongoDB initial connect failed:', err.message));
} else if (isRailway) {
  console.error(
    `Railway: set one of ${mongo.ENV_KEYS.join(', ')} to your MongoDB Atlas connection string`,
  );
}

app.get('/api/health', async (req, res) => {
  const mongoUriConfigured = Boolean(MONGODB_URI);
  if (!mongoUriConfigured) {
    res.status(503).json({
      ok: false,
      mongoUriConfigured: false,
      mongoState: mongoose.connection.readyState,
      lastMongoFailure: mongo.getLastMongoFailure(),
      hint: `Add variable: ${mongo.ENV_KEYS[0]} (or DATABASE_URL) in Railway`,
    });
    return;
  }

  let pingOk = false;
  if (mongoose.connection.readyState === 1) {
    pingOk = await mongo.pingDb();
  }

  const ok = pingOk;
  res.status(ok ? 200 : 503).json({
    ok,
    mongoUriConfigured: true,
    mongoState: mongoose.connection.readyState,
    mongoStates: { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' },
    lastMongoFailure: ok ? null : mongo.getLastMongoFailure(),
    mongodbForceIpv4: process.env.MONGODB_FORCE_IPV4 === '1',
    optionalEnv: {
      MONGODB_DB_NAME: 'if URI has no /dbname or wrong default database',
      MONGODB_FORCE_IPV4: 'set to 1 if DNS/SRV fails on Railway',
      MONGO_CONNECT_RETRIES: 'default 5',
    },
  });
});

async function mongoGate(req, res, next) {
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  try {
    await mongo.ensureConnected(MONGODB_URI);
    next();
  } catch (err) {
    console.error('mongoGate:', err.message);
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    const missing = err.name === 'MissingMongoConfiguration';
    mongo.recordMongoFailure(err);
    res.status(503).json({
      error: 'Database unavailable',
      code: err.name || 'MongoError',
      reason: missing ? 'MISSING_MONGODB_URI' : 'CONNECTION_FAILED',
      mongoUriConfigured: Boolean(MONGODB_URI),
      detail: mongo.sanitizeForClient(err.message),
      hint: missing
        ? `Railway → Variables → ${mongo.ENV_KEYS[0]} or DATABASE_URL`
        : 'Atlas: Network Access 0.0.0.0/0; Database user readWrite on cluster; password URL-encoded in URI. GET /api/health for lastMongoFailure.',
    });
  }
}

app.use('/api/qna', mongoGate, require('./routes/qnaRoutes'));

function isMongoInfraError(err) {
  const name = err.name || '';
  if (name === 'CastError' || name === 'ValidationError') return false;
  if (name.startsWith('Mongo')) return true;
  if (name === 'MongooseError') return true;
  return false;
}

function errorPayload(err) {
  const isMongo = isMongoInfraError(err);
  const payload = {
    error: isMongo ? 'Database error' : 'Something went wrong!',
    code: err.name || 'Error',
  };
  if (typeof err.code === 'number' || typeof err.code === 'string') {
    payload.driverCode = err.code;
  }
  if (isMongo) {
    payload.detail = mongo.sanitizeForClient(err.message);
    mongo.recordMongoFailure(err);
  }
  if (process.env.API_ERROR_DETAILS === '1') {
    payload.message = err.message;
  }
  return payload;
}

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

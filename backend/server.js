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

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/interview-qna';

const mongooseOptions = { serverSelectionTimeoutMS: 15000 };

async function ensureMongoConnected() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGODB_URI, mongooseOptions);
}

// Eager connect so first request is fast when DB is healthy
ensureMongoConnected()
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

app.get('/api/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  res.status(mongoOk ? 200 : 503).json({
    ok: mongoOk,
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
    res.status(503).json({
      error: 'Database unavailable',
      code: err.name || 'MongoError',
      hint: 'Set MONGODB_URI on Railway and allow 0.0.0.0/0 (or Railway egress) in Atlas Network Access',
    });
  }
}

// Routes
app.use('/api/qna', mongoGate, require('./routes/qnaRoutes'));

// Error handling middleware (include CORS so browsers show API errors, not generic CORS failures)
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  const mongoErr =
    err.name === 'MongoServerSelectionError'
    || err.name === 'MongoNetworkError'
    || err.name === 'MongoParseError'
    || err.name === 'MongoAPIError';
  const status = mongoErr ? 503 : 500;
  res.status(status).json({
    error: mongoErr ? 'Database error' : 'Something went wrong!',
    code: err.name,
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

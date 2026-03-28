const express = require('express');
const mongoose = require('mongoose');

const qnaSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const collectionName = process.env.MONGODB_QNA_COLLECTION?.trim();
const Qna = mongoose.models.Qna
  || mongoose.model('Qna', qnaSchema, collectionName || undefined);

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const items = await Qna.find().sort({ _id: -1 }).limit(200).lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const doc = await Qna.create(req.body && typeof req.body === 'object' ? req.body : {});
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

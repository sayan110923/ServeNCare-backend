import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { getCollection } from '../db/index.js';

const router = Router();

router.post(
  '/',
  [
    body('name').trim().notEmpty().isLength({ max: 200 }).withMessage('Name is required'),
    body('email').trim().isEmail().isLength({ max: 200 }).withMessage('Valid email is required'),
    body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 40 }),
    body('subject').trim().notEmpty().isLength({ max: 300 }).withMessage('Subject is required'),
    body('message').trim().notEmpty().isLength({ max: 10000 }).withMessage('Message is required'),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(400).json({ error: errs.array()[0]?.msg || 'Invalid input', errors: errs.array() });
    }
    try {
      const coll = getCollection('contact_messages');
      const now = new Date();
      await coll.insertOne({
        name: req.body.name,
        email: req.body.email.trim().toLowerCase(),
        phone: req.body.phone?.trim() || null,
        subject: req.body.subject,
        message: req.body.message,
        read: false,
        created_at: now,
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      console.error('Contact submit error:', e);
      res.status(500).json({ error: 'Could not send message. Please try again later.' });
    }
  }
);

export default router;

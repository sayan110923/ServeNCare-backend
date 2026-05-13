import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/service/:serviceId', async (req, res) => {
  try {
    let sid;
    try {
      sid = new ObjectId(req.params.serviceId);
    } catch {
      return res.json([]);
    }
    const reviews = getCollection('reviews');
    const users = getCollection('users');
    const list = await reviews
      .aggregate([
        { $match: { service_id: sid } },
        { $sort: { created_at: -1 } },
        { $lookup: { from: 'users', localField: 'taker_id', foreignField: '_id', as: 'u' } },
        { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            id: { $toString: '$_id' },
            booking_id: { $toString: '$booking_id' },
            taker_id: { $toString: '$taker_id' },
            provider_id: { $toString: '$provider_id' },
            service_id: { $toString: '$service_id' },
            rating: 1,
            comment: 1,
            created_at: 1,
            taker_name: '$u.full_name',
            taker_avatar: '$u.avatar_url',
          },
        },
      ])
      .toArray();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

router.post(
  '/',
  authenticate,
  requireRole('taker'),
  [
    body('booking_id').isMongoId(),
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().trim(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { booking_id, rating, comment } = req.body;
    try {
      const bid = new ObjectId(booking_id);
      const bookings = getCollection('bookings');
      const b = await bookings.findOne({ _id: bid });
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      if (b.taker_id.toString() !== req.user.id)
        return res.status(403).json({ error: 'Forbidden' });
      if (b.status !== 'completed')
        return res.status(400).json({ error: 'Can only review completed bookings' });

      const reviews = getCollection('reviews');
      const existing = await reviews.findOne({ booking_id: bid });
      if (existing) return res.status(409).json({ error: 'Already reviewed' });

      const now = new Date();
      const doc = {
        booking_id: bid,
        taker_id: req.user._id,
        provider_id: b.provider_id,
        service_id: b.service_id,
        rating: parseInt(rating, 10),
        comment: comment || null,
        created_at: now,
      };
      const { insertedId } = await reviews.insertOne(doc);

      const reviewList = await reviews.find({ service_id: b.service_id }).toArray();
      const avg = reviewList.reduce((s, r) => s + r.rating, 0) / reviewList.length;
      const services = getCollection('services');
      await services.updateOne(
        { _id: b.service_id },
        {
          $set: {
            review_count: reviewList.length,
            avg_rating: Math.round(avg * 100) / 100,
            updated_at: now,
          },
        }
      );
      res.status(201).json(toObj({ _id: insertedId, ...doc }));
    } catch (e) {
      console.error('Create review error:', e);
      res.status(500).json({ error: 'Failed to create review' });
    }
  }
);

export default router;

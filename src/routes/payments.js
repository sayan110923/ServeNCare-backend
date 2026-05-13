import { Router } from 'express';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

function razorpayBasicAuth() {
  const { razorpayKeyId, razorpayKeySecret } = config;
  if (!razorpayKeyId || !razorpayKeySecret) return null;
  return Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
}

/**
 * Create a Razorpay payment intent directly for a service — no booking is created yet.
 * The booking is only created after the user completes payment on the frontend.
 */
router.post(
  '/razorpay/create-intent',
  authenticate,
  requireRole('taker'),
  [body('service_id').isMongoId()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const authHeader = razorpayBasicAuth();
    if (!authHeader) return res.status(503).json({ error: 'Online payments are not configured' });

    try {
      const services = getCollection('services');
      const svc = await services.findOne({ _id: new ObjectId(req.body.service_id), status: 'active' });
      if (!svc) return res.status(404).json({ error: 'Service not found' });

      const amountPaise = Math.round(Number(svc.price) * 100);
      if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        return res.status(400).json({ error: 'Invalid service price' });
      }

      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${authHeader}`,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: `svc_${req.body.service_id.slice(-12)}_${Date.now()}`,
        }),
      });
      const data = await rzpRes.json().catch(() => ({}));
      if (!rzpRes.ok) {
        console.error('Razorpay create-intent error:', data);
        return res.status(502).json({ error: data.error?.description || 'Could not create payment order' });
      }

      res.json({
        orderId: data.id,
        amount: data.amount,
        currency: data.currency || 'INR',
        keyId: config.razorpayKeyId,
      });
    } catch (e) {
      console.error('Create-intent route error:', e);
      res.status(500).json({ error: 'Payment setup failed' });
    }
  }
);

/**
 * Create a Razorpay order for an existing booking (online payment).
 * Kept for backwards-compatibility with any pending bookings in My Bookings.
 */
router.post(
  '/razorpay/order',
  authenticate,
  requireRole('taker'),
  [body('booking_id').isMongoId()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const authHeader = razorpayBasicAuth();
    if (!authHeader) return res.status(503).json({ error: 'Online payments are not configured' });

    try {
      const bookingId = new ObjectId(req.body.booking_id);
      const bookings = getCollection('bookings');
      const b = await bookings.findOne({ _id: bookingId, taker_id: req.user._id });
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      if (b.payment_method !== 'online') {
        return res.status(400).json({ error: 'This booking is not set for online payment' });
      }
      if (b.payment_status === 'paid') {
        return res.status(400).json({ error: 'Booking is already paid' });
      }

      const amountPaise = Math.round(Number(b.amount) * 100);
      if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        return res.status(400).json({ error: 'Invalid booking amount' });
      }

      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${authHeader}`,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: b._id.toString().slice(-36),
        }),
      });
      const data = await rzpRes.json().catch(() => ({}));
      if (!rzpRes.ok) {
        console.error('Razorpay order error:', data);
        return res.status(502).json({ error: data.error?.description || 'Could not create payment order' });
      }

      await bookings.updateOne(
        { _id: bookingId },
        { $set: { razorpay_order_id: data.id, updated_at: new Date() } }
      );

      res.json({
        orderId: data.id,
        amount: data.amount,
        currency: data.currency || 'INR',
        keyId: config.razorpayKeyId,
      });
    } catch (e) {
      console.error('Razorpay order route error:', e);
      res.status(500).json({ error: 'Payment setup failed' });
    }
  }
);

/**
 * Verify Razorpay payment and mark booking as paid.
 */
router.post(
  '/razorpay/verify',
  authenticate,
  requireRole('taker'),
  [
    body('booking_id').isMongoId(),
    body('razorpay_order_id').trim().notEmpty(),
    body('razorpay_payment_id').trim().notEmpty(),
    body('razorpay_signature').trim().notEmpty(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    if (!config.razorpayKeySecret) return res.status(503).json({ error: 'Online payments are not configured' });

    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    try {
      const bookingId = new ObjectId(booking_id);
      const bookings = getCollection('bookings');
      const b = await bookings.findOne({ _id: bookingId, taker_id: req.user._id });
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      if (b.payment_method !== 'online') {
        return res.status(400).json({ error: 'This booking is not set for online payment' });
      }
      if (b.payment_status === 'paid') {
        return res.json({ ok: true, booking: toObj(b) });
      }

      const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expected = crypto
        .createHmac('sha256', config.razorpayKeySecret)
        .update(payload)
        .digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid payment signature' });
      }
      if (b.razorpay_order_id && b.razorpay_order_id !== razorpay_order_id) {
        return res.status(400).json({ error: 'Order mismatch' });
      }

      const now = new Date();
      await bookings.updateOne(
        { _id: bookingId },
        {
          $set: {
            payment_status: 'paid',
            razorpay_order_id,
            razorpay_payment_id,
            payment_paid_at: now,
            updated_at: now,
          },
        }
      );
      const updated = await bookings.findOne({ _id: bookingId });
      res.json({ ok: true, booking: toObj(updated) });
    } catch (e) {
      console.error('Razorpay verify error:', e);
      res.status(500).json({ error: 'Payment verification failed' });
    }
  }
);

export default router;

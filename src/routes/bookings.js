import { Router } from 'express';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

router.get('/', authenticate, async (req, res) => {
  const { role } = req.user;
  const { status, page = 1, limit = 10 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  try {
    const match = role === 'provider' ? { provider_id: req.user._id } : { taker_id: req.user._id };
    if (status) match.status = status;

    const bookings = getCollection('bookings');
    const services = getCollection('services');
    const users = getCollection('users');

    const projectStage = {
      $project: {
        id: { $toString: '$_id' },
        service_id: { $toString: '$service_id' },
        taker_id: { $toString: '$taker_id' },
        provider_id: { $toString: '$provider_id' },
        status: 1,
        scheduled_at: 1,
        completed_at: 1,
        amount: 1,
        commission: 1,
        provider_payout: 1,
        taker_address: 1,
        taker_lat: 1,
        taker_lng: 1,
        notes: 1,
        created_at: 1,
        counter_offer_amount: 1,
        counter_offer_message: 1,
        counter_offer_at: 1,
        proposed_scheduled_at: 1,
        proposed_reschedule_message: 1,
        proposed_reschedule_at: 1,
        completion_otp: 1,
        payment_method: 1,
        payment_status: 1,
        razorpay_order_id: 1,
        razorpay_payment_id: 1,
        payment_paid_at: 1,
        service_title: '$svc.title',
        price_type: '$svc.price_type',
        price: '$svc.price',
        service_type: '$svc.service_type',
        provider_name: '$u_prov.full_name',
        provider_avatar: '$u_prov.avatar_url',
        taker_name: '$u_taker.full_name',
        taker_avatar: '$u_taker.avatar_url',
      },
    };
    if (role === 'taker') {
      projectStage.$project.has_review = 1;
    }

    const pipeline = [
      { $match: match },
      { $sort: { scheduled_at: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
      { $lookup: { from: 'services', localField: 'service_id', foreignField: '_id', as: 'svc' } },
      { $unwind: { path: '$svc', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'provider_id', foreignField: '_id', as: 'u_prov' } },
      { $unwind: { path: '$u_prov', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'taker_id', foreignField: '_id', as: 'u_taker' } },
      { $unwind: { path: '$u_taker', preserveNullAndEmptyArrays: true } },
    ];
    if (role === 'taker') {
      pipeline.push({
        $lookup: {
          from: 'reviews',
          let: { bid: '$_id', tid: req.user._id },
          pipeline: [
            { $match: { $expr: { $and: [ { $eq: ['$booking_id', '$$bid'] }, { $eq: ['$taker_id', '$$tid'] } ] } } },
            { $limit: 1 },
          ],
          as: 'my_review',
        },
      });
      pipeline.push({
        $addFields: { has_review: { $gt: [{ $size: { $ifNull: ['$my_review', []] } }, 0] } },
      });
    }
    pipeline.push(projectStage);

    const [list, total] = await Promise.all([
      bookings.aggregate(pipeline).toArray(),
      bookings.countDocuments(match),
    ]);
    if (req.user.role === 'provider') {
      list.forEach((b) => delete b.completion_otp);
    } else if (req.user.role === 'taker') {
      for (const b of list) {
        if (b.status === 'confirmed' && !b.completion_otp) {
          const otp = generateCompletionOtp();
          await bookings.updateOne(
            { _id: new ObjectId(b.id) },
            { $set: { completion_otp: otp, updated_at: new Date() } }
          );
          b.completion_otp = otp;
        }
      }
    }
    res.json({ bookings: list, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (e) {
    console.error('Bookings list error:', e);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const pipeline = [
      { $match: { _id: id } },
      { $lookup: { from: 'services', localField: 'service_id', foreignField: '_id', as: 'svc' } },
      { $unwind: { path: '$svc', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'provider_id', foreignField: '_id', as: 'u_prov' } },
      { $unwind: { path: '$u_prov', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'taker_id', foreignField: '_id', as: 'u_taker' } },
      { $unwind: { path: '$u_taker', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          id: { $toString: '$_id' },
          service_id: { $toString: '$service_id' },
          taker_id: { $toString: '$taker_id' },
          provider_id: { $toString: '$provider_id' },
          status: 1,
          scheduled_at: 1,
          completed_at: 1,
          amount: 1,
          commission: 1,
          provider_payout: 1,
          taker_address: 1,
          taker_lat: 1,
          taker_lng: 1,
          notes: 1,
          created_at: 1,
          counter_offer_amount: 1,
          counter_offer_message: 1,
          counter_offer_at: 1,
          proposed_scheduled_at: 1,
          proposed_reschedule_message: 1,
          proposed_reschedule_at: 1,
          completion_otp: 1,
          payment_method: 1,
          payment_status: 1,
          razorpay_order_id: 1,
          razorpay_payment_id: 1,
          payment_paid_at: 1,
          service_title: '$svc.title',
          description: '$svc.description',
          price_type: '$svc.price_type',
          price: '$svc.price',
          service_type: '$svc.service_type',
          provider_name: '$u_prov.full_name',
          provider_avatar: '$u_prov.avatar_url',
          provider_phone: '$u_prov.phone',
          taker_name: '$u_taker.full_name',
          taker_avatar: '$u_taker.avatar_url',
          taker_phone: '$u_taker.phone',
        },
      },
    ];
    const arr = await bookings.aggregate(pipeline).toArray();
    const b = arr[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.provider_id !== req.user.id && b.taker_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'taker' && b.status === 'confirmed' && !b.completion_otp) {
      const otp = generateCompletionOtp();
      await bookings.updateOne(
        { _id: id },
        { $set: { completion_otp: otp, updated_at: new Date() } }
      );
      b.completion_otp = otp;
    }
    if (req.user.role === 'provider') delete b.completion_otp;
    res.json(b);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

router.post(
  '/',
  authenticate,
  requireRole('taker'),
  [
    body('service_id').isMongoId(),
    body('scheduled_at').isISO8601(),
    body('taker_address').optional().trim(),
    body('taker_lat').optional().isFloat(),
    body('taker_lng').optional().isFloat(),
    body('notes').optional().trim(),
    body('payment_method').optional().isIn(['cash', 'online']),
    // Razorpay fields — required when payment_method is 'online'
    body('razorpay_order_id').optional().trim(),
    body('razorpay_payment_id').optional().trim(),
    body('razorpay_signature').optional().trim(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { service_id, scheduled_at, taker_address, taker_lat, taker_lng, notes } = req.body;
    const payment_method = req.body.payment_method === 'online' ? 'online' : 'cash';

    // For online payments, verify the Razorpay signature BEFORE touching the database.
    // This means: no booking is ever created unless payment is already confirmed.
    if (payment_method === 'online') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Payment details are required for online booking. Please complete the payment first.' });
      }
      if (!config.razorpayKeySecret) {
        return res.status(503).json({ error: 'Online payment is not configured' });
      }
      const expected = crypto
        .createHmac('sha256', config.razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed. Please try again or choose cash.' });
      }
    }

    try {
      const services = getCollection('services');
      const svc = await services.findOne({ _id: new ObjectId(service_id), status: 'active' });
      if (!svc) return res.status(404).json({ error: 'Service not found' });

      const bookings = getCollection('bookings');

      // Idempotency guard for cash: prevent duplicate bookings from rapid double-submits.
      if (payment_method === 'cash') {
        const cutoff = new Date(Date.now() - 60 * 1000); // 60-second window
        const existing = await bookings.findOne({
          taker_id: req.user._id,
          service_id: svc._id,
          payment_method: 'cash',
          status: 'pending',
          created_at: { $gt: cutoff },
        });
        if (existing) {
          return res.status(200).json(toObj({ _id: existing._id, ...existing }));
        }
      }

      // For online: also guard against replayed payment signatures
      if (payment_method === 'online') {
        const { razorpay_payment_id } = req.body;
        const duplicate = await bookings.findOne({ razorpay_payment_id });
        if (duplicate) {
          return res.status(200).json(toObj({ _id: duplicate._id, ...duplicate }));
        }
      }

      const settings = getCollection('platform_settings');
      const setting = await settings.findOne({ key: 'commission_rate' });
      const commissionRate = (parseFloat(setting?.value ?? 10) || 10) / 100;
      const amount = parseFloat(svc.price);
      const commission = Math.round(amount * commissionRate * 100) / 100;
      const providerPayout = Math.round((amount - commission) * 100) / 100;

      const now = new Date();
      // Online bookings are created with payment_status 'paid' because the signature
      // was already verified above. Cash bookings are 'na' (paid at service time).
      const payment_status = payment_method === 'cash' ? 'na' : 'paid';
      const doc = {
        service_id: svc._id,
        taker_id: req.user._id,
        provider_id: svc.provider_id,
        status: 'pending',
        scheduled_at: new Date(scheduled_at),
        amount,
        commission,
        provider_payout: providerPayout,
        taker_address: taker_address || null,
        taker_lat: taker_lat ?? null,
        taker_lng: taker_lng ?? null,
        notes: notes || null,
        payment_method,
        payment_status,
        ...(payment_method === 'online' ? {
          razorpay_order_id: req.body.razorpay_order_id,
          razorpay_payment_id: req.body.razorpay_payment_id,
          payment_paid_at: now,
        } : {}),
        created_at: now,
        updated_at: now,
      };
      const notifications = getCollection('notifications');
      const { insertedId } = await bookings.insertOne(doc);
      await notifications.insertOne({
        user_id: svc.provider_id,
        title: 'New booking request',
        body: 'You have a new booking request.',
        type: 'booking',
        link: `/dashboard/bookings/${insertedId.toString()}`,
        created_at: now,
      });
      res.status(201).json(toObj({ _id: insertedId, ...doc }));
    } catch (e) {
      console.error('Create booking error:', e);
      res.status(500).json({ error: 'Failed to create booking' });
    }
  }
);

const generateCompletionOtp = () => String(Math.floor(100000 + Math.random() * 900000));

router.patch('/:id/confirm', authenticate, requireRole('provider'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const wallets = getCollection('wallets');
    const transactions = getCollection('transactions');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (!b.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'You are not the provider for this booking' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });
    if (b.payment_method === 'online' && b.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Customer must complete online payment before you can confirm.' });
    }
    const now = new Date();
    const completion_otp = generateCompletionOtp();
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'confirmed', completion_otp, updated_at: now } },
      { returnDocument: 'after' }
    );
    const out = toObj(updated);
    delete out.completion_otp;
    res.json(out);
    await notifications.insertOne({
      user_id: updated.taker_id,
      title: 'Booking confirmed',
      body: `Your booking is confirmed. Your verification OTP is ${completion_otp}. Share this OTP with the provider only when the service is done.`,
      type: 'booking',
      link: `/dashboard/bookings`,
      created_at: now,
    }).catch((err) => console.error('Confirm notification failed:', err));
  } catch (e) {
    console.error('Confirm booking error:', e);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

router.patch(
  '/:id/counter-offer',
  authenticate,
  requireRole('provider'),
  [
    body('amount').isFloat({ min: 0 }),
    body('message').optional().trim(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      let id;
      try {
        id = new ObjectId(req.params.id);
      } catch {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const { amount, message } = req.body;
      const bookings = getCollection('bookings');
      const b = await bookings.findOne({ _id: id });
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      if (!b.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'Not your booking' });
      if (b.status !== 'pending') return res.status(400).json({ error: 'Only pending bookings can have a counter offer' });

      const settings = getCollection('platform_settings');
      const setting = await settings.findOne({ key: 'commission_rate' });
      const commissionRate = (parseFloat(setting?.value ?? 10) || 10) / 100;
      const commission = Math.round(amount * commissionRate * 100) / 100;
      const providerPayout = Math.round((amount - commission) * 100) / 100;
      const now = new Date();

      const updated = await bookings.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            counter_offer_amount: parseFloat(amount),
            counter_offer_message: message || null,
            counter_offer_at: now,
            updated_at: now,
          },
        },
        { returnDocument: 'after' }
      );

      const notifications = getCollection('notifications');
      await notifications.insertOne({
        user_id: b.taker_id,
        title: 'Counter offer received',
        body: `Provider sent a counter offer of ₹${Number(amount).toLocaleString()}. ${message ? message.slice(0, 80) : ''}`,
        type: 'booking',
        link: `/dashboard/bookings`,
        created_at: now,
      });

      res.json(toObj(updated));
    } catch (e) {
      res.status(500).json({ error: 'Failed to send counter offer' });
    }
  }
);

router.patch('/:id/accept-counter', authenticate, requireRole('taker'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.taker_id.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });
    if (b.counter_offer_amount == null) return res.status(400).json({ error: 'No counter offer to accept' });

    const settings = getCollection('platform_settings');
    const setting = await settings.findOne({ key: 'commission_rate' });
    const commissionRate = (parseFloat(setting?.value ?? 10) || 10) / 100;
    const amount = parseFloat(b.counter_offer_amount);
    const commission = Math.round(amount * commissionRate * 100) / 100;
    const providerPayout = Math.round((amount - commission) * 100) / 100;
    const now = new Date();

    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          amount,
          commission,
          provider_payout: providerPayout,
          status: 'confirmed',
          updated_at: now,
        },
        $unset: {
          counter_offer_amount: '',
          counter_offer_message: '',
          counter_offer_at: '',
        },
      },
      { returnDocument: 'after' }
    );

    await notifications.insertOne({
      user_id: b.provider_id,
      title: 'Counter offer accepted',
      body: 'The customer accepted your counter offer. Booking is confirmed.',
      type: 'booking',
      link: `/dashboard/bookings`,
      created_at: now,
    });

    res.json(toObj(updated));
  } catch (e) {
    res.status(500).json({ error: 'Failed to accept counter offer' });
  }
});

router.patch('/:id/reject-counter', authenticate, requireRole('taker'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.taker_id.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });
    if (b.counter_offer_amount == null) return res.status(400).json({ error: 'No counter offer to reject' });

    const now = new Date();
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      {
        $unset: { counter_offer_amount: '', counter_offer_message: '', counter_offer_at: '' },
        $set: { updated_at: now },
      },
      { returnDocument: 'after' }
    );

    await notifications.insertOne({
      user_id: b.provider_id,
      title: 'Counter offer declined',
      body: 'The customer declined your counter offer.',
      type: 'booking',
      link: `/dashboard/bookings`,
      created_at: now,
    });

    res.json(toObj(updated));
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject counter offer' });
  }
});

router.patch(
  '/:id/propose-reschedule',
  authenticate,
  requireRole('provider'),
  [
    body('scheduled_at').isISO8601(),
    body('message').optional().trim(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    try {
      let id;
      try {
        id = new ObjectId(req.params.id);
      } catch {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const { scheduled_at, message } = req.body;
      const bookings = getCollection('bookings');
      const notifications = getCollection('notifications');
      const b = await bookings.findOne({ _id: id });
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      if (!b.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'Not your booking' });
      if (!['pending', 'confirmed'].includes(b.status)) {
        return res.status(400).json({ error: 'Only pending or confirmed bookings can be rescheduled' });
      }
      const newDate = new Date(scheduled_at);
      if (Number.isNaN(newDate.getTime())) {
        return res.status(400).json({ error: 'Invalid proposed time' });
      }
      if (newDate.getTime() < Date.now() - 120_000) {
        return res.status(400).json({ error: 'Proposed time must be in the future' });
      }
      const now = new Date();
      const updated = await bookings.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            proposed_scheduled_at: newDate,
            proposed_reschedule_message: message?.trim() || null,
            proposed_reschedule_at: now,
            updated_at: now,
          },
        },
        { returnDocument: 'after' }
      );
      await notifications.insertOne({
        user_id: b.taker_id,
        title: 'New time proposed',
        body: `Your provider suggested a new time (${newDate.toLocaleString()}). Open My Bookings to accept or decline.`,
        type: 'booking',
        link: '/dashboard/bookings',
        created_at: now,
      }).catch((err) => console.error('Propose reschedule notification failed:', err));
      res.json(toObj(updated));
    } catch (e) {
      console.error('Propose reschedule error:', e);
      res.status(500).json({ error: 'Failed to propose new time' });
    }
  }
);

router.patch('/:id/accept-reschedule', authenticate, requireRole('taker'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.taker_id.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (!['pending', 'confirmed'].includes(b.status)) {
      return res.status(400).json({ error: 'This booking cannot be rescheduled' });
    }
    if (!b.proposed_scheduled_at) return res.status(400).json({ error: 'No proposed time to accept' });
    const now = new Date();
    const newSched = b.proposed_scheduled_at;
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      {
        $set: { scheduled_at: newSched, updated_at: now },
        $unset: {
          proposed_scheduled_at: '',
          proposed_reschedule_message: '',
          proposed_reschedule_at: '',
        },
      },
      { returnDocument: 'after' }
    );
    await notifications.insertOne({
      user_id: b.provider_id,
      title: 'Reschedule accepted',
      body: `The customer accepted your proposed time (${new Date(newSched).toLocaleString()}).`,
      type: 'booking',
      link: '/dashboard/bookings',
      created_at: now,
    }).catch((err) => console.error('Accept reschedule notification failed:', err));
    res.json(toObj(updated));
  } catch (e) {
    console.error('Accept reschedule error:', e);
    res.status(500).json({ error: 'Failed to accept new time' });
  }
});

router.patch('/:id/reject-reschedule', authenticate, requireRole('taker'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.taker_id.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (!b.proposed_scheduled_at) return res.status(400).json({ error: 'No proposed time to decline' });
    const now = new Date();
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      {
        $unset: {
          proposed_scheduled_at: '',
          proposed_reschedule_message: '',
          proposed_reschedule_at: '',
        },
        $set: { updated_at: now },
      },
      { returnDocument: 'after' }
    );
    await notifications.insertOne({
      user_id: b.provider_id,
      title: 'Reschedule declined',
      body: 'The customer declined your proposed new time. The original schedule stays in place.',
      type: 'booking',
      link: '/dashboard/bookings',
      created_at: now,
    }).catch((err) => console.error('Reject reschedule notification failed:', err));
    res.json(toObj(updated));
  } catch (e) {
    console.error('Reject reschedule error:', e);
    res.status(500).json({ error: 'Failed to decline proposed time' });
  }
});

router.patch('/:id/reject', authenticate, requireRole('provider'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (!b.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'You are not the provider for this booking' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending' });
    const now = new Date();
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'cancelled', updated_at: now } },
      { returnDocument: 'after' }
    );
    await notifications.insertOne({
      user_id: updated.taker_id,
      title: 'Booking declined',
      body: 'The provider declined your booking.',
      type: 'booking',
      link: '/dashboard/bookings',
      created_at: now,
    });
    res.json(toObj(updated));
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject' });
  }
});

router.patch('/:id/complete', authenticate, requireRole('provider'), [
  body('otp').optional().trim(),
], async (req, res) => {
  const otp = req.body?.otp != null ? String(req.body.otp).trim() : '';
  if (!otp) return res.status(400).json({ error: 'OTP is required. Ask the customer for the verification OTP from their My Bookings.' });
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const wallets = getCollection('wallets');
    const transactions = getCollection('transactions');
    let b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (!b.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'You are not the provider for this booking' });
    const statusLower = String(b.status || '').toLowerCase();
    if (statusLower !== 'confirmed') {
      return res.status(400).json({ error: 'Booking must be confirmed first. Current status: ' + (b.status || 'unknown') });
    }
    if (!b.completion_otp) {
      const newOtp = generateCompletionOtp();
      await bookings.updateOne(
        { _id: id },
        { $set: { completion_otp: newOtp, updated_at: new Date() } }
      );
      await notifications.insertOne({
        user_id: b.taker_id,
        title: 'Verification OTP ready',
        body: 'Your verification OTP is now in My Bookings. Share it with the provider when the service is done.',
        type: 'booking',
        link: `/dashboard/bookings`,
        created_at: new Date(),
      });
      return res.status(400).json({
        error: 'OTP was just generated for this booking. Ask the customer to open My Bookings to see their OTP, then enter it here.',
        code: 'OTP_GENERATED',
      });
    }
    if (String(b.completion_otp) !== otp) {
      return res.status(400).json({ error: 'Invalid OTP. Ask the customer for the verification OTP from their My Bookings.' });
    }
    const now = new Date();
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'completed', completed_at: now, updated_at: now } },
      { returnDocument: 'after' }
    );
    const payout = Number(updated?.provider_payout ?? updated?.amount ?? 0);
    if (payout > 0) {
      let wallet = await wallets.findOne({ user_id: updated.provider_id });
      if (!wallet) {
        const inserted = await wallets.insertOne({
          user_id: updated.provider_id,
          balance: 0,
          created_at: now,
          updated_at: now,
        });
        wallet = { _id: inserted.insertedId, balance: 0 };
      }

      await wallets.updateOne(
        { _id: wallet._id },
        {
          $inc: { balance: payout },
          $set: { updated_at: now },
        }
      );

      const customerPaid = Number(updated.amount ?? 0);
      const platformFee = Number(updated.commission ?? 0);
      const bookingRef = updated._id.toString().slice(-6).toUpperCase();
      await transactions.insertOne({
        wallet_id: wallet._id,
        user_id: updated.provider_id,
        type: 'booking_payout',
        amount: payout,
        customer_paid: customerPaid,
        platform_commission: platformFee,
        currency: 'INR',
        booking_id: updated._id,
        service_id: updated.service_id,
        payment_method: updated.payment_method || 'cash',
        note: `Booking #${bookingRef} — Customer paid ₹${customerPaid}, platform fee ₹${platformFee}, your payout ₹${payout}`,
        created_at: now,
      });
    }
    const out = toObj(updated);
    delete out.completion_otp;
    res.json(out);
    await notifications.insertOne({
      user_id: updated.taker_id,
      title: 'Service completed',
      body: 'Your service has been marked as completed. Thank you!',
      type: 'booking',
      link: `/dashboard/bookings`,
      created_at: now,
    }).catch((err) => console.error('Complete notification failed:', err));
  } catch (e) {
    console.error('Complete booking error:', e);
    res.status(500).json({ error: 'Failed to complete' });
  }
});

router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const bookings = getCollection('bookings');
    const notifications = getCollection('notifications');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    const allowed =
      ['pending', 'confirmed'].includes(b.status) &&
      (req.user.id === b.taker_id?.toString() ||
        req.user.id === b.provider_id?.toString() ||
        req.user.role === 'admin');
    if (!allowed) return res.status(403).json({ error: 'Cannot cancel this booking' });
    const updated = await bookings.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'cancelled', updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    const other =
      req.user.id === b.taker_id?.toString() ? b.provider_id : b.taker_id;
    await notifications.insertOne({
      user_id: other,
      title: 'Booking cancelled',
      body: 'A booking was cancelled.',
      type: 'booking',
      link: '/dashboard/bookings',
      created_at: new Date(),
    });
    res.json(toObj(updated));
  } catch (e) {
    res.status(500).json({ error: 'Failed to cancel' });
  }
});

export default router;

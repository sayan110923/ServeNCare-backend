import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { emitToUser, emitToRole } from '../realtime.js';

const router = Router();

router.get('/services', authenticate, requireRole('provider'), async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  
  try {
    const services = getCollection('services');
    const categories = getCollection('categories');
    
    const [list, total] = await Promise.all([
      services
        .find({ provider_id: req.user._id })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .toArray(),
      services.countDocuments({ provider_id: req.user._id })
    ]);
    
    const cats = new Map(
      (await categories.find({}).toArray()).map((c) => [c._id.toString(), c])
    );
    const out = list.map((s) => {
      const c = cats.get(s.category_id?.toString());
      return {
        ...toObj(s),
        category_name: c?.name,
        category_slug: c?.slug,
      };
    });
    
    res.json({ 
      services: out, 
      total, 
      page: parseInt(page, 10), 
      limit: parseInt(limit, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10))
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

router.get('/profile', authenticate, requireRole('provider'), async (req, res) => {
  try {
    const coll = getCollection('provider_profiles');
    const pp = await coll.findOne({ user_id: req.user._id });
    res.json(pp ? toObj(pp) : null);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.put(
  '/profile',
  authenticate,
  requireRole('provider'),
  [
    body('business_name').optional().trim(),
    body('tagline').optional().trim(),
    body('bio').optional().trim(),
    body('website').optional().trim(),
    body('address').optional().trim(),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
    body('radius_km').optional().isInt({ min: 1, max: 100 }),
    body('working_hours').optional().isObject(),
    body('gender').optional().trim().isIn(['male', 'female', 'other', 'prefer_not_to_say', '']),
    body('phone').optional().trim(),
    body('experience_years').optional().isInt({ min: 0, max: 70 }),
    body('certifications').optional().trim(),
    body('listing_active').optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const {
      business_name, tagline, bio, website, address, latitude, longitude, radius_km,
      working_hours, gender, phone, experience_years, certifications, listing_active,
    } = req.body;
    try {
      const coll = getCollection('provider_profiles');
      const now = new Date();

      // Build the $set payload from whichever fields were actually provided
      const setFields = { updated_at: now };
      if (business_name != null) setFields.business_name = business_name;
      if (tagline != null) setFields.tagline = tagline;
      if (bio != null) setFields.bio = bio;
      if (website != null) setFields.website = website;
      if (address != null) setFields.address = address;
      if (latitude != null) setFields.latitude = parseFloat(latitude);
      if (longitude != null) setFields.longitude = parseFloat(longitude);
      if (radius_km != null) setFields.radius_km = parseInt(radius_km, 10);
      if (working_hours != null) setFields.working_hours = working_hours;
      if (gender !== undefined) setFields.gender = gender || null;
      if (phone !== undefined) setFields.phone = phone || null;
      if (experience_years !== undefined) setFields.experience_years = experience_years != null ? parseInt(experience_years, 10) : null;
      if (certifications !== undefined) setFields.certifications = certifications || null;
      if (listing_active !== undefined) setFields.listing_active = listing_active === true || listing_active === 'true';

      // Atomic upsert: creates the profile on first save, updates on subsequent saves.
      // $setOnInsert must NOT overlap with $set — only static insert-only fields go here.
      const result = await coll.findOneAndUpdate(
        { user_id: req.user._id },
        {
          $set: setFields,
          $setOnInsert: {
            user_id: req.user._id,
            created_at: now,
          },
        },
        { upsert: true, returnDocument: 'after' }
      );

      return res.json(toObj(result));
    } catch (e) {
      console.error('Provider profile update error:', e);
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

router.get('/availability', authenticate, requireRole('provider'), async (req, res) => {
  try {
    const coll = getCollection('availability');
    const list = await coll
      .find({ provider_id: req.user._id })
      .sort({ day_of_week: 1, start_time: 1 })
      .toArray();
    res.json(list.map(toObj));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

router.put('/availability', authenticate, requireRole('provider'), async (req, res) => {
  const slots = Array.isArray(req.body.slots) ? req.body.slots : [];
  try {
    const coll = getCollection('availability');
    await coll.deleteMany({ provider_id: req.user._id });
    const now = new Date();
    for (const s of slots) {
      if (s.day_of_week == null || s.start_time == null || s.end_time == null) continue;
      await coll.insertOne({
        provider_id: req.user._id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
        created_at: now,
      });
    }
    const list = await coll
      .find({ provider_id: req.user._id })
      .sort({ day_of_week: 1, start_time: 1 })
      .toArray();
    res.json(list.map(toObj));
  } catch (e) {
    console.error('Availability update error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.get('/earnings', authenticate, requireRole('provider'), async (req, res) => {
  try {
    const wallets = getCollection('wallets');
    const transactions = getCollection('transactions');
    const bookings = getCollection('bookings');
    const wallet = await wallets.findOne({ user_id: req.user._id });
    let tx = [];
    if (wallet?._id) {
      tx = await transactions
        .find({ wallet_id: wallet._id })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();
    }
    const agg = await bookings.aggregate([
      { $match: { provider_id: req.user._id } },
      {
        $group: {
          _id: null,
          total_earnings: { $sum: '$provider_payout' },
          completed_earnings: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$provider_payout', 0] },
          },
          pending_earnings: {
            $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, '$provider_payout', 0] },
          },
        },
      },
    ]).toArray();
    const a = agg[0] || {};
    res.json({
      wallet: wallet ? toObj(wallet) : null,
      transactions: tx.map(toObj),
      total_earnings: a.total_earnings ?? 0,
      completed_earnings: a.completed_earnings ?? 0,
      pending_earnings: a.pending_earnings ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// SOS endpoint for providers (women providers only)
router.post(
  '/sos',
  authenticate,
  requireRole('provider'),
  [
    body('lat').isFloat().withMessage('Latitude is required'),
    body('lng').isFloat().withMessage('Longitude is required'),
    body('accuracy').optional().isFloat(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { lat, lng, accuracy } = req.body;

    try {
      const profiles = getCollection('provider_profiles');
      const profile = await profiles.findOne({ user_id: req.user._id });
      const gender = profile?.gender || null;
      if (gender !== 'female') {
        return res.status(403).json({ error: 'SOS is only enabled for women providers.' });
      }

      const sos = getCollection('sos_incidents');
      const now = new Date();
      const doc = {
        provider_id: req.user._id,
        provider_name: req.user.full_name,
        provider_email: req.user.email,
        provider_phone: req.user.phone || null,
        gender,
        location: {
          lat,
          lng,
          accuracy: accuracy ?? null,
        },
        status: 'open',
        assigned_admin_id: null,
        created_at: now,
        updated_at: now,
      };
      const { insertedId } = await sos.insertOne(doc);

      // Notify all admins
      const users = getCollection('users');
      const admins = await users.find({ role: 'admin', is_active: { $ne: false } }).toArray();
      if (admins.length) {
        const notifications = getCollection('notifications');
        const notifs = admins.map((a) => ({
          user_id: a._id,
          title: 'SOS alert from provider',
          body: `${req.user.full_name || 'Provider'} sent an SOS alert.`,
          type: 'sos',
          link: '/dashboard/admin/sos',
          created_at: now,
          read_at: null,
        }));
        const ins = await notifications.insertMany(notifs);
        const n = notifs.length;
        const insertedIdList = Array.from({ length: n }, (_, i) => ins.insertedIds[i]);
        admins.forEach((admin, i) => {
          emitToUser(admin._id.toString(), 'notification', {
            notification: {
              id: insertedIdList[i]?.toString(),
              title: notifs[i].title,
              body: notifs[i].body,
              type: notifs[i].type,
              link: notifs[i].link,
              created_at: notifs[i].created_at,
              read_at: null,
            },
          });
        });
        emitToRole('admin', 'sos', {
          incident: {
            id: insertedId.toString(),
            provider_id: req.user._id.toString(),
            provider_name: req.user.full_name,
            provider_email: req.user.email,
            status: 'open',
            created_at: now,
            location: doc.location,
          },
        });
      }

      res.status(201).json({ id: insertedId.toString(), ...toObj(doc) });
    } catch (e) {
      console.error('Provider SOS error:', e);
      res.status(500).json({ error: 'Failed to send SOS' });
    }
  }
);

export default router;

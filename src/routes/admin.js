import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

function slugifyInput(s) {
  const raw = String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return raw || 'category';
}

async function uniqueSlug(coll, base) {
  let slug = base;
  let n = 0;
  while (await coll.findOne({ slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/** Dashboard stats: counts for admin overview */
router.get('/stats', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const users = getCollection('users');
    const services = getCollection('services');
    const bookings = getCollection('bookings');
    const [customersCount, providersCount, servicesCount, bookingsCount, pendingProvidersCount] = await Promise.all([
      users.countDocuments({ role: 'taker' }),
      users.countDocuments({ role: 'provider' }),
      services.countDocuments({}),
      bookings.countDocuments({}),
      users.countDocuments({ role: 'provider', is_verified: { $ne: true } }),
    ]);
    const completedBookings = await bookings.countDocuments({ status: 'completed' });
    res.json({
      customers: customersCount,
      providers: providersCount,
      pendingProviders: pendingProvidersCount,
      services: servicesCount,
      bookings: bookingsCount,
      completedBookings,
    });
  } catch (e) {
    console.error('Admin stats error:', e);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

/** List providers for admin (optional filter: ?verified=false for pending only) */
router.get('/providers', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const verified = req.query.verified;
    const users = getCollection('users');
    const filter = { role: 'provider' };
    if (verified === 'false' || verified === '0') filter.is_verified = { $ne: true };
    else if (verified === 'true' || verified === '1') filter.is_verified = true;

    const list = await users
      .find(filter)
      .sort({ created_at: -1 })
      .project({ password_hash: 0 })
      .toArray();

    const providerProfiles = getCollection('provider_profiles');
    const profiles = await providerProfiles.find({}).toArray();
    const profileByUserId = new Map(profiles.map((p) => [p.user_id.toString(), toObj(p)]));

    const out = list.map((u) => {
      const profile = profileByUserId.get(u._id.toString());
      return {
        id: u._id.toString(),
        email: u.email,
        full_name: u.full_name,
        phone: u.phone || null,
        is_verified: !!u.is_verified,
        is_active: u.is_active !== false,
        created_at: u.created_at,
        updated_at: u.updated_at,
        business_name: profile?.business_name || null,
        address: profile?.address || null,
      };
    });

    res.json({ providers: out });
  } catch (e) {
    console.error('Admin list providers error:', e);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

/** Verify a provider (set is_verified = true) */
router.patch('/providers/:id/verify', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    const users = getCollection('users');
    const user = await users.findOne({
      _id: new ObjectId(id),
      role: 'provider',
    });
    if (!user) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    const now = new Date();
    await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { is_verified: true, updated_at: now } }
    );
    const updated = await users.findOne({ _id: new ObjectId(id) }, { projection: { password_hash: 0 } });
    res.json(toObj(updated));
  } catch (e) {
    console.error('Admin verify provider error:', e);
    res.status(500).json({ error: 'Failed to verify provider' });
  }
});

/** SOS incidents for admin */
router.get('/sos', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    const sos = getCollection('sos_incidents');
    const match = {};
    if (status) match.status = status;
    const list = await sos
      .find(match)
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    res.json({ incidents: list.map(toObj) });
  } catch (e) {
    console.error('Admin sos list error:', e);
    res.status(500).json({ error: 'Failed to fetch SOS incidents' });
  }
});

router.patch('/sos/:id/assign', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const sos = getCollection('sos_incidents');
    const now = new Date();
    const { value } = await sos.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'assigned', assigned_admin_id: req.user._id, updated_at: now } },
      { returnDocument: 'after' }
    );
    if (!value) return res.status(404).json({ error: 'SOS incident not found' });
    res.json(toObj(value));
  } catch (e) {
    console.error('Admin sos assign error:', e);
    res.status(500).json({ error: 'Failed to assign SOS incident' });
  }
});

router.patch('/sos/:id/resolve', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const sos = getCollection('sos_incidents');
    const now = new Date();
    const { value } = await sos.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'resolved', updated_at: now } },
      { returnDocument: 'after' }
    );
    if (!value) return res.status(404).json({ error: 'SOS incident not found' });
    res.json(toObj(value));
  } catch (e) {
    console.error('Admin sos resolve error:', e);
    res.status(500).json({ error: 'Failed to resolve SOS incident' });
  }
});

/** Contact form submissions (public site → stored here) */
router.get('/contact-messages', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const coll = getCollection('contact_messages');
    const list = await coll.find({}).sort({ created_at: -1 }).limit(300).toArray();
    res.json({ messages: list.map(toObj) });
  } catch (e) {
    console.error('Admin contact messages list error:', e);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.patch('/contact-messages/:id/read', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const coll = getCollection('contact_messages');
    const now = new Date();
    const { value } = await coll.findOneAndUpdate(
      { _id: id },
      { $set: { read: true, read_at: now } },
      { returnDocument: 'after' }
    );
    if (!value) return res.status(404).json({ error: 'Message not found' });
    res.json(toObj(value));
  } catch (e) {
    console.error('Admin contact message read error:', e);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

/** Category tree (same shape as public GET /categories) */
router.get('/categories', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const coll = getCollection('categories');
    const parents = await coll.find({ parent_id: null }).sort({ sort_order: 1, name: 1 }).toArray();
    const children = await coll.find({ parent_id: { $ne: null } }).sort({ sort_order: 1, name: 1 }).toArray();
    const byParent = new Map();
    for (const c of children) {
      const pid = c.parent_id?.toString();
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(toObj(c));
    }
    const withChildren = parents.map((p) => ({
      ...toObj(p),
      children: byParent.get(p._id.toString()) || [],
    }));
    res.json(withChildren);
  } catch (e) {
    console.error('Admin categories list error:', e);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.patch(
  '/categories/:id',
  authenticate,
  requireRole('admin'),
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('icon').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errs = validationResult(req);
      if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

      let id;
      try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

      const coll = getCollection('categories');
      const existing = await coll.findOne({ _id: id });
      if (!existing) return res.status(404).json({ error: 'Category not found' });

      const update = { updated_at: new Date() };
      if (req.body.name !== undefined) update.name = req.body.name.trim();
      if (req.body.icon !== undefined) update.icon = req.body.icon.trim() || null;

      await coll.updateOne({ _id: id }, { $set: update });
      const updated = await coll.findOne({ _id: id });
      res.json(toObj(updated));
    } catch (e) {
      console.error('Admin update category error:', e);
      res.status(500).json({ error: 'Failed to update category' });
    }
  }
);

router.delete('/categories/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    let id;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

    const coll = getCollection('categories');
    const existing = await coll.findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    await coll.deleteMany({ parent_id: id });
    await coll.deleteOne({ _id: id });

    res.json({ success: true });
  } catch (e) {
    console.error('Admin delete category error:', e);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

router.post(
  '/categories',
  authenticate,
  requireRole('admin'),
  [
    body('name').trim().notEmpty().withMessage('Name required'),
    body('slug')
      .optional()
      .trim()
      .custom((v) => !v || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v))
      .withMessage('Invalid slug (use lowercase letters, numbers, hyphens)'),
    body('parent_id')
      .optional()
      .custom((v) => v == null || v === '' || /^[a-f\d]{24}$/i.test(String(v)))
      .withMessage('Invalid parent_id'),
    body('sort_order').optional().isInt({ min: 0 }),
    body('icon').optional().trim(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    const { name, icon } = req.body;
    let parent_id = req.body.parent_id;
    if (parent_id === '' || parent_id === null || parent_id === undefined) {
      parent_id = null;
    } else {
      try {
        parent_id = new ObjectId(parent_id);
      } catch {
        return res.status(400).json({ error: 'Invalid parent_id' });
      }
    }

    const coll = getCollection('categories');
    if (parent_id) {
      const parent = await coll.findOne({ _id: parent_id });
      if (!parent) return res.status(400).json({ error: 'Parent category not found' });
    }

    const baseSlug = req.body.slug ? slugifyInput(req.body.slug) : slugifyInput(name);
    const slug = await uniqueSlug(coll, baseSlug);

    const parentFilter = parent_id ? { parent_id } : { parent_id: null };
    const last = await coll.find(parentFilter).sort({ sort_order: -1 }).limit(1).toArray();
    const sort_order =
      req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : (last[0]?.sort_order ?? -1) + 1;

    const now = new Date();
    const doc = {
      name: name.trim(),
      slug,
      parent_id,
      sort_order,
      icon: parent_id ? null : icon?.trim() || null,
      created_at: now,
      updated_at: now,
    };

    try {
      const { insertedId } = await coll.insertOne(doc);
      res.status(201).json(toObj({ _id: insertedId, ...doc }));
    } catch (e) {
      if (e.code === 11000) {
        return res.status(409).json({ error: 'Slug already exists' });
      }
      console.error('Admin create category error:', e);
      res.status(500).json({ error: 'Failed to create category' });
    }
  }
);

export default router;

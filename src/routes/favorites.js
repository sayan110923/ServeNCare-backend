import { Router } from 'express';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

/** List current user's favorite service IDs and optionally full service details */
router.get('/', authenticate, requireRole('taker'), async (req, res) => {
  try {
    const favorites = getCollection('favorites');
    const list = await favorites
      .find({ user_id: req.user._id })
      .sort({ created_at: -1 })
      .toArray();
    const serviceIds = list.map((f) => f.service_id.toString());
    const services = getCollection('services');
    const categories = getCollection('categories');
    const cats = new Map((await categories.find({}).toArray()).map((c) => [c._id.toString(), c]));
    const ids = list.map((f) => f.service_id);
    const serviceDocs = await services.find({ _id: { $in: ids } }).toArray();
    const byId = new Map(serviceDocs.map((s) => [s._id.toString(), s]));
    const ordered = serviceIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((s) => {
        const c = cats.get(s.category_id?.toString());
        return {
          ...toObj(s),
          id: s._id.toString(),
          category_name: c?.name,
          category_slug: c?.slug,
        };
      });
    res.json({ favorites: ordered, favoriteIds: serviceIds });
  } catch (e) {
    console.error('Favorites list error:', e);
    res.status(500).json({ error: 'Failed to load favorites' });
  }
});

/** Add service to favorites */
router.post('/:serviceId', authenticate, requireRole('taker'), async (req, res) => {
  try {
    const serviceId = req.params.serviceId;
    const services = getCollection('services');
    const service = await services.findOne({ _id: new ObjectId(serviceId) });
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const favorites = getCollection('favorites');
    const existing = await favorites.findOne({
      user_id: req.user._id,
      service_id: new ObjectId(serviceId),
    });
    if (existing) return res.json({ message: 'Already in favorites', favoriteIds: [] });
    const now = new Date();
    await favorites.insertOne({
      user_id: req.user._id,
      service_id: new ObjectId(serviceId),
      created_at: now,
    });
    const list = await favorites.find({ user_id: req.user._id }).toArray();
    res.status(201).json({
      message: 'Added to favorites',
      favoriteIds: list.map((f) => f.service_id.toString()),
    });
  } catch (e) {
    console.error('Add favorite error:', e);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

/** Remove service from favorites */
router.delete('/:serviceId', authenticate, requireRole('taker'), async (req, res) => {
  try {
    const serviceId = req.params.serviceId;
    const favorites = getCollection('favorites');
    const result = await favorites.deleteOne({
      user_id: req.user._id,
      service_id: new ObjectId(serviceId),
    });
    const list = await favorites.find({ user_id: req.user._id }).toArray();
    res.json({
      message: result.deletedCount ? 'Removed from favorites' : 'Not in favorites',
      favoriteIds: list.map((f) => f.service_id.toString()),
    });
  } catch (e) {
    console.error('Remove favorite error:', e);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

export default router;

import { Router } from 'express';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, async (req, res) => {
  const { unreadOnly, limit = 20 } = req.query;
  try {
    const match = { user_id: req.user._id };
    if (unreadOnly === 'true') match.read_at = null;
    const coll = getCollection('notifications');
    const list = await coll
      .find(match)
      .sort({ created_at: -1 })
      .limit(parseInt(limit, 10) || 20)
      .toArray();
    const unread = await coll.countDocuments({
      user_id: req.user._id,
      read_at: null,
    });
    res.json({ notifications: list.map(toObj), unreadCount: unread });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    const coll = getCollection('notifications');
    const { value } = await coll.findOneAndUpdate(
      { _id: id, user_id: req.user._id },
      { $set: { read_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!value) return res.status(404).json({ error: 'Not found' });
    res.json(toObj(value));
  } catch (e) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

router.patch('/read-all', authenticate, async (req, res) => {
  try {
    const coll = getCollection('notifications');
    await coll.updateMany(
      { user_id: req.user._id, read_at: null },
      { $set: { read_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

export default router;

import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { getCollection, ObjectId } from '../db/index.js';
import { emitToUser } from '../realtime.js';

const router = Router();

async function usersCanChat(userAId, userBId, bookingId = null) {
  const bookings = getCollection('bookings');
  const a = new ObjectId(userAId);
  const b = new ObjectId(userBId);

  if (bookingId) {
    let bid;
    try {
      bid = new ObjectId(bookingId);
    } catch {
      return false;
    }
    const booking = await bookings.findOne({
      _id: bid,
      $or: [
        { provider_id: a, taker_id: b },
        { provider_id: b, taker_id: a },
      ],
    });
    return !!booking;
  }

  const booking = await bookings.findOne({
    $or: [
      { provider_id: a, taker_id: b },
      { provider_id: b, taker_id: a },
    ],
  });
  return !!booking;
}

router.get('/conversations', authenticate, async (req, res) => {
  try {
    const me = req.user._id;
    const messages = getCollection('messages');
    const users = getCollection('users');

    const docs = await messages.find({
      $or: [{ sender_id: me }, { receiver_id: me }],
    }).sort({ created_at: -1 }).limit(500).toArray();

    const map = new Map();
    for (const m of docs) {
      const otherId = (String(m.sender_id) === String(me) ? m.receiver_id : m.sender_id)?.toString();
      if (!otherId) continue;
      if (!map.has(otherId)) {
        map.set(otherId, {
          other_user_id: otherId,
          last_message: m.text,
          last_message_at: m.created_at,
          booking_id: m.booking_id ? m.booking_id.toString() : null,
          unread_count: 0,
        });
      }
      if (String(m.receiver_id) === String(me) && !m.read_at) {
        const prev = map.get(otherId);
        prev.unread_count += 1;
      }
    }

    const otherIds = [...map.keys()].map((id) => new ObjectId(id));
    const others = otherIds.length
      ? await users.find({ _id: { $in: otherIds } }, { projection: { full_name: 1, avatar_url: 1, role: 1 } }).toArray()
      : [];
    const userMap = new Map(others.map((u) => [u._id.toString(), u]));

    const conversations = [...map.values()]
      .map((c) => ({
        ...c,
        other_user_name: userMap.get(c.other_user_id)?.full_name || 'User',
        other_user_avatar: userMap.get(c.other_user_id)?.avatar_url || null,
        other_user_role: userMap.get(c.other_user_id)?.role || null,
      }))
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));

    res.json({ conversations });
  } catch (e) {
    console.error('Conversations error:', e);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

router.get(
  '/with/:otherUserId',
  authenticate,
  [query('booking_id').optional().isMongoId()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    const me = req.user._id.toString();
    const { otherUserId } = req.params;
    const { booking_id: bookingId } = req.query;

    try {
      let otherObj;
      try {
        otherObj = new ObjectId(otherUserId);
      } catch {
        return res.status(400).json({ error: 'Invalid user id' });
      }
      const ok = await usersCanChat(me, otherUserId, bookingId || null);
      if (!ok) return res.status(403).json({ error: 'Chat is only allowed between booking participants' });

      const messages = getCollection('messages');
      const meObj = new ObjectId(me);
      const threadQuery = {
        $or: [
          { sender_id: meObj, receiver_id: otherObj },
          { sender_id: otherObj, receiver_id: meObj },
        ],
      };
      if (bookingId) threadQuery.booking_id = new ObjectId(bookingId);

      const list = await messages.find(threadQuery).sort({ created_at: 1 }).limit(500).toArray();

      await messages.updateMany(
        { sender_id: otherObj, receiver_id: meObj, read_at: null, ...(bookingId ? { booking_id: new ObjectId(bookingId) } : {}) },
        { $set: { read_at: new Date() } }
      );

      res.json({
        messages: list.map((m) => ({
          id: m._id.toString(),
          sender_id: m.sender_id.toString(),
          receiver_id: m.receiver_id.toString(),
          booking_id: m.booking_id ? m.booking_id.toString() : null,
          text: m.text,
          created_at: m.created_at,
          read_at: m.read_at || null,
        })),
      });
    } catch (e) {
      console.error('Thread error:', e);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  }
);

router.post(
  '/',
  authenticate,
  [
    body('to_user_id').isMongoId(),
    body('booking_id').optional().isMongoId(),
    body('text').isString().trim().isLength({ min: 1, max: 2000 }),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    const { to_user_id: toUserId, booking_id: bookingId, text } = req.body;
    const fromUserId = req.user.id;

    try {
      const ok = await usersCanChat(fromUserId, toUserId, bookingId || null);
      if (!ok) return res.status(403).json({ error: 'Chat is only allowed between booking participants' });

      const messages = getCollection('messages');
      const notifications = getCollection('notifications');
      const now = new Date();
      const doc = {
        sender_id: new ObjectId(fromUserId),
        receiver_id: new ObjectId(toUserId),
        booking_id: bookingId ? new ObjectId(bookingId) : null,
        text: text.trim(),
        created_at: now,
        read_at: null,
      };
      const r = await messages.insertOne(doc);

      const notifDoc = {
        user_id: new ObjectId(toUserId),
        title: 'New message',
        body: `${req.user.full_name}: ${text.trim().slice(0, 80)}`,
        type: 'message',
        link: '/dashboard/bookings',
        created_at: now,
        read_at: null,
      };
      const notifIns = await notifications.insertOne(notifDoc);
      const messagePayload = {
        id: r.insertedId.toString(),
        sender_id: fromUserId,
        receiver_id: toUserId,
        booking_id: bookingId || null,
        text: doc.text,
        created_at: now,
      };
      const notificationPayload = {
        id: notifIns.insertedId.toString(),
        title: notifDoc.title,
        body: notifDoc.body,
        type: notifDoc.type,
        link: notifDoc.link,
        created_at: notifDoc.created_at,
        read_at: null,
      };

      emitToUser(toUserId, 'chat_message', { message: messagePayload });
      emitToUser(fromUserId, 'chat_message', { message: messagePayload });
      emitToUser(toUserId, 'notification', { notification: notificationPayload });

      res.status(201).json({
        id: r.insertedId.toString(),
        sender_id: fromUserId,
        receiver_id: toUserId,
        booking_id: bookingId || null,
        text: doc.text,
        created_at: now,
      });
    } catch (e) {
      console.error('Send message error:', e);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

export default router;

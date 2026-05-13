import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getCollection, ObjectId } from '../db/index.js';

export async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const users = getCollection('users');
    const user = await users.findOne({
      _id: new ObjectId(payload.userId),
      is_active: { $ne: false },
    });
    if (!user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.user = {
      id: user._id.toString(),
      _id: user._id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      avatar_url: user.avatar_url,
      role: user.role,
      is_verified: user.is_verified,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function optionalAuthenticate(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return next();
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const users = getCollection('users');
    const user = await users.findOne({
      _id: new ObjectId(payload.userId),
      is_active: { $ne: false },
    });
    if (user) {
      req.user = {
        id: user._id.toString(),
        _id: user._id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        role: user.role,
        is_verified: user.is_verified,
      };
    }
  } catch (e) {
    // Ignore token errors for optional auth
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

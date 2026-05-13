import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { body, validationResult } from 'express-validator';
import { getCollection } from '../db/index.js';
import { config } from '../config.js';
import { authenticate } from '../middleware/auth.js';
import { isMailConfigured, sendPasswordResetEmail } from '../utils/mail.js';

const router = Router();
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const registerValidators = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('role').isIn(['provider', 'taker']).withMessage('Role must be provider or taker'),
];
const loginValidators = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

router.post('/register', registerValidators, async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  const { email, password, fullName, role, phone } = req.body;
  try {
    const users = getCollection('users');
    const existing = await users.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const now = new Date();
    const { insertedId } = await users.insertOne({
      email,
      password_hash: hash,
      full_name: fullName,
      phone: phone || null,
      role,
      is_verified: false,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    const providerProfiles = getCollection('provider_profiles');
    const wallets = getCollection('wallets');
    if (role === 'provider') {
      await providerProfiles.insertOne({ user_id: insertedId, working_hours: {}, created_at: now, updated_at: now });
      await wallets.insertOne({ user_id: insertedId, balance: 0, created_at: now, updated_at: now });
    } else {
      await wallets.insertOne({ user_id: insertedId, balance: 0, created_at: now, updated_at: now });
    }
    const user = {
      id: insertedId.toString(),
      email,
      full_name: fullName,
      phone: phone || null,
      role,
      is_verified: false,
      created_at: now,
    };
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );
    res.status(201).json({ user, token });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', loginValidators, async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  const { email, password } = req.body;
  try {
    const users = getCollection('users');
    const u = await users.findOne({ email });
    if (!u || u.is_active === false) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { userId: u._id.toString(), role: u.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );
    const user = {
      id: u._id.toString(),
      email: u.email,
      full_name: u.full_name,
      phone: u.phone,
      avatar_url: u.avatar_url,
      role: u.role,
      is_verified: u.is_verified,
    };
    res.json({ user, token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/google', async (req, res) => {
  const { credential, role } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });
  if (!googleClient) return res.status(503).json({ error: 'Google login not configured' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ error: 'Email not provided by Google' });

    const users = getCollection('users');
    let u = await users.findOne({ email });
    const now = new Date();

    const normalizedRole = role === 'provider' ? 'provider' : 'taker';
    if (!u) {
      const { insertedId } = await users.insertOne({
        email,
        password_hash: null,
        full_name: name || email.split('@')[0],
        phone: null,
        avatar_url: picture || null,
        role: normalizedRole,
        google_id: googleId,
        is_verified: true,
        is_active: true,
        created_at: now,
        updated_at: now,
      });
      const wallets = getCollection('wallets');
      await wallets.insertOne({ user_id: insertedId, balance: 0, created_at: now, updated_at: now });
      if (normalizedRole === 'provider') {
        const providerProfiles = getCollection('provider_profiles');
        await providerProfiles.insertOne({ user_id: insertedId, working_hours: {}, created_at: now, updated_at: now });
      }
      u = await users.findOne({ _id: insertedId });
    } else {
      if (u.is_active === false) return res.status(401).json({ error: 'Account is disabled' });
      await users.updateOne(
        { _id: u._id },
        { $set: { google_id: googleId, avatar_url: picture || u.avatar_url, updated_at: now } }
      );
      u = await users.findOne({ _id: u._id });
    }

    const token = jwt.sign(
      { userId: u._id.toString(), role: u.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );
    const user = {
      id: u._id.toString(),
      email: u.email,
      full_name: u.full_name,
      phone: u.phone,
      avatar_url: u.avatar_url,
      role: u.role,
      is_verified: u.is_verified,
    };
    res.json({ user, token });
  } catch (e) {
    console.error('Google login error:', e);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const users = getCollection('users');
    const u = await users.findOne({ _id: req.user._id });
    if (!u) return res.status(404).json({ error: 'User not found' });

    const profile = {
      id: u._id.toString(),
      email: u.email,
      full_name: u.full_name,
      phone: u.phone,
      avatar_url: u.avatar_url,
      role: u.role,
      is_verified: u.is_verified,
      gender: u.gender || null,
      address: u.address || null,
      date_of_birth: u.date_of_birth || null,
      preferred_language: u.preferred_language || 'en',
      created_at: u.created_at,
    };

    if (req.user.role === 'provider') {
      const providerProfiles = getCollection('provider_profiles');
      const pp = await providerProfiles.findOne({ user_id: req.user._id });
      profile.provider_profile = pp ? { ...pp, id: pp._id.toString(), user_id: pp.user_id?.toString() } : null;
    }

    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const email = req.body.email;
    try {
      const users = getCollection('users');
      const u = await users.findOne({ email, role: { $in: ['taker', 'provider'] } });
      if (!u) {
        return res.json({ message: 'If an account exists with this email, you will receive a password reset link.' });
      }
      const tokens = getCollection('password_reset_tokens');
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
      await tokens.deleteMany({ email });
      await tokens.insertOne({ email, token, expires_at: expiresAt, created_at: new Date() });
      const resetLink = `${config.frontendUrl}/reset-password?token=${token}`;
      if (isMailConfigured()) {
        try {
          await sendPasswordResetEmail(email, resetLink, u.full_name);
        } catch (mailErr) {
          console.error('Password reset email failed:', mailErr);
          return res.status(500).json({ error: 'Could not send reset email. Please try again later.' });
        }
      } else if (config.nodeEnv === 'development') {
        console.log('[Forgot password] SMTP not configured; reset link for', email, ':', resetLink);
      } else {
        console.error('[Forgot password] SMTP not configured; cannot send reset email in production.');
        return res.status(503).json({ error: 'Password reset email is not configured.' });
      }
      res.json({ message: 'If an account exists with this email, you will receive a password reset link.' });
    } catch (e) {
      console.error('Forgot password error:', e);
      res.status(500).json({ error: 'Failed to process request' });
    }
  }
);

router.post(
  '/reset-password',
  [
    body('token').trim().notEmpty().withMessage('Token required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    const { token, newPassword } = req.body;
    try {
      const tokens = getCollection('password_reset_tokens');
      const record = await tokens.findOne({ token });
      if (!record) {
        return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
      }
      if (new Date() > record.expires_at) {
        await tokens.deleteOne({ token });
        return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
      }
      const users = getCollection('users');
      const hash = await bcrypt.hash(newPassword, 12);
      const now = new Date();
      await users.updateOne(
        { email: record.email },
        { $set: { password_hash: hash, updated_at: now } }
      );
      await tokens.deleteOne({ token });
      res.json({ message: 'Password has been reset. You can now log in.' });
    } catch (e) {
      console.error('Reset password error:', e);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

router.patch('/me', authenticate, async (req, res) => {
  const { fullName, phone, avatar_url, gender, address, date_of_birth, preferred_language, notification_sms, notification_email } = req.body;
  const updates = {};
  if (fullName != null) updates.full_name = fullName;
  if (phone != null) updates.phone = phone;
  if (avatar_url != null) updates.avatar_url = avatar_url;
  if (gender != null) updates.gender = gender;
  if (address != null) updates.address = address;
  if (date_of_birth != null) updates.date_of_birth = date_of_birth;
  if (preferred_language != null) updates.preferred_language = preferred_language;
  if (notification_sms != null) updates.notification_sms = notification_sms;
  if (notification_email != null) updates.notification_email = notification_email;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });
  updates.updated_at = new Date();
  try {
    const users = getCollection('users');
    const result = await users.findOneAndUpdate(
      { _id: req.user._id },
      { $set: updates },
      { returnDocument: 'after' }
    );
    const value = result?.value ?? result;
    if (!value?._id) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: value._id.toString(),
      email: value.email,
      full_name: value.full_name,
      phone: value.phone,
      avatar_url: value.avatar_url,
      role: value.role,
      is_verified: value.is_verified,
      gender: value.gender || null,
      address: value.address || null,
      date_of_birth: value.date_of_birth || null,
      preferred_language: value.preferred_language || 'en',
    });
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

export default router;

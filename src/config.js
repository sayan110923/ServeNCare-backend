import dotenv from 'dotenv';
dotenv.config();

/** No trailing slash — must match browser `Origin` exactly for CORS. */
export function normalizeWebOrigin(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

function parseFrontendOrigins(raw) {
  const source =
    raw != null && String(raw).trim() !== '' ? String(raw) : 'http://localhost:5173';
  const list = source
    .split(',')
    .map((s) => normalizeWebOrigin(s))
    .filter(Boolean);
  return [...new Set(list)];
}

/** Groq API keys: GROQ_API_KEYS comma/newline-separated; GROQ_API_KEY is prepended if not already listed (legacy). */
function parseGroqApiKeys() {
  const fromMulti = (process.env.GROQ_API_KEYS || '')
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const single = process.env.GROQ_API_KEY?.trim();
  if (single && !fromMulti.includes(single)) {
    return [single, ...fromMulti];
  }
  if (fromMulti.length) return fromMulti;
  return single ? [single] : [];
}

const frontendOrigins = parseFrontendOrigins(process.env.FRONTEND_URL);

export const config = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: (() => {
    const u = process.env.DATABASE_URL || 'mongodb://localhost:27017/servecare';
    return u.startsWith('mongodb') ? u : 'mongodb://localhost:27017/servecare';
  })(),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  /** First origin — used in password-reset links; list order matters if you use multiple. */
  frontendUrl: frontendOrigins[0] || 'http://localhost:5173',
  /** All allowed browser origins (CORS). Comma-separated in FRONTEND_URL; trailing slashes stripped. */
  frontendOrigins,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  /** @deprecated use groqApiKeys — first key for backwards compatibility */
  groqApiKey: parseGroqApiKeys()[0] || '',
  groqApiKeys: parseGroqApiKeys(),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number.parseInt(process.env.SMTP_PORT || '587', 10),
  smtpSecure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.EMAIL_FROM || '',
};

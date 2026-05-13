import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { getCollection } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

const FAQ_SNIPPET = `
Frequently asked questions (use these accurate answers; you may rephrase briefly):

Q: What is ServeNCare?
A: A marketplace to find and book trusted local and online services (home, care, professional, education, and more).

Q: How do I book a service?
A: Browse Services, open a listing, choose date/time, pick payment (cash or online where available), and submit. The provider confirms in their dashboard.

Q: How do payments work?
A: Customers can choose pay by cash at service time or pay online with Razorpay when booking (if configured). Online bookings must be paid before the provider can confirm.

Q: I am a provider — how do I list services?
A: Sign up as a provider, complete your profile, add services under Provider → Services, and keep "Show on marketplace" enabled to appear on the home page and search.

Q: How do I reset my password?
A: Use "Forgot password" on the login page; you will receive an email with a reset link (if email is configured).

Q: Where do I see my bookings?
A: Customers: Dashboard → My Bookings. Providers: Dashboard → Bookings.

Q: How many service or booking categories are there? What categories exist?
A: Use ONLY the "CURRENT PLATFORM SERVICE CATEGORIES" block in your instructions — those names and counts come from the live database. Bookings use each service's category (usually a subcategory). Do not invent examples.

Q: What services are on the platform? How many? Can you list services?
A: Use ONLY the "CURRENT PLATFORM LISTINGS (SERVICES)" block for counts and sample titles. The full catalog is on Browse Services (/services). Do not invent listings or prices.

Q: Who are the service providers? How many providers? Can you list providers?
A: Use ONLY the "CURRENT SERVICE PROVIDERS" block for counts and sample names. Do not invent providers. Customers find providers through service listings and search; providers sign up and get verified by admins.

Q: Is there customer support?
A: You can use this chat for general help, or contact the team through the website contact options if available.

Q: I'm on the customer dashboard — what can I do day to day?
A: Use Discover for highlights, My Bookings to track visits and your completion OTP, Payments for online receipts, Messages to chat with providers, Saved for favorites, and Profile to update your details. Open **Daily helper** in the sidebar for full-page everyday tips (cooking, DIY, habits). Use the green **ServeNCare Support** chat for bookings, payments, and how to use the site. Neither can read private messages or modify bookings for you.

Q: What is the customer dashboard AI assistant? Can you recommend something? I need help choosing.
A: You MAY give friendly guidance. Map the user's stated need (e.g. home help, learning, health support, legal/accounting, online help) to real options from the CURRENT PLATFORM SERVICE CATEGORIES and CURRENT PLATFORM LISTINGS (SERVICES) blocks only. Suggest 2–4 relevant category names or real sample listing titles from those blocks; briefly say why each fits. If the user is vague, ask one short clarifying question, then suggest. Always invite them to open Browse Services (/services) to compare listings, prices, and providers. Never invent categories or listings not shown in those blocks.
`;

const SYSTEM_PROMPT = `You are a helpful customer support assistant for ServeNCare, a service marketplace platform that connects customers with service providers.

ServeNCare includes:
- Browsing and booking services through the website
- Customer and Provider dashboards
- Providers listing services under platform categories and setting availability
- Customers browsing, booking, and managing bookings
- Payment options: cash or online (Razorpay) when booking, where enabled

${FAQ_SNIPPET}

For open-ended questions (recommendations, "what should I book?", troubleshooting, comparisons), reason from the live data blocks below (categories, listings, providers) when relevant. You may combine brief advice with factual platform information.

Keep responses concise (about 3–6 short sentences for recommendations; shorter for simple facts). Be friendly and helpful. If unsure, say you are not certain and suggest Browse Services or contacting support.`;

/** In-dashboard “daily life” assistant: cooking, DIY, habits — not ServeNCare account/booking support. */
const DAILY_ASSISTANT_SYSTEM_PROMPT = `You are a friendly, practical everyday assistant for people using the ServeNCare customer app. You help with general day-to-day topics only, for example:
- Home tips (e.g. basic fan cleaning, simple fixes, organizing)
- Cooking and food (recipes, substitutions, food safety basics)
- Productivity, reminders, study or work habits
- General “how do I…” life questions

Rules:
- Give clear, safe, step-by-step guidance when relevant. Keep answers concise unless the user asks for detail.
- For electrical work, gas, medical, or legal topics: give only general safety-aware information and say they should consult a qualified professional or doctor when risk is involved. Do not give medical diagnoses or legal advice.
- This chat is NOT for ServeNCare bookings, payments, OTPs, or account issues. If the user asks about bookings, refunds, providers on the platform, or app errors, briefly say you cannot access their account and they should use My Bookings, Messages, Payments, or the website Contact page.
- Do not claim to browse the internet or access private data.
- Respond in the user's language as indicated in the instructions.`;

/** Authoritative category list for the AI (matches MongoDB; updates when admins add categories). */
async function buildCategoryFactsForPrompt() {
  try {
    const coll = getCollection('categories');
    const parents = await coll.find({ parent_id: null }).sort({ sort_order: 1, name: 1 }).toArray();
    const children = await coll.find({ parent_id: { $ne: null } }).sort({ sort_order: 1, name: 1 }).toArray();
    const byParent = new Map();
    for (const c of children) {
      const pid = c.parent_id?.toString();
      if (!pid) continue;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(c.name);
    }
    const lines = [];
    lines.push(
      `Top-level groups: ${parents.length}. Subcategories (service types providers usually pick): ${children.length}.`,
    );
    lines.push(
      'A booking is tied to a service; that service has one category — typically one of the subcategories above, or a top-level group if it has no children.',
    );
    lines.push('List (group → subcategories):');
    for (const p of parents) {
      const subs = byParent.get(p._id.toString()) || [];
      if (subs.length) lines.push(`- ${p.name}: ${subs.join(', ')}`);
      else lines.push(`- ${p.name} (no subcategories; services may use this group directly)`);
    }
    return lines.join('\n');
  } catch (e) {
    console.error('Chat category facts:', e);
    return 'Category data could not be loaded. Ask the user to open Browse Services to see current filters, or contact support.';
  }
}

/** Active service listings (counts + sample rows; full catalog is on /services). */
async function buildServiceFactsForPrompt() {
  try {
    const servicesColl = getCollection('services');
    const categoriesColl = getCollection('categories');
    const [activeCount, anyCount] = await Promise.all([
      servicesColl.countDocuments({ status: 'active' }),
      servicesColl.countDocuments({}),
    ]);
    const cats = await categoriesColl.find({}).project({ name: 1 }).toArray();
    const catMap = new Map(cats.map((c) => [c._id.toString(), c.name]));
    const catName = (id) => (id ? catMap.get(id.toString()) : null) || '—';
    const sample = await servicesColl
      .find({ status: 'active' })
      .project({ title: 1, category_id: 1, price: 1, currency: 1, service_type: 1 })
      .sort({ created_at: -1 })
      .limit(24)
      .toArray();

    const lines = [];
    lines.push(
      `Active marketplace listings: ${activeCount}. Total service documents (any status): ${anyCount}.`,
    );
    lines.push(
      'Users book a specific listing (title, price, provider shown on the service page). Direct them to Browse Services for search, filters, and map.',
    );
    if (!sample.length) {
      lines.push('No active listings in the database right now.');
      return lines.join('\n');
    }
    lines.push('Sample of active listings (title — category — indicative price / location type):');
    for (const s of sample) {
      const cur = s.currency || 'INR';
      const price = s.price != null ? `${cur} ${s.price}` : 'price on request';
      const st =
        s.service_type === 'at_customer'
          ? 'at customer location'
          : s.service_type === 'at_provider'
            ? 'at provider'
            : s.service_type === 'online'
              ? 'online'
              : s.service_type || '—';
      lines.push(`- ${s.title} — ${catName(s.category_id)} — ${price} (${st})`);
    }
    if (activeCount > sample.length) {
      lines.push(`(…and ${activeCount - sample.length} more active listing(s); not all shown.)`);
    }
    return lines.join('\n');
  } catch (e) {
    console.error('Chat service facts:', e);
    return 'Service listing data could not be loaded. Suggest Browse Services (/services).';
  }
}

/** Providers on the platform (counts + sample; no private contact details). */
async function buildProviderFactsForPrompt() {
  try {
    const usersColl = getCollection('users');
    const profilesColl = getCollection('provider_profiles');
    const [total, verified, unverified] = await Promise.all([
      usersColl.countDocuments({ role: 'provider' }),
      usersColl.countDocuments({ role: 'provider', is_verified: true }),
      usersColl.countDocuments({ role: 'provider', is_verified: { $ne: true } }),
    ]);

    const sampleUsers = await usersColl
      .find({ role: 'provider' })
      .project({ full_name: 1, is_verified: 1 })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();

    const ids = sampleUsers.map((u) => u._id);
    const profiles =
      ids.length > 0
        ? await profilesColl.find({ user_id: { $in: ids } }).project({ user_id: 1, business_name: 1 }).toArray()
        : [];
    const bizByUser = new Map(profiles.map((p) => [p.user_id.toString(), p.business_name]));

    const lines = [];
    lines.push(`Provider accounts: ${total} total, ${verified} verified, ${unverified} not verified.`);
    lines.push(
      'Do not share emails or phone numbers from the database. Customers contact providers through booking flows and messaging when logged in.',
    );
    if (!sampleUsers.length) {
      lines.push('No provider accounts in the database yet.');
      return lines.join('\n');
    }
    lines.push('Sample provider display names (newest first; business name when set):');
    for (const u of sampleUsers) {
      const biz = bizByUser.get(u._id.toString());
      const label = biz?.trim() ? `${biz} (${u.full_name || 'Provider'})` : u.full_name || 'Provider';
      const badge = u.is_verified ? 'verified' : 'unverified';
      lines.push(`- ${label} — ${badge}`);
    }
    if (total > sampleUsers.length) {
      lines.push(`(…and ${total - sampleUsers.length} more provider account(s); not all shown.)`);
    }
    return lines.join('\n');
  } catch (e) {
    console.error('Chat provider facts:', e);
    return 'Provider data could not be loaded. Suggest Browse Services or the Providers section of the site.';
  }
}

function buildChatHistory(messages) {
  const mapped = messages
    .filter((m) => m.type && m.text)
    .map((m) => ({
      role: m.type === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));
  const firstUser = mapped.findIndex((m) => m.role === 'user');
  if (firstUser > 0) return mapped.slice(firstUser);
  if (firstUser === -1) return [];
  return mapped;
}

function openAiStyleHistory(history) {
  return buildChatHistory(history).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.parts?.[0]?.text || '',
  }));
}

function groqErrorIsRetryableWithNextKey(res, data) {
  if (res.status === 429) return true;
  if (res.status === 503) return true;
  const code = data?.error?.code;
  if (code === 'rate_limit_exceeded') return true;
  const msg = String(data?.error?.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) return true;
  return false;
}

async function groqChatSingle(apiKey, userMessage, history, lang, systemPrompt) {
  const messages = [
    {
      role: 'system',
      content: `${systemPrompt}\n\nRespond in the user's language. Language code: ${lang}.`,
    },
    ...openAiStyleHistory(history),
    { role: 'user', content: userMessage.trim() },
  ];
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 1024,
      temperature: 0.65,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    const err = new Error(msg || `Groq request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    err.retryableWithNextKey = groqErrorIsRetryableWithNextKey(res, data);
    throw err;
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty Groq response');
  return text.trim();
}

/** Try each configured Groq key in order when rate limits / overload occur. */
async function groqChatWithRotation(userMessage, history, lang, systemPrompt) {
  const keys = config.groqApiKeys;
  if (!keys.length) throw new Error('No Groq API keys configured');
  let lastErr;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      return await groqChatSingle(keys[i], userMessage, history, lang, systemPrompt);
    } catch (e) {
      lastErr = e;
      const tryNext = e.retryableWithNextKey === true && i < keys.length - 1;
      if (tryNext) {
        console.warn(`[Groq] Key ${i + 1}/${keys.length} failed (${e.status || 'error'}), rotating to next key.`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function geminiChat(userMessage, history, lang, systemPrompt) {
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `${systemPrompt}\n\nRespond in the user's language. The user's language code is: ${lang}. Common codes: en=English, es=Spanish, fr=French, hi=Hindi, pt=Portuguese, de=German, ar=Arabic.`,
  });
  const chat = model.startChat({
    history: buildChatHistory(history),
  });
  const result = await chat.sendMessage(userMessage.trim());
  const text = result.response.text();
  if (!text) throw new Error('No response from AI');
  return text.trim();
}

router.post('/daily', authenticate, requireRole('taker'), async (req, res) => {
  const { message, history = [], lang = 'en' } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message required' });
  }

  const useGroq = config.groqApiKeys.length > 0;
  const useGemini = Boolean(config.geminiApiKey);

  if (!useGroq && !useGemini) {
    return res.status(503).json({
      error: 'AI assistant not configured',
      fallback: true,
    });
  }

  try {
    const reply = useGroq
      ? await groqChatWithRotation(message, history, lang, DAILY_ASSISTANT_SYSTEM_PROMPT)
      : await geminiChat(message, history, lang, DAILY_ASSISTANT_SYSTEM_PROMPT);
    res.json({ reply });
  } catch (e) {
    console.error('Daily assistant AI error:', e);
    if (useGroq && useGemini) {
      try {
        const reply = await geminiChat(message, history, lang, DAILY_ASSISTANT_SYSTEM_PROMPT);
        return res.json({ reply });
      } catch (e2) {
        console.error('Gemini fallback error (daily):', e2);
      }
    }
    res.status(500).json({
      error: e.message || 'AI request failed',
      fallback: true,
    });
  }
});

router.post('/', async (req, res) => {
  const { message, history = [], lang = 'en' } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message required' });
  }

  const useGroq = config.groqApiKeys.length > 0;
  const useGemini = Boolean(config.geminiApiKey);

  if (!useGroq && !useGemini) {
    return res.status(503).json({
      error: 'AI chat not configured',
      fallback: true,
    });
  }

  const [categoryFacts, serviceFacts, providerFacts] = await Promise.all([
    buildCategoryFactsForPrompt(),
    buildServiceFactsForPrompt(),
    buildProviderFactsForPrompt(),
  ]);
  const systemPrompt = `${SYSTEM_PROMPT}

CURRENT PLATFORM SERVICE CATEGORIES (authoritative — when asked how many categories, what categories exist, or examples: use ONLY this block; do not guess or use generic industry lists):
${categoryFacts}

CURRENT PLATFORM LISTINGS (SERVICES) (authoritative — when asked what services exist, how many, examples, or prices: use this block; do not invent listings):
${serviceFacts}

CURRENT SERVICE PROVIDERS (authoritative — when asked about providers, how many, or names: use this block; never invent providers or share private contact fields):
${providerFacts}`;

  try {
    const reply = useGroq
      ? await groqChatWithRotation(message, history, lang, systemPrompt)
      : await geminiChat(message, history, lang, systemPrompt);
    res.json({ reply });
  } catch (e) {
    console.error('Chat AI error:', e);
    if (useGroq && useGemini) {
      try {
        const reply = await geminiChat(message, history, lang, systemPrompt);
        return res.json({ reply });
      } catch (e2) {
        console.error('Gemini fallback error:', e2);
      }
    }
    res.status(500).json({
      error: e.message || 'AI request failed',
      fallback: true,
    });
  }
});

export default router;

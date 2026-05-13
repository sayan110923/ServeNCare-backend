import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

let uri = process.env.DATABASE_URL || 'mongodb://localhost:27017/servecare';
if (uri.startsWith('postgres')) uri = 'mongodb://localhost:27017/servecare';

const categories = [
  {
    name: 'Home Services',
    slug: 'home-services',
    icon: 'home',
    children: [
      { name: 'Maid', slug: 'maid' },
      { name: 'Cook', slug: 'cook' },
      { name: 'Cleaner', slug: 'cleaner' },
      { name: 'Electrician', slug: 'electrician' },
      { name: 'Plumber', slug: 'plumber' },
    ],
  },
  {
    name: 'Health & Care',
    slug: 'health-care',
    icon: 'heart',
    children: [
      { name: 'Nurse', slug: 'nurse' },
      { name: 'Elder Care', slug: 'elder-care' },
      { name: 'Physiotherapy', slug: 'physiotherapy' },
    ],
  },
  {
    name: 'Professional',
    slug: 'professional',
    icon: 'briefcase',
    children: [
      { name: 'Lawyer', slug: 'lawyer' },
      { name: 'Accountant', slug: 'accountant' },
      { name: 'Consultant', slug: 'consultant' },
    ],
  },
  {
    name: 'Education',
    slug: 'education',
    icon: 'book',
    children: [
      { name: 'Tutor', slug: 'tutor' },
      { name: 'Music Teacher', slug: 'music-teacher' },
    ],
  },
  {
    name: 'Online Services',
    slug: 'online-services',
    icon: 'globe',
    children: [
      { name: 'Tech Support', slug: 'tech-support' },
      { name: 'Counselling', slug: 'counselling' },
    ],
  },
];

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();

    const users = db.collection('users');
    const existingAdmin = await users.findOne({ role: 'admin' });
    if (existingAdmin) {
      console.log('Seed already applied. Skipping.');
      return;
    }

    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ role: 1 });

    const adminHash = await bcrypt.hash('admin123', 12);
    const now = new Date();
    const { insertedId: adminId } = await users.insertOne({
      email: 'admin@servecare.com',
      password_hash: adminHash,
      full_name: 'Platform Admin',
      role: 'admin',
      is_verified: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    console.log('Admin user created: admin@servecare.com / admin123');

    const categoriesColl = db.collection('categories');
    await categoriesColl.createIndex({ slug: 1 }, { unique: true });
    await categoriesColl.createIndex({ parent_id: 1 });
    const parentIds = [];
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const { insertedId: pid } = await categoriesColl.insertOne({
        name: cat.name,
        slug: cat.slug,
        icon: cat.icon || null,
        parent_id: null,
        sort_order: i,
        created_at: now,
        updated_at: now,
      });
      parentIds.push(pid);
      for (let j = 0; j < (cat.children || []).length; j++) {
        const sub = cat.children[j];
        await categoriesColl.insertOne({
          name: sub.name,
          slug: sub.slug,
          parent_id: pid,
          sort_order: j,
          created_at: now,
          updated_at: now,
        });
      }
    }
    console.log('Categories seeded.');

    const providerHash = await bcrypt.hash('provider123', 12);
    const { insertedId: provId } = await users.insertOne({
      email: 'provider@demo.com',
      password_hash: providerHash,
      full_name: 'Demo Provider',
      phone: '+91 9876543210',
      role: 'provider',
      is_verified: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    const providerProfiles = db.collection('provider_profiles');
    await providerProfiles.createIndex({ user_id: 1 }, { unique: true });
    await providerProfiles.insertOne({
      user_id: provId,
      business_name: 'Demo Services Co',
      tagline: 'Trusted home & repair services',
      bio: 'Verified home & repair services.',
      website: 'https://demoservices.example.com',
      address: '123 Demo Street, Mumbai',
      latitude: 19.076,
      longitude: 72.8777,
      radius_km: 15,
      gender: 'male',
      phone: '+91 9876543210',
      experience_years: 5,
      certifications: 'Certified Home Service Provider',
      verified: true,
      working_hours: {},
      created_at: now,
      updated_at: now,
    });

    const services = db.collection('services');
    await services.createIndex({ provider_id: 1 });
    await services.createIndex({ category_id: 1 });
    await services.createIndex({ status: 1 });
    const childCats = await categoriesColl.find({ parent_id: { $ne: null } }).toArray();
    const catId = childCats[0]?._id;
    if (catId) {
      await services.insertOne({
        provider_id: provId,
        category_id: catId,
        title: 'Home Cleaning',
        description: 'Thorough home cleaning with eco-friendly products.',
        price_type: 'fixed',
        price: 1500,
        currency: 'INR',
        service_type: 'at_customer',
        images: [],
        status: 'active',
        avg_rating: 0,
        review_count: 0,
        created_at: now,
        updated_at: now,
      });
    }
    console.log('Demo provider and service created: provider@demo.com / provider123');

    const takerHash = await bcrypt.hash('taker123', 12);
    const { insertedId: takerId } = await users.insertOne({
      email: 'taker@demo.com',
      password_hash: takerHash,
      full_name: 'Demo Customer',
      phone: '+91 9123456789',
      role: 'taker',
      is_verified: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    const wallets = db.collection('wallets');
    await wallets.createIndex({ user_id: 1 }, { unique: true });
    await wallets.insertOne({ user_id: takerId, balance: 0, created_at: now, updated_at: now });
    await wallets.insertOne({ user_id: provId, balance: 0, created_at: now, updated_at: now });
    console.log('Demo taker created: taker@demo.com / taker123');

    const platformSettings = db.collection('platform_settings');
    await platformSettings.insertOne({
      key: 'commission_rate',
      value: 10,
      updated_at: now,
    });
    await platformSettings.insertOne({
      key: 'cancellation_hours',
      value: 24,
      updated_at: now,
    });

    const bookings = db.collection('bookings');
    await bookings.createIndex({ service_id: 1 });
    await bookings.createIndex({ taker_id: 1 });
    await bookings.createIndex({ provider_id: 1 });
    await bookings.createIndex({ status: 1 });

    const reviews = db.collection('reviews');
    await reviews.createIndex({ booking_id: 1 }, { unique: true });
    await reviews.createIndex({ provider_id: 1 });
    await reviews.createIndex({ service_id: 1 });

    const notifications = db.collection('notifications');
    await notifications.createIndex({ user_id: 1 });

    const transactions = db.collection('transactions');
    await transactions.createIndex({ wallet_id: 1 });
  } finally {
    await client.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

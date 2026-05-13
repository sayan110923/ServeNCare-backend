import { Router } from 'express';
import { getCollection, ObjectId } from '../db/index.js';

const router = Router();

function servicePipelineForList() {
  return [
    {
      $lookup: {
        from: 'categories',
        localField: 'category_id',
        foreignField: '_id',
        as: 'cat',
      },
    },
    { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'provider_id',
        foreignField: '_id',
        as: 'prov',
      },
    },
    { $unwind: { path: '$prov', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'provider_profiles',
        localField: 'provider_id',
        foreignField: 'user_id',
        as: 'pp',
      },
    },
    { $unwind: { path: '$pp', preserveNullAndEmptyArrays: true } },
    { $match: { $nor: [{ 'pp.listing_active': false }] } },
    {
      $project: {
        id: { $toString: '$_id' },
        provider_id: { $toString: '$provider_id' },
        category_id: { $toString: '$category_id' },
        title: 1,
        description: 1,
        price_type: 1,
        price: 1,
        currency: 1,
        service_type: 1,
        recurring_type: 1,
        frequency: 1,
        payment_frequency: 1,
        images: 1,
        avg_rating: 1,
        review_count: 1,
        created_at: 1,
        latitude: 1,
        longitude: 1,
        radius_km: 1,
        address: 1,
        category_name: '$cat.name',
        category_slug: '$cat.slug',
        provider_name: '$prov.full_name',
        provider_avatar: '$prov.avatar_url',
        provider_lat: '$pp.latitude',
        provider_lng: '$pp.longitude',
        provider_radius_km: '$pp.radius_km',
        provider_address: '$pp.address',
        provider_verified: '$prov.is_verified',
      },
    },
  ];
}

function attachBadges(rows) {
  const topRated = (s) => (s.avg_rating || 0) >= 4.5 && (s.review_count || 0) >= 5;
  return rows.map((s) => {
    const badges = [];
    if (topRated(s)) badges.push('top_rated');
    if (topRated(s) && s.provider_verified) badges.push('most_trusted');
    else if (s.provider_verified) badges.push('verified');
    return { ...s, badges };
  });
}

/** Public: verified providers (approved by admin) */
router.get('/', async (req, res) => {
  try {
    const users = getCollection('users');
    const pipeline = [
      {
        $match: {
          role: 'provider',
          is_verified: true,
          $or: [{ is_active: true }, { is_active: { $exists: false } }],
        },
      },
      { $project: { password_hash: 0 } },
      {
        $lookup: {
          from: 'provider_profiles',
          localField: '_id',
          foreignField: 'user_id',
          as: 'pp',
        },
      },
      { $unwind: { path: '$pp', preserveNullAndEmptyArrays: true } },
      { $match: { $nor: [{ 'pp.listing_active': false }] } },
      {
        $lookup: {
          from: 'services',
          let: { pid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ['$provider_id', '$$pid'] }, { $eq: ['$status', 'active'] }],
                },
              },
            },
            { $count: 'total' },
          ],
          as: 'sc',
        },
      },
      {
        $addFields: {
          service_count: {
            $cond: {
              if: { $gt: [{ $size: '$sc' }, 0] },
              then: { $arrayElemAt: ['$sc.total', 0] },
              else: 0,
            },
          },
        },
      },
      { $sort: { full_name: 1 } },
      {
        $project: {
          id: { $toString: '$_id' },
          full_name: 1,
          avatar_url: 1,
          business_name: '$pp.business_name',
          bio: '$pp.bio',
          address: '$pp.address',
          latitude: '$pp.latitude',
          longitude: '$pp.longitude',
          service_count: 1,
        },
      },
    ];
    const rows = await users.aggregate(pipeline).toArray();
    res.json({ providers: rows });
  } catch (e) {
    console.error('Public providers list error:', e);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

/** Public: one verified provider + their active services */
router.get('/:id', async (req, res) => {
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch {
    return res.status(404).json({ error: 'Provider not found' });
  }
  try {
    const users = getCollection('users');
    const u = await users.findOne({
      _id: oid,
      role: 'provider',
      is_verified: true,
      $or: [{ is_active: true }, { is_active: { $exists: false } }],
    });
    if (!u) return res.status(404).json({ error: 'Provider not found' });

    const providerProfiles = getCollection('provider_profiles');
    const pp = await providerProfiles.findOne({ user_id: u._id });
    if (pp && pp.listing_active === false) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const servicesColl = getCollection('services');
    const pipeline = [
      { $match: { provider_id: u._id, status: 'active' } },
      { $sort: { avg_rating: -1, review_count: -1 } },
      ...servicePipelineForList(),
    ];
    const raw = await servicesColl.aggregate(pipeline).toArray();
    const withBadges = attachBadges(
      raw.map((r) => ({
        ...r,
        address: r.address || r.provider_address || null,
        radius_km: r.radius_km ?? r.provider_radius_km ?? null,
      }))
    );

    const prov = {
      id: u._id.toString(),
      full_name: u.full_name,
      avatar_url: u.avatar_url,
      phone: u.phone || null,
      business_name: pp?.business_name || null,
      bio: pp?.bio || null,
      address: pp?.address || null,
      latitude: pp?.latitude ?? null,
      longitude: pp?.longitude ?? null,
    };

    res.json({ provider: prov, services: withBadges });
  } catch (e) {
    console.error('Public provider detail error:', e);
    res.status(500).json({ error: 'Failed to load provider' });
  }
});

export default router;

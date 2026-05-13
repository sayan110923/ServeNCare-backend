import { Router } from 'express';
import { body, query as q, validationResult } from 'express-validator';
import { getCollection, ObjectId, toObj } from '../db/index.js';
import { authenticate, optionalAuthenticate, requireRole } from '../middleware/auth.js';

const router = Router();

const listValidators = [
  q('category').optional().isMongoId(),
  q('lat').optional().isFloat(),
  q('lng').optional().isFloat(),
  q('radius').optional().isInt({ min: 1, max: 100 }),
  q('minPrice').optional().isFloat({ min: 0 }),
  q('maxPrice').optional().isFloat({ min: 0 }),
  q('type').optional().isIn(['at_customer', 'at_provider', 'online']),
  q('q').optional().trim(),
  q('sort').optional().isIn(['rating', 'price_asc', 'price_desc', 'newest']),
  q('page').optional().isInt({ min: 1 }),
  q('limit').optional().isInt({ min: 1, max: 50 }),
];

router.get('/', listValidators, async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  const {
    category,
    lat,
    lng,
    radius = 50,
    minPrice,
    maxPrice,
    type,
    q: search,
    sort = 'rating',
    page = 1,
    limit = 12,
  } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const services = getCollection('services');
    const categories = getCollection('categories');
    const users = getCollection('users');
    const providerProfiles = getCollection('provider_profiles');

    let categoryIds = null;
    if (category) {
      const catIds = await categories.distinct('_id', {
        $or: [{ _id: new ObjectId(category) }, { parent_id: new ObjectId(category) }],
      });
      categoryIds = catIds.length ? catIds : [new ObjectId(category)];
    }

    const match = { status: 'active' };
    if (categoryIds) match.category_id = { $in: categoryIds };
    if (minPrice != null || maxPrice != null) {
      match.price = {};
      if (minPrice != null) match.price.$gte = parseFloat(minPrice);
      if (maxPrice != null) match.price.$lte = parseFloat(maxPrice);
    }
    if (type) match.service_type = type;
    if (search) {
      match.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    let sortStage = { avg_rating: -1, review_count: -1 };
    if (sort === 'price_asc') sortStage = { price: 1 };
    else if (sort === 'price_desc') sortStage = { price: -1 };
    else if (sort === 'newest') sortStage = { created_at: -1 };

    const listingFilter = { $match: { $nor: [{ 'pp.listing_active': false }] } };

    const pipeline = [
      { $match: match },
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
      listingFilter,
      { $sort: sortStage },
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
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

    const countPipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'provider_profiles',
          localField: 'provider_id',
          foreignField: 'user_id',
          as: 'pp',
        },
      },
      { $unwind: { path: '$pp', preserveNullAndEmptyArrays: true } },
      listingFilter,
      { $count: 'n' },
    ];

    const [list, countArr] = await Promise.all([
      services.aggregate(pipeline).toArray(),
      services.aggregate(countPipeline).toArray(),
    ]);
    const total = countArr[0]?.n ?? 0;

    const topRated = (s) => (s.avg_rating || 0) >= 4.5 && (s.review_count || 0) >= 5;
    const withBadges = list.map((s) => {
      const badges = [];
      if (topRated(s)) badges.push('top_rated');
      if (topRated(s) && s.provider_verified) badges.push('most_trusted');
      else if (s.provider_verified) badges.push('verified');
      return { ...s, badges };
    });

    let rows = withBadges;
    if (lat != null && lng != null && rows.length) {
      const rad = (d) => (d * Math.PI) / 180;
      const dist = (la, ln) => {
        const R = 6371;
        const dLat = rad(la - parseFloat(lat));
        const dLon = rad(ln - parseFloat(lng));
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(rad(parseFloat(lat))) * Math.cos(rad(la)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      rows = rows
        .map((r) => {
          // Use service's own location if available, otherwise provider location
          const serviceLat = r.latitude ?? r.provider_lat;
          const serviceLng = r.longitude ?? r.provider_lng;
          const serviceRadius = r.radius_km ?? r.provider_radius_km;
          
          const d = serviceLat != null ? dist(serviceLat, serviceLng) : 0;
          return { 
            ...r, 
            distance_km: serviceLat != null ? Math.round(d * 10) / 10 : null,
            // Use service's own address if available
            address: r.address || r.provider_address || null,
            // Use service's own radius if available
            radius_km: serviceRadius || null,
          };
        })
        .filter((r) => {
          // For services with location, filter by radius
          if (r.distance_km != null) {
            return r.distance_km <= parseInt(radius, 10);
          }
          // For online services or services without location, include them
          return r.service_type === 'online' || r.latitude == null;
        });
    }

    res.json({ services: rows, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (e) {
    console.error('Services list error:', e);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

router.get('/:id', optionalAuthenticate, async (req, res) => {
  try {
    const services = getCollection('services');
    const categories = getCollection('categories');
    const users = getCollection('users');
    const providerProfiles = getCollection('provider_profiles');
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    // Allow providers to access their own services regardless of status
    const query = req.user && req.user.role === 'provider' 
      ? { _id: id, provider_id: req.user._id }
      : { _id: id, status: 'active' };
    
    const s = await services.findOne(query);
    if (!s) return res.status(404).json({ error: 'Service not found' });
    const [cat, prov, pp] = await Promise.all([
      categories.findOne({ _id: s.category_id }),
      users.findOne({ _id: s.provider_id }),
      providerProfiles.findOne({ user_id: s.provider_id }),
    ]);
    const isOwner = req.user && req.user.role === 'provider' && s.provider_id.equals(req.user._id);
    if (!isOwner && pp && pp.listing_active === false) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const topRated = (s.avg_rating || 0) >= 4.5 && (s.review_count || 0) >= 5;
    const provVerified = !!prov?.is_verified || !!pp?.verified;
    const badges = [];
    if (topRated) badges.push('top_rated');
    if (topRated && provVerified) badges.push('most_trusted');
    else if (provVerified) badges.push('verified');

    const doc = {
      ...toObj(s),
      category_name: cat?.name,
      category_slug: cat?.slug,
      provider_name: prov?.full_name,
      provider_avatar: prov?.avatar_url,
      provider_phone: prov?.phone,
      business_name: pp?.business_name,
      bio: pp?.bio,
      address: s.address || pp?.address,
      latitude: s.latitude ?? pp?.latitude ?? null,
      longitude: s.longitude ?? pp?.longitude ?? null,
      radius_km: s.radius_km ?? pp?.radius_km ?? null,
      verified: provVerified,
      badges,
    };
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

router.post(
  '/',
  authenticate,
  requireRole('provider'),
  [
    body('category_id').isMongoId(),
    body('title').trim().notEmpty(),
    body('description').optional().trim(),
    body('price_type').isIn(['hourly', 'fixed']),
    body('price').isFloat({ min: 0 }),
    body('payment_frequency').optional().isIn(['per_service', 'monthly']),
    body('service_type').isIn(['at_customer', 'at_provider', 'online']),
    body('images').optional().isArray(),
    body('recurring_type').optional().isIn(['one_time', 'daily', 'weekly', 'monthly']),
    body('frequency').optional().isInt({ min: 1 }),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
    body('radius_km').optional().isFloat({ min: 0 }),
    body('address').optional().trim(),
    body('service_areas').optional().isArray(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
    if (!req.user.is_verified) {
      return res.status(403).json({
        error: 'Your account must be verified by an admin before you can post services.',
        code: 'PROVIDER_NOT_VERIFIED',
      });
    }
    const { 
      category_id, title, description, price_type, price, payment_frequency, service_type, images,
      recurring_type, frequency, latitude, longitude, radius_km, address, service_areas 
    } = req.body;
    try {
      const services = getCollection('services');
      const now = new Date();
      const doc = {
        provider_id: req.user._id,
        category_id: new ObjectId(category_id),
        title,
        description: description || null,
        price_type,
        price: parseFloat(price),
        payment_frequency: payment_frequency || (recurring_type === 'one_time' ? 'per_service' : 'per_service'),
        currency: 'INR',
        service_type,
        images: images || [],
        recurring_type: recurring_type || 'one_time',
        frequency: frequency || 1,
        latitude: latitude || null,
        longitude: longitude || null,
        radius_km: radius_km || null,
        address: address || null,
        service_areas: service_areas || [],
        status: 'active',
        avg_rating: 0,
        review_count: 0,
        created_at: now,
        updated_at: now,
      };
      const { insertedId } = await services.insertOne(doc);
      res.status(201).json(toObj({ _id: insertedId, ...doc }));
    } catch (e) {
      console.error('Create service error:', e);
      res.status(500).json({ error: 'Failed to create service' });
    }
  }
);

router.patch('/:id', authenticate, requireRole('provider'), async (req, res) => {
  const { 
    title, description, price_type, price, payment_frequency, service_type, images, status,
    recurring_type, frequency, latitude, longitude, radius_km, address, service_areas 
  } = req.body;
  const updates = {};
  if (title != null) updates.title = title;
  if (description != null) updates.description = description;
  if (price_type != null) updates.price_type = price_type;
  if (price != null) updates.price = price;
  if (payment_frequency != null) updates.payment_frequency = payment_frequency;
  if (service_type != null) updates.service_type = service_type;
  if (images != null) updates.images = images;
  if (status != null) updates.status = status;
  if (recurring_type != null) updates.recurring_type = recurring_type;
  if (frequency != null) updates.frequency = frequency;
  if (latitude != null) updates.latitude = latitude;
  if (longitude != null) updates.longitude = longitude;
  if (radius_km != null) updates.radius_km = radius_km;
  if (address != null) updates.address = address;
  if (service_areas != null) updates.service_areas = service_areas;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates' });
  updates.updated_at = new Date();
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Service not found' });
    }
    const services = getCollection('services');
    const s = await services.findOne({ _id: id });
    if (!s) return res.status(404).json({ error: 'Service not found' });
    if (!s.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'You do not own this service' });
    const { value } = await services.findOneAndUpdate(
      { _id: id },
      { $set: updates },
      { returnDocument: 'after' }
    );
    res.json(toObj(value));
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/:id', authenticate, requireRole('provider'), async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Service not found' });
    }
    const services = getCollection('services');
    const s = await services.findOne({ _id: id });
    if (!s) return res.status(404).json({ error: 'Service not found' });
    if (!s.provider_id.equals(req.user._id)) return res.status(403).json({ error: 'You do not own this service' });
    await services.deleteOne({ _id: id });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Admin endpoint to list all services
router.get('/admin/all', authenticate, requireRole('admin'), async (req, res) => {
  const { page = 1, limit = 20, status, search } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  
  try {
    const services = getCollection('services');
    const categories = getCollection('categories');
    const users = getCollection('users');
    
    const match = {};
    if (status) match.status = status;
    if (search) {
      match.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    
    const pipeline = [
      { $match: match },
      { $sort: { created_at: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
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
          latitude: 1,
          longitude: 1,
          radius_km: 1,
          service_areas: 1,
          images: 1,
          status: 1,
          avg_rating: 1,
          review_count: 1,
          created_at: 1,
          category_name: '$cat.name',
          provider_name: '$prov.full_name',
          provider_email: '$prov.email',
        },
      },
    ];
    
    const [list, total] = await Promise.all([
      services.aggregate(pipeline).toArray(),
      services.countDocuments(match),
    ]);
    
    res.json({ 
      services: list, 
      total, 
      page: parseInt(page, 10), 
      limit: parseInt(limit, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10))
    });
  } catch (e) {
    console.error('Admin services list error:', e);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

export default router;

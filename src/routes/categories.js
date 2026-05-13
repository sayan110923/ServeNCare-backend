import { Router } from 'express';
import { getCollection, ObjectId, toObj } from '../db/index.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const coll = getCollection('categories');
    const parents = await coll.find({ parent_id: null }).sort({ sort_order: 1, name: 1 }).toArray();
    const children = await coll.find({ parent_id: { $ne: null } }).sort({ sort_order: 1, name: 1 }).toArray();
    const byParent = new Map();
    for (const c of children) {
      const pid = c.parent_id?.toString();
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(toObj(c));
    }
    const withChildren = parents.map((p) => ({
      ...toObj(p),
      children: byParent.get(p._id.toString()) || [],
    }));
    res.json(withChildren);
  } catch (e) {
    console.error('Categories list error:', e);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.get('/flat', async (req, res) => {
  try {
    const coll = getCollection('categories');
    const rows = await coll.find({}).sort({ sort_order: 1, name: 1 }).toArray();
    res.json(rows.map((r) => ({ ...toObj(r), parent_id: r.parent_id?.toString() ?? null })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.get('/marketplace', async (req, res) => {
  try {
    const categories = getCollection('categories');
    const services = getCollection('services');

    const parents = await categories
      .find({ parent_id: null })
      .sort({ sort_order: 1, name: 1 })
      .toArray();

    const children = await categories
      .find({ parent_id: { $ne: null } })
      .sort({ sort_order: 1, name: 1 })
      .toArray();

    const childIdsByParent = new Map();
    const childrenByParent = new Map();
    for (const child of children) {
      const parentId = child.parent_id?.toString();
      if (!parentId) continue;
      if (!childIdsByParent.has(parentId)) childIdsByParent.set(parentId, []);
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childIdsByParent.get(parentId).push(child._id);
      childrenByParent.get(parentId).push(toObj(child));
    }

    const parentIds = parents.map((p) => p._id);
    const categoryStatsRows = await services
      .aggregate([
        { $match: { status: 'active', category_id: { $in: parentIds.concat(children.map((c) => c._id)) } } },
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
          $group: {
            _id: '$category_id',
            minPrice: { $min: '$price' },
            count: { $sum: 1 },
            weightedRatingSum: {
              $sum: {
                $cond: [
                  { $gt: ['$review_count', 0] },
                  { $multiply: ['$avg_rating', '$review_count'] },
                  0,
                ],
              },
            },
            totalReviews: {
              $sum: {
                $cond: [{ $gt: ['$review_count', 0] }, '$review_count', 0],
              },
            },
          },
        },
      ])
      .toArray();

    const statsByCategoryId = new Map(
      categoryStatsRows.map((row) => [row._id.toString(), row])
    );

    const result = parents.map((parent) => {
      const parentId = parent._id.toString();
      const direct = statsByCategoryId.get(parentId);
      const childObjs = childrenByParent.get(parentId) || [];
      const childCategoryIds = childIdsByParent.get(parentId) || [];

      const childStats = childCategoryIds
        .map((id) => statsByCategoryId.get(id.toString()))
        .filter(Boolean);

      const minCandidates = [];
      if (direct?.minPrice != null) minCandidates.push(direct.minPrice);
      for (const item of childStats) {
        if (item?.minPrice != null) minCandidates.push(item.minPrice);
      }

      const startingPrice = minCandidates.length > 0 ? Math.min(...minCandidates) : null;
      const providers =
        (direct?.count || 0) +
        childStats.reduce((acc, item) => acc + (item?.count || 0), 0);
      const weightedRatingSum =
        (direct?.weightedRatingSum || 0) +
        childStats.reduce((acc, item) => acc + (item?.weightedRatingSum || 0), 0);
      const totalReviews =
        (direct?.totalReviews || 0) +
        childStats.reduce((acc, item) => acc + (item?.totalReviews || 0), 0);
      const avgRating = totalReviews > 0 ? weightedRatingSum / totalReviews : null;

      return {
        ...toObj(parent),
        children: childObjs,
        startingPrice,
        avgRating,
        providers,
        defaultCategoryId: childObjs[0]?.id || parentId,
      };
    });

    res.json(result);
  } catch (e) {
    console.error('Categories marketplace error:', e);
    res.status(500).json({ error: 'Failed to fetch marketplace categories' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const coll = getCollection('categories');
    let doc;
    try {
      doc = await coll.findOne({ _id: new ObjectId(req.params.id) });
    } catch {
      return res.status(404).json({ error: 'Category not found' });
    }
    if (!doc) return res.status(404).json({ error: 'Category not found' });
    res.json({ ...toObj(doc), parent_id: doc.parent_id?.toString() ?? null });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch category' });
  }
});

export default router;

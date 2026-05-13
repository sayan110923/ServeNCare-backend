import { Router } from 'express';
import { getCollection, toObj } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const wallets = getCollection('wallets');
    const transactions = getCollection('transactions');
    const wallet = await wallets.findOne({ user_id: req.user._id });
    if (!wallet) return res.json({ balance: 0, transactions: [] });
    const tx = await transactions
      .find({ wallet_id: wallet._id })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    res.json({
      balance: parseFloat(wallet.balance ?? 0),
      transactions: tx.map(toObj),
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

export default router;

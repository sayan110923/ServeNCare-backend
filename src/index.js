import http from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { connectDb } from './db/index.js';
import { attachRealtime } from './realtime.js';

import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import categoriesRoutes from './routes/categories.js';
import servicesRoutes from './routes/services.js';
import bookingsRoutes from './routes/bookings.js';
import reviewsRoutes from './routes/reviews.js';
import providerRoutes from './routes/provider.js';
import notificationsRoutes from './routes/notifications.js';
import walletRoutes from './routes/wallet.js';
import chatRoutes from './routes/chat.js';
import messagesRoutes from './routes/messages.js';
import adminRoutes from './routes/admin.js';
import favoritesRoutes from './routes/favorites.js';
import providersPublicRoutes from './routes/providers.js';
import contactRoutes from './routes/contact.js';
import paymentsRoutes from './routes/payments.js';

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/provider', providerRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/providers', providersPublicRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/payments', paymentsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
attachRealtime(server);

connectDb()
  .then(() => {
    server.listen(config.port, () => {
      console.log(`Serve & Care API running on http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });

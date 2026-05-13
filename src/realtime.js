import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { config } from './config.js';
import { getCollection, ObjectId } from './db/index.js';

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const clientsByUser = new Map();

/**
 * @param {string} userId
 * @param {import('ws').WebSocket} ws
 */
function trackClient(userId, ws) {
  const id = String(userId);
  if (!clientsByUser.has(id)) clientsByUser.set(id, new Set());
  clientsByUser.get(id).add(ws);
  ws.on('close', () => {
    clientsByUser.get(id)?.delete(ws);
    if (clientsByUser.get(id)?.size === 0) clientsByUser.delete(id);
  });
}

function safeSend(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Push an event to every connected socket for this user (multi-tab safe).
 * @param {string} userId
 * @param {string} type
 * @param {Record<string, unknown>} payload
 */
export function emitToUser(userId, type, payload) {
  const set = clientsByUser.get(String(userId));
  if (!set) return;
  const msg = { type, ...payload };
  for (const ws of set) safeSend(ws, msg);
}

/**
 * Push to every connected socket whose JWT role matches.
 * @param {'admin' | 'provider' | 'taker'} role
 * @param {string} type
 * @param {Record<string, unknown>} payload
 */
export function emitToRole(role, type, payload) {
  const msg = { type, ...payload };
  for (const set of clientsByUser.values()) {
    for (const ws of set) {
      if (ws.userRole === role) safeSend(ws, msg);
    }
  }
}

/**
 * @param {import('http').Server} server
 */
export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host || 'localhost';
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', `http://${host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (ws, req) => {
    const host = req.headers.host || 'localhost';
    let token = '';
    try {
      token = new URL(req.url || '/', `http://${host}`).searchParams.get('token') || '';
    } catch {
      ws.close(4001, 'Bad request');
      return;
    }
    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const users = getCollection('users');
      const user = await users.findOne({
        _id: new ObjectId(payload.userId),
        is_active: { $ne: false },
      });
      if (!user) {
        ws.close(4002, 'User not found');
        return;
      }
      const userId = user._id.toString();
      const userRole = user.role;
      ws.userId = userId;
      ws.userRole = userRole;
      trackClient(userId, ws);
      safeSend(ws, { type: 'connected', userId, role: userRole });
    } catch {
      ws.close(4003, 'Invalid token');
    }
  });
}

// ============================================================
// src/index.js
// ============================================================
import './env.js';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { twilioRoutes } from './twilio.js';
import { callRoutes } from './calls.js';
import { handleMediaStream } from './mediaStream.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/twilio', twilioRoutes);
app.use('/calls', callRoutes);
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });
wss.on('connection', (ws) => handleMediaStream(ws));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        AI Calling Agent — Started ✅                  ║
╠══════════════════════════════════════════════════════╣
║  HTTP  : http://localhost:${PORT}                       ║
║  WS    : ws://localhost:${PORT}/stream                  ║
║  Public: ${(process.env.BASE_URL || '').padEnd(28)} ║
╚══════════════════════════════════════════════════════╝`);
});
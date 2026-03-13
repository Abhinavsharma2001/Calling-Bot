// ============================================================
// src/index.js — Main Server
// Architecture: Twilio Stream → WebSocket → Gemini (STT+LLM)
//               → ElevenLabs TTS → Audio back to Twilio
// Cost: ~₹1/min vs ₹8/min with ElevenLabs native agent
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { twilioRoutes } from './twilio.js';
import { callRoutes } from './calls.js';
import { handleMediaStream } from './mediaStream.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ──────────────────────────────────────────────────
app.use('/twilio', twilioRoutes);
app.use('/calls', callRoutes);

app.get('/', (_, res) => res.json({
  message: 'AI Calling Backend is running!',
  endpoints: {
    health: '/health',
    twilio: '/twilio',
    calls: '/calls'
  },
  docs: 'Check README.md for API documentation'
}));

app.get('/health', (_, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  architecture: 'Twilio + Gemini + ElevenLabs TTS (not agent)',
}));

// ── HTTP + WebSocket Server ──────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] New media stream connection from ${req.socket.remoteAddress}`);
  handleMediaStream(ws);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║          AI Calling Backend — Started ✅              ║
╠══════════════════════════════════════════════════════╣
║  HTTP  : http://localhost:${PORT}                       ║
║  WS    : ws://localhost:${PORT}/stream                  ║
║  Public: ${process.env.BASE_URL || 'Set BASE_URL in .env'}  ║
╠══════════════════════════════════════════════════════╣
║  Stack : Twilio + Gemini Flash + ElevenLabs TTS      ║
║  Cost  : ~₹1/min  (vs ₹8/min native ElevenLabs)     ║
╚══════════════════════════════════════════════════════╝
  `);
});

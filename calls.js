// ============================================================
// src/routes/calls.js — REST API to Initiate Outbound Calls
//
// POST /calls/outbound   — start a new outbound call
// GET  /calls/active     — list active call sessions
// POST /calls/:sid/end   — hang up a call
// ============================================================

import { Router } from 'express';
import twilio from 'twilio';
import { activeSessions } from '../services/mediaStream.js';

const router = Router();
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Initiate Outbound Call ───────────────────────────────────
router.post('/outbound', async (req, res) => {
  const { to, context } = req.body;

  if (!to) {
    return res.status(400).json({ error: '`to` phone number is required' });
  }

  try {
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/twilio/outbound`,       // TwiML to run on connect
      statusCallback: `${process.env.BASE_URL}/twilio/status`,
      statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable',                           // AMD — detect voicemail
      machineDetectionTimeout: 5,
    });

    console.log(`[Calls] Outbound initiated | SID: ${call.sid} | To: ${to}`);

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      to: call.to,
    });

  } catch (err) {
    console.error('[Calls] Outbound error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List Active Sessions ─────────────────────────────────────
router.get('/active', (req, res) => {
  const sessions = [];
  for (const [callSid, session] of activeSessions) {
    sessions.push({
      callSid,
      direction: session.direction,
      phone: session.phone,
      startedAt: session.startedAt,
      turnCount: session.history.length,
    });
  }
  res.json({ count: sessions.length, sessions });
});

// ── End a Call ───────────────────────────────────────────────
router.post('/:sid/end', async (req, res) => {
  try {
    await twilioClient.calls(req.params.sid).update({ status: 'completed' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as callRoutes };

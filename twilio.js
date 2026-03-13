// ============================================================
// src/routes/twilio.js — Twilio Webhook Handlers
//
// Twilio calls these URLs when:
//  POST /twilio/incoming  — someone calls your Twilio number
//  POST /twilio/outbound  — your app initiates an outbound call
//  POST /twilio/status    — call status updates (completed, etc.)
// ============================================================

import { Router } from 'express';
import twilio from 'twilio';
import { freshsalesService } from './freshsales.js';

const { twiml: { VoiceResponse } } = twilio;
const router = Router();

// ── Incoming Call Handler ────────────────────────────────────
router.post('/incoming', async (req, res) => {
  const { From: callerPhone, To: twilioNumber, CallSid } = req.body;
  console.log(`[Twilio] Incoming call | SID: ${CallSid} | From: ${callerPhone}`);

  // Log contact to Freshsales
  freshsalesService.upsertContact({
    phone: callerPhone,
    source: 'inbound_call',
    callSid: CallSid,
  }).catch(console.error);

  const response = new VoiceResponse();
  const connect = response.connect();

  // 🔑 KEY TRICK: Use <Stream> to pipe audio to OUR WebSocket
  // This lets us handle AI logic cheaply instead of using ElevenLabs Agent
  const stream = connect.stream({
    url: `wss://${new URL(process.env.BASE_URL).host}/stream`,
  });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'direction', value: 'inbound' });

  res.type('text/xml').send(response.toString());
});

// ── Outbound Call TwiML ──────────────────────────────────────
// Called by Twilio when YOUR outbound call connects
router.post('/outbound', async (req, res) => {
  const { CallSid, To: calledPhone } = req.body;
  console.log(`[Twilio] Outbound connected | SID: ${CallSid} | To: ${calledPhone}`);

  const response = new VoiceResponse();
  const connect = response.connect();

  const stream = connect.stream({
    url: `wss://${new URL(process.env.BASE_URL).host}/stream`,
  });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'calledPhone', value: calledPhone });
  stream.parameter({ name: 'direction', value: 'outbound' });

  res.type('text/xml').send(response.toString());
});

// ── Status Callback ──────────────────────────────────────────
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, To, From } = req.body;
  console.log(`[Twilio] Status: ${CallStatus} | SID: ${CallSid} | Duration: ${CallDuration}s`);

  if (CallStatus === 'completed' || CallStatus === 'failed') {
    // Update CRM with call outcome
    freshsalesService.logCallActivity({
      callSid: CallSid,
      status: CallStatus,
      duration: parseInt(CallDuration) || 0,
      phone: To || From,
    }).catch(console.error);
  }

  res.sendStatus(200);
});

export { router as twilioRoutes };

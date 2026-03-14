// ============================================================
// src/routes/twilio.js
// ============================================================
import { Router } from 'express';
import twilio from 'twilio';

const { twiml: { VoiceResponse } } = twilio;
const router = Router();

function getWsHost() {
  return new URL(process.env.BASE_URL).host;
}

// ── Incoming Call ────────────────────────────────────────────
router.post('/incoming', (req, res) => {
  const { From: callerPhone, CallSid } = req.body;
  console.log(`[Twilio] Incoming | SID: ${CallSid} | From: ${callerPhone}`);

  const r = new VoiceResponse();
  const connect = r.connect();
  const stream = connect.stream({ url: `wss://${getWsHost()}/stream` });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'direction', value: 'inbound' });

  // Keep call alive for up to MAX_CALL_DURATION_S seconds
  r.pause({ length: parseInt(process.env.MAX_CALL_DURATION_S) || 300 });

  console.log('[Twilio] TwiML:', r.toString());
  res.type('text/xml').send(r.toString());
});

// ── Outbound Call ────────────────────────────────────────────
router.post('/outbound', (req, res) => {
  const { CallSid, To: calledPhone } = req.body;
  console.log(`[Twilio] Outbound connected | SID: ${CallSid} | To: ${calledPhone}`);

  const r = new VoiceResponse();
  const connect = r.connect();
  const stream = connect.stream({ url: `wss://${getWsHost()}/stream` });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'calledPhone', value: calledPhone });
  stream.parameter({ name: 'direction', value: 'outbound' });

  r.pause({ length: parseInt(process.env.MAX_CALL_DURATION_S) || 300 });

  console.log('[Twilio] TwiML:', r.toString());
  res.type('text/xml').send(r.toString());
});

// ── Status Callback ──────────────────────────────────────────
router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Twilio] Status: ${CallStatus} | SID: ${CallSid} | Duration: ${CallDuration}s`);
  res.sendStatus(200);
});

export { router as twilioRoutes };
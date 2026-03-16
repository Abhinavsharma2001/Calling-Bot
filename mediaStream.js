// ============================================================
// src/services/mediaStream.js — AI Calling Agent
//
// NEW ARCHITECTURE (with Deepgram):
//
//  OLD: chunks → buffer → silence timer → Gemini STT → LLM → TTS
//       latency: ~3-4 seconds
//
//  NEW: chunks → Deepgram stream → speech_final → LLM → TTS
//       latency: ~1 second
//
// Deepgram handles VAD + STT in real-time.
// We removed: silence timer, audio buffering, wrapMulawAsWav, Gemini STT
// ============================================================

import { geminiService } from './gemini.js';
import { elevenLabsService } from './elevenlabs.js';
import { createDeepgramSession } from './deepgram.js';

export const activeSessions = new Map();

function newSession(callSid, params) {
  return {
    callSid,
    streamSid: null,
    ws: null,
    phone: params.callerPhone || params.calledPhone || 'unknown',
    direction: params.direction || 'inbound',
    history: [],
    isSpeaking: false,   // true while ElevenLabs audio is playing
    isProcessing: false,   // true while LLM/TTS is running
    dgSession: null,    // Deepgram streaming connection
  };
}

export function handleMediaStream(ws) {
  let S = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      // ── Call connected ──────────────────────────────────────
      case 'start': {
        const p = msg.start.customParameters || {};
        S = newSession(msg.start.callSid, p);
        S.streamSid = msg.start.streamSid;
        S.ws = ws;
        activeSessions.set(S.callSid, S);

        console.log(`\n[Agent] ▶ Call started | ${S.direction} | ${S.phone}`);

        // Open Deepgram stream — fires onTranscript when user finishes speaking
        S.dgSession = createDeepgramSession((transcript) => {
          onUserSpeech(S, transcript);
        });

        // Greet after 800ms so Twilio stream is ready
        setTimeout(() => greet(S), 800);
        break;
      }

      // ── Incoming audio from caller ──────────────────────────
      case 'media': {
        if (!S || !S.dgSession) break;

        // While agent is speaking, don't send echo to Deepgram
        if (S.isSpeaking) break;

        const chunk = Buffer.from(msg.media.payload, 'base64');
        S.dgSession.send(chunk);
        break;
      }

      // ── Twilio mark: our audio finished playing ─────────────
      case 'mark': {
        if (!S) break;
        if (msg.mark?.name?.startsWith('sp_')) {
          console.log(`[Agent] 🎵 Mark: ${msg.mark.name}`);
          setTimeout(() => {
            if (S) {
              S.isSpeaking = false;
              console.log('[Agent] ✅ Done speaking — Deepgram listening...');
            }
          }, 300);
        }
        break;
      }

      // ── Call ended ──────────────────────────────────────────
      case 'stop':
        console.log(`[Agent] ⏹ Call ended | SID: ${S?.callSid}`);
        if (S) teardown(S);
        break;
    }
  });

  ws.on('close', () => { if (S) teardown(S); });
  ws.on('error', e => { console.error('[WS]', e.message); if (S) teardown(S); });
}

// ── Called by Deepgram when user finishes a sentence ────────
function onUserSpeech(S, transcript) {
  // Ignore if agent is speaking or already processing
  if (S.isSpeaking || S.isProcessing) {
    console.log(`[Agent] ⏭ Ignored (busy): "${transcript}"`);
    return;
  }

  S.isProcessing = true;
  console.log(`[Agent] 👤 User: "${transcript}"`);

  processTurn(S, transcript)
    .catch(e => console.error('[Agent] Turn error:', e.message))
    .finally(() => { S.isProcessing = false; });
}

// ── One full conversation turn ───────────────────────────────
async function processTurn(S, transcript) {
  // 1. Add to history
  S.history.push({ role: 'user', parts: [{ text: transcript }] });

  // 2. Gemini LLM
  const reply = await geminiService.reply(S.history);
  S.history.push({ role: 'model', parts: [{ text: reply }] });
  console.log(`[Agent] 🤖 Agent: "${reply}"`);

  // 3. Speak
  await speak(S, reply);

  // 4. Goodbye → hang up after reply finishes
  if (/goodbye|bye|take care|have a great day|talk soon|shubh ho|alvida|shukriya/i.test(reply)) {
    setTimeout(() => hangup(S), 4000);
  }
}

// ── Greeting ─────────────────────────────────────────────────
async function greet(S) {
  const name = process.env.AGENT_NAME || 'Karishma';
  const company = process.env.COMPANY_NAME || 'CareerGuide';

  const text = S.direction === 'outbound'
    ? `Hello, this is the ${company} support team calling from our organization. Am I speaking with the right person? May I know your full name, please?`
    : `Hello, thank you for calling ${company}! This is ${name} from the support team. How may I help you today?`;

  S.history.push({ role: 'model', parts: [{ text }] });
  await speak(S, text);
}

// ── TTS → ffmpeg → μ-law → Twilio ───────────────────────────
async function speak(S, text) {
  try {
    S.isSpeaking = true;

    const mp3 = await elevenLabsService.textToSpeech(text);
    const mulaw = await elevenLabsService.mp3ToMulaw(mp3);

    sendAudio(S, mulaw);
  } catch (e) {
    console.error('[Agent] speak() error:', e.message);
    S.isSpeaking = false;
  }
}

// ── Send μ-law audio to Twilio in 20ms chunks ────────────────
function sendAudio(S, audioBuffer) {
  if (!S.ws || S.ws.readyState !== 1) {
    S.isSpeaking = false;
    return;
  }

  const CHUNK = 320; // 20ms @ 8kHz
  for (let i = 0; i < audioBuffer.length; i += CHUNK) {
    S.ws.send(JSON.stringify({
      event: 'media',
      streamSid: S.streamSid,
      media: { payload: audioBuffer.slice(i, i + CHUNK).toString('base64') },
    }));
  }

  // Mark — Twilio echoes back when playback is complete
  const markName = `sp_${Date.now()}`;
  S.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: S.streamSid,
    mark: { name: markName },
  }));

  console.log(`[Agent] 📤 Sent ${audioBuffer.length} bytes | mark: ${markName}`);

  // Safety net: if mark never returns, unlock after 15s
  setTimeout(() => {
    if (S?.isSpeaking) {
      console.warn('[Agent] ⚠️ Mark timeout — force unlock');
      S.isSpeaking = false;
    }
  }, 15000);
}

// ── Hang up ───────────────────────────────────────────────────
function hangup(S) {
  if (S.ws?.readyState === 1) {
    S.ws.send(JSON.stringify({ event: 'clear', streamSid: S.streamSid }));
  }
}

// ── Teardown ─────────────────────────────────────────────────
function teardown(S) {
  S.dgSession?.close();
  activeSessions.delete(S.callSid);
  console.log(`[Agent] 🧹 Done | SID: ${S.callSid} | Turns: ${Math.floor(S.history.length / 2)}\n`);
}
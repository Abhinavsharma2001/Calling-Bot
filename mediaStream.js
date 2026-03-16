// ============================================================
// src/services/mediaStream.js — Complete AI Calling Agent
// Works exactly like ElevenLabs native agent
// ============================================================

import { geminiService } from './gemini.js';
import { elevenLabsService } from './elevenlabs.js';

export const activeSessions = new Map();

function newSession(callSid, params) {
  return {
    callSid,
    streamSid: null,
    ws: null,
    phone: params.callerPhone || params.calledPhone || 'unknown',
    direction: params.direction || 'inbound',
    history: [],
    audioChunks: [],
    isSpeaking: false,
    isProcessing: false,
    silenceTimer: null,
    listenTimer: null,   // minimum listen window after agent speaks
    markReceived: false,
  };
}

export function handleMediaStream(ws) {
  let S = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case 'start': {
        const p = msg.start.customParameters || {};
        S = newSession(msg.start.callSid, p);
        S.streamSid = msg.start.streamSid;
        S.ws = ws;
        activeSessions.set(S.callSid, S);
        console.log(`\n[Agent] ▶ Call started | ${S.direction} | ${S.phone}`);
        setTimeout(() => greet(S), 800);
        break;
      }

      case 'media': {
        if (!S) break;

        // Drop audio while agent is speaking (echo prevention)
        if (S.isSpeaking) break;

        // Drop audio while STT/LLM is running
        if (S.isProcessing) break;

        const chunk = Buffer.from(msg.media.payload, 'base64');
        const chunkHasAudio = hasAudio(chunk);
        
        if (chunkHasAudio) {
          S.audioChunks.push(chunk);
          // Only restart the silence timer when there IS speech
          // This way it properly counts down once user stops talking
          armSilenceTimer(S);
        } else if (S.audioChunks.length > 0 && !S.silenceTimer) {
          // User has spoken before but silence timer somehow died — rearm
          armSilenceTimer(S);
        }
        break;
      }

      case 'mark': {
        if (!S) break;
        // Twilio confirmed our audio finished playing
        const markName = msg.mark?.name;
        if (markName && markName.startsWith('sp_')) {
          console.log(`[Agent] 🎵 Mark received: ${markName}`);
          // FIXED: don't rely only on mark to stop speaking
          // Add a buffer window to let Twilio fully finish playing
          setTimeout(() => {
            if (S) {
              S.isSpeaking = false;
              S.markReceived = true;
              S.audioChunks = []; // discard echo
              console.log('[Agent] ✅ Agent done speaking — listening...');
            }
          }, 500); // 500ms grace period after mark
        }
        break;
      }

      case 'stop':
        console.log(`[Agent] ⏹ Call ended | SID: ${S?.callSid}`);
        if (S) teardown(S);
        break;
    }
  });

  ws.on('close', () => { if (S) teardown(S); });
  ws.on('error', e => { console.error('[WS]', e.message); if (S) teardown(S); });
}

// ── Greeting ─────────────────────────────────────────────────
async function greet(S) {
  const name = process.env.AGENT_NAME || 'Karishma';
  const company = process.env.COMPANY_NAME || 'our company';

  const text = S.direction === 'outbound'
    ? `Hello, this is the CareerGuide support team calling from our organization. Am I speaking with the right person? May I know your full name, please?`
    : `Hello, thank you for calling CareerGuide! This is ${name} from the support team. How may I help you today?`;

  S.history.push({ role: 'model', parts: [{ text }] });
  
  S.isSpeaking = true;
  S.markReceived = false;
  clearSilenceTimer(S);
  S.audioChunks = [];

  await elevenLabsService.textToSpeechStream(text, (chunk) => sendAudioChunk(S, chunk));
  sendMark(S);
}

// ── Arm silence timer ─────────────────────────────────────────
function armSilenceTimer(S) {
  if (S.silenceTimer) clearTimeout(S.silenceTimer);
  if (S.isSpeaking || S.isProcessing) return;

  const baseTimeout = parseInt(process.env.SILENCE_TIMEOUT_MS) || 800;
  // Dynamic timer: if user spoke for less than ~1.0 sec (50 chunks), trigger processing faster
  const timeoutMs = S.audioChunks.length < 50 ? 400 : baseTimeout;
  const MAX_CHUNKS = 600; // ~12 seconds of audio max (600 * 20ms)

  // Force process if we've collected too much (e.g., continuous background noise)
  if (S.audioChunks.length >= MAX_CHUNKS) {
    console.log(`[Agent] ⚠️ Max listening duration reached, forcing process...`);
    processAudioBuffer(S);
    return;
  }

  S.silenceTimer = setTimeout(() => {
    if (S.isSpeaking || S.isProcessing) return;
    
    console.log(`[Agent] ⏱️ Silence timer fired! Chunks in buffer: ${S.audioChunks.length}`);

    if (S.audioChunks.length < 8) {
      console.log(`[Agent] 🗑️ Buffer too small (< 8 chunks), discarding.`);
      S.audioChunks = [];
      return;
    }

    processAudioBuffer(S);
  }, timeoutMs);
}

async function processAudioBuffer(S) {
  const audio = Buffer.concat(S.audioChunks);
  S.audioChunks = [];
  S.isProcessing = true;

  console.log(`[Agent] 🎤 Processing ${audio.length} bytes of audio...`);

  try {
    await processTurn(S, audio);
  } catch (e) {
    console.error('[Agent] Turn error:', e.message);
  } finally {
    S.isProcessing = false;
  }
}

// ── One conversation turn ─────────────────────────────────────
async function processTurn(S, audioBuffer) {
  // 1. STT — wrap μ-law in WAV for Gemini
  const wav = wrapMulawAsWav(audioBuffer);
  const transcript = await geminiService.transcribe(wav);

  if (!transcript || transcript.trim().length < 2) {
    console.log('[Agent] 🔇 No speech detected, back to listening');
    return;
  }

  console.log(`[Agent] 👤 User: "${transcript}"`);

  // 2. Add to history
  S.history.push({ role: 'user', parts: [{ text: transcript }] });

  // 3. Immediately lock state to prevent echo pickup
  S.isSpeaking = true;
  S.markReceived = false;
  clearSilenceTimer(S);
  S.audioChunks = [];

  // 4. Stream LLM output sentences directly to TTS API, and TTS bytes directly to Twilio WebSocket
  const reply = await geminiService.replyStream(S.history, async (sentence) => {
    await elevenLabsService.textToSpeechStream(sentence, (audioChunk) => {
      sendAudioChunk(S, audioChunk);
    });
  });

  S.history.push({ role: 'model', parts: [{ text: reply }] });
  console.log(`[Agent] 🤖 Agent: "${reply}"`);

  // 5. Signal TTS chunking is fully complete
  sendMark(S);

  // 6. Goodbye detection
  if (/goodbye|bye|take care|have a great day|talk soon|shubh ho|alvida|shukriya/i.test(reply)) {
    setTimeout(() => hangup(S), 4000);
  }
}

// ── Send stream audio chunks natively ─────────────────────────────
function sendAudioChunk(S, audioBuffer) {
  if (!S.ws || S.ws.readyState !== 1) return;

  const CHUNK = 320; // 20ms @ 8kHz μ-law
  for (let i = 0; i < audioBuffer.length; i += CHUNK) {
    S.ws.send(JSON.stringify({
      event: 'media',
      streamSid: S.streamSid,
      media: { payload: audioBuffer.slice(i, i + CHUNK).toString('base64') },
    }));
  }
}

// ── Send mark ─────────────────────────────────────────────────────
function sendMark(S) {
  if (!S.ws || S.ws.readyState !== 1) return;

  const markName = `sp_${Date.now()}`;
  S.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: S.streamSid,
    mark: { name: markName },
  }));

  console.log(`[Agent] 🚩 Sent mark: ${markName}`);

  // SAFETY NET: if mark never comes back within 15s, force unlock
  setTimeout(() => {
    if (S && S.isSpeaking) {
      console.warn('[Agent] ⚠️ Mark timeout — forcing isSpeaking=false');
      S.isSpeaking = false;
      S.audioChunks = [];
    }
  }, 15000);
}

// ── Hang up ───────────────────────────────────────────────────
function hangup(S) {
  if (S.ws?.readyState === 1) {
    S.ws.send(JSON.stringify({ event: 'clear', streamSid: S.streamSid }));
  }
}

// ── Cleanup ───────────────────────────────────────────────────
function clearSilenceTimer(S) {
  if (S.silenceTimer) { clearTimeout(S.silenceTimer); S.silenceTimer = null; }
}

function teardown(S) {
  clearSilenceTimer(S);
  if (S.listenTimer) clearTimeout(S.listenTimer);
  activeSessions.delete(S.callSid);
  console.log(`[Agent] 🧹 Done | SID: ${S.callSid} | Turns: ${Math.floor(S.history.length / 2)}\n`);
}

// ── Voice Activity Detection - Energy/RMS based ──────────────
// μ-law decode then measure RMS energy. Background phone line noise is 
// typically 50-200 RMS, real speech is 800+. Threshold set at 400.
function mulawToLinear(u) {
  u = ~u & 0xFF;
  const sign = (u & 0x80) ? -1 : 1;
  const exp  = (u >> 4) & 0x07;
  const mant = u & 0x0F;
  return sign * (((mant << 1) | 33)) << (exp + 1);
}

const ENERGY_THRESHOLD = 150; // tune: lower = more sensitive, higher = stricter

function hasAudio(chunk) {
  let sum = 0;
  for (const b of chunk) {
    const s = mulawToLinear(b);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / chunk.length);
  return rms > ENERGY_THRESHOLD;
}

// ── Wrap μ-law bytes in WAV container for Gemini ─────────────
function wrapMulawAsWav(raw) {
  const sr = 8000, ch = 1, bps = 8;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0, 'ascii'); hdr.writeUInt32LE(36 + raw.length, 4);
  hdr.write('WAVE', 8, 'ascii'); hdr.write('fmt ', 12, 'ascii');
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(7, 20); // 7 = μ-law
  hdr.writeUInt16LE(ch, 22); hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * ch * bps / 8, 28);
  hdr.writeUInt16LE(ch * bps / 8, 32); hdr.writeUInt16LE(bps, 34);
  hdr.write('data', 36, 'ascii'); hdr.writeUInt32LE(raw.length, 40);
  return Buffer.concat([hdr, raw]);
}
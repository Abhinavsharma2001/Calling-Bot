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
        // FIXED: very loose threshold — accept almost everything
        // Indian phone lines have lots of compression artifacts
        if (hasAudio(chunk)) {
          S.audioChunks.push(chunk);
        }

        armSilenceTimer(S);
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
  const name = process.env.AGENT_NAME || 'Aria';
  const company = process.env.COMPANY_NAME || 'our company';

  const text = S.direction === 'outbound'
    ? `Hello, this is the CareerGuide support team calling from our organization. Am I speaking with the right person? May I know your full name, please?`
    : `Hello, thank you for calling CareerGuide! This is ${name} from the support team. How may I help you today?`;

  S.history.push({ role: 'model', parts: [{ text }] });
  await speak(S, text);
}

// ── Arm silence timer ─────────────────────────────────────────
function armSilenceTimer(S) {
  if (S.silenceTimer) clearTimeout(S.silenceTimer);
  if (S.isSpeaking || S.isProcessing) return;

  // FIXED: 1800ms silence = user finished speaking
  const SILENCE_MS = parseInt(process.env.SILENCE_TIMEOUT_MS) || 1800;

  S.silenceTimer = setTimeout(async () => {
    if (S.isSpeaking || S.isProcessing) return;

    // Need at least 8 chunks (~160ms) of audio to bother transcribing
    if (S.audioChunks.length < 8) {
      S.audioChunks = [];
      return;
    }

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
  }, SILENCE_MS);
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

  // 3. LLM reply
  const reply = await geminiService.reply(S.history);
  S.history.push({ role: 'model', parts: [{ text: reply }] });
  console.log(`[Agent] 🤖 Agent: "${reply}"`);

  // 4. Speak reply
  await speak(S, reply);

  // 5. Goodbye detection
  if (/goodbye|bye|take care|have a great day|talk soon|shubh ho|alvida|shukriya/i.test(reply)) {
    setTimeout(() => hangup(S), 4000);
  }
}

// ── TTS → μ-law → Twilio ─────────────────────────────────────
async function speak(S, text) {
  try {
    S.isSpeaking = true;
    S.markReceived = false;
    clearSilenceTimer(S);
    S.audioChunks = []; // clear any pre-buffered audio

    const mp3 = await elevenLabsService.textToSpeech(text);
    const mulaw = await elevenLabsService.mp3ToMulaw(mp3);

    sendAudio(S, mulaw);

  } catch (e) {
    console.error('[Agent] speak() error:', e.message);
    S.isSpeaking = false; // recover — don't stay stuck
  }
}

// ── Send audio + mark to Twilio ───────────────────────────────
function sendAudio(S, audioBuffer) {
  if (!S.ws || S.ws.readyState !== 1) {
    S.isSpeaking = false;
    return;
  }

  const CHUNK = 320; // 20ms @ 8kHz μ-law
  for (let i = 0; i < audioBuffer.length; i += CHUNK) {
    S.ws.send(JSON.stringify({
      event: 'media',
      streamSid: S.streamSid,
      media: { payload: audioBuffer.slice(i, i + CHUNK).toString('base64') },
    }));
  }

  // Send mark — Twilio echoes it back when audio is done playing
  const markName = `sp_${Date.now()}`;
  S.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: S.streamSid,
    mark: { name: markName },
  }));

  console.log(`[Agent] 📤 Sent ${audioBuffer.length} bytes | mark: ${markName}`);

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

// ── Voice detection — FIXED: very loose for phone audio ──────
// μ-law 0xFF = silence. But phone lines compress differently.
// Use a very low threshold so we don't miss real speech.
function hasAudio(chunk) {
  let voice = 0;
  for (const b of chunk) {
    if (b !== 0xFF && b !== 0x7F && b !== 0x00) voice++;
  }
  return voice / chunk.length > 0.02; // just 2% — accept almost everything
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
// ============================================================
// src/services/mediaStream.js — Core Call Orchestrator
// FIXED:
//  1. Greeting delayed 1s so Twilio stream is ready
//  2. μ-law buffer wrapped with WAV header for Gemini STT
//  3. Better error logging throughout
// ============================================================

import { geminiService } from './gemini.js';
import { elevenLabsService } from './elevenlabs.js';
import { freshsalesService } from './freshsales.js';

export const activeSessions = new Map();

// ── Session State Factory ────────────────────────────────────
function createSession(callSid, params) {
  return {
    callSid,
    phone: params.callerPhone || params.calledPhone || 'unknown',
    direction: params.direction || 'inbound',
    startedAt: new Date(),
    history: [],
    audioBuffer: [],
    isProcessing: false,
    streamSid: null,
    silenceTimer: null,
    hasGreeted: false,
    ws: null,
  };
}

// ── Main WebSocket Handler ───────────────────────────────────
export function handleMediaStream(ws) {
  let session = null;

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.event) {

      case 'connected':
        console.log('[Stream] WebSocket connected');
        break;

      case 'start': {
        const { streamSid, callSid, customParameters } = msg.start;
        session = createSession(callSid, customParameters || {});
        session.streamSid = streamSid;
        session.ws = ws;
        activeSessions.set(callSid, session);

        console.log(`[Stream] Started | SID: ${callSid} | ${session.direction} | ${session.phone}`);

        // FIX: wait 1s for Twilio stream to be fully ready before sending audio
        setTimeout(() => sendGreeting(session).catch(console.error), 1000);
        break;
      }

      case 'media': {
        if (!session || session.isProcessing) break;
        const chunk = Buffer.from(msg.media.payload, 'base64');
        session.audioBuffer.push(chunk);
        resetSilenceTimer(session);
        break;
      }

      case 'stop':
        console.log(`[Stream] Stopped | SID: ${session?.callSid}`);
        if (session) cleanup(session);
        break;
    }
  });

  ws.on('close', () => { if (session) cleanup(session); });
  ws.on('error', (err) => {
    console.error('[Stream] WS error:', err.message);
    if (session) cleanup(session);
  });
}

// ── Send Greeting ────────────────────────────────────────────
async function sendGreeting(session) {
  const agentName = process.env.AGENT_NAME || 'Aria';
  const company = process.env.COMPANY_NAME || 'our company';

  const greeting = session.direction === 'outbound'
    ? `Hello! This is ${agentName} calling from ${company}. Is this a good time to speak?`
    : `Thank you for calling ${company}. My name is ${agentName}. How can I help you today?`;

  session.history.push({ role: 'model', parts: [{ text: greeting }] });
  session.hasGreeted = true;

  console.log(`[Stream] Sending greeting: "${greeting}"`);
  await speakToUser(session, greeting);
}

// ── Silence Detection → Trigger STT ─────────────────────────
function resetSilenceTimer(session) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);

  const SILENCE_MS = parseInt(process.env.SILENCE_TIMEOUT_MS) || 2000;

  session.silenceTimer = setTimeout(async () => {
    if (session.audioBuffer.length === 0 || session.isProcessing) return;

    const audioData = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];
    session.isProcessing = true;

    try {
      await processUserSpeech(session, audioData);
    } catch (err) {
      console.error('[Stream] Speech processing error:', err.message);
    } finally {
      session.isProcessing = false;
    }
  }, SILENCE_MS);
}

// ── Process User Speech ──────────────────────────────────────
async function processUserSpeech(session, audioBuffer) {
  console.log(`[Stream] Processing ${audioBuffer.length} bytes of audio`);

  // FIX: wrap raw μ-law in WAV header so Gemini can parse it
  const wavBuffer = mulawToWav(audioBuffer);

  const transcript = await geminiService.transcribeAudio(wavBuffer);
  if (!transcript || transcript.trim().length < 2) {
    console.log('[Stream] Empty/short transcript, skipping');
    return;
  }

  console.log(`[Stream] User: "${transcript}"`);
  session.history.push({ role: 'user', parts: [{ text: transcript }] });

  const aiResponse = await geminiService.chat(session.history, {
    phone: session.phone,
    direction: session.direction,
  });

  console.log(`[Stream] Agent: "${aiResponse}"`);
  session.history.push({ role: 'model', parts: [{ text: aiResponse }] });

  await speakToUser(session, aiResponse);

  if (shouldEndCall(aiResponse)) {
    setTimeout(() => endCall(session), 3000);
  }

  freshsalesService.logConversationTurn({
    phone: session.phone,
    userSaid: transcript,
    agentSaid: aiResponse,
    callSid: session.callSid,
  }).catch(console.error);
}

// ── TTS → Send Audio to Twilio ───────────────────────────────
async function speakToUser(session, text) {
  try {
    const mp3Buffer = await elevenLabsService.textToSpeech(text);
    const mulawBuffer = await elevenLabsService.mp3ToMulaw(mp3Buffer);
    sendAudioToTwilio(session, mulawBuffer);
    console.log(`[Stream] Audio sent: ${mulawBuffer.length} bytes`);
  } catch (err) {
    console.error('[Stream] speakToUser error:', err.message);
  }
}

// ── Send μ-law Audio to Twilio via WebSocket ─────────────────
function sendAudioToTwilio(session, audioBuffer) {
  if (!session.ws || session.ws.readyState !== 1) {
    console.warn('[Stream] WS not open, cannot send audio');
    return;
  }

  const CHUNK_SIZE = 320; // 20ms @ 8kHz
  for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
    const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
    session.ws.send(JSON.stringify({
      event: 'media',
      streamSid: session.streamSid,
      media: { payload: chunk.toString('base64') },
    }));
  }

  session.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: session.streamSid,
    mark: { name: 'end_of_speech' },
  }));
}

// ── FIX: Wrap raw μ-law PCM in WAV header for Gemini ─────────
// Gemini needs a proper audio container, not raw PCM bytes
function mulawToWav(mulawBuffer) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 8;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = mulawBuffer.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');

  // fmt chunk — audio format 7 = μ-law
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);          // Chunk size
  wav.writeUInt16LE(7, 20);           // Audio format: 7 = μ-law
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  mulawBuffer.copy(wav, 44);

  return wav;
}

// ── Call End Detection ───────────────────────────────────────
function shouldEndCall(text) {
  const endPhrases = ['goodbye', 'bye', 'take care', 'have a great day', 'talk to you soon'];
  return endPhrases.some(p => text.toLowerCase().includes(p));
}

function endCall(session) {
  if (session.ws && session.ws.readyState === 1) {
    session.ws.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
  }
}

// ── Cleanup ──────────────────────────────────────────────────
function cleanup(session) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  activeSessions.delete(session.callSid);
  console.log(`[Stream] Cleaned up | SID: ${session.callSid} | Turns: ${Math.floor(session.history.length / 2)}`);
}
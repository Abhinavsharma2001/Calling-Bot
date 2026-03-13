// ============================================================
// src/services/mediaStream.js — Core Call Orchestrator
//
// FLOW:
//  Twilio sends μ-law audio chunks via WebSocket (Twilio Media Stream)
//  → We buffer + detect silence (VAD)
//  → Convert μ-law to PCM → send to Gemini for STT
//  → Gemini LLM generates response text
//  → ElevenLabs converts text to MP3 (TTS only, NOT agent)
//  → MP3 converted to μ-law → sent back to Twilio
//
// COST TRICK:
//  ElevenLabs Agent = processes your entire call = ~₹8/min
//  Our approach = ElevenLabs only for TTS synthesis = ~₹1/min
// ============================================================

import { geminiService } from './gemini.js';
import { elevenLabsService } from './elevenlabs.js';
import { freshsalesService } from './freshsales.js';

// Active call sessions: Map<callSid, SessionState>
export const activeSessions = new Map();

// ── Session State Factory ────────────────────────────────────
function createSession(callSid, params) {
  return {
    callSid,
    phone: params.callerPhone || params.calledPhone || 'unknown',
    direction: params.direction || 'inbound',
    startedAt: new Date(),
    history: [],              // Conversation history for Gemini
    audioBuffer: [],          // Buffered μ-law audio chunks
    isProcessing: false,      // Prevent overlapping LLM calls
    streamSid: null,          // Twilio stream SID (for sending audio back)
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

        console.log(`[Stream] Call started | SID: ${callSid} | ${session.direction} | Phone: ${session.phone}`);

        // Greet the caller using ElevenLabs TTS
        await sendGreeting(session);
        break;
      }

      case 'media': {
        if (!session || session.isProcessing) break;

        // Twilio sends base64-encoded μ-law (mulaw) audio
        const chunk = Buffer.from(msg.media.payload, 'base64');
        session.audioBuffer.push(chunk);

        // VAD: reset silence timer on each audio chunk
        resetSilenceTimer(session);
        break;
      }

      case 'stop':
        console.log(`[Stream] Call ended | SID: ${session?.callSid}`);
        if (session) cleanup(session);
        break;
    }
  });

  ws.on('close', () => {
    if (session) cleanup(session);
  });

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

  await speakToUser(session, greeting);
}

// ── Silence Detection → Process Speech ──────────────────────
function resetSilenceTimer(session) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);

  const SILENCE_MS = parseInt(process.env.SILENCE_TIMEOUT_MS) || 2000;

  session.silenceTimer = setTimeout(async () => {
    if (session.audioBuffer.length === 0 || session.isProcessing) return;

    // Grab buffered audio and clear
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

  // 1. Transcribe with Gemini (STT)
  const transcript = await geminiService.transcribeAudio(audioBuffer);
  if (!transcript || transcript.trim().length < 2) {
    console.log('[Stream] Empty transcript, skipping');
    return;
  }

  console.log(`[Stream] User said: "${transcript}"`);

  // 2. Add to conversation history
  session.history.push({ role: 'user', parts: [{ text: transcript }] });

  // 3. Generate AI response with Gemini (LLM)
  const aiResponse = await geminiService.chat(session.history, {
    phone: session.phone,
    direction: session.direction,
  });

  console.log(`[Stream] AI response: "${aiResponse}"`);

  // 4. Add AI response to history
  session.history.push({ role: 'model', parts: [{ text: aiResponse }] });

  // 5. Convert to speech via ElevenLabs TTS & send back
  await speakToUser(session, aiResponse);

  // 6. Check for call-end signals
  if (shouldEndCall(aiResponse)) {
    setTimeout(() => endCall(session), 3000);
  }

  // 7. Update CRM with transcript
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
    // Get MP3 from ElevenLabs TTS (cheap — not their agent)
    const mp3Buffer = await elevenLabsService.textToSpeech(text);

    // Convert MP3 → μ-law (8kHz, mono) for Twilio
    const mulawBuffer = await elevenLabsService.mp3ToMulaw(mp3Buffer);

    // Send to Twilio via WebSocket media message
    sendAudioToTwilio(session, mulawBuffer);

    console.log(`[Stream] Sent ${mulawBuffer.length} bytes of audio to caller`);
  } catch (err) {
    console.error('[Stream] TTS error:', err.message);
  }
}

// ── Send Audio Buffer to Twilio ──────────────────────────────
function sendAudioToTwilio(session, audioBuffer) {
  if (!session.ws || session.ws.readyState !== 1) return;

  // Split into 20ms chunks (Twilio requires small chunks)
  const CHUNK_SIZE = 320; // 20ms @ 8kHz μ-law
  for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
    const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);
    session.ws.send(JSON.stringify({
      event: 'media',
      streamSid: session.streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    }));
  }

  // Mark end of audio
  session.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: session.streamSid,
    mark: { name: 'end_of_speech' },
  }));
}

// ── Call End Detection ───────────────────────────────────────
function shouldEndCall(text) {
  const endPhrases = ['goodbye', 'bye', 'take care', 'have a great day', 'talk to you soon', 'end this call'];
  return endPhrases.some(p => text.toLowerCase().includes(p));
}

function endCall(session) {
  if (session.ws && session.ws.readyState === 1) {
    session.ws.send(JSON.stringify({
      event: 'clear',
      streamSid: session.streamSid,
    }));
    // Twilio will detect silence and end the call
  }
}

// ── Cleanup ──────────────────────────────────────────────────
function cleanup(session) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  activeSessions.delete(session.callSid);
  console.log(`[Stream] Session cleaned up | SID: ${session.callSid} | Turns: ${Math.floor(session.history.length / 2)}`);
}

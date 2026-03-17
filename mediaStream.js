// ============================================================
// src/services/mediaStream.js — Full Streaming Pipeline
//
// PIPELINE (each stage starts before previous finishes):
//
//  Deepgram STT (speech_final)
//    ↓ transcript string (~150ms)
//  Gemini streaming tokens
//    ↓ first sentence ready (~300ms)
//  Deepgram Aura TTS streaming
//    ↓ first mulaw chunk (~100ms)
//  Send to Twilio immediately
//
//  Total first audio: ~550ms  (vs ~3s before)
// ============================================================

import { geminiService } from './gemini.js';
import { streamTTS, fallbackTTS } from './tts.js';
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
    isSpeaking: false,
    isProcessing: false,
    dgSession: null,
    markCount: 0,      // how many marks sent
    markAcked: 0,      // how many marks acknowledged
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

        // Open Deepgram STT stream
        S.dgSession = createDeepgramSession((transcript, isFinal) => {
          onUserSpeech(S, transcript, isFinal);
        });

        setTimeout(() => greet(S), 800);
        break;
      }

      case 'media': {
        if (!S?.dgSession) break;
        if (S.isSpeaking) break; // don't send echo to Deepgram
        const chunk = Buffer.from(msg.media.payload, 'base64');
        S.dgSession.send(chunk);
        break;
      }

      case 'mark': {
        if (!S) break;
        const name = msg.mark?.name;
        if (name?.startsWith('sp_')) {
          S.markAcked++;
          // All marks acked = all audio finished playing
          if (S.markAcked >= S.markCount) {
            S.isSpeaking = false;
            console.log('[Agent] ✅ Done speaking — listening...');
          }
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

// ── User speech received from Deepgram ──────────────────────
// ── Global Metrics ──────────────────────────────────────────
let geminiCallsThisMinute = 0;
setInterval(() => { geminiCallsThisMinute = 0; }, 60000);

// ── User speech received from Deepgram ──────────────────────
function onUserSpeech(S, transcript, isFinal = false) {
  // BARGE-IN: If agent is speaking and user interrupts, stop the agent immediately
  if (S.isSpeaking) {
    console.log('[Agent] 🛑 User interrupted — clearing playback');
    if (S.ws?.readyState === 1) {
      S.ws.send(JSON.stringify({ event: 'clear', streamSid: S.streamSid }));
    }
    S.isSpeaking = false;
    S.isProcessing = false;
  }

  // 1. FINAL TRANSCRIPT FILTER: Deepgram sends 'isFinal' for segments.
  // We only trigger LLM on 'speech_final' (user actually stopped talking).
  if (!isFinal) return; 

  const fullTranscript = transcript.trim();
  if (fullTranscript.length < 2) return;

  // 2. MINIMUM INPUT FILTER & SHORT-CIRCUIT
  const clean = fullTranscript.toLowerCase().replace(/[.,?!।]/g, '').trim();
  const words = clean.split(/\s+/);
  
  // Handled greetings/fillers without LLM call
  const shortReplies = {
    'hi': 'Hello! How can I help you today?',
    'hello': 'Hi there! Tanya here from CareerGuide.',
    'yes': 'Great! Please tell me more.',
    'ok': 'Acknowledged.',
    'ji': 'Bilkul! Batayein.',
    'namaste': 'नमस्ते! मैं तान्या हूँ, कैसे मदद कर सकती हूँ?',
    'shukriya': 'आपका धन्यवाद!',
    'thanks': 'You are welcome!'
  };

  if (words.length < 3 && shortReplies[clean]) {
    console.log(`[Agent] ⚡ LLM CALL SKIPPED (Short-circuit): "${fullTranscript}"`);
    speakSentence(S, shortReplies[clean]);
    return;
  }

  // Ignore very short noise/fillers
  const fillers = ['hmm', 'uh', 'um', 'ji', 'haan', 'ha', 'bye'];
  if (words.length < 2 && fillers.includes(clean)) {
    console.log(`[Agent] 🔇 LLM CALL SKIPPED (Noise/Filler): "${fullTranscript}"`);
    return;
  }

  // 3. DEBOUNCE: Wait 1.5s for silence before triggering (Requirement #1)
  if (S._debounceTimer) clearTimeout(S._debounceTimer);
  S._debounceTimer = setTimeout(() => {
    executeGeminiTurn(S, fullTranscript);
  }, 1500); 
}

async function executeGeminiTurn(S, transcript) {
  // 4. SINGLE ACTIVE REQUEST LOCK (Requirement #4)
  if (S.isProcessing) {
    console.log(`[Agent] ⏭ LLM CALL SKIPPED (Request already in progress): "${transcript}"`);
    return;
  }

  // 5. RATE LIMIT TRACKER (Requirement #8)
  if (geminiCallsThisMinute >= 15) {
    console.log(`[Agent] 🛑 LLM CALL SKIPPED (RPM Limit Reached)`);
    speakSentence(S, "One moment please, I am processing your last request.");
    return;
  }

  console.log(`[Agent] 👤 User (Final): "${transcript}"`);
  console.log(`[Agent] 🧠 LLM CALL TRIGGERED | Current RPM: ${geminiCallsThisMinute + 1}`);
  geminiCallsThisMinute++;
  
  S.isProcessing = true;
  S._lastActivity = Date.now();

  processTurn(S, transcript)
    .catch(e => {
        console.error('[Agent] Turn error:', e.message);
        S.isSpeaking = false;
        S.isProcessing = false;
    })
    .finally(() => { 
        S.isProcessing = false; 
    });
}

// ── Full streaming pipeline turn ────────────────────────────
async function processTurn(S, transcript) {
  S.history.push({ role: 'user', parts: [{ text: transcript }] });
  S.isSpeaking = true;
  S.isProcessing = true; // Ensure locked while processing
  S.markCount = 0;
  S.markAcked = 0;

  let fullReply = '';

  // Stream Gemini tokens → as each sentence arrives → stream TTS → send audio
  await geminiService.replyStreaming(
    S.history,

    // Called for each sentence as it streams out of Gemini
    async (sentence) => {
      console.log(`[Agent] 🤖 "${sentence}"`);
      await speakSentence(S, sentence);
    },

    // Called when full reply is done
    (fullText) => {
      fullReply = fullText;
      S.history.push({ role: 'model', parts: [{ text: fullText }] });

      // Check for goodbye
      if (/goodbye|bye|take care|have a great day|shubh ho|alvida/i.test(fullText)) {
        setTimeout(() => hangup(S), 5000);
      }
    }
  );
}

// ── Stream one sentence through TTS → Twilio ────────────────
async function speakSentence(S, text) {
  if (!text?.trim()) return;

  try {
    // Try ElevenLabs first (High quality + streaming)
    // We don't 'await' here because we want Gemini to keep streaming
    // and starting the next sentence TTS immediately.
    // The order is maintained by Twilio/Websocket if handled carefully.
    elevenLabsService.streamTTS(text, (chunk) => {
      sendRawAudio(S, chunk);
    }).catch(e => {
        console.warn('[Agent] ElevenLabs failed fallback to Deepgram:', e.message);
        streamTTS(text, (chunk) => sendRawAudio(S, chunk)).catch(ee => console.error(ee));
    });
  } catch (e) {
    console.warn('[Agent] TTS initiation failed:', e.message);
  }

  // Send mark after each sentence
  sendMark(S);
}

// ── Send raw mulaw audio directly to Twilio ─────────────────
function sendRawAudio(S, chunk) {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.ws.send(JSON.stringify({
    event: 'media',
    streamSid: S.streamSid,
    media: { payload: chunk.toString('base64') },
  }));
}

// ── Send mark to track playback completion ───────────────────
function sendMark(S) {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.markCount++;
  const name = `sp_${Date.now()}`;
  S.ws.send(JSON.stringify({
    event: 'mark',
    streamSid: S.streamSid,
    mark: { name },
  }));
}

// ── Greeting ─────────────────────────────────────────────────
async function greet(S) {
  const name = process.env.AGENT_NAME || 'Karishma';
  const company = process.env.COMPANY_NAME || 'CareerGuide';

  const text = S.direction === 'outbound'
    ? `Hello, this is the ${company} support team calling from our organization. Am I speaking with the right person? May I know your full name, please?`
    : `Hello, thank you for calling ${company}! This is ${name} from the support team. How may I help you today?`;

  S.history.push({ role: 'model', parts: [{ text }] });
  S.isSpeaking = true;
  S.markCount = 0;
  S.markAcked = 0;

  await speakSentence(S, text);
  sendMark(S); // final mark

  // Safety net: unlock after 10s if marks never return
  setTimeout(() => {
    if (S?.isSpeaking) { 
      console.warn('[Agent] ⚠️ Response playback took too long — force unlocking');
      S.isSpeaking = false; 
    }
  }, 10000);
}

// ── Hang up ───────────────────────────────────────────────────
function hangup(S) {
  if (S.ws?.readyState === 1) {
    S.ws.send(JSON.stringify({ event: 'clear', streamSid: S.streamSid }));
  }
}

// ── Teardown ──────────────────────────────────────────────────
function teardown(S) {
  S.dgSession?.close();
  activeSessions.delete(S.callSid);
  console.log(`[Agent] 🧹 Done | Turns: ${Math.floor(S.history.length / 2)}\n`);
}
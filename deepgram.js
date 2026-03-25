// ============================================================
// src/services/deepgram.js
// FIX 1: onTranscript only fires on speech_final — NOT on every
//         interim result. Interim results caused Gemini to be
//         called 10-20x per utterance = confused responses.
// FIX 2: UtteranceEnd deduplication — don't fire if speech_final
//         already handled it.
// ============================================================

import { WebSocket } from 'ws';

const DG_URL = 'wss://api.deepgram.com/v1/listen?' + [
  'model=nova-2',
  'language=hi',
  'encoding=mulaw',
  'sample_rate=8000',
  'channels=1',
  'punctuate=true',
  'smart_format=true',
  'interim_results=true',
  'endpointing=200',
  'utterance_end_ms=1000',
].join('&');

export function createDeepgramSession(onTranscript, onSpeechStart) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY missing in .env');

  let closed = false;
  let lastFinal = '';
  let speechFinalFired = false; // dedup flag
  let socket = null;
  let keepaliveTimer = null;
  let ready = false;
  const queue = [];

  function connect() {
    if (closed) return;

    socket = new WebSocket(DG_URL, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    socket.on('open', () => {
      console.log('[Deepgram] ✅ Connected');
      ready = true;
      for (const chunk of queue) socket.send(chunk);
      queue.length = 0;

      keepaliveTimer = setInterval(() => {
        if (socket?.readyState === 1)
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 8000);
    });

    socket.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      const msgType = data?.type;
      const alt = data?.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim();
      const isFinal = data?.is_final;
      const speechFinal = data?.speech_final;

      if (msgType === 'Results' || !msgType) {
        if (!text) return;

        if (!isFinal) {
          // Interim — just log, and trigger AI interruption
          process.stdout.write(`\r[Deepgram] 💬 "${text}"   `);
          if (onSpeechStart) onSpeechStart();
          return;
        }

        // is_final=true — store it
        lastFinal = text;
        console.log(`\n[Deepgram] ${speechFinal ? '🔚 speech_final' : '📝 is_final'}: "${text}"`);

        if (speechFinal) {
          // Fire once per utterance
          speechFinalFired = true;
          onTranscript(text);
          lastFinal = '';
        }
      }

      if (msgType === 'UtteranceEnd') {
        // Only fire if speech_final did NOT already handle this utterance
        if (!speechFinalFired && lastFinal?.length > 1) {
          console.log(`\n[Deepgram] 🔚 UtteranceEnd fallback: "${lastFinal}"`);
          onTranscript(lastFinal);
          lastFinal = '';
        }
        // Reset dedup flag for next utterance
        speechFinalFired = false;
      }
    });

    socket.on('error', (err) => console.error('[Deepgram] ❌', err.message));

    socket.on('close', (code) => {
      console.log(`[Deepgram] Closed (${code})`);
      ready = false;
      clearInterval(keepaliveTimer);
      if (!closed) {
        console.log('[Deepgram] 🔄 Reconnecting...');
        setTimeout(connect, 1000);
      }
    });
  }

  connect();

  return {
    send(chunk) {
      if (closed) return;
      if (!ready || socket?.readyState !== 1) { queue.push(chunk); return; }
      try { socket.send(chunk); } catch { }
    },
    close() {
      closed = true;
      clearInterval(keepaliveTimer);
      try { socket?.close(); } catch { }
    },
  };
}
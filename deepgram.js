// ============================================================
// src/services/deepgram.js — Raw WebSocket to Deepgram
// FIX: keepalive ping + auto-reconnect on close
// ============================================================

import { WebSocket } from 'ws';

const DG_URL = 'wss://api.deepgram.com/v1/listen?' + [
  'model=nova-2',
  'language=multi',
  'encoding=mulaw',
  'sample_rate=8000',
  'channels=1',
  'punctuate=true',
  'smart_format=true',
  'interim_results=true',
  'utterance_end_ms=1000',
  'vad_events=true',
  'endpointing=300',
].join('&');

export function createDeepgramSession(onTranscript) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY missing in .env');

  let closed = false;
  let lastTranscript = '';
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

      // Flush any queued audio
      for (const chunk of queue) socket.send(chunk);
      queue.length = 0;

      // Send keepalive every 8s to prevent timeout
      keepaliveTimer = setInterval(() => {
        if (socket?.readyState === 1) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);
    });

    socket.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      const msgType = data?.type;

      if (msgType === 'Results' || !msgType) {
        const alt = data?.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        const isFinal = data?.is_final;
        const speechFinal = data?.speech_final;

        if (!text) return;

        if (isFinal) {
          lastTranscript = text;
          console.log(`\n[Deepgram] ${speechFinal ? '🔚 speech_final' : '📝 final'}: "${text}"`);
        } else {
          process.stdout.write(`\r[Deepgram] 💬 "${text}"   `);
        }

        if (speechFinal && text.length > 1) {
          onTranscript(text);
          lastTranscript = '';
        }
      }

      if (msgType === 'UtteranceEnd') {
        if (lastTranscript?.length > 1) {
          console.log(`\n[Deepgram] 🔚 UtteranceEnd: "${lastTranscript}"`);
          onTranscript(lastTranscript);
          lastTranscript = '';
        }
      }
    });

    socket.on('error', (err) => {
      console.error('[Deepgram] ❌ Error:', err.message);
    });

    socket.on('close', (code, reason) => {
      console.log(`[Deepgram] Closed | code: ${code} | reason: ${reason}`);
      ready = false;
      clearInterval(keepaliveTimer);

      // Auto-reconnect unless we deliberately closed
      if (!closed) {
        console.log('[Deepgram] 🔄 Reconnecting in 1s...');
        setTimeout(connect, 1000);
      }
    });
  }

  connect(); // initial connection

  return {
    send(chunk) {
      if (closed) return;
      if (!ready || socket?.readyState !== 1) {
        queue.push(chunk); // buffer until reconnected
        return;
      }
      try { socket.send(chunk); } catch { }
    },
    close() {
      closed = true;
      clearInterval(keepaliveTimer);
      try { socket?.close(); } catch { }
    },
  };
}
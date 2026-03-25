// ============================================================
// src/services/mediaStream.js — Twilio Media Stream Handler
//
// 1. Receives audio from Twilio (WebSocket)
// 2. Streams to Deepgram (STT)
// 3. Streams text to Gemini (LLM)
// 4. Streams Gemini sentences to Deepgram Aura (TTS)
// 5. Streams audio back to Twilio
// ============================================================

import { createDeepgramSession } from './deepgram.js';
import { geminiService } from './gemini.js';
import { elevenLabsService } from './elevenlabs.js';
import { freshsalesService } from './freshsales.js';
import { getTwilioClient } from './calls.js';

// Map to track active call sessions for the /calls/active API
export const activeSessions = new Map();

/**
 * Handle incoming WebSocket connection from Twilio Media Streams
 */
export function handleMediaStream(ws) {
  let callSid = null;
  let streamSid = null;
  let phone = null;
  let direction = null;
  let dgSession = null;
  let responseId = 0; // Track current response to allow interruption
  let isAIResponding = false; // Flag to gate interruptions
  let lastUserTranscript = ''; // Prevent self-interruption from echoes
  let lastResponseStartTime = 0; // Lock-out period
  let crmContact = null; // Freshsales contact reference
  let callStartTime = Date.now(); // For calculating duration
  let isClosing = false; // Prevent double cleanup
  
  // Call history for the LLM
  const history = [
    { role: 'model', parts: [{ text: "Hello, this is the career-guide support team calling from our organization. Am I speaking with the right person? May I know your full name, please?" }] }
  ];

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.event) {
        case 'start':
          callSid = msg.start.callSid;
          streamSid = msg.start.streamSid;
          const params = msg.start.customParameters || {};
          phone = params.callerPhone || params.calledPhone || 'Unknown';
          direction = params.direction || 'inbound';

          console.log(`[Media] 📞 Start | SID: ${callSid} | ${direction} | From: ${phone}`);
          callStartTime = Date.now();

          // ── CRM: Upsert contact immediately on call start ────
          freshsalesService.upsertContact({ phone, source: direction, callSid })
            .then(contact => { crmContact = contact; })
            .catch(err => console.error('[Freshsales] Contact upsert failed:', err.message));

          const initialGreeting = history[0].parts[0].text;

          // ── Initialize Deepgram STT Session ────────────────
          dgSession = createDeepgramSession(
            async (transcript) => {
              // 1. Check if this is a repeat of the same transcript (echo)
              const cleanTranscript = transcript.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").trim().toLowerCase();
              if (cleanTranscript === lastUserTranscript && isAIResponding) {
                  return;
              }
              lastUserTranscript = cleanTranscript;

              // 2. New final transcript — stop any current generation and start new one
              isAIResponding = true;
              lastResponseStartTime = Date.now();
              const rid = ++responseId;
              const shouldAbort = () => rid !== responseId;

              console.log(`[Media] 👤 User (final): "${transcript}"`);
              
              // 3. STOP any current audio immediately
              if (ws.readyState === 1 && streamSid) {
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
              }

              // 4. Update history
              history.push({ role: 'user', parts: [{ text: transcript }] });

              const userStopSpeakingTime = Date.now();
              let firstChunkSent = false;
              let playbackPromise = Promise.resolve();

              try {
                // 4. Start Gemini Streaming LLM
                await geminiService.replyStreaming(
                  history,
                  async (sentence) => {
                    if (shouldAbort()) return;

                    // ── Voice-Gate: Stop the pipeline for NULL (noise) ────
                    if (sentence.includes('NULL')) {
                       console.log("Internal: Background noise detected. Silent ignore.");
                       return;
                    }

                    const bufferedChunks = [];
                    let isMyTurn = false;

                    // 5. Pre-fetch TTS for this sentence immediately
                    const ttsPromise = elevenLabsService.streamTTS(sentence, (mulawChunk) => {
                       if (isMyTurn) {
                          // If it's our turn, send to Twilio immediately (live streaming)
                          if (ws.readyState === 1 && !shouldAbort()) {
                             ws.send(JSON.stringify({
                               event: 'media',
                               streamSid,
                               media: { payload: Buffer.from(mulawChunk).toString('base64') }
                             }));
                          }
                       } else {
                          // Otherwise, buffer it for when it is our turn
                          bufferedChunks.push(mulawChunk);
                       }

                       if (!firstChunkSent && !shouldAbort()) {
                          firstChunkSent = true;
                          console.log(`[Latency] ⏱️ TOTAL LATENCY: ${Date.now() - userStopSpeakingTime}ms`);
                       }
                    }, shouldAbort);

                    // 6. Add to sequential playback queue
                    const currentPlayback = playbackPromise;
                    playbackPromise = (async () => {
                       await currentPlayback; // Wait for previous sentence to finish
                       if (shouldAbort()) return;
                       
                       // It's our turn!
                       isMyTurn = true;
                       
                       // Flush any chunks we buffered while waiting
                       console.log(`[Media] 🔊 Playing sentence: "${sentence.slice(0, 30)}..." (${bufferedChunks.length} chunks buffered)`);
                       for (const chunk of bufferedChunks) {
                          if (shouldAbort()) return;
                          if (ws.readyState === 1) {
                             ws.send(JSON.stringify({
                               event: 'media',
                               streamSid,
                               media: { payload: Buffer.from(chunk).toString('base64') }
                             }));
                          }
                       }
                       bufferedChunks.length = 0; // Clear buffer

                       // Wait for the rest of the synthesis to finish (live chunks will be sent by the callback)
                       await ttsPromise;
                    })();
                  },
                  (fullText) => {
                    if (shouldAbort() || fullText === 'NULL') return;
                    // LLM finished — store response in history
                    history.push({ role: 'model', parts: [{ text: fullText }] });

                    // ── Automatic Hangup Check ────
                    if (fullText.includes('Goodbye')) {
                       playbackPromise.then(async () => {
                          if (shouldAbort()) return;
                          console.log(`[Media] 👋 Goodbye detected. Ending call (SID: ${callSid})...`);
                          try {
                             const twilioClient = getTwilioClient();
                             await twilioClient.calls(callSid).update({ status: 'completed' });
                          } catch (err) {
                             console.error('[Media] Failed to hang up call:', err.message);
                             ws.close(); // Fallback
                          }
                       });
                    }
                  },
                  shouldAbort
                );
                
                // Wait for all queued audio to finish playing
                await playbackPromise;
              } finally {
                // Only reset flag if this was the latest response
                if (!shouldAbort()) {
                  isAIResponding = false;
                }
              }
            },
            (interimTranscript) => {
              if (!interimTranscript) return;

              // onSpeechStart — User started speaking (interim result)
              // 1. Normalize and ignore if it's the same as the last triggered transcript
              const cleanInterim = interimTranscript.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").trim().toLowerCase();
              if (cleanInterim === lastUserTranscript) {
                  return;
              }

              // 2. Ignore if we just started a response (750ms lock-out)
              if (Date.now() - lastResponseStartTime < 750) {
                  return;
              }

              // 3. ONLY interrupt if the AI is currently "responding"
              if (isAIResponding) {
                console.log(`[Media] 💡 Interruption! User said: "${interimTranscript}"`);
                responseId++; // Signal current generation/playback to stop
                isAIResponding = false;
                
                // Tell Twilio to stop playing current audio
                ws.send(JSON.stringify({
                  event: 'clear',
                  streamSid
                }));
              }
            }
          );

          // ── Proactive Greeting ────────────────
          // Stream the initial greeting immediately upon connection
          isAIResponding = true;
          lastResponseStartTime = Date.now();
          const rid = ++responseId;
          const shouldAbort = () => rid !== responseId;

          console.log(`[Media] 🤖 Proactive Greeting: "${initialGreeting}"`);
          elevenLabsService.streamTTS(initialGreeting, (mulawChunk) => {
            if (ws.readyState === 1 && !shouldAbort()) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: {
                  payload: Buffer.from(mulawChunk).toString('base64')
                }
              }));
            }
          }, shouldAbort).finally(() => {
             if (!shouldAbort()) isAIResponding = false;
          });

          // Register in active sessions
          activeSessions.set(callSid, {
            direction,
            phone,
            startedAt: new Date(),
            history,
            streamSid
          });
          break;

        case 'media':
          // Pipe raw audio (mulaw) to Deepgram STT
          if (dgSession) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            dgSession.send(audioData);
          }
          break;

        case 'stop':
          console.log(`[Media] 🛑 Stop | SID: ${callSid}`);
          cleanup();
          break;
      }
    } catch (err) {
      console.error('[Media] WebSocket error:', err.message);
    }
  });

  ws.on('error', (err) => console.error('[Media] WS Socket Error:', err.message));

  ws.on('close', () => {
    console.log(`[Media] 🔌 Closed | SID: ${callSid}`);
    cleanup();
  });

  function cleanup() {
    if (isClosing) return;
    isClosing = true;

    if (dgSession) {
      dgSession.close();
      dgSession = null;
    }
    if (callSid) {
      activeSessions.delete(callSid);

      // ── CRM: Log call activity on hang-up ──────────────
      const durationSec = Math.round((Date.now() - callStartTime) / 1000);
      freshsalesService.logCallActivity({
        callSid,
        status: 'completed',
        duration: durationSec,
        phone,
        contactId: crmContact?.id, 
      }).catch(() => {}); // non-blocking

      // ── CRM: Post full conversation summary note ────────
      freshsalesService.logCallSummary({
        callSid,
        phone,
        history,
        contactId: crmContact?.id,
        status: 'completed',
        duration: durationSec,
      }).catch(() => {}); // non-blocking
    }
  }
}

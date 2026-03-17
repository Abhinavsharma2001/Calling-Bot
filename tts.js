// ============================================================
// src/services/tts.js — Deepgram Aura Streaming TTS
//
// WHY Deepgram Aura instead of ElevenLabs for streaming?
//  ElevenLabs: full text → full MP3 → convert → send  (~800ms)
//  Deepgram Aura: text → streaming mulaw chunks → send  (~100ms)
//
// Deepgram Aura outputs mulaw 8000hz directly — no ffmpeg needed!
// ============================================================

import https from 'https';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const AURA_VOICE = process.env.DEEPGRAM_VOICE || 'aura-2-thalia-en'; // female English voice

// ── Stream TTS audio chunks via callback ─────────────────────
// onChunk(mulawBuffer) called as audio arrives
// Returns promise that resolves when all audio is sent
export function streamTTS(text, onChunk) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.DEEPGRAM_API_KEY;

        const body = JSON.stringify({ text });

        const options = {
            hostname: 'api.deepgram.com',
            path: `/v1/speak?model=${AURA_VOICE}&encoding=mulaw&sample_rate=8000&container=none`,
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', d => errBody += d);
                res.on('end', () => reject(new Error(`Deepgram TTS ${res.statusCode}: ${errBody}`)));
                return;
            }

            console.log(`[Aura TTS] Streaming "${text.slice(0, 60)}..."`);

            res.on('data', (chunk) => {
                // Deepgram streams raw mulaw chunks — send directly to Twilio
                onChunk(chunk);
            });

            res.on('end', () => {
                console.log('[Aura TTS] Stream complete');
                resolve();
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Fallback: ElevenLabs TTS (non-streaming) ─────────────────
// Used only if Deepgram Aura fails
import { elevenLabsService } from './elevenlabs.js';

export async function fallbackTTS(text, onChunk) {
    const mp3 = await elevenLabsService.textToSpeech(text);
    const mulaw = await elevenLabsService.mp3ToMulaw(mp3);
    // Send in 320-byte chunks (20ms each)
    const CHUNK = 320;
    for (let i = 0; i < mulaw.length; i += CHUNK) {
        onChunk(mulaw.slice(i, i + CHUNK));
    }
}
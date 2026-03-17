// ============================================================
// src/services/elevenlabs.js — ElevenLabs TTS only (not agent)
// FIXED: mp3ToMulaw is fully async/await using promises
// ============================================================
import axios from 'axios';
import https from 'https';
import { exec } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

class ElevenLabsService {

  // ── Stream TTS using ElevenLabs (Direct mulaw + Streaming) ──
  // No ffmpeg needed! Speed is comparable to Deepgram Aura.
  async streamTTS(text, onChunk) {
    return new Promise((resolve, reject) => {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

      const options = {
        method: 'POST',
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`,
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'accept': 'audio/wav', // ElevenLabs uses this for nested containers even for raw
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', d => errBody += d);
          res.on('end', () => reject(new Error(`ElevenLabs streaming failed (${res.statusCode}): ${errBody}`)));
          return;
        }

        console.log(`[ElevenLabs] Streaming output...`);
        res.on('data', chunk => onChunk(chunk));
        res.on('end', resolve);
      });

      req.on('error', reject);
      req.write(JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      }));
      req.end();
    });
  }

  // FIXED: fully async — awaits ffmpeg before returning
  async mp3ToMulaw(mp3Buffer) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inp = join(tmpdir(), `el_in_${id}.mp3`);
    const out = join(tmpdir(), `el_out_${id}.raw`);

    try {
      await writeFile(inp, mp3Buffer);

      // Run ffmpeg and wait for it to finish
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i "${inp}" -ar 8000 -ac 1 -codec:a pcm_mulaw -f mulaw "${out}"`;
        console.log(`[ffmpeg] Running: ${cmd}`);
        exec(cmd, (error, stdout, stderr) => {
          if (error) reject(new Error(`ffmpeg failed: ${stderr || error.message}`));
          else resolve();
        });
      });

      const buf = await readFile(out);
      console.log(`[ffmpeg] μ-law output: ${buf.length} bytes`);
      return buf;

    } finally {
      unlink(inp).catch(() => { });
      unlink(out).catch(() => { });
    }
  }
}

export const elevenLabsService = new ElevenLabsService();
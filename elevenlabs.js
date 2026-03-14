// ============================================================
// src/services/elevenlabs.js — ElevenLabs TTS only (not agent)
// FIXED: mp3ToMulaw is fully async/await using promises
// ============================================================
import axios from 'axios';
import { exec } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

class ElevenLabsService {

  async textToSpeech(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    console.log(`[ElevenLabs] Requesting TTS: "${text.slice(0, 80)}"`);

    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
      },
      {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 15000,
      }
    ).catch(err => {
      const msg = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
      throw new Error(`[ElevenLabs] TTS failed (${err.response?.status}): ${msg}`);
    });

    const buf = Buffer.from(res.data);
    console.log(`[ElevenLabs] TTS success: ${buf.length} bytes`);
    return buf;
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
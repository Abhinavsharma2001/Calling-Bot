// ============================================================
// src/services/elevenlabs.js — ElevenLabs TTS (NOT Agent)
// FIXED: output_format as URL param, ffmpeg codec + error logs
// ============================================================

import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    this.baseUrl = 'https://api.elevenlabs.io/v1';

    this.voiceSettings = {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    };
  }

  // ── Text → MP3 ─────────────────────────────────────────────
  // FIX: output_format MUST be a URL query param, not in the body
  async textToSpeech(text) {
    try {
      console.log(`[ElevenLabs] Requesting TTS: "${text.substring(0, 80)}"`);

      const response = await axios.post(
        `${this.baseUrl}/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
        {
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: this.voiceSettings,
        },
        {
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
          timeout: 15000,
        }
      );

      const buf = Buffer.from(response.data);
      console.log(`[ElevenLabs] TTS success: ${buf.length} bytes`);
      return buf;

    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data
        ? Buffer.from(err.response.data).toString()
        : err.message;
      console.error(`[ElevenLabs] TTS error ${status}: ${detail}`);
      throw new Error(`TTS failed: ${detail}`);
    }
  }

  // ── MP3 → μ-law (for Twilio) ───────────────────────────────
  // FIX: use -codec:a pcm_mulaw (not just -f mulaw), show errors
  async mp3ToMulaw(mp3Buffer) {
    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inPath = join(tmpdir(), `tts_in_${tmpId}.mp3`);
    const outPath = join(tmpdir(), `tts_out_${tmpId}.raw`);

    try {
      await writeFile(inPath, mp3Buffer);

      const cmd = `ffmpeg -y -i "${inPath}" -codec:a pcm_mulaw -ar 8000 -ac 1 -f mulaw "${outPath}"`;
      console.log(`[ffmpeg] Running: ${cmd}`);

      await execAsync(cmd).catch(e => {
        throw new Error(`ffmpeg conversion failed: ${e.stderr || e.message}`);
      });

      const mulawBuffer = await readFile(outPath);
      console.log(`[ffmpeg] μ-law output: ${mulawBuffer.length} bytes`);
      return mulawBuffer;

    } finally {
      unlink(inPath).catch(() => { });
      unlink(outPath).catch(() => { });
    }
  }

  // ── List Available Voices ──────────────────────────────────
  async listVoices() {
    const response = await axios.get(`${this.baseUrl}/voices`, {
      headers: { 'xi-api-key': this.apiKey },
    });
    return response.data.voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      preview: v.preview_url,
    }));
  }
}

export const elevenLabsService = new ElevenLabsService();
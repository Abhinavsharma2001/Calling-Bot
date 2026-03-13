// ============================================================
// src/services/elevenlabs.js — ElevenLabs TTS (NOT Agent)
//
// 💡 THE COST TRICK EXPLAINED:
//
//  ❌ ElevenLabs Agent mode:
//     - Their agent handles STT + LLM + TTS + routing
//     - Costs ~$0.10-0.12/min = ~₹8-10/min
//     - You have limited control over the LLM logic
//
//  ✅ Our approach (TTS only):
//     - We ONLY call ElevenLabs /v1/text-to-speech endpoint
//     - Use Gemini for STT + LLM (10x cheaper)
//     - Still get ElevenLabs' beautiful voice quality
//     - Full control over conversation logic
//     - Cost: ~$0.006/1000 chars ≈ ~₹0.50/min = ~₹1/min
//
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

    // TTS settings optimized for phone calls
    this.voiceSettings = {
      stability: 0.5,           // Lower = more expressive
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    };
  }

  // ── Text → MP3 ─────────────────────────────────────────────
  async textToSpeech(text) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/text-to-speech/${this.voiceId}`,
        {
          text,
          model_id: 'eleven_turbo_v2',    // Fastest + cheapest model
          voice_settings: this.voiceSettings,
          output_format: 'mp3_22050_32',  // 22kHz, 32kbps — good for phone
        },
        {
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 10000,
        }
      );

      return Buffer.from(response.data);

    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
      console.error(`[ElevenLabs] TTS error ${status}: ${detail}`);
      throw new Error(`TTS failed: ${detail}`);
    }
  }

  // ── MP3 → μ-law (for Twilio) ───────────────────────────────
  // Twilio Media Streams require: μ-law, 8kHz, mono, 8-bit
  async mp3ToMulaw(mp3Buffer) {
    const tmpId = Date.now();
    const inPath = join(tmpdir(), `in_${tmpId}.mp3`);
    const outPath = join(tmpdir(), `out_${tmpId}.ul`);

    try {
      await writeFile(inPath, mp3Buffer);

      // ffmpeg: MP3 → μ-law PCM @ 8kHz mono
      await execAsync(
        `ffmpeg -y -i "${inPath}" -ar 8000 -ac 1 -f mulaw "${outPath}" 2>/dev/null`
      );

      const mulawBuffer = await readFile(outPath);
      return mulawBuffer;

    } finally {
      // Cleanup temp files
      unlink(inPath).catch(() => {});
      unlink(outPath).catch(() => {});
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

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
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
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

  async textToSpeechStream(text, onChunk) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    console.log(`[ElevenLabs] Streaming TTS: "${text.slice(0, 80)}"`);

    try {
      const res = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
        data: {
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        },
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 15000,
      });

      return new Promise((resolve, reject) => {
        res.data.on('data', chunk => {
          onChunk(chunk);
        });
        res.data.on('end', resolve);
        res.data.on('error', reject);
      });
    } catch (err) {
      console.error(`[ElevenLabs] TTS stream failed: ${err.message}`);
    }
  }
}

export const elevenLabsService = new ElevenLabsService();
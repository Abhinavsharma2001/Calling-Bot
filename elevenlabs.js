import axios from 'axios';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'audio_cache');


class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
  }

  // Pure JS 16-bit PCM to 8-bit μ-law (G.711) converter
  pcmToMulaw(pcmBuffer) {
    const BIAS = 132;
    const CLIP = 32635;
    const encodeMap = [
      0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
      4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
    ];

    const mulaw = Buffer.alloc(pcmBuffer.length / 2);
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      let sample = pcmBuffer.readInt16LE(i);
      let sign = (sample < 0) ? 0x80 : 0x00;
      if (sample < 0) sample = -sample;
      if (sample > CLIP) sample = CLIP;
      sample += BIAS;

      let exponent = encodeMap[(sample >> 7) & 0xFF];
      let mantissa = (sample >> (exponent + 3)) & 0x0F;
      let val = ~(sign | (exponent << 4) | mantissa);
      mulaw[i / 2] = val;
    }
    return mulaw;
  }

  normalizeText(text) {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, "") // Remove all non-word chars except spaces
      .replace(/\s+/g, " ")    // Collapse multiple spaces
      .trim();
  }

  async streamTTS(text, onChunk, shouldAbort = () => false) {
    if (shouldAbort()) return;

    // 1. Check Audio Cache
    const normalized = this.normalizeText(text);
    const fileName = `${normalized.replace(/\s+/g, '_').slice(0, 50)}.mulaw`;
    const filePath = path.join(CACHE_DIR, fileName);

    if (fs.existsSync(filePath)) {
      console.log(`[AudioCache] ⚡ Cache Hit: "${normalized}"`);
      try {
        const cachedMulaw = fs.readFileSync(filePath);
        // Stream in chunks of 320 bytes (20ms at 8kHz Mulaw)
        const CHUNK_SIZE = 320;
        for (let i = 0; i < cachedMulaw.length; i += CHUNK_SIZE) {
          if (shouldAbort()) return;
          onChunk(cachedMulaw.subarray(i, i + CHUNK_SIZE));
        }
        return; // Success, don't call API
      } catch (err) {
        console.error(`[AudioCache] ❌ Failed to read cache file: ${err.message}`);
        // Fallback to API if read fails
      }
    }

    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const apiKey = this.apiKey;
        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const ttsStartTime = Date.now();
        let firstTTSChunkReceived = false;
        let leftover = Buffer.alloc(0);

        // Output format: pcm_8000 (16-bit PCM at 8kHz). Direct map to Twilio.
        const response = await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_8000`,
          data: {
            text,
            model_id: 'eleven_flash_v2_5',
            voice_settings: { stability: 0.8, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true }
          },
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 10000
        });

        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => {
            if (shouldAbort()) {
              response.data.destroy();
              return resolve();
            }
            if (!firstTTSChunkReceived) {
              firstTTSChunkReceived = true;
              console.log(`[Latency] ⏱️ ElevenLabs Time to First Audio: ${Date.now() - ttsStartTime}ms (No-FFmpeg)`);
            }

            // Combine with previous leftover bytes
            let pcmBuffer = Buffer.concat([leftover, chunk]);
            
            // If odd number of bytes, save the last byte for next chunk
            if (pcmBuffer.length % 2 !== 0) {
              leftover = pcmBuffer.subarray(pcmBuffer.length - 1);
              pcmBuffer = pcmBuffer.subarray(0, pcmBuffer.length - 1);
            } else {
              leftover = Buffer.alloc(0);
            }

            if (pcmBuffer.length > 0) {
              const mulaw = this.pcmToMulaw(pcmBuffer);
              onChunk(mulaw);
            }
          });

          response.data.on('end', resolve);
          response.data.on('error', reject);
        });

        return; 
      } catch (err) {
        if (shouldAbort()) return;
        const is429 = err.response?.status === 429 || err.message.includes('429');
        if (is429 && retries > 1) {
          console.warn(`[ElevenLabs] ⚠️ 429. Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          retries--; delay *= 2; continue;
        }
        console.error(`[ElevenLabs] ❌ Stream Error:`, err.message);
        return;
      }
    }
  }
}

export const elevenLabsService = new ElevenLabsService();
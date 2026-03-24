import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { elevenLabsService } from '../elevenlabs.js';

/**
 * Utility to generate a pre-recorded .mulaw file from text.
 * Run it like: node scripts/generate_cache.js "Hello, how can I help you today?"
 */

const CACHE_DIR = path.join(process.cwd(), 'audio_cache');

// Helper to normalize text (lowercase, no punctuation, safe for filenames)
function normalizeText(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, "") // Remove all non-word chars except spaces
    .replace(/\s+/g, " ")    // Collapse multiple spaces
    .trim();
}

async function generateAndCache(text) {
  if (!text) {
    console.error('❌ Please provide text as an argument.');
    process.exit(1);
  }

  const normalized = normalizeText(text);
  const fileName = `${normalized.replace(/\s+/g, '_').slice(0, 50)}.mulaw`;
  const filePath = path.join(CACHE_DIR, fileName);

  console.log(`[CacheGen] 🎙️ Generating audio for: "${text}"`);
  console.log(`[CacheGen] 📁 Target file: ${fileName}`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_8000`,
      data: {
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.8, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true }
      },
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer'
    });

    const pcmBuffer = Buffer.from(response.data);
    const mulawBuffer = elevenLabsService.pcmToMulaw(pcmBuffer);

    fs.writeFileSync(filePath, mulawBuffer);
    console.log(`[CacheGen] ✅ Successfully saved to ${filePath}`);

  } catch (err) {
    console.error('❌ Generation failed:', err.response?.data?.toString() || err.message);
  }
}

const textArg = process.argv[2];
generateAndCache(textArg);

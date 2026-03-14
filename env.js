// src/env.js — MUST be imported first in index.js
// ES modules hoist imports, so dotenv.config() inside index.js
// runs AFTER service constructors. This file ensures env is loaded first.
import dotenv from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '.env') });

console.log('[Env] Loaded — ElevenLabs key:', process.env.ELEVENLABS_API_KEY ? `${process.env.ELEVENLABS_API_KEY.slice(0, 8)}...` : '❌ MISSING');
console.log('[Env] Loaded — Gemini key:', process.env.GEMINI_API_KEY ? `${process.env.GEMINI_API_KEY.slice(0, 8)}...` : '❌ MISSING');
console.log('[Env] Loaded — Twilio SID:', process.env.TWILIO_ACCOUNT_SID ? `${process.env.TWILIO_ACCOUNT_SID.slice(0, 8)}...` : '❌ MISSING');
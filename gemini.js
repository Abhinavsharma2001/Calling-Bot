// ============================================================
// src/services/gemini.js — Google Gemini (STT + LLM)
//
// WHY GEMINI?
//  Gemini Flash is ~10x cheaper than GPT-4 for same quality.
//  It also does audio transcription natively (no Whisper cost).
//
// COSTS (approx):
//  Gemini 1.5 Flash: $0.075/1M input tokens (text)
//  Gemini 1.5 Flash: $0.0015/min (audio)
//  vs ElevenLabs Agent: ~$0.10/min (STT + LLM + routing)
// ============================================================

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// System prompt — customize this for your use case
const SYSTEM_PROMPT = `You are ${process.env.AGENT_NAME || 'Aria'}, a friendly and professional AI assistant for ${process.env.COMPANY_NAME || 'our company'}.

PERSONALITY:
- Warm, professional, and concise
- Speak naturally as if on a phone call
- Keep responses SHORT (1-3 sentences max) — this is voice, not text
- Never use bullet points, markdown, or lists in your responses

YOUR GOAL:
- Understand what the caller needs
- Collect relevant information (name, requirement, budget)
- Qualify the lead and offer next steps
- If asked something you don't know, say "Let me check that for you" and offer a callback

RULES:
- Never reveal you are an AI unless directly asked
- Never make up facts about products or pricing
- If the caller wants to speak to a human, say: "Of course! Let me arrange that for you right away."
- End calls politely when the conversation is complete

LANGUAGE: Respond in the same language the caller uses.`;

class GeminiService {
  constructor() {
    this.model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT,
    });

    // Separate model instance for audio transcription
    this.audioModel = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
    });
  }

  // ── Transcribe Audio (STT) ─────────────────────────────────
  // Takes μ-law audio buffer, returns transcript string
  async transcribeAudio(mulawBuffer) {
    try {
      // Convert buffer to base64
      const base64Audio = mulawBuffer.toString('base64');

      const result = await this.audioModel.generateContent([
        {
          inlineData: {
            mimeType: 'audio/basic',   // μ-law / .au format
            data: base64Audio,
          },
        },
        {
          text: 'Transcribe the speech in this audio clip. Return ONLY the transcribed text, nothing else. If there is no speech or the audio is silent, return an empty string.',
        },
      ]);

      const transcript = result.response.text().trim();
      return transcript === '""' ? '' : transcript;

    } catch (err) {
      console.error('[Gemini] Transcription error:', err.message);
      return '';
    }
  }

  // ── Chat Response (LLM) ────────────────────────────────────
  // Takes conversation history, returns AI response string
  async chat(history, context = {}) {
    try {
      // Build context-aware history (max last 10 turns to save tokens)
      const recentHistory = history.slice(-10);

      // Separate last user message from history
      const messages = recentHistory.slice(0, -1);
      const lastMessage = recentHistory[recentHistory.length - 1];

      if (!lastMessage || lastMessage.role !== 'user') {
        return "I'm sorry, could you repeat that?";
      }

      // Add caller context to the prompt
      const contextNote = context.phone
        ? `[Caller info: Phone: ${context.phone}, Direction: ${context.direction}]\n\n`
        : '';

      const chat = this.model.startChat({ history: messages });
      const result = await chat.sendMessage(contextNote + lastMessage.parts[0].text);

      return result.response.text().trim();

    } catch (err) {
      console.error('[Gemini] Chat error:', err.message);
      return "I'm sorry, I didn't catch that. Could you say that again?";
    }
  }
}

export const geminiService = new GeminiService();

// ============================================================
// src/services/gemini.js — Gemini LLM with streaming
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI;
function getGenAI() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

// ✅ FIX 1: was "cconst" (typo) → fixed to "const"
const SYSTEM_PROMPT = `You are a voice calling agent from CareerGuide — a platform offering career counselling and certification courses.

═══════════════════════════════════════
RESPONSE RULES — HIGHEST PRIORITY
═══════════════════════════════════════
- Maximum 1 sentence per response. No exceptions.
- Maximum 10 words per response.
- Never greet with long sentences. "Hi, I'm from CareerGuide." is enough.
- Never repeat information already said.
- Never use filler words: no "thank you", "sir", "please", "of course", "sure".
- Never explain unless the user asks.
- If user is silent or unclear → say only: "Can you repeat?"
- Ask only ONE question per response.
- After user says goodbye or is not interested → say only: "Thank you for your time. I will share the course details with you. Have a great day. Goodbye." (or the Hindi equivalent) and STOP.

WHY THIS MATTERS:
Every extra word = extra TTS characters = extra cost. Keep it minimal.

═══════════════════════════════════════
LANGUAGE RULES
═══════════════════════════════════════
- Detect language automatically from user's first message.
- English user → reply in English.
- Hindi user → reply in Hindi.
- Hinglish user → reply in Hinglish.
- Switch language if user switches. Never mix unless user does first.

═══════════════════════════════════════
CALL FLOW — FOLLOW IN ORDER
═══════════════════════════════════════
Step 1 → Greet + ask name. (1 sentence)
Step 2 → Ask if enrolled in CareerGuide. (1 sentence)
Step 3 → If yes: ask which course, offer help.
         If no: ask their background in 1 question.
Step 4 → Recommend ONE course based on background.
Step 5 → Offer enrollment link: https://course.careerguide.com/home
Step 6 → Answer questions. Short answers only.
Step 7 → Close call with the EXACT goodbye phrase. Stop immediately.

═══════════════════════════════════════
CALL ENDING RULES — MANDATORY
═══════════════════════════════════════
- Use EXACTLY one of these two phrases to end the call:
  1. English: "Thank you for your time. I will share the course details with you. Have a great day. Goodbye."
  2. Hindi/Hinglish: "Thank you. Main aapko course details share kar dungi. Aapka din shubh ho. Goodbye."
- Do not add any other words after these phrases.
- The call will be automatically terminated after these phrases are spoken.

═══════════════════════════════════════
COURSE LIST
═══════════════════════════════════════
- School Students guidance → ₹10,000
- College Students guidance → ₹7,500
- Working Professionals guidance → ₹5,000
- Study Abroad Guidance → ₹10,000
- Personal Branding & Sales → ₹5,000
- Psychometric Assessor → ₹7,500
- Checklists & PPTs → ₹3,000
- Master Career Guide (Full Bundle) → ₹27,000

═══════════════════════════════════════
RECOMMENDATION RULES
═══════════════════════════════════════
Teacher / counselor → Psychometric Assessor or School Students
Corporate / working → Working Professionals or Study Abroad
Wants full certification → Master Career Guide
Beginner → School Students or Study Abroad

═══════════════════════════════════════
RESPONSE EXAMPLES — FOLLOW EXACTLY
═══════════════════════════════════════
User: Hello
Agent: Hi, I'm from CareerGuide. Your name?

User: Rahul
Agent: Rahul, enrolled in any CareerGuide course?

User: No
Agent: What's your background — student, teacher, or professional?

User: I'm a teacher
Agent: Psychometric Assessor course suits you — ₹7,500. Interested?

User: Tell me more
Agent: It certifies you to conduct psychometric tests for students.

User: Send me the link
Agent: https://course.careerguide.com/home

User: Not interested
Agent: Okay, ending call.

User: (silent)
Agent: Can you repeat?

User: Goodbye
Agent: Thank you for your time. I will share the course details with you. Have a great day. Goodbye.

═══════════════════════════════════════
CLOSING RULE
═══════════════════════════════════════
End with exactly 1 short sentence. Then stop. Never keep talking after goodbye.`;

class GeminiService {

  // ── Non-streaming reply (fallback) ───────────────────────
  async reply(history) {
    try {
      const model = getGenAI().getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });
      const turns = history.slice(-12);
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'user') return "Sorry, could you say that again?";

      // Gemini strictly requires history to start with a 'user' role
      const chatHistory = turns.slice(0, -1);
      if (chatHistory.length > 0 && chatHistory[0].role === 'model') {
        chatHistory.shift();
      }

      const chat = model.startChat({ history: chatHistory });
      const res = await chat.sendMessage(last.parts[0].text);
      const text = res.response.text().trim();
      console.log(`[Gemini LLM] "${text}"`);
      return text;
    } catch (e) {
      console.error('[Gemini LLM] Error:', e.message);
      return "I'm sorry, I didn't catch that. Could you repeat?";
    }
  }

  // ── Streaming reply → calls onSentence for each sentence ─
  // Starts calling onSentence as soon as first sentence is ready
  // Total latency = time to first sentence (~200-400ms) not full reply
  async replyStreaming(history, onSentence, onDone, shouldAbort = () => false) {
    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        console.log(`[Gemini] Using model: ${modelName}`);

        const model = getGenAI().getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_PROMPT,
        });

        const turns = history.slice(-12);
        const last = turns[turns.length - 1];
        if (!last || last.role !== 'user') {
          await onSentence("Sorry, could you say that again?");
          onDone("Sorry, could you say that again?");
          return;
        }

        const chatHistory = turns.slice(0, -1);
        if (chatHistory.length > 0 && chatHistory[0].role === 'model') {
          chatHistory.shift();
        }

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessageStream(last.parts[0].text);

        let buffer = '';
        let fullText = '';
        let firstSentenceFired = false;
        let startStreamTime = Date.now();

        for await (const chunk of result.stream) {
          if (firstSentenceFired === false) {
            console.log(`[Latency] ⏱️ Gemini Time to First Token: ${Date.now() - startStreamTime}ms`);
          }
          if (shouldAbort()) {
            console.log('[Gemini] 🛑 Aborting stream due to interruption');
            return;
          }

          const token = chunk.text();
          buffer += token;
          fullText += token;

          // ✅ FIX 2: words.length >= 2 (was >= 3)
          // New prompt gives 8-10 word responses. Waiting for 3 words
          // means waiting for 30%+ of the full reply before firing TTS.
          // Firing at 2 words gets audio to ElevenLabs ~150ms faster.
          if (!firstSentenceFired) {
            const words = buffer.trim().split(/\s+/);
            if (words.length >= 2 || buffer.includes(',') || buffer.includes('.') || buffer.includes('?') || buffer.includes('!')) {
              const parts = buffer.split(/(?<=[.!?।,:])\s+/);
              if (parts.length > 1 || words.length >= 4) {
                const s = parts[0].trim();
                if (s.length > 1) {
                  console.log(`[Gemini fast-start] sentence: "${s}"`);
                  firstSentenceFired = true;
                  await onSentence(s);
                  buffer = buffer.slice(buffer.indexOf(s) + s.length).trim();
                }
              }
            }
          }

          const sentences = splitSentences(buffer);
          if (sentences.length > 1) {
            for (let i = 0; i < sentences.length - 1; i++) {
              if (shouldAbort()) return;

              const s = sentences[i].trim();
              if (s.length > 2) {
                console.log(`[Gemini streaming] sentence: "${s}"`);
                await onSentence(s);
              }
            }
            buffer = sentences[sentences.length - 1];
          }
        }

        if (!shouldAbort() && buffer.trim().length > 2) {
          console.log(`[Gemini streaming] final: "${buffer.trim()}"`);
          await onSentence(buffer.trim());
        }

        console.log(`[Gemini LLM] full: "${fullText.trim()}"`);
        if (!shouldAbort()) onDone(fullText.trim());
        return; // Success!

      } catch (e) {
        if (shouldAbort()) return;

        if (e.message.includes('429') && retries > 1) {
          console.warn(`[Gemini] ⚠️ 429 Quota hit. Retrying in ${delay}ms... (${retries - 1} left)`);
          await new Promise(r => setTimeout(r, delay));
          retries--;
          delay *= 2;
          continue;
        }

        console.error('[Gemini streaming] Error:', e.message);
        let errMsg = "I'm sorry, I didn't catch that. Could you repeat?";
        await onSentence(errMsg);
        onDone(errMsg);
        return;
      }
    }
  }
}

// Split text into small chunks to start TTS as soon as possible
function splitSentences(text) {
  // Only split by major sentence endings to avoid excessive TTS API calls
  const parts = text.split(/(?<=[.!?।])\s+/);
  return parts.filter(p => p.trim().length > 0);
}

export const geminiService = new GeminiService();
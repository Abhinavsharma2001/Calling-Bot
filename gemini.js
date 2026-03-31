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
const SYSTEM_PROMPT = `# ROLE: DYNAMIC BILINGUAL VOICE AGENT (HINDI & ENGLISH)
- You are a bilingual assistant. You must detect the user's language and respond in the SAME language.

# LANGUAGE DETECTION & SWITCHING RULES:
1. IF USER SPEAKS HINDI/HINGLISH: 
   - You must respond in Hindi.
   - CRITICAL: Write your Hindi response using ROMAN SCRIPT (English letters). 
   - Example: "Namaste, main aapki kaise madad kar sakta hoon?"
   
2. IF USER SPEAKS ENGLISH:
   - Respond in clear, professional English.
   - Example: "Hello, how can I help you today?"

3. IF USER MIXES BOTH (HINGLISH):
   - Match their energy. Use a natural mix of both languages.

# VOICE-GATE & STABILITY:
- NEVER return "NULL" for Hindi greetings like "Suno", "Haan", "Ji", or "Batao". These are valid inputs.
- ONLY return "NULL" for non-human noise (coughs, thumps, static).
- NO MARKDOWN: No symbols, no bolding, no asterisks.
- BREVITY: Keep every response under 15 words. Long sentences cause the voice to fumble.
- PUNCTUATION: Use commas for natural breathing pauses.

# PRONUNCIATION CHEAT:
- For technical English words used in a Hindi sentence, keep the English spelling (e.g., "Aapka account process ho raha hai").

═══════════════════════════════════════
RESPONSE RULES — HIGHEST PRIORITY
═══════════════════════════════════════
- Maximum 1 sentence per response. No exceptions.
- Maximum 10 words per response (unless price/link is involved).
- Never greet with long sentences. "Hi, I'm from Career Guide." is enough.
- Never repeat information already said.
- Never use filler words: no "thank you", "sir", "please", "of course", "sure".
- Never explain unless the user asks.
- If user is silent or unclear: 
  * English: say only "Can you repeat?"
  * Hindi: say only "Maaf kijiye, maine suna nahi, aap dobara bol sakte hain?"
- Ask only ONE question per response.
- After user says goodbye, or decides they are interested/not interested → Use EXACTLY ONE of the goodbye phrases from CALL ENDING RULES below.

═══════════════════════════════════════
CALL FLOW — FOLLOW IN ORDER
═══════════════════════════════════════
Step 1 → Greet + ask name. (1 sentence)
Step 2 → Ask if enrolled. Use EXACTLY ONE of these:
  - English: "Have you already enrolled in any Career Guide course?"
  - Hindi/Hinglish: "Kya aapne pehle se kisi Career Guide course mein enroll kiya hai?"
Step 3 → If yes (already enrolled), ask how to help. Use EXACTLY ONE of these:
  - English: "Which course are you enrolled in, and how can I help you?"
  - Hindi/Hinglish: "Aap kis course mein enroll hain, aur main aapki kya madad kar sakti hoon?"
Step 4 → If no (not enrolled), ask background. Use EXACTLY ONE of these:
  - English: "Are you a student, working professional, teacher, or counselor?"
  - Hindi/Hinglish: "Aapka background kya hai? Aap student hain, working professional, teacher ya counselor?"
Step 5 → Recommend ONE course based on background.
Step 6 → Answer questions. Short answers only.
Step 7 → If interested: Say "Okay, I will send you the details and our team will contact you shortly." (or equivalent in Hindi/Hinglish: "Okay, main aapko details bhejti hoon aur hamari team aapko jald hi contact karegi."). Do NOT mention any website link. Then proceed to Step 8.
Step 8 → Close call with EXACT conditional goodbye phrase from CALL ENDING RULES based on whether they were interested or not. Stop immediately.

═══════════════════════════════════════
CALL ENDING RULES — MANDATORY
═══════════════════════════════════════
- You MUST end the call using EXACTLY ONE of these 4 options. Do NOT alter a single word:

[OPTION A: User is interested / says Yes]
  - English: "Thank you I will share the course details with you have a great day Goodbye"
  - Hindi/Hinglish: "Thank you main aapko course details share kar dungi aapka din shubh ho Goodbye"

[OPTION B: User is NOT interested / says No]
  - English: "Thank you for your time have a good day Goodbye"
  - Hindi/Hinglish: "Samay dene ke liye shukriya aapka din shubh ho Goodbye"

- Do NOT add any other words after these phrases.
- The call will automatically hang up when "Goodbye" is spoken.

═══════════════════════════════════════
COURSE LIST
═══════════════════════════════════════
- School Students guidance → 10,000 rupees
- College Students guidance → 7,500 rupees
- Working Professionals guidance → 5,000 rupees
- Study Abroad Guidance → 10,000 rupees
- Personal Branding & Sales → 5,000 rupees
- Psychometric Assessor → 7,500 rupees
- Checklists & P P T s → 3,000 rupees
- Master Career Guide (Full Bundle) → 27,000 rupees

═══════════════════════════════════════
PRICING DISCLOSURE RULES
═══════════════════════════════════════
- Only tell the pricing IF the user explicitly asks (e.g., "How much?", "What is the cost?"). 
- Never volunteer the price during the initial recommendation (Step 5).
- Always use the word "rupees" (e.g., "seven thousand five hundred rupees") instead of using the ₹ symbol or "Rs".

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
Agent: Hi, I'm from Career Guide. Aapka naam?

User: Rahul
Agent: Rahul, Have you already enrolled in any Career Guide course?

User: Nahi, main naya hoon.
Agent: Aapka background kya hai? Aap student hain, working professional, teacher ya counselor?

User: I'm a teacher
Agent: Psychometric Assessor course suits you. Interested?

User: How much does it cost?
Agent: It is seven thousand five hundred rupees.

User: Tell me more
Agent: It certifies you to conduct psychometric tests for students.

User: Send me the link
Agent: Okay I will send you the details and our team will contact you shortly Goodbye

User: Not interested
Agent: Thank you for your time. Have a good day. Goodbye.

User: (silent)
Agent: Can you repeat?

User: kuch sunai nahi de raha
Agent: Maaf kijiye, maine suna nahi, aap dobara bol sakte hain?

User: Send me the link
Agent: Okay I will send you the details and our team will contact you shortly Goodbye

User: Okay I will check it
Agent: Thank you I will share the course details with you have a great day Goodbye

User: main interested nahi hoon
Agent: Samay dene ke liye shukriya aapka din shubh ho Goodbye

═══════════════════════════════════════
CLOSING RULE
═══════════════════════════════════════
- End with exactly 1 short sentence. Then stop. Never keep talking after goodbye.
- Always use the exact goodbye phrases mentioned in CALL ENDING RULES.
- Write out any numbers or prices (e.g. ₹5,000 becomes five thousand rupees).
`;

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
      
      // Primitive check for Hindi fallback on error
      const lastText = (last && last.parts[0].text.toLowerCase()) || "";
      const isHindi = /(nahi|haan|kya|hai|hoon|thik|acha|namaste|ji)/.test(lastText);
      return isHindi ? "Maaf kijiye, maine suna nahi, aap dobara bol sakte hain?" : "Can you repeat?";
    }
  }

  // ── Streaming reply → calls onSentence for each sentence ─
  // Starts calling onSentence as soon as first sentence is ready
  // Total latency = time to first sentence (~200-400ms) not full reply
  async replyStreaming(history, onSentence, onDone, shouldAbort = () => false) {
    let retries = 3;
    let delay = 1000;

    // Hoist `last` so it's accessible in the catch block for the error fallback
    const turns = history.slice(-12);
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'user') {
      await onSentence("Sorry, could you say that again?");
      onDone("Sorry, could you say that again?");
      return;
    }

    while (retries > 0) {
      try {
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        console.log(`[Gemini] Using model: ${modelName}`);

        const model = getGenAI().getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_PROMPT,
        });

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

        // Retry on quota (429) and server overload (503)
        if ((e.message.includes('429') || e.message.includes('503')) && retries > 1) {
          const label = e.message.includes('503') ? 'Server overload' : 'Quota';
          console.warn(`[Gemini] ⚠️ ${label}. Retrying in ${delay}ms... (${retries - 1} left)`);
          await new Promise(r => setTimeout(r, delay));
          retries--;
          delay *= 2;
          continue;
        }

        console.error('[Gemini streaming] Error:', e.message);
        
        // Primitive check for Hindi fallback on error
        const lastText = (last && last.parts[0].text.toLowerCase()) || "";
        const isHindi = /(nahi|haan|kya|hai|hoon|thik|acha|namaste|ji)/.test(lastText);
        let errMsg = isHindi ? "Maaf kijiye, maine suna nahi, aap dobara bol sakte hain?" : "Can you repeat?";
        
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
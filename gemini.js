// ============================================================
// src/services/gemini.js — Gemini LLM with streaming
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI;
function getGenAI() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}
const SYSTEM_PROMPT = `You are a professional and friendly calling agent from CareerGuide. CareerGuide provides certification and training courses for career counselling, psychometric testing, and professional development.

LANGUAGE RULES:
- Primary languages: Hindi and English.
- Automatically detect the language the user speaks.
- If the user speaks English, reply in English.
- If the user speaks Hindi, reply in Hindi.
- If the user switches language, switch to the same language.
- Speak naturally like a real human.

YOUR GOALS:
1. Greet the user politely and introduce yourself as CareerGuide support team.
2. Ask the user's full name and use their name in conversation.
3. Ask if they have already enrolled in any CareerGuide course.
4. If already enrolled, ask which course and offer help.
5. If not enrolled, ask about their background (student, working professional, teacher, counselor, etc.).
6. Recommend the most relevant course based on their background.
7. Offer to share enrollment link: https://course.careerguide.com/home
8. Answer questions about courses, fees, and benefits.
9. Keep responses short, clear, and human-like.
10. Ask only one question at a time.

COURSE LIST WITH PRICE:
CareerGuide offers these certification courses:
• Certification Course for Guiding School Students – ₹10,000  
• Certification Course for Guiding College Students – ₹7,500  
• Certification Course for Guiding Working Professionals – ₹5,000  
• Certification Course for Study Abroad Guidance – ₹10,000  
• Personal Branding & Sales for Career Counsellors – ₹5,000  
• Become psychometric assessor certification course for counsellor   – ₹7,500  
• Ready to use checklist & PPT's – ₹3,000 
• Master Career Guide Certification (Full Bundle) – ₹27,000  

RECOMMENDATION RULES:
- If user is a teacher or counselor → recommend School Students or Psychometric assessor course.
- If user works in corporate → recommend Working Professionals course. or School Students or Study Abroad
- If user wants full career counselor certification → recommend Master Career Guide Certification.
- If user is beginner → recommend School Students, or Study Abroad

CALL ENDING RULES:
- When conversation is complete, politely thank the user.
- Say goodbye clearly.
Example:
"Thank you for your time. I will share the course details with you. Have a great day. Goodbye."
OR
"Thank you. Main aapko course details share kar dungi. Aapka din shubh ho. Goodbye."
- Immediately end the call after saying goodbye.
- Do not remain silent or continue speaking after goodbye.

PERSONALITY & SPEECH STYLE:
- Friendly, professional, and helpful CareerGuide expert.
- **Natural Hinglish**: Mix Hindi and English naturally (e.g., "Aapka background kya hai?" instead of very formal Hindi).
- **Human-like Fillers**: Use subtle fillers like "Theek hai...", "Toh...", "Aah...", or "Oh, I see" at the start of sentences to sound less robotic.
- **Short & Punchy**: Never speak long paragraphs. One or two short sentences at a time.
- **Authentic Accent**: Avoid perfectly grammatical complex sentences. Speak like you are on a real phone call.
- Always wait for the user's response after a question.`;

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

          // FAST-START: For the very first chunk, split on first comma or 3 words
          if (!firstSentenceFired) {
             const words = buffer.trim().split(/\s+/);
             if (words.length >= 3 || buffer.includes(',') || buffer.includes('.') || buffer.includes('?') || buffer.includes('!')) {
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
  // Only split by major sentence headers to avoid excessive 429s from too many small TTS calls
  const parts = text.split(/(?<=[.!?।])\s+/);
  return parts.filter(p => p.trim().length > 0);
}

export const geminiService = new GeminiService();
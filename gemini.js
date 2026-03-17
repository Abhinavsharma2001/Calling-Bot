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

PERSONALITY:
- Friendly, professional, and helpful.
- Speak like a real human.
- Do not speak long paragraphs.
- Always wait for the user's response.`;

class GeminiService {

  // ── Non-streaming reply (fallback) ───────────────────────
  async reply(history) {
    try {
      const model = getGenAI().getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
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
  async replyStreaming(history, onSentence, onDone) {
    try {
      const model = getGenAI().getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
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

      for await (const chunk of result.stream) {
        const token = chunk.text();
        buffer += token;
        fullText += token;

        // Fire onSentence at sentence boundaries
        // This lets TTS start immediately on first sentence
        const sentences = splitSentences(buffer);
        if (sentences.length > 1) {
          // All complete sentences except the last (may be incomplete)
          for (let i = 0; i < sentences.length - 1; i++) {
            const s = sentences[i].trim();
            if (s.length > 2) {
              console.log(`[Gemini streaming] sentence: "${s}"`);
              await onSentence(s);
            }
          }
          buffer = sentences[sentences.length - 1]; // keep remainder
        }
      }

      // Flush remaining buffer
      if (buffer.trim().length > 2) {
        console.log(`[Gemini streaming] final: "${buffer.trim()}"`);
        await onSentence(buffer.trim());
      }

      console.log(`[Gemini LLM] full: "${fullText.trim()}"`);
      onDone(fullText.trim());

    } catch (e) {
      console.error('[Gemini streaming] Error:', e.message);
      await onSentence("I'm sorry, I didn't catch that. Could you repeat?");
      onDone("I'm sorry, I didn't catch that. Could you repeat?");
    }
  }
}

// Split text into sentences at . ! ? boundaries OR every ~8 words for extreme speed
function splitSentences(text) {
  // First split by punctuation
  const parts = text.split(/(?<=[.!?।])\s+/);
  
  const finalParts = [];
  for (const p of parts) {
    const words = p.trim().split(/\s+/);
    // If a part is too long (e.g. 10 words), split it anyway to start TTS
    if (words.length > 10) {
      finalParts.push(words.slice(0, 8).join(' ') + '...');
      finalParts.push(words.slice(8).join(' '));
    } else {
      finalParts.push(p);
    }
  }
  return finalParts;
}

export const geminiService = new GeminiService();
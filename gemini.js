// ============================================================
// src/services/gemini.js — Gemini STT + LLM
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let genAI;
let fileManager;
function getGenAI() {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) throw new Error("GEMINI_API_KEY is missing from environment variables");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

function getFileManager() {
  if (!fileManager) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) throw new Error("GEMINI_API_KEY is missing");
    fileManager = new GoogleAIFileManager(key);
  }
  return fileManager;
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
• Become Psychometric Assessor Certification Course for Counsellors – ₹7,500
• Ready to Use Checklist & PPTs – ₹3,000
• Master Career Guide Certification (Full Bundle) – ₹27,000

RECOMMENDATION RULES:
- If user is a teacher or counselor → recommend School Students or Psychometric Assessor course.
- If user works in corporate → recommend Working Professionals, School Students, or Study Abroad course.
- If user wants full career counselor certification → recommend Master Career Guide Certification.
- If user is a beginner → recommend School Students or Study Abroad course.

CALL ENDING RULES:
- When conversation is complete, politely thank the user.
- Say goodbye clearly. Example:
  English: "Thank you for your time. I will share the course details with you. Have a great day. Goodbye."
  Hindi: "Thank you. Main aapko course details share kar dungi. Aapka din shubh ho. Goodbye."
- End the call after saying goodbye.
- Do not remain silent or continue speaking after goodbye.

PERSONALITY:
- Friendly, professional, and helpful.
- Speak like a real human on a phone call.
- Never use bullet points, markdown, numbers, or lists in your spoken responses.
- Keep every reply to 1-3 short sentences maximum.
- Always wait for the user's response — ask only ONE question at a time.
- Never say "Certainly!", "Absolutely!", or "Great!" robotically — respond naturally.`;

class GeminiService {

  async transcribe(wavBuffer) {
    let tmpPath = null;
    let uploadResponse = null;

    try {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      tmpPath = join(tmpdir(), `gemini_in_${id}.wav`);
      
      // 1. Write the WAV buffer to disk
      await writeFile(tmpPath, wavBuffer);

      // 2. Upload to Gemini File API
      uploadResponse = await getFileManager().uploadFile(tmpPath, {
        mimeType: 'audio/wav',
        displayName: `Audio_${id}`,
      });

      console.log(`[Gemini STT] Uploaded audio file: ${uploadResponse.file.name}`);

      // 3. Request transcription using the fileData URI
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash-8b';
      const model = getGenAI().getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        {
          fileData: {
            mimeType: uploadResponse.file.mimeType,
            fileUri: uploadResponse.file.uri
          }
        },
        { text: 'Transcribe this phone call audio exactly as spoken. Return ONLY the spoken words. If silent or no speech detected, return empty string.' },
      ]);
      
      const text = result.response.text().trim().replace(/^["']|["']$/g, '');
      if (text) console.log(`[Gemini STT] "${text}"`);
      return text;

    } catch (e) {
      console.error('[Gemini STT] Error:', e.message);
      return '';
    } finally {
      // 4. Cleanup local file
      if (tmpPath) {
        unlink(tmpPath).catch(() => {});
      }
      // 5. Cleanup hosted Gemini file
      if (uploadResponse?.file?.name) {
        getFileManager().deleteFile(uploadResponse.file.name).catch(e => {
          console.error(`[Gemini] Failed to delete remote file: ${e.message}`);
        });
      }
    }
  }

  async reply(history) {
    try {
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash-8b';
      const model = getGenAI().getGenerativeModel({
        model: modelName,
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

  async replyStream(history, onSentence) {
    try {
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash-8b';
      const model = getGenAI().getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
      });

      const turns = history.slice(-12);
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'user') return "Sorry, could you say that again?";

      const chatHistory = turns.slice(0, -1);
      if (chatHistory.length > 0 && chatHistory[0].role === 'model') {
        chatHistory.shift();
      }

      const chat = model.startChat({ history: chatHistory });
      const res = await chat.sendMessageStream(last.parts[0].text);

      let sentenceBuffer = '';
      let fullText = '';
      for await (const chunk of res.stream) {
        const text = chunk.text();
        fullText += text;
        sentenceBuffer += text;
        
        // Split on punctuation (. ? ! and Hindi Purna Viram ।)
        const match = sentenceBuffer.match(/([.?!।])(\s|\n|$)/);
        if (match) {
          const index = match.index + 1;
          const sentence = sentenceBuffer.slice(0, index).trim();
          if (sentence) {
            await onSentence(sentence);
          }
          sentenceBuffer = sentenceBuffer.slice(index);
        }
      }
      
      if (sentenceBuffer.trim()) {
        await onSentence(sentenceBuffer.trim());
      }
      
      return fullText.trim();
    } catch (e) {
      console.error('[Gemini LLM Stream] Error:', e.message);
      return "I'm sorry, I didn't catch that. Could you repeat?";
    }
  }
}

export const geminiService = new GeminiService();
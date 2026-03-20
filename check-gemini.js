import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  try {
    console.log("Listing all available models for this API key...");
    // The SDK provides a way to list models
    // Actually, usually it's through the client.listModels()
    // But since we are using the simple SDK, let's try to find it.
    // If not, we can try common variations.
    
    // For now, let's try a much wider range of common names 
    // to see which one doesn't return 404.
    const models = [
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-pro',
      'gemini-pro',
      'gemini-1.0-pro',
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash'
    ];

    for (const m of models) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        const result = await model.generateContent("hi");
        console.log(`✅ ${m}: SUCCESS`);
        fs.appendFileSync('working_models.txt', `${m}\n`);
      } catch (e) {
        console.log(`❌ ${m}: ${e.message}`);
        if (e.message.includes('429')) {
             console.log(`⚠️ ${m} is valid but rate-limited.`);
             fs.appendFileSync('working_models.txt', `${m} (429)\n`);
        }
      }
    }
  } catch (e) {
    console.error("Master error:", e.message);
  }
}

listModels();

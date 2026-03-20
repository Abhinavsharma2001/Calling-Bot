import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function checkModels() {
  try {
    console.log("Checking available models...");
    // The SDK doesn't have a direct 'listModels' in the top-level easy API usually,
    // but the REST API does. We can try common ones.
    const models = [
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-001',
      'gemini-1.5-flash-002',
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash',
      'gemini-pro'
    ];

    for (const m of models) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        const result = await model.generateContent("hi");
        console.log(`✅ ${m}: SUCCESS`);
      } catch (e) {
        console.log(`❌ ${m}: FAILED - ${e.message}`);
      }
    }
  } catch (e) {
    console.error("Master error:", e.message);
  }
}

checkModels();

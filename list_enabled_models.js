import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("No GEMINI_API_KEY found.");
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.error("API Error:", data.error.message);
      return;
    }

    console.log("Enabled Models for this API Key:");
    data.models.forEach(m => {
      console.log(`- ${m.name} (${m.displayName})`);
      console.log(`  Supported Actions: ${m.supportedGenerationMethods.join(', ')}`);
    });
  } catch (e) {
    console.error("Fetch failed:", e.message);
  }
}

listModels();

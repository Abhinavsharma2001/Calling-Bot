const https = require('https');
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("No GEMINI_API_KEY found.");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) {
        console.error("API Error:", parsed.error.message);
        return;
      }
      console.log("Enabled Models for this API Key:");
      if (!parsed.models) {
        console.log("No models returned. check key.");
        return;
      }
      parsed.models.forEach(m => {
        console.log(`- ${m.name} (${m.displayName})`);
      });
    } catch (e) {
      console.error("Parse error:", e.message);
    }
  });
}).on('error', (e) => {
  console.error("Request error:", e.message);
});

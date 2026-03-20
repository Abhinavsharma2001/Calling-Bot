import https from 'https';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("No GEMINI_API_KEY found.");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', async () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) {
        console.error("API Error:", parsed.error.message);
        return;
      }
      
      const models = parsed.models || [];
      console.log(`Found ${models.length} models. Testing each...`);
      
      const results = [];
      
      // We'll test up to 20 models to avoid spamming
      const toTest = models.filter(m => m.supportedGenerationMethods.includes('generateContent')).slice(0, 20);

      for (const m of toTest) {
        const shortName = m.name.replace('models/', '');
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/${m.name}:generateContent?key=${apiKey}`;
        const body = JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] });
        
        const success = await new Promise((resolve) => {
          const req = https.request(testUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res2) => {
            let d2 = '';
            res2.on('data', c => d2 += c);
            res2.on('end', () => {
              if (res2.statusCode === 200) {
                resolve({ name: shortName, status: '✅ WORKS' });
              } else {
                try {
                  const errorRes = JSON.parse(d2);
                  const msg = errorRes.error?.message || 'Unknown error';
                  if (msg.includes('quota') || msg.includes('429')) {
                    resolve({ name: shortName, status: `⚠️ QUOTA HIT (${msg})` });
                  } else {
                    resolve({ name: shortName, status: `❌ FAILED (${res2.statusCode}: ${msg})` });
                  }
                } catch {
                  resolve({ name: shortName, status: `❌ FAILED (${res2.statusCode})` });
                }
              }
            });
          });
          req.write(body);
          req.end();
        });
        console.log(`- ${success.name}: ${success.status}`);
        results.push(success);
      }
      
      fs.writeFileSync('model_test_results.txt', JSON.stringify(results, null, 2));
      
      const working = results.find(r => r.status === '✅ WORKS');
      if (working) {
        console.log(`\n🎉 FOUND WORKING MODEL: ${working.name}`);
      } else {
        console.log("\n❌ NO WORKING MODELS FOUND. This API key may have 0 quota across the board or is restricted.");
      }
    } catch (e) {
      console.error("Parse error:", e.message);
    }
  });
}).on('error', (e) => {
  console.error("Request error:", e.message);
});

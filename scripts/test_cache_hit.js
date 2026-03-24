import 'dotenv/config';
import { elevenLabsService } from '../elevenlabs.js';

async function testCacheHit() {
  const text = "Hi, I'm from CareerGuide. Your name?";
  console.log(`[Test] 🧪 Testing cache hit for: "${text}"`);

  let chunkCount = 0;
  await elevenLabsService.streamTTS(text, (chunk) => {
    chunkCount++;
  });

  if (chunkCount > 0) {
    console.log(`[Test] ✅ Success: Received ${chunkCount} chunks from cache.`);
  } else {
    console.error(`[Test] ❌ Failure: No chunks received.`);
  }
}

testCacheHit();

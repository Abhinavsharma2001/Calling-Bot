# 🤖 AI Calling Backend
### Twilio + Gemini Flash + ElevenLabs TTS + Freshsales CRM

> **The Trick:** Use ElevenLabs **only for TTS** (not their agent) + Google Gemini for STT & LLM  
> **Result:** ~₹1/min instead of ~₹8/min — same voice quality, 8x cheaper

---

## 📐 Architecture

```
Caller ──────────────────────────────────────────────────────────────────────────────
       │                                                                              │
       ▼                                                                              │
 ┌─────────────┐   Twilio Media     ┌──────────────────────────────────────────┐     │
 │   Twilio    │◄──Stream (μ-law)──►│         Our Node.js Server               │     │
 │  (SIP/PSTN) │                   │                                            │     │
 └─────────────┘                   │  1. Buffer audio chunks                    │     │
                                   │  2. Silence detection (VAD)                │     │
                                   │  3. μ-law → Gemini (STT + LLM)            │     │
                                   │  4. Response → ElevenLabs (TTS only)       │     │
                                   │  5. MP3 → μ-law → back to Twilio           │     │
                                   │  6. Log to Freshsales CRM                  │     │
                                   └──────────────────────────────────────────┘     │
                                                                                      │
 ┌─────────────────────────────────────────────────────────────────────────────────────┘
 │
 └─► Services Used:
       🤖 Google Gemini Flash  — STT + LLM  (~₹0.05/min)
       🎙️ ElevenLabs TTS only  — Voice      (~₹0.45/min)
       📞 Twilio               — PSTN/SIP   (~₹0.50/min)
       📋 Freshsales           — CRM        (free tier)
                                            ──────────
                                     Total: ~₹1/min ✅
```

### vs ElevenLabs Agent Approach
```
ElevenLabs Agent:
  STT (ElevenLabs)  + LLM (ElevenLabs) + TTS (ElevenLabs) + Routing
  = ~₹8/min ❌ (expensive, less control)

Our Approach:
  STT + LLM (Gemini Flash) + TTS only (ElevenLabs)
  = ~₹1/min ✅ (cheap, full control)
```

---

## 🚀 Quick Start

### 1. Prerequisites

```bash
node --version    # v18+
ffmpeg -version   # Must be installed!
```

Install ffmpeg:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
winget install ffmpeg
```

### 2. Install & Configure

```bash
git clone <repo>
cd ai-calling-backend
npm install

cp .env.example .env
# Edit .env with your API keys
```

### 3. Get API Keys

| Service | Where to get it |
|---------|----------------|
| **Twilio** | [console.twilio.com](https://console.twilio.com) → Account SID + Auth Token |
| **ElevenLabs** | [elevenlabs.io/app/settings](https://elevenlabs.io/app/settings) → API Key |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| **Freshsales** | Settings → API Settings → API Key |

### 4. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 5. Expose Publicly (Twilio needs a public URL)

```bash
# Option A: ngrok
ngrok http 3000
# Copy HTTPS URL → set as BASE_URL in .env

# Option B: localtunnel
npm run tunnel
```

### 6. Configure Twilio

1. Go to **Twilio Console → Phone Numbers → Your Number**
2. Set **Voice webhook**:
   - URL: `https://your-url.ngrok.io/twilio/incoming`
   - Method: `POST`
3. Set **Status callback**:
   - URL: `https://your-url.ngrok.io/twilio/status`
   - Method: `POST`

---

## 📞 Making Outbound Calls

```bash
curl -X POST http://localhost:3000/calls/outbound \
  -H "Content-Type: application/json" \
  -d '{ "to": "+919876543210" }'
```

Response:
```json
{
  "success": true,
  "callSid": "CA1234...",
  "status": "queued",
  "to": "+919876543210"
}
```

---

## 🔧 Customization

### Change AI Persona (src/services/gemini.js)

Edit `SYSTEM_PROMPT` to change the agent's:
- Name and company
- Personality and tone
- Goals (sales, support, survey, etc.)
- What to do when asked for a human

### Change Voice (ElevenLabs)

```bash
# List available voices
curl https://api.elevenlabs.io/v1/voices \
  -H "xi-api-key: YOUR_KEY" | jq '.voices[] | {id: .voice_id, name: .name}'
```

Then set `ELEVENLABS_VOICE_ID` in `.env`

### Tune Silence Detection

In `.env`:
```
SILENCE_TIMEOUT_MS=2000   # Wait 2s of silence before processing
```
- Lower = more responsive but may cut off speaker
- Higher = more patient but feels slow

---

## 📁 Project Structure

```
ai-calling-backend/
├── src/
│   ├── index.js              # Express + WebSocket server
│   ├── routes/
│   │   ├── twilio.js         # Twilio webhooks (incoming/outbound/status)
│   │   └── calls.js          # REST API to start/manage calls
│   └── services/
│       ├── mediaStream.js    # Core orchestrator — the main logic
│       ├── gemini.js         # Gemini STT + LLM
│       ├── elevenlabs.js     # ElevenLabs TTS only
│       └── freshsales.js     # CRM integration
├── .env.example
├── package.json
└── README.md
```

---

## 💰 Cost Breakdown

| Component | Service | Cost | Per minute |
|-----------|---------|------|------------|
| PSTN/Phone | Twilio | $0.006/min | ~₹0.50 |
| STT | Gemini Flash | $0.0015/min audio | ~₹0.12 |
| LLM | Gemini Flash | ~$0.001/call | ~₹0.08 |
| TTS | ElevenLabs | $0.006/1000 chars | ~₹0.35 |
| **Total** | | | **~₹1.05/min** ✅ |

vs ElevenLabs Agent: ~₹8-10/min ❌

---

## 🩺 Health Check

```bash
curl http://localhost:3000/health
```

```bash
# View active calls
curl http://localhost:3000/calls/active
```

---

## ⚠️ Production Checklist

- [ ] Use a process manager: `pm2 start src/index.js`
- [ ] Add authentication to `/calls/outbound` endpoint
- [ ] Store conversation transcripts in a database
- [ ] Set up Twilio Elastic SIP Trunk for cheaper PSTN rates
- [ ] Add rate limiting to prevent abuse
- [ ] Monitor ElevenLabs character usage
- [ ] Set `MAX_CALL_DURATION_S` to limit runaway calls

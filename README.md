# AiTwin × LiveKit Agents demo

Local harness: **LiveKit** runs STT + LLM and publishes **text only**. **AiTwin** in the browser owns TTS + avatar animation.

```text
Mic / chat
  → LiveKit Agents (OpenAI STT + LLM, tts=None, audio_output=False)
  → aitwin.speak (+ lk.transcription)
  → browser @streamoji/aitwin speakText()
  → AiTwin TTS + lipsync
```

No agent audio track.

**Project path:** `SitWithMe Labs/aitwin-livekit-demo`

## Prerequisites

- Python 3.10+
- Node.js 18+
- [LiveKit Cloud](https://cloud.livekit.io) credentials
- OpenAI API key (STT + LLM only)
- AiTwin Client-Id + Client-Secret (dashboard → API Keys)

## Setup

### Backend

```powershell
cd "...\SitWithMe Labs\aitwin-livekit-demo\backend"
copy .env.example .env
# Fill LIVEKIT_*, OPENAI_API_KEY, AITWIN_CLIENT_ID, AITWIN_CLIENT_SECRET
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
python agent.py download-files
```

### Frontend

```powershell
cd ..\frontend
copy .env.example .env
npm install
```

## Run (3 terminals)

```powershell
# Terminal 1 — token + agent dispatch + AiTwin auth
cd backend
.\.venv\Scripts\Activate.ps1
python token_server.py
```

```powershell
# Terminal 2 — LiveKit Agents worker
cd backend
.\.venv\Scripts\Activate.ps1
python agent.py dev
```

```powershell
# Terminal 3 — AiTwin UI
cd frontend
npm run dev
```

Open http://localhost:3000 → **Connect**.

| Mode | Behavior |
|------|----------|
| **Mic** | User audio → STT → LLM → `aitwin.speak` → AiTwin `speakText` |
| **Chat (LLM)** | `lk.chat` → LLM → `aitwin.speak` → AiTwin `speakText` |
| **Speak text** | Browser calls AiTwin `speakText` directly (no LLM) |

## Env reference

| Where | Vars |
|-------|------|
| `backend/.env` | `LIVEKIT_*`, `OPENAI_API_KEY`, `LLM_MODEL`, `STT_MODEL`, `AITWIN_*`, `AGENT_NAME`, `TOPIC_SPEAK`, `TOKEN_SERVER_PORT` |
| `frontend/.env` | `VITE_TOPIC_SPEAK`, `VITE_TOPIC_CHAT` (must match backend); optional `VITE_AITWIN_*` |

Defaults live only in `.env` / `.env.example` — not hardcoded in app code.
Copy `backend/.env.example` → `backend/.env` and `frontend/.env.example` → `frontend/.env` before running.

Keep `AITWIN_CLIENT_SECRET` on the token server only. The browser receives a short-lived `client_*` JWT from `POST /token`.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Token 500 | Missing LiveKit env on token server |
| AiTwin auth missing | `AITWIN_CLIENT_ID` / `AITWIN_CLIENT_SECRET` not set |
| Agent never joins | Worker not running, or `AGENT_NAME` mismatch |
| Twin silent after chat | Check console for `aitwin.speak` / `[AiTwin] speakText`; ensure twin ready |
| Mic unused | Tap **Enable mic** after Connect |

## Decision notes

- **LLM:** OpenAI `gpt-4o-mini` (chat) + `gpt-4o-mini-transcribe` STT — not Realtime. Matches explicit STT→LLM→text split.
- **TTS:** none in the agent (`tts=None`, `audio_output=False`).
- **Avatar:** `@streamoji/aitwin` in-page (not `livekit-plugins-aitwin`).

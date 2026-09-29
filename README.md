# Wallet

## Digital AI Money Movement Platform

Wallet is a voice-first, chat-enabled money movement platform for everyday financial actions. It combines a deterministic financial ledger with local AI conversation, speech recognition, natural voice output, explicit transaction confirmation, split payments, requests, recent activity, festival savings goals, and browser-side biometric confirmation via Face ID.

The system is designed around one non-negotiable rule:

> The AI may understand language and make the experience feel human, but it never owns the ledger and never invents financial facts.

Balances, recipients, amounts, transaction state, idempotency, and money movement are controlled by deterministic Python and SQLAlchemy code.

## Capabilities

- Voice and text conversation with casual chat support.
- Voice input through browser microphone and Faster Whisper transcription.
- Voice responses through browser speech synthesis plus optional server-side TTS.
- Wake-word listening ("Hey Wallet") via openWakeWord running entirely in the browser.
- Local Ollama model cascade with DeepSeek as the primary model.
- Deterministic regex fallback when the model is unavailable.
- Exact balance and history answers from SQLite ledger state.
- Send-money flow with review, explicit confirmation, expiry, and cancellation.
- Request-money flow with idempotency protection and payer actions.
- Equal split payments to two or more recipients in one confirmed operation.
- Festival savings goals for Eid, Durga Puja, Pohela Boishakh, Valentine's Day, or custom celebrations.
- Idempotent savings contributions recorded in recent activity.
- Recent balance timeline focused on the latest few days of activity.
- Fuzzy recipient resolution with self-transfer protection.
- Atomic debit/credit operations and insufficient-funds protection.
- Background expiry sweeper for unconfirmed transactions.
- Runtime health reporting for Ollama and configured model readiness.
- **Face ID enrollment and payment confirmation** using face-api.js in the browser.
- Responsive Next.js dashboard with Framer Motion and accessible controls.

## Architecture

```text
Browser voice or chat (mic, text, Face ID)
        |
        v
Next.js dashboard (App Router)
   |-- FaceIDEnroll.tsx      enrolls face via webcam, stores 128-dim embedding
   |-- FaceIDConfirm.tsx     verifies face before money actions are confirmed
   |-- openWakeWord.ts       always-on "Hey Wallet" trigger word
   |-- useVoiceLoop.ts       wake-word -> STT -> /agent/act -> confirm pipeline
        |
        | /api proxy
        v
FastAPI routers
        |
        +--> Intent parser and conversational assistant
        |       +--> Ollama: DeepSeek first
        |       +--> OpenRouter fallback when configured
        |       +--> deterministic regex fallback
        |
        +--> Resolver: recipient and amount validation
        |
        +--> Transaction engine
        |       +--> pending -> completed/cancelled
        |       +--> atomic debit and credit
        |       +--> idempotency
        |       +--> TTL expiry sweeper
        |
        +--> SQLAlchemy + SQLite demo ledger
```

### Safety boundary

Every money-moving action follows this sequence:

```text
user speech/text
  -> intent parsing
  -> deterministic validation and recipient resolution
  -> pending transaction or request
  -> review card and spoken review
  -> Face ID confirmation (when enrolled)
     -- browser captures webcam frame
     -- extracts 128-dim embedding
     -- cosine similarity vs locally-stored reference
     -- match -> proceeds; mismatch -> cancel
  -> atomic ledger mutation
  -> spoken and visible result
```

The LLM does not receive database write access. Financial phrasing uses database facts and deterministic templates so a model cannot alter a balance in its response. Face ID matching runs entirely in the browser; the server only stores an opaque 128-dimensional float vector that cannot be reverse-engineered into a photograph.

## Face ID

Face ID replaces the typed "yes" / spoken confirmation for money actions. It is a **demo biometric**, not a security boundary:

- **Browser-only matching.** A webcam frame is captured, the [face-api.js](https://github.com/justadudewhohacks/face-api.js) detector (tiny_face_detector + face_landmark_68_tiny + face_recognition_net) produces a 128-dim embedding, and cosine similarity is compared against the reference vector in `localStorage`. The server never sees the raw frame.
- **Server-side opaque blob.** The backend stores only the 128-dim float array for cross-device recovery and for the "I deleted localStorage" case. There is no way to recover the original face from that array.
- **Enrollment.** Settings -> Face ID -> Enroll. Captures six frames over ~2 seconds and averages them to produce a stable reference (per-frame jitter ~0.02 cosine, averaging reduces it ~sqrt(6) ≈ 2.5x).
- **Re-enrollment.** Overwrites the previous embedding both on the server and in `localStorage`.
- **Removal.** Settings -> Remove. Clears both copies.
- **Threshold.** `FACE_MATCH_THRESHOLD = 0.6` (cosine similarity). Mismatches surface as "different face detected" rather than a silent retry, so a shoulder-surfer cannot brute-force the prompt.

**Threat model.** This raises the cost of accidental shoulder-surfing and prevents a casual user from confirming while a different person is at the screen. It is NOT a security boundary -- the matching is fully client-side and trivially bypassable by anyone with browser DevTools. Real biometric confirmation for money would require server-side liveness detection, secure enclaves, and an actual authentication layer on top.

### Model weights

The three face-api.js model files (~4.4 MB total) live in `frontend/public/models/face-api/`:

| File                                | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `tiny_face_detector_model-*`        | Lightweight face detector (~190 KB).                   |
| `face_landmark_68_tiny_model-*`     | 68-point landmark predictor for face alignment.        |
| `face_recognition_model-*`          | Produces the 128-dim embedding used for matching.      |

The `face_recognition_model` weights are split across **two shards** (`shard1` and `shard2`) -- both are required or the recognition net will fail with a tensor-shape error. The other two models are single-shard. To re-download (after a `face-api.js` upgrade), see `frontend/public/models/face-api/README.md`. The `Cache-Control: immutable, max-age=31536000` header in `next.config.js` keeps the browser from re-fetching these on every visit.

## Project structure

```text
wallet/
├── README.md
├── AUDIT.md
├── AUDIT-2026-09-29.md
├── .gitignore
├── backend/
│   ├── .env.example
│   ├── requirements.txt
│   ├── app/
│   │   ├── config.py        Environment configuration and model cascade
│   │   ├── db.py            SQLAlchemy engine and SQLite migration bootstrap
│   │   ├── engine.py        Atomic money engine and state machine
│   │   ├── llm.py           Intent parsing, chat, and safe phrasing
│   │   ├── main.py          FastAPI application and health checks
│   │   ├── models.py        Users, accounts, transactions, requests, goals
│   │   ├── resolver.py      Recipient and amount validation
│   │   ├── schemas.py       API contracts
│   │   ├── seed.py          Reproducible demo users and billers
│   │   ├── voice_io.py      STT/TTS integrations
│   │   └── routers/
│   │       ├── accounts.py   Accounts, history, requests, savings goals, Face ID
│   │       ├── agent.py      Chat, intent actions, review, confirmation
│   │       └── voice.py      Audio transcription and server TTS trigger
│   └── tests/
│       ├── conftest.py
│       ├── test_accounts.py
│       ├── test_agent_chat.py
│       ├── test_engine.py
│       ├── test_face_endpoints.py
│       └── test_llm_fallback.py
└── frontend/
    ├── package.json
    ├── package-lock.json
    ├── next.config.js
    ├── app/
    │   ├── page.tsx          Main dashboard
    │   ├── login/page.tsx    Demo user picker
    │   ├── layout.tsx        Metadata and app shell
    │   ├── globals.css       Theme and layout utilities
    │   └── icon.svg          Wallet app icon
    ├── components/
    │   ├── FaceIDEnroll.tsx  Webcam enrollment UI
    │   ├── FaceIDConfirm.tsx Webcam verification UI
    │   ├── SettingsModal.tsx Settings + Face ID management
    │   └── ...                Dashboard, voice, split, savings, and forms
    ├── hooks/
    │   └── useVoiceLoop.ts   Wake-word -> STT -> agent -> confirm
    ├── lib/
    │   ├── face.ts           Browser-side face detection (face-api.js)
    │   ├── face-storage.ts   localStorage mirror for the embedding
    │   ├── api.ts            Typed API client
    │   └── speech.ts         TTS playback helper
    ├── voice/
    │   ├── openWakeWord.ts   Always-on wake-word listener
    │   ├── MicCapture.ts     Microphone capture
    │   ├── ConfirmListener.ts Yes/no confirmation capture
    │   ├── sileroVAD.ts      Voice activity detection
    │   └── voiceStore.ts     Voice state machine
    └── public/
        └── models/
            ├── face-api/     face-api.js weights (3 models, ~4.4 MB)
            ├── alexa_v0.1.onnx
            ├── embedding_model.onnx
            ├── melspectrogram.onnx
            └── silero_vad.onnx
```

## Requirements

- macOS, Linux, or Windows with Python 3.11+.
- Node.js 18+ and npm.
- Ollama for local AI conversation. The tested local model is `deepseek-coder-v2:16b`.
- A browser with **microphone AND webcam** permissions for voice input and Face ID.
- Optional: Edge TTS, Qwen3-TTS, or another configured TTS backend.
- Optional: an OpenRouter API key for cloud conversational fallback.

The repository intentionally does not commit `backend/.venv`, `frontend/node_modules`, `.next`, `backend/.env`, or live SQLite WAL files. These are machine-specific, large, generated, or secret. The face-api.js and wake-word ONNX weights **are** committed so the demo works out-of-the-box.

## Setup

### Start Ollama

```bash
ollama list
ollama pull deepseek-coder-v2:16b
```

The application uses DeepSeek first. OpenRouter free models are configured as a fallback list, but require an API key.

### Start the backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

A healthy response includes `ollama_reachable: true` and `deepseek-coder-v2:16b` in `llm_models_ready`.

### Start the frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. If the port is occupied, Next.js prints another local port. On first visit the browser will download the face-api.js and wake-word model weights (~4.4 MB + ~3 MB, served from `/public/models/`). Subsequent visits hit the browser's immutable cache.

## How to use it

Select a demo account, then use the text box, the waveform voice button, or the wake word.

```text
how are you
check my balance
show my recent transactions
send 500 to rishad
request 300 from bikash
split 900 between rishad arman
```

Money actions create a review card first. Confirm with the button, say `yes`, or look at the camera for Face ID (if enrolled). Say `no` to cancel. Casual conversation does not create a financial action.

### Face ID workflow

1. Open Settings (gear icon) -> Face ID -> **Enroll**. Allow camera access, hold still, wait for the progress bar to fill, save.
2. The next time a money action prompts for confirmation, the Face ID camera opens automatically. Look at the camera. On match (cosine similarity ≥ 0.6), the action proceeds.
3. To remove Face ID for a user: Settings -> Face ID -> **Remove**.

## Environment configuration

Copy `backend/.env.example` to `backend/.env`.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Local Ollama endpoint |
| `LLM_CASCADE` | `deepseek-coder-v2:16b` | Ordered local model cascade |
| `OPENROUTER_API_KEY` | empty | Optional cloud fallback key |
| `OPENROUTER_MODELS` | free model list | Cloud fallback models |
| `DB_PATH` | `./wallet.db` | SQLite database path |
| `PENDING_TTL_SECONDS` | `60` | Review expiry window |
| `TTS_ENGINE` | `qwen` | `edge`, `qwen`, or `off` |
| `STT_MODEL` | `base` | Faster Whisper model |
| `STT_COMPUTE` | `int8` | Faster Whisper compute mode |

Frontend settings (Ollama URL, model cascade, OpenRouter key, TTS voice, STT model, Face ID) can be changed at runtime via the Settings modal and are persisted via `PATCH /settings`.

Never commit `backend/.env` or API keys.

## Tests and validation

Backend:

```bash
cd backend
.venv/bin/python -m compileall -q app tests
.venv/bin/python -m pytest -q
```

Frontend:

```bash
cd frontend
npm run build
```

The tests cover atomic transfers, insufficient funds, idempotency, expiry, split confirmation and cancellation, request payments, account history, balance timelines, chat fallback, factual response safety, and Face ID enrollment/status/remove endpoints.

## API overview

| Endpoint | Purpose |
|---|---|
| `GET /health` | Backend, Ollama, and model readiness |
| `GET /users` | Demo users |
| `GET /users/{id}/history` | Recent ledger activity and balance timeline |
| `GET /users/{id}/requests` | Pending requests payable by the user |
| `GET /users/{id}/savings-goals` | Festival savings goals |
| `POST /users/{id}/savings-goals` | Create a savings goal |
| `POST /users/{id}/savings-goals/{goal}/contribute` | Idempotent savings contribution |
| `GET /users/{id}/face` | Face ID enrollment status |
| `POST /users/{id}/face` | Enroll or re-enroll the 128-dim embedding |
| `DELETE /users/{id}/face` | Remove Face ID for a user |
| `POST /agent/act` | Parse and prepare an action |
| `POST /agent/confirm` | Confirm or cancel a pending money action |
| `POST /agent/chat` | Casual conversation and read-only questions |
| `POST /voice/transcribe` | Convert browser audio to text |
| `POST /voice/speak` | Trigger server-side TTS playback |

## Recovery after deleting the project

```bash
git clone https://github.com/bikash-20/AI-AUTOMATED-MONEY-MOVEMENT-SYSTEM.git wallet
cd wallet/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
cd ../frontend
npm install
```

Then start Ollama, the backend, and the frontend using the commands above. The SQLite schema and seed users are recreated automatically. The model weights under `frontend/public/models/` are committed to the repository, so the first browser load is offline-capable. A deleted local database is runtime demo state; the application source and setup remain recoverable from Git.

## Production readiness

This repository is production-oriented for a local demo and development environment. Before handling real money, add real authentication, PostgreSQL, Alembic migrations, TLS, secure CORS, rate limiting, CSRF protection, secret management, durable queues, audit-log retention, backups, alerting, reconciliation, threat modeling, penetration testing, and compliance review. Face ID is a UX convenience for the demo, not a security boundary -- production biometric confirmation requires server-side liveness detection, secure enclaves, and an actual authentication layer.

The deterministic transaction boundary and idempotency rules are the foundation for those next steps.

## License

No license has been selected yet. Add an explicit license before distributing this project publicly.

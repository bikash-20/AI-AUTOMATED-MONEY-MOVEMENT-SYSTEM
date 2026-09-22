# Wallet

## Digital AI Money Movement Platform

Wallet is a voice-first, chat-enabled money movement platform for everyday financial actions. It combines a deterministic financial ledger with local AI conversation, speech recognition, natural voice output, explicit transaction confirmation, split payments, requests, recent activity, and festival savings goals.

The system is designed around one non-negotiable rule:

> The AI may understand language and make the experience feel human, but it never owns the ledger and never invents financial facts.

Balances, recipients, amounts, transaction state, idempotency, and money movement are controlled by deterministic Python and SQLAlchemy code.

## Capabilities

- Voice and text conversation with casual chat support.
- Voice input through browser microphone and Faster Whisper transcription.
- Voice responses through browser speech synthesis plus optional server-side TTS.
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
- Responsive Next.js dashboard with Framer Motion and accessible controls.

## Architecture

```text
Browser voice or chat
        |
        v
Next.js dashboard
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
  -> explicit confirmation
  -> atomic ledger mutation
  -> spoken and visible result
```

The LLM does not receive database write access. Financial phrasing uses database facts and deterministic templates so a model cannot alter a balance in its response.

## Project structure

```text
wallet/
├── README.md
├── .gitignore
├── backend/
│   ├── .env.example
│   ├── requirements.txt
│   ├── repro_500.py
│   ├── app/
│   │   ├── config.py       Environment configuration and model cascade
│   │   ├── db.py           SQLAlchemy engine and SQLite migration bootstrap
│   │   ├── engine.py       Atomic money engine and state machine
│   │   ├── llm.py          Intent parsing, chat, and safe phrasing
│   │   ├── main.py         FastAPI application and health checks
│   │   ├── models.py       Users, accounts, transactions, requests, goals
│   │   ├── resolver.py      Recipient and amount validation
│   │   ├── schemas.py       API contracts
│   │   ├── seed.py          Reproducible demo users and billers
│   │   ├── voice_io.py      STT/TTS integrations
│   │   └── routers/
│   │       ├── accounts.py  Accounts, history, requests, savings goals
│   │       ├── agent.py     Chat, intent actions, review, confirmation
│   │       └── voice.py     Audio transcription and server TTS trigger
│   └── tests/
│       ├── conftest.py
│       ├── test_accounts.py
│       ├── test_agent_chat.py
│       ├── test_engine.py
│       └── test_llm_fallback.py
└── frontend/
    ├── package.json
    ├── package-lock.json
    ├── app/
    │   ├── page.tsx        Main dashboard
    │   ├── layout.tsx      Metadata and app shell
    │   ├── globals.css     Theme and layout utilities
    │   └── icon.svg        Wallet app icon
    ├── components/         Dashboard, voice, split, savings, and forms
    └── lib/                API client, session, idempotency, speech output
```

## Requirements

- macOS, Linux, or Windows with Python 3.11+.
- Node.js 18+ and npm.
- Ollama for local AI conversation. The tested local model is `deepseek-coder-v2:16b`.
- A browser with microphone permission for voice input.
- Optional: Edge TTS, Qwen3-TTS, or another configured TTS backend.
- Optional: an OpenRouter API key for cloud conversational fallback.

The repository intentionally does not commit `backend/.venv`, `frontend/node_modules`, `.next`, model weights, `.env`, or live SQLite WAL files. These are machine-specific, large, generated, or secret. They can be recreated exactly with the commands below.

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

Open `http://localhost:3000`. If the port is occupied, Next.js prints another local port.

## How to use it

Select a demo account, then use the text box or waveform voice control.

```text
how are you
check my balance
show my recent transactions
send 500 to rishad
request 300 from bikash
split 900 between rishad arman
```

Money actions create a review card first. Confirm with the button or say `yes`. Say `no` to cancel. Casual conversation does not create a financial action.

Festival savings can be created for Eid, Durga Puja, Pohela Boishakh, Valentine's Day, or another event. Contributions reduce the available wallet balance and appear in recent activity with idempotent replay protection.

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
| `TTS_ENGINE` | `edge` | `edge`, `qwen`, or `off` |
| `STT_MODEL` | `base` | Faster Whisper model |
| `STT_COMPUTE` | `int8` | Faster Whisper compute mode |

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

The tests cover atomic transfers, insufficient funds, idempotency, expiry, split confirmation and cancellation, request payments, account history, balance timelines, chat fallback, and factual response safety.

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

Then start Ollama, the backend, and the frontend using the commands above. The SQLite schema and seed users are recreated automatically. A deleted local database is runtime demo state; the application source and setup remain recoverable from Git.

## Production readiness

This repository is production-oriented for a local demo and development environment. Before handling real money, add real authentication, PostgreSQL, Alembic migrations, TLS, secure CORS, rate limiting, CSRF protection, secret management, durable queues, audit-log retention, backups, alerting, reconciliation, threat modeling, penetration testing, and compliance review.

The deterministic transaction boundary and idempotency rules are the foundation for those next steps.

## License

No license has been selected yet. Add an explicit license before distributing this project publicly.

# Wallet — Senior Code Audit

**Auditor perspective:** 10+ years of full-stack / fintech engineering, payments + ledger focus.
**Scope:** `backend/` (FastAPI + SQLAlchemy + SQLite, voice/STT/TTS pipeline), `frontend/` (Next.js 14 App Router), `tests/`, configs.
**Single commit (`871c1df`)**: greenfield build, no production history.
**Overall verdict:** This is a **well-structured, safety-conscious prototype** that is **not production-ready for handling real money**. The ledger boundary and the "LLM never owns the ledger" principle are good. There are, however, several **high-severity correctness/security issues** that must be fixed before any user-facing deployment — and a long list of reliability, performance, and maintainability improvements.

Severity legend: **CRITICAL** (blocker for real money), **HIGH** (blocker for multi-user or networked use), **MEDIUM** (significant bug class or maintainability), **LOW** (nit / nice-to-have).

---

## 1. Top-line summary

### What is done well
- **Sound safety boundary.** LLM never writes to DB; intents are normalised by deterministic resolvers; pending → confirm/cancel/TTL state machine; idempotency keys; atomic debit/credit. This is the right architecture for an AI-driven payments demo.
- **Deterministic fallback.** When Ollama/OpenRouter fail, regex + templates keep the demo alive. Phrasing for factual kinds never touches the LLM (`_FACTUAL_PHRASE_KINDS` guard).
- **Schema discipline.** `Numeric(12,2)` for money, `CHECK (balance >= 0)`, `UNIQUE(initiator_user_id, idempotency_key)`, indexes on hot columns. Models use `Mapped[...]` typing, Enum-as-text for portability.
- **Idempotency replay handling.** `_find_idempotent_*` + `IdempotencyReplay` signals are present for both sends and requests. The router returns the same `pending_id` on replay instead of double-charging. Good.
- **Atomicity on split.** `create_pending_split` creates N children under one parent and the balance check happens before any child row is written, then `confirm_split` operates on the parent group with `with_for_update()`.
- **Frontend UX.** Glass/plum palette, animations, accessible buttons, mobile-friendly grid, voice confirm listening state. The intent classification in `ChatBar` is a nice pragmatic shortcut.

### What is wrong (the things that matter)
1. **CORS `allow_origins=["*"]` + public PATCH `/settings`** lets any browser script on any origin read state and **write** runtime config including the OpenRouter key. This is a CRITICAL authn/authz gap.
2. **Zero authentication.** Every endpoint trusts a `user_id` path/query/body field. Any caller can move any user's money. CRITICAL.
3. **`repro_500.py` is a permanent debug artifact** in the repo, not a test, not gitignored. CRITICAL (cleanliness + accidental public data exposure via the comment in the file).
4. **`agent._handle_request_action` references an undefined `payer_handle`** inside an `except engine.IdempotencyReplay_for_request` branch that is only reachable via a bug (the branch is also unreachable: `create_pending_send` never raises `IdempotencyReplay_for_request`). HIGH.
5. **`engine.pay_request` re-reads `payer_user_id` from the request row** in `accounts.py` `pay_request_endpoint` *after* opening the session and re-checks nothing about authz, and the endpoint does not take a `payer_user_id` from the caller — see point 2. HIGH.
6. **`engine._execute` and `pay_request` are not protected with row-level locking** against concurrent debits. A concurrent confirm of two pending txns can both pass the balance check and produce a negative balance (the CHECK constraint will save you on most DBs, but SQLite with `synchronous=NORMAL` won't surface it as a constraint error during the same txn). HIGH.
7. **`PATCH /settings` writes to module-level `config.OLLAMA_URL` etc. in-process**, including a runtime-supplied `OPENROUTER_API_KEY`. There is no input validation, length cap, or sanitisation; a malformed URL crashes `_probe_ollama` (caught) but `openrouter_url` of `https://evil.example` will silently redirect API calls. HIGH.
8. **LLM `intent_dict.get("amount")` is `float`, then immediately used in `Decimal(str(raw))` paths**. The schemas declare `amount: Optional[float]`, which can lose precision. Acceptable for BDT (2dp), but `1.0e-30` or `inf` should be rejected. MEDIUM.
9. **No request validation that `recipient_handle` does not contain a comma / SQL meta** — fortunately SQLAlchemy parameterises, so it's a non-issue, but `note` is 140 chars unbounded unicode. MEDIUM (XSS risk if rendered raw — see UI checks).
10. **No CSRF protection** on POST endpoints that mutate state. HIGH (paired with CORS=* this becomes RCE-equivalent for an attacker page).

I'll go deeper below.

---

## 2. Security & authz (CRITICAL/HIGH)

### 2.1 No authentication / no session binding — CRITICAL
Every router accepts a `user_id` from the URL or the request body:
- `POST /agent/act` takes `{user_id, text, idempotency_key}` — any caller can drive **any** user.
- `POST /agent/confirm` takes `{user_id, pending_id, …}` — same.
- `POST /users/{user_id}/savings-goals/{goal_id}/contribute` — same.
- `POST /requests/{request_id}/pay` — derives `payer_user_id` from DB (good), but the caller doesn't have to prove they are that payer. **Anyone can pay anyone's pending request.**
- `GET /users`, `/users/{id}/history`, `/users/{id}/balance`, `/users/{id}/requests`, `/users/{id}/savings-goals` — full PII (phone, display_name, balance, history) is world-readable.

The frontend "login" only writes a number into `localStorage` and the dashboard reads it back. There is **no server-side trust check** that ties the bearer (cookie/JWT/header) to that user.

**Fix:**
- Introduce real auth (JWT or session cookie).
- Move `user_id` from path/body to server-derived identity (`Depends(get_current_user)`).
- Add an `ownership` check helper for every `/users/{id}/...` route.
- Audit log every money-mutating call.

### 2.2 CORS `allow_origins=["*"]` — CRITICAL
`backend/app/main.py:49` allows every origin with every method and every header. Combined with cookie-less state, this is currently mitigated only because the API holds no secrets *server-side* worth exfiltrating — but it lets a malicious page **invoke `/agent/confirm`** on behalf of any user once auth lands (and even now, drive `/agent/act` for any `user_id`).

**Fix:** restrict to the explicit frontend origin in non-dev, never wildcard once auth exists. Use `allow_credentials=True` only with explicit origins.

### 2.3 `PATCH /settings` accepts and stores runtime secrets — HIGH
`main.py:140-167`. The endpoint happily accepts `openrouter_api_key`, `ollama_url`, `tts_engine`, etc., and mutates module-level `config.*` in-process. Issues:
- No auth → any caller can rotate the OpenRouter key. Once a user configures one, anyone can replace it.
- The settings live in-process and die on restart; that's a UX bug, but the bigger issue is that the endpoint writes them to a global, which means **concurrent reads can see partially-updated state** (no lock).
- The endpoint echoes back via `get_settings()` after write, which **leaks the key if it were ever returned** (currently it doesn't, but only because the writer is careful; the contract is fragile).

**Fix:** gate behind admin auth, validate URLs with `httpx.URL` and reject anything not http(s), add a max length for keys, store in a single source-of-truth dict under a lock.

### 2.4 No rate limiting / no abuse controls — HIGH
`/agent/act`, `/agent/confirm`, `/voice/transcribe` can be hammered. There's no per-IP / per-user quota, and `transcribe` is an unbounded file upload (no `max_size` cap). Worse, STT cost is non-trivial (faster-whisper is CPU-heavy).

**Fix:**
- Add `slowapi` or a tiny token-bucket per IP/user.
- Cap `audio` upload size (e.g. 10 MB) in the route (`audio: bytes = File(..., max_length=10_000_000)`).
- Consider per-user concurrency caps on `/agent/act`.

### 2.5 Idempotency key is a free-text client field — MEDIUM
`idempotency_key: str = Field(min_length=8, max_length=64)`. There's no proof the client is honest; a malicious caller can pre-generate keys for `bikash` to grief future legit replays. In practice this just causes "IdempotencyReplay" errors for bikash — annoying but not destructive. Still, document the trust model: the key prevents double-spend only **in cooperation with the client**.

### 2.6 `repro_500.py` is a stray script in the repo — CRITICAL (cleanliness)
`backend/repro_500.py` is a hand-rolled debug reproducer that:
- Sets `os.environ["OLLAMA_URL"]` *before* importing the app (which works because `config.py` reads env at import-time — fragile).
- Seeds the DB and prints `r.text[:2000]` from `/agent/act` to stdout.

This file shouldn't ship. It is **not** in `tests/`, has no `__test__` marker, isn't excluded by `pytest`'s default config (it would be picked up as a test if it had `test_` prefix, but it does not — so it just lingers). Move it to a `scripts/` or `debug/` folder or delete it. Add `tests/__test__` collection ignore for non-test helpers if you keep any.

### 2.7 STT endpoint accepts arbitrary bytes — MEDIUM
`/voice/transcribe` accepts `audio: bytes = File(...)` with no content-type enforcement, no mime sniffing, no size cap. A 1 GB file would OOM the worker. Add a hard cap and decode-time validation.

---

## 3. Correctness & money-safety (HIGH)

### 3.1 Concurrent confirms can overdraw — HIGH
`engine._execute` does:
```python
src = session.get(Account, txn.from_account_id)
if src.balance_bdt < txn.amount_bdt: raise InsufficientFunds(...)
src.balance_bdt = src.balance_bdt - txn.amount_bdt
```
There is **no `SELECT ... FOR UPDATE`** on the source account. With `synchronous=NORMAL` on SQLite, two concurrent threads can both:
1. Read balance 500.
2. See `500 >= 500`, proceed.
3. Both write `0`, but actually **both** decrement, producing `-500`.

The DB-level `CHECK (balance_bdt >= 0)` *should* prevent commit, but only if the constraint fires inside the transaction. SQLite's enforcement is reliable, but the race window between the in-Python check and the flush still exists; you'd better rely on the DB constraint, not the in-Python check.

In `confirm_split`, `with_for_update()` is used on the children, but **not** on the source account row. So the balance row is still free to race.

**Fix:** wrap `_execute` in `with session.begin():` and acquire `SELECT ... FROM accounts WHERE id=:id FOR UPDATE` first; or use `with_for_update(of=Account)` on the source account. Keep the Python pre-check, but treat it as advisory. Make the Python check + DB write atomic by re-reading inside the locked section.

### 3.2 `agent._handle_send` references undefined `payer_handle` — HIGH
`backend/app/routers/agent.py:237-246`:
```python
except engine.IdempotencyReplay_for_request as replay:
    return AgentActResponse(
        text=llm.phrase(
            "request_created",
            {"payer": payer_handle, "amount_bdt": str(replay.req.amount_bdt)},
        ),
        ...
    )
```
- `payer_handle` is undefined in `_handle_send` scope (it lives in `_handle_request_action`).
- `IdempotencyReplay_for_request` cannot be raised by `engine.create_pending_send` — that exception comes from `create_pending_request`. So this `except` is **dead code**.

This means if a future refactor raises `IdempotencyReplay_for_request` from inside `create_pending_send`, we'd hit a `NameError` and return 500. Currently dead, but a footgun.

**Fix:** delete the dead `except` branch. If you want a fallback, move the handling to `_handle_request_action` where the variables exist.

### 3.3 `engine.pay_request` does not lock the request row — HIGH
Two concurrent `/requests/{id}/pay` calls for the same pending request can both pass `status=PENDING`, both create `Transaction` rows, both debit/credit. There's no `with_for_update()` on the `Request` row.

**Fix:** `req = session.query(Request).filter_by(id=request_id).with_for_update().one()` and re-check status inside the lock.

### 3.4 Sweeper does not acquire row locks — MEDIUM
`Sweeper._tick` bulk-updates pending → cancelled without `with_for_update()`. The race with `confirm()` is: sweeper sets cancelled, then confirm() reads and sees pending again (or vice versa). This is unlikely because confirm() re-reads inside the same txn, but it would be cleaner to use `with_for_update(skip_locked=True)`.

### 3.5 `agent_act` idempotency-replay branch returns wrong review text — MEDIUM
`agent.py:84-102`. When an existing pending send is found:
```python
"resulting_balance_bdt": str(
    _post_debit_balance(s, req.user_id) - existing.amount_bdt
),
```
This is correct. But it always builds a `ReviewCard(kind="send", …)` regardless of `existing.kind`. If the same idempotency key was previously used for a split child or bill, the card is wrong. The same key cannot legitimately be reused across kinds (the engine's idempotency is per-(user, key) regardless of kind), so this is mostly a UX correctness bug for misuse. Tighten by validating `existing.kind` matches the action.

### 3.6 `engine._find_idempotent_txn` is called inside an open txn — LOW/MEDIUM
The flow `create_pending_*` calls `_find_idempotent_txn` then flushes; between them, another session could insert a row. The subsequent `IntegrityError` catch retries with a re-read — that's the correct pattern. But the **first read** doesn't `with_for_update()` — concurrent inserts racing each other would result in one success and one `IntegrityError`, which is fine. Just document this and consider adding a `SELECT ... FOR UPDATE` to prevent unnecessary retries under contention.

### 3.7 Resolver `_normalize` strips zero-width chars? No — LOW
Handles with embedded spaces or punctuation can leak. `re.sub(r"\s+", " ", s.strip().lower())` only collapses whitespace. A handle like `bi kash` would not match `bikash`. Acceptable for a demo, but worth noting in docs.

### 3.8 `pay_request` writes `idempotency_key=f"reqpay:{idempotency_key}"` but doesn't pre-check for an existing payment — LOW
If `/requests/{id}/pay` is called twice with the same key, you get two `Transaction` rows. There is no UNIQUE constraint guarding `requests.linked_txn_id` from being set twice (the row is updated to a new id). Consider making `Request.linked_txn_id` UNIQUE and pre-checking.

### 3.9 `_collect_with_fallback` swallows all exceptions — LOW (intentional but worth flagging)
`llm.py:126-128`:
```python
except Exception as e:
    last_err = e
    sys.stderr.write(f"[llm] {label} failed: {type(e).__name__}: {e}\n")
```
Good for resilience. But you also swallow `KeyboardInterrupt`? No — `Exception` doesn't include `KeyboardInterrupt`/`SystemExit`, so you're fine. Just be aware that any logging library config you adopt may want to capture `last_err` more loudly.

### 3.10 `_post_debit_balance` is mis-named and confusing — LOW
The function returns the **current** balance (debit hasn't happened yet). Reads would be clearer if renamed `_current_balance`.

### 3.11 `agent.py:_handle_pay_bill` swallows `resolver.ResolutionError` — LOW
```python
try:
    biller = resolver.resolve_biller(raw_biller, billers) if raw_biller else ""
except resolver.ResolutionError:
    biller = ""
```
A misspelled biller is silently turned into "Which biller?" — fine — but there's no log. Add a debug log.

### 3.12 `HistoryResponse` `timeline` shape is untyped — MEDIUM
`timeline: list[dict]` instead of a typed list. Frontend relies on `data[i].date` and `data[i].balance`. Pydantic v2 + `TypedDict` would catch mistakes.

### 3.13 `voice_io._speak_blocking` polls `pgrep` — LOW
`while subprocess.run(["pgrep", ...])` is a tight-ish loop with 200ms sleep. Acceptable, but blocking the TTS worker thread for the entire speech duration serialises all TTS jobs. If you queue 5 messages, message #5 won't play for ages. Consider playing in-process via `sounddevice` or `pygame`, or at least don't block on the queue.

---

## 4. Data layer & migrations (HIGH)

### 4.1 SQLite WAL + filesystem DB — HIGH (production-readiness)
`db.py` enables WAL on every connect — fine for SQLite demo — but this codebase is explicitly aimed at money movement. SQLite is fine for read-heavy, single-writer dev; **not for production concurrency**. The README acknowledges this. Plan Postgres + Alembic **now** — the schema is portable, but you haven't tested a real migration path.

### 4.2 In-place migration in `init_db` — MEDIUM
`db.py:60-90` does a `CREATE TABLE IF NOT EXISTS` then a hand-rolled `ALTER TABLE requests ADD COLUMN idempotency_key` for legacy rows. This is acceptable for a single-developer SQLite, but:
- It runs every startup; the `inspect()` call is wasteful.
- It uses `DEFAULT ''` which masks missing data; backfill with a real key (`legacy-request:{id}`) is good.
- This will break on Postgres (different DDL).

**Fix:** Alembic. Period.

### 4.3 `Numeric(12,2)` caps at 999,999,999.99 — LOW
Per-account balances cap at ~10M BDT. With bikash seeded at 50k, fine. But for real money, this is the kind of silent overflow you only notice in an audit. `Numeric(20,2)` costs nothing.

### 4.4 No PII redaction on logs — MEDIUM
`sys.stderr.write(f"[llm] openrouter:{model} failed: {type(e).__name__}: {e}\n")` — if `e` contains the user's prompt, that's PII into logs. The LLM does receive `f"User said: {text!r}"`, and the upstream error from OpenRouter could echo the request body. Strip PII before logging.

### 4.5 No DB-level CHECK on `transactions.amount_bdt > 0` — LOW
You validate in the resolver, but a direct DB write could create a negative-amount txn. Add `CheckConstraint("amount_bdt > 0")` on `transactions`.

### 4.6 `Transaction.completed_at` is nullable but should be NOT NULL when status is 'completed' — LOW
Partial index / CHECK constraint would let queries be cheaper.

### 4.7 `Request.idempotency_key` defaulted to `""` — LOW
`default=""` masks legacy rows; once migrated, set `nullable=False` and remove the default.

---

## 5. LLM / AI safety (HIGH)

### 5.1 `phrase()` falls back to LLM for chat kinds — MEDIUM
`phrase()` checks `_FACTUAL_PHRASE_KINDS` and routes only those to deterministic templates. **All other kinds** still go through the LLM. Good design choice, but: `phrase("request_created", …)` uses LLM, but you've defined it as a factual kind — verify the call sites always pass only factual kinds, otherwise a hallucination could appear in user-facing text. Quick grep:

```
phrase("request_created", ...)   # factual ✓
phrase("request_paid", ...)      # factual ✓
```

Looks consistent in current code. Worth a unit test that fails if any non-factual kind is added to `_FACTUAL_PHRASE_KINDS` *and* used in a financial fact path.

### 5.2 `chat_reply` always runs through LLM — LOW (acceptable)
Even when Ollama is dead, fallback exists via `_deterministic_chat`. Good.

### 5.3 `parse_intent` falls back to regex but the regex is fuzzy on actions — MEDIUM
`_classify_action` checks substrings: `if any(k in t for k in _SEND_TRIGGERS): return "send"`. If a user says "I want to **pay** my bill", `_PAY_BILL` wins because bill tokens are also checked first; but "**send** the internet bill" would classify as send (correct). Edge cases: "send a thank you" → "send" — false positive. The regex is brittle. Add a "money context" pre-check before accepting an action.

### 5.4 Prompt is on `chat_reply` could leak system prompt into reply — LOW
`chat_reply` strips quotes/backticks but not Markdown code fences. A malicious model output `\`\`\`js\n/* prompt */\`\`\`` would survive stripping. Strip triple backticks too.

### 5.5 `_parse_json_lenient` strips only outer braces — LOW
`start = s.find("{"); end = s.rfind("}")` — if the LLM emits nested objects in a string field, you'd capture too much. Acceptable for the current schema but a single test would catch a regression.

### 5.6 No token-bucket / cost caps on LLM — MEDIUM
A user could say "hi" 1000 times, each call hits Ollama. On the cloud fallback (OpenRouter), this could rack up cost. Add per-user / per-IP rate limit (see §2.4).

### 5.7 OpenRouter response `delta.content` could be empty/null — LOW
Handled: `content = delta.get("content") or ""`.

### 5.8 OpenRouter URL is configurable at runtime via PATCH /settings — HIGH (see §2.3)

---

## 6. Voice pipeline (MEDIUM)

### 6.1 `_synthesize_to_wav` fallback logic is brittle — MEDIUM
```python
if engine == "edge":
    try:
        _edge_synthesize_to_wav(text, out_path); return
    except RuntimeError as e:
        if "edge-tts is not installed" not in str(e):
            raise
        print("  [tts] Edge TTS unavailable; falling back to Qwen3.")
        try:
            _qwen_synthesize_to_wav(text, out_path); return
        except Exception:
            raise RuntimeError("No TTS backend available.") from e
```
- If `_edge_synthesize_to_wav` raises anything other than "edge-tts is not installed", the error propagates.
- If Qwen is also unavailable, the original exception is **chained** via `from e`, but `e` is a `RuntimeError` about edge-tts missing — the user sees that, not the actual Qwen failure. Print/log the Qwen exception too.

### 6.2 `_get_model` lazy-loads Qwen on first speak — MEDIUM
First-speak latency is huge (~5–10s for model load). Show a "loading voice…" status.

### 6.3 `_save_wav` uses `scipy.io.wavfile` — MEDIUM
`wavfile.write` with int16 expects 16-bit values; you clamp to `[-1, 1]` and multiply by 32767, which is correct but lossy. Consider `soundfile` (better at float32 WAV) or write 24-bit for headroom.

### 6.4 TTS worker is one thread, one queue — MEDIUM
TTS plays sequentially. If a user sends 3 messages, the third waits minutes. Consider dropping the oldest or playing in parallel.

### 6.5 `_tts_worker` reads forever — LOW
The `while True` exits only on `None` sentinel. Good, but if `drain_and_stop` puts `None` before the queue is empty, in-flight jobs are dropped. Use a join-with-timeout instead.

### 6.6 STT runs in request thread — MEDIUM
`/voice/transcribe` blocks the worker while whisper loads. First call pays the model-load cost. Consider a warm-up task in lifespan.

### 6.7 `_synthesize_to_wav("off")` writes 1 sample of silence — LOW
Returns an empty WAV so callers don't choke. Fine, but the client thinks audio played. Return a distinct "no audio" sentinel or 204.

### 6.8 `STT.transcribe_bytes` uses `buf.name = "audio.webm"` — LOW
faster-whisper reads the name to dispatch the codec. OK on Chromium (webm/opus). On Safari the recorder might emit `audio/mp4`, so name should reflect the actual `mimeType`. Set `buf.name` based on `mr.mimeType`.

### 6.9 TTS hard-codes `afplay`/`aplay` — LOW
macOS-only assumption. On Linux/Windows you'd want `aplay` (already fallback) or `mpv`. Log a warning rather than silently no-op.

### 6.10 `drain_and_stop()` puts `None` before joining is reliable — LOW
If `task_done` is missing (worker crashed), `_tts_queue.join()` hangs forever.

---

## 7. Frontend (MEDIUM/LOW)

### 7.1 Idempotency key reuse is correct but confusing — LOW
`lib/idempotency.ts` stores a per-tab prefix in sessionStorage. Good. But the same key is used for `/agent/act` (create pending) and `/agent/confirm`. If the first call returns a card, the second call (confirm) **uses the same key** — which is correct because the engine treats the confirm as a separate operation. However, a future contributor might assume "idempotency key == action id" and break it. Document the contract.

### 7.2 `sendIntent` always speaks on confirm/decline — LOW
`speakText(r.text)` runs even when `r.text` is "Cancelled." which is fine; but if r.text is long, TTS plays it. Consider a short variant for confirm/decline.

### 7.3 Chat classification regex is fragile — MEDIUM
`ChatBar.tsx:53-57`:
```js
const isCommand =
  /\b(send|transfer|pay|request|split|balance|history|hi|hello|hey|greetings)\b/.test(norm)
  && /\d/.test(norm)
    ? true
    : /^\s*(send|transfer|pay|request|split|balance|history)\b/.test(norm);
```
"hi please send 500" — both branches true → command. "balance" → first branch false (no digit), second true → command. OK. "send" (no number) — neither true → chat. This is a heuristic; backend's `/agent/chat` will also classify and **fall back to chat** for ambiguous cases. So worst case is the user gets a chat response for a send. Acceptable.

But "send" with no number → goes to chat → `chat_reply` returns a generic "try 'send 500 to rishad'" — fine.

### 7.4 `page.tsx:onVoiceTranscript` confirms on "haan" / Bengali yes — MEDIUM
The affirmative regex includes Bangla words — good. The negative regex is `/no|nope|cancel|stop|nah|না|বাদ|না কর/`. "না কর" includes "না" already so OK. But `থামো` (stop in Bangla) is missing. Add more.

### 7.5 `VoiceButton` cleanup is partial — MEDIUM
On unmount, `recorderRef.current?.stop()` is called, but the `MediaRecorder.stop()` triggers `onstop` which then calls `stream.getTracks().forEach(t => t.stop())` — but if the component is unmounted, `setTranscribing(true)` is called on a dead component. Add an `alive` flag.

### 7.6 `SettingsModal` saves all fields even on partial edits — LOW
The patch always sends every field. If you only meant to change one, you overwrite the others. Add a "dirty" check.

### 7.7 `SettingsModal` writes API key in plaintext to localStorage indirectly — MEDIUM
The key is sent in the PATCH body over the wire. There's no TLS by default in dev (`127.0.0.1`), which is fine for localhost. But the key is held in JS memory and never cleared. Consider not storing the key at all — push it straight to the backend and discard.

### 7.8 `idempotency.ts` SSR fallback uses `Math.random()` — LOW
Acceptable. UUID via `crypto.randomUUID()` is preferred when available — you handle both. OK.

### 7.9 `lib/api.ts:transcribe` uses FormData but doesn't set `Content-Type` — LOW
`fetch` with FormData sets multipart boundary automatically. Good. But the backend uses `audio: bytes = File(...)` — FastAPI parses multipart, OK.

### 7.10 `PendingRequests` Pay button uses `pendingId: -1` to disable all — LOW
`pendingId?: number` with `-1` sentinel is hacky. Pass an `isWorking: boolean` instead.

### 7.11 `SplitForm` only allows 2 recipients — LOW
The README says "2 or more", but UI caps at 2. Either extend the UI or document it.

### 7.12 `SavingsGoals` uses `window.prompt` — LOW
`prompt` is jarring. Replace with an inline input.

### 7.13 `SavingsGoals.target_amount_bdt` is sent as a string from a `type="number"` input — LOW
Backend uses `Decimal` schema; `target_amount_bdt: "500"` parses fine via Pydantic, but locale-formatted numbers ("1,000") will fail. Add input validation.

### 7.14 `LoginPage` lacks keyboard navigation — LOW
Tiles are `<button>`s — good. Missing `aria-label`s for screen readers.

### 7.15 `Dashboard` doesn't show "savings contributions" in recent activity — LOW
The README claims "Contributions reduce the available wallet balance and appear in recent activity". The History endpoint pulls `kind="savings"` transactions, so they show. Good. But the `SavingsGoals` panel doesn't link to those txns.

### 7.16 No offline indicator — LOW
If Ollama is down, the user sees "Loading…" forever on STT. Add a health badge.

### 7.17 No error boundary — MEDIUM
A render error in any component will white-screen the app. Add a top-level `<ErrorBoundary>`.

### 7.18 No service worker / PWA — LOW
Acceptable for a demo. Worth noting.

### 7.19 Build-time typescript `tsconfig.tsbuildinfo` is checked in — LOW
`.gitignore` already excludes it; verify it's actually excluded.

### 7.20 `package-lock.json` is committed but `node_modules` isn't — OK
Standard.

### 7.21 `lucide-react ^1.47.0` is ancient — MEDIUM
Current is `0.460+`. The pinned `1.47.0` may have different exports and is a security hazard (no patches). Bump.

### 7.22 No CSP / security headers — HIGH
Next.js doesn't ship CSP by default. Add `headers()` in `next.config.js` for `Content-Security-Policy`, `Strict-Transport-Security` (when over TLS), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

---

## 8. Backend code quality (MEDIUM)

### 8.1 Module-level mutable state in `config.py` — MEDIUM
`config.OPENROUTER_API_KEY = payload["openrouter_api_key"].strip()` in `main.py:158` mutates a module global. With async workers, this is a race. Move to a `Settings` dataclass guarded by a `threading.Lock` or use FastAPI's dependency-injected settings.

### 8.2 `_collect_with_fallback` defines nested `callable` type hint — LOW
`primary: list[tuple[str, callable]]` — should be `Callable[..., Iterator[str]]` from `typing`. Linter will catch.

### 8.3 `repro_500.py` lives in `backend/` — CRITICAL (already noted in §2.6)

### 8.4 `seed.py` uses a fixed random seed — LOW (intentional)
`random.Random(20260922)` is documented; phones are reproducible. Good. But re-running with a new seed won't re-seed existing users. Document.

### 8.5 `db.py` `reset_engine` exposes mutable global — LOW (test-only)
Document with `# noqa: test-only` or move to `tests/_helpers/`.

### 8.6 Logging is `logging.basicConfig` once at import time — LOW
Replace with structured logging (`structlog` or `loguru`) for production.

### 8.7 Bare `except Exception:` in many places — MEDIUM
`llm.py`, `voice_io.py`, `main.py` — many blanket catches swallow bugs. At minimum, log with traceback.

### 8.8 `agent.py` has a duplicate dead except — HIGH (already noted §3.2)

### 8.9 `schemas.py` has unused imports — LOW
`Optional` is fine. `ConfigDict` is used. No unused.

### 8.10 `engine.py` mixes engine, sweeper, and helpers — MEDIUM
Split into `engine/`, `sweeper.py`, `errors.py`. Currently 600 lines.

### 8.11 `pay_request` uses `from ..models import Biller` lazily inside function — LOW
Move to top-level imports.

### 8.12 `_execute` doesn't handle `Decimal` overflow — LOW
`Numeric(12,2)` will overflow DB-side, raising. Catch `DataError` and convert to a user-friendly error.

### 8.13 `init_db` runs inspect() every startup — LOW (already noted)

### 8.14 `accounts.py` uses both `select()` style and `query()` style — LOW
SQLAlchemy 2.0 prefers `select()`. Migrate for consistency.

### 8.15 No type annotations on response builder helpers — LOW
`ReviewCard` is built without annotations; IDE can't help.

### 8.16 `tests/conftest.py` does `importlib.reload(seed)` — LOW
Works because `seed` is a module-level function. Fragile.

### 8.17 `tests/` covers engine invariants well, but **does not test the routers' HTTP layer** — HIGH
You have:
- `test_engine.py` (engine invariants, good)
- `test_agent_chat.py` (1 test)
- `test_llm_fallback.py` (regex fallback)
- `test_accounts.py` (1 test)

You lack router-level tests for:
- `POST /agent/act` (send, request, split, bill, history, balance, chat)
- `POST /agent/confirm`
- `POST /users/{id}/savings-goals` and `/contribute`
- `POST /requests/{id}/pay` and `/decline`
- `PATCH /settings`

Add these as a `tests/test_api_*.py` series with `TestClient`.

### 8.18 No test for idempotency on requests — MEDIUM
`test_request_idempotency_replay` exists, but doesn't go through the router. Test it end-to-end.

### 8.19 `repro_500.py` is a one-off; consider keeping similar scripts in `scripts/` — LOW

### 8.20 `requirements.txt` doesn't pin major versions tightly — LOW
`faster-whisper>=1.0.0` is fine, but `mlx-audio>=0.2` is a moving target. Pin to known-good.

### 8.21 `requirements.txt` doesn't include `httpx` for the tests — LOW
Actually `httpx>=0.27` is in `requirements.txt` already — good.

### 8.22 No `pyproject.toml` — LOW
Use one for modern Python packaging.

---

## 9. Performance & scale (MEDIUM)

### 9.1 Sweeper runs every 5 seconds and scans whole table — LOW
For a 6-user demo, fine. For production, an indexed partial scan: `WHERE status = 'pending' AND expires_at < now()` with a partial index.

### 9.2 `/users/{id}/history` pulls 50 txns by default — LOW
Fine. Limit/offset would help at scale; consider cursor pagination.

### 9.3 `confirm_split` loads *all* children into memory — LOW
Fine for N≤10, but cap N.

### 9.4 No DB connection pooling tuning — LOW
`create_engine(...)` uses SQLAlchemy defaults; fine for SQLite.

### 9.5 STT load on every request thread — MEDIUM (already noted §6.6)

### 9.6 TTS serial queue — MEDIUM (already noted §6.4)

### 9.7 No caching on `/users` — LOW
6 users, hits DB every page load. Cache in-memory for the lifespan of the app.

### 9.8 No pagination on `/voice/transcribe` history — N/A
Stateless.

### 9.9 `int` overflow risk on `_PKType` — LOW
Integer in SQLite (4-byte signed) caps at 2^31 — fine for a demo. On Postgres `BigInteger`. Document.

---

## 10. Accessibility & UX (LOW)

### 10.1 No `aria-live` for toast / review card updates — LOW
Add `role="status"` and `aria-live="polite"` to the toast.

### 10.2 No focus trap in modals — LOW
The `Ask` / `Split` / `Settings` modals don't trap focus. Add focus trap or rely on a library.

### 10.3 No skip-to-content link — LOW
Standard a11y hygiene.

### 10.4 Color contrast — LOW
Peach on plum should be checked; #f0a585 on #2d2330 has contrast ratio ~7:1 — OK. White/cream on plum 950 is high contrast. Good.

### 10.5 Voice button has no keyboard shortcut — LOW
Pressing Space should toggle recording. Add `onKeyDown`.

### 10.6 No reduced-motion handling — LOW
The animations are nice; respect `prefers-reduced-motion`.

### 10.7 No internationalisation hooks — LOW
The Bangla strings are hardcoded. Plan i18n before the codebase grows.

---

## 11. Observability (MEDIUM)

### 11.1 No metrics endpoint — LOW
Add Prometheus or at least counters in logs.

### 11.2 No request IDs in logs — LOW
Add a middleware that injects a `request_id` and includes it in logs.

### 11.3 No tracing — LOW
OpenTelemetry would let you correlate LLM calls with DB writes.

### 11.4 No alerting hooks — N/A (demo)

### 11.5 Health endpoint exposes internal state — LOW
`/health` reveals `ollama_url`, `openrouter_configured` — fine for local. Remove internal URLs in prod.

### 11.6 PII in logs — already noted §4.4

---

## 12. Concrete remediation plan (prioritized)

**Phase 1 — Make it safe to expose on a network (1–2 weeks)**
1. Add real auth (JWT or session cookie). Bind `user_id` to the caller.
2. Tighten CORS to explicit origin.
3. Add ownership check helper on every `/users/{id}` route.
4. Add per-IP / per-user rate limiting.
5. Lock `_execute` and `pay_request` with `SELECT ... FOR UPDATE` on source account + request row.
6. Cap `/voice/transcribe` upload size and add basic validation.
7. Move `repro_500.py` out of the repo (or gitignore + delete).
8. Fix dead `except IdempotencyReplay_for_request` branch in `_handle_send`.
9. Add CSP + security headers in `next.config.js`.
10. Bump `lucide-react`.

**Phase 2 — Make it safe to handle real money (2–4 weeks)**
1. Migrate to Postgres + Alembic. Drop the in-place `init_db` migration.
2. Increase `Numeric` precision to `Numeric(20,2)`.
3. Add `CheckConstraint("amount_bdt > 0")` on transactions.
4. Structured logging with PII redaction.
5. Audit log table: every confirm/decline/pay contributes a row.
6. Two-step confirmation token (out-of-band).
7. Replace `localStorage`-based "login" with proper auth UI.
8. Add reconciliation report job (daily).

**Phase 3 — Polish (ongoing)**
1. Router-level integration tests (TestClient) covering all money paths.
2. PWA + offline indicator.
3. a11y pass (focus traps, aria-live, prefers-reduced-motion).
4. Observability: request IDs, metrics, tracing.
5. Performance: warm up STT/TTS in lifespan, paginate history.
6. i18n scaffolding.
7. Move `voice_io` to a dedicated process (`subprocess`) to isolate TTS failures.

---

## 13. TL;DR for the next reviewer

- **The ledger is the best part.** Don't let anyone shortcut it. Every fix above is to **protect** the ledger, not change it.
- **The biggest risk today is identity.** No auth + CORS=* + free-text `user_id` is a one-line exploit.
- **The second biggest risk is concurrency.** `_execute` needs `SELECT FOR UPDATE` on the source account.
- **The third is hygiene.** `repro_500.py`, dead `except` branches, and missing router tests are low-effort, high-payoff.
- **Everything else is a polish ticket.**

# TOOLS.md — Relio Environment Configuration

## AI Models

### Primary: Google Gemini
- Model: `gemini-2.5-flash-lite`
- Tasks: Notes generation, date extraction, real-time context, search analysis, pre-meeting briefs
- Key: `GEMINI_API_KEY` in `.env`
- Tier: Free

### Fallback: Groq Llama
- Model: `llama-3.3-70b-versatile`
- Triggered: Automatic on Gemini 429 (rate limit) or 503 (unavailable)
- Key: `GROQ_API_KEY` in `.env`
- Tier: Free

### Transcription: Groq Whisper
- Model: `whisper-large-v3-turbo`
- Fallback: Gemini STT
- Input: WebM/Opus audio chunks
- Key: `GROQ_API_KEY` in `.env`

## Integrations

### Telegram Bot
- Token: `TELEGRAM_BOT_TOKEN` in `.env`
- Chat ID: `TELEGRAM_CHAT_ID` in `.env`
- Sends: Meeting summaries (post-meeting), daily digests (8 AM), pre-meeting briefs (1 hour prior)
- Formatting: Compact markdown, falls back to plain text on parse errors

### Google Calendar
- Auth: OAuth2 via `credentials.json` in project root
- Token: Auto-generated `token.json` after first auth
- Browser: `OAUTH_BROWSER` env var (`start` on Windows, `open` on macOS, `xdg-open` on Linux)
- Capability: Read events + inject new events from extracted meeting dates

### Obsidian Vault
- Path: `vault/` in project root
- Structure: `01_Meetings/Post-Meet/`, `01_Meetings/Pre-Meet/`, `02_Skills/`, `03_Projects/`
- Format: Markdown with YAML frontmatter (date, title, rating, tags)

## Audio

- Capture: MediaRecorder API (browser audio)
- Format: WebM/Opus
- Storage: `data/recordings/` (backup, persisted even if transcription fails)
- Real-time window: 30 seconds (hardcoded for `Ctrl+Shift+R`)
- Cooldown: 10 seconds between real-time requests

## Database

- Engine: SQLite via sql.js (in-memory + file persistence)
- Path: `db/` directory
- Stores: Meeting records (id, title, transcript, notes, rating, timestamps)
- Purpose: Meeting history persistence and stats — NOT the primary context system
- Context source: MD files in `agent_core/` and `vault/` are the primary context

## Hotkeys

- `Ctrl+Shift+M` — Start/Stop recording (global)
- `Ctrl+Shift+R` — Real-time 30-second context (global, during recording)
- `Ctrl+Shift+Q` — Search overlay (global)

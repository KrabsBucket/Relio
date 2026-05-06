# Relio — AI Meeting Assistant

## Problem

Meeting context is lost the moment a call ends. Notes are incomplete, action items get forgotten, deadlines slip through cracks, and there is no searchable record of what was discussed. Manual note-taking during meetings splits attention between listening and writing. Existing transcription tools require paid subscriptions, send audio to third-party servers, or produce raw transcripts without actionable structure.

## Solution

Relio is a local-first, privacy-conscious AI meeting assistant built on Electron. It records meetings, transcribes audio using Groq Whisper, generates structured notes with AI (Gemini + Groq Llama fallback), extracts dates and action items, pushes events to Google Calendar, saves notes to an Obsidian vault, and sends compact summaries to Telegram. Everything runs on your machine with free-tier APIs.

The workflow is hotkey-driven:

- `Ctrl+Shift+M` starts and stops a meeting recording.
- `Ctrl+Shift+R` transcribes the last 30 seconds and provides real-time AI context.
- `Ctrl+Shift+Q` opens a search overlay to query your local data files with AI analysis.

## Architecture

```text
Electron Main Process
        |
        +-- MediaRecorder (browser audio capture)
        +-- Groq Whisper API (transcription, free tier)
        +-- Gemini 2.5 Flash Lite (notes, dates, context)
        +-- Groq Llama 3.3 70B (automatic fallback when Gemini is down)
        +-- Google Calendar API (date injection via OAuth2)
        +-- Telegram Bot API (compact meeting summaries)
        +-- SQLite via sql.js (meeting history, in-memory + persistence)
        +-- Obsidian vault (markdown note export)
        +-- Context Engine (identity + vault knowledge)
```

All AI calls go through `safeGenerate()` which tries Gemini first and automatically falls back to Groq Llama on 429/503 errors. Transcription uses Groq Whisper as primary with Gemini STT as fallback.

## Workspace Layout

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | Electron main process, IPC handlers, hotkey registration, scheduling. |
| `src/main/preload.js` | Secure IPC bridge between main and renderer. |
| `src/renderer/app.js` | UI logic, recording lifecycle, search overlay, context display. |
| `src/renderer/index.html` | Application shell and UI components. |
| `src/renderer/index.css` | Dark theme styling with glassmorphism and micro-animations. |
| `src/services/gemini-client.js` | Multi-model AI client with Groq Llama fallback. |
| `src/services/whisper-service.js` | Groq Whisper transcription service. |
| `src/services/telegram-bot.js` | Compact, formal Telegram meeting notifications. |
| `src/services/calendar-sync.js` | Google Calendar OAuth2 authentication and event injection. |
| `src/services/context-engine.js` | Context assembly from identity, vault, and meeting history. |
| `src/services/vault-search.js` | Local file search across the data/ directory. |
| `src/services/db.js` | SQLite database for meeting persistence and stats. |
| `data/` | CSV, JSON, and other data files for search queries. |

Private runtime state is ignored by git, including `.env`, `credentials.json`, `token.json`, database files, recordings, and vault contents.

## Features

### Recording & Transcription

- One-hotkey meeting recording (`Ctrl+Shift+M` to start/stop).
- Full audio saved to `data/recordings/` as WebM backup.
- Transcription via Groq Whisper Large V3 Turbo (free, fast, accurate).
- Automatic fallback to Gemini STT if Whisper is unavailable.

### AI Notes Generation

- Structured markdown notes with summary, action items, decisions, dates, and insights.
- Productivity rating (X/10) for each meeting.
- Smart auto-title extraction from notes.
- Context-aware: references past meetings, ongoing projects, and user profile.

### Post-Meeting Automation

After recording stops, the system automatically:

1. Transcribes the full recording via Whisper.
2. Generates structured notes via Gemini (Groq Llama fallback).
3. Extracts dates and deadlines.
4. Injects dates into Google Calendar.
5. Saves notes to Obsidian vault as markdown.
6. Saves to SQLite database for history.
7. Sends compact summary to Telegram.

### Real-time Context (`Ctrl+Shift+R`)

- Hardcoded 30-second audio window.
- On-demand transcription + AI analysis during live meetings.
- Shows current topic, key points, suggested questions, and sentiment.
- 10-second cooldown prevents API spam.

### Search (`Ctrl+Shift+Q`)

- Searches local `data/` directory for matching files.
- AI-powered analysis of search results.
- Automatic chart/graph generation from CSV data.

### Daily Digest

- 8 AM Telegram digest with today's calendar events.
- Meeting stats (total meetings, average rating, weekly count).

### Resilience

- `safeGenerate()` wrapper: Gemini → Groq Llama automatic failover.
- Retry with exponential backoff for rate-limited APIs.
- Full audio recording saved to disk even if transcription fails.
- Telegram messages fall back to plain text if markdown parsing fails.

## Models and Providers

| Layer | Primary | Fallback |
| --- | --- | --- |
| AI Tasks (Notes, Context, Search, Dates) | `gemini-2.5-flash-lite` (Google) | `llama-3.3-70b-versatile` (Groq) |
| Audio Transcription | `whisper-large-v3-turbo` (Groq) | Gemini STT |

Both providers are free tier.

## Setup

1. Clone and enter the repository.

```bash
git clone https://github.com/KrabsBucket/Relio.git
cd Relio
```

2. Install dependencies.

```bash
npm install
```

3. Create local configuration.

```bash
cp .env.example .env
```

4. Fill `.env`.

```bash
GEMINI_API_KEY=       # https://aistudio.google.com/apikey
GROQ_API_KEY=         # https://console.groq.com
TELEGRAM_BOT_TOKEN=   # https://t.me/BotFather
TELEGRAM_CHAT_ID=
USER_NAME=YourName
OAUTH_BROWSER=start
```

5. Set up Google Calendar (optional).

- Create a Google Cloud project.
- Enable Google Calendar API.
- Create OAuth2 Desktop credentials.
- Download as `credentials.json` in project root.
- First run will prompt for OAuth authorization.

6. Run the application.

```bash
npm start
```

## Usage

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+M` | Start / Stop meeting recording |
| `Ctrl+Shift+R` | Get AI context for last 30 seconds (during recording) |
| `Ctrl+Shift+Q` | Open search overlay |
| `Escape` | Close search overlay |

## API Keys

| Service | Cost | Get Key |
| --- | --- | --- |
| Gemini | Free tier | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Groq | Free tier | [console.groq.com](https://console.groq.com) |
| Telegram | Free | [t.me/BotFather](https://t.me/BotFather) |
| Google Calendar | Free | [console.cloud.google.com](https://console.cloud.google.com) |

## AI Disclosure

This project uses the following AI tools and models:

- **Google Gemini 2.5 Flash Lite** — Primary AI for generating meeting notes, extracting dates, real-time context analysis, search result interpretation, and pre-meeting briefs.
- **Groq Whisper Large V3 Turbo** — Audio transcription engine. Converts recorded meeting audio (WebM) into text via Groq's free API.
- **Groq Llama 3.3 70B** — Automatic fallback AI when Gemini is rate-limited (429) or unavailable (503). Handles all the same tasks as Gemini.
- **Obsidian** — Meeting notes are exported as Obsidian-compatible Markdown files to a local vault for long-term knowledge management.

All AI processing uses free-tier API keys. No audio or text data is stored on third-party servers beyond the API call duration.

## Tech Stack

- **Runtime**: Electron + Node.js
- **Database**: SQLite via sql.js
- **AI**: Google Gemini + Groq Llama + Groq Whisper
- **Notifications**: Telegram Bot API
- **Calendar**: Google Calendar API (OAuth2)
- **Notes Export**: Obsidian-compatible Markdown
- **Audio**: MediaRecorder API (WebM/Opus)
- **UI**: Vanilla HTML/CSS/JS with glassmorphism dark theme

## Team

**Relio** — Built by Team Relio

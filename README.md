<div align="center">

# Relio — AI Meeting Assistant

**Local-first, privacy-conscious meeting intelligence powered by free-tier AI.**

Record meetings · Live transcription · Smart notes · Calendar sync · Telegram alerts


</div>

---

## 📋 Table of Contents

- [Problem](#problem)
- [Solution](#solution)
- [Architecture](#architecture)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Usage](#usage)
- [OpenClaw Integration](#-openclaw-integration)
- [API Keys](#api-keys)
- [Models & Providers](#models--providers)
- [Workspace Layout](#workspace-layout)
- [AI Disclosure](#ai-disclosure)
- [Team](#team)

---

## Problem

Meeting context is lost the moment a call ends. Notes are incomplete, action items get forgotten, deadlines slip through cracks, and there is no searchable record of what was discussed. Manual note-taking during meetings splits attention between listening and writing. Existing transcription tools require paid subscriptions, send audio to third-party servers, or produce raw transcripts without actionable structure.

## Solution

Relio is a **local-first, privacy-conscious** AI meeting assistant built on Electron. It records meetings, transcribes audio using Groq Whisper, generates structured notes with AI (Gemini + Groq Llama fallback), extracts dates and action items, pushes events to Google Calendar, saves notes to an Obsidian vault, and sends compact summaries to Telegram. Everything runs on your machine with **free-tier APIs only**.

The workflow is hotkey-driven:

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+M` | Start / Stop meeting recording |
| `Ctrl+Shift+R` | Transcribe last 30 seconds + AI context (during recording) |
| `Ctrl+Shift+Q` | Open search overlay |
| `Escape` | Close search overlay |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                  Electron Main Process                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────┐    ┌────────────────────────────┐  │
│  │ MediaRecorder    │    │ AI Engine (safeGenerate)    │  │
│  │ Browser Audio    │    │  Primary: Gemini 2.5 Flash │  │
│  │ Capture (WebM)   │    │  Fallback: Groq Llama 3.3  │  │
│  └────────┬────────┘    └─────────────┬──────────────┘  │
│           │                           │                  │
│  ┌────────▼────────┐    ┌─────────────▼──────────────┐  │
│  │ Groq Whisper     │    │ Context Engine (MD-based)   │  │
│  │ Transcription    │    │  Reads: SOUL.md, USER.md,   │  │
│  │                  │    │  IDENTITY.md + vault/*.md    │  │
│  └────────┬────────┘    └─────────────┬──────────────┘  │
│           │                           │                  │
│  ┌────────▼───────────────────────────▼──────────────┐  │
│  │              Post-Meeting Pipeline                 │  │
│  │  Google Calendar ← Dates → Obsidian Vault (*.md)   │  │
│  │  SQLite (records only) ←──→ Telegram Bot           │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  🦞 OpenClaw Agent Context (agent_core/)                │
│  SOUL.md · IDENTITY.md · USER.md · HEARTBEAT.md         │
│  Markdown-first context — the AI reads these, not SQL   │
└─────────────────────────────────────────────────────────┘
```

> **Context is markdown-first.** The AI builds its understanding from `agent_core/*.md` files (personality, user profile, environment) and `vault/*.md` files (meeting notes, skills, projects). SQLite stores meeting records for persistence and stats — it is **not** the context system.

All AI calls go through `safeGenerate()` which tries Gemini first and automatically falls back to Groq Llama on 429/503 errors. Transcription uses Groq Whisper as primary with Gemini STT as fallback.

---

## Features

### 🎤 Recording & Transcription
- One-hotkey meeting recording (`Ctrl+Shift+M` to start/stop)
- Full audio saved to `data/recordings/` as WebM backup
- Transcription via Groq Whisper Large V3 Turbo (free, fast, accurate)
- Automatic fallback to Gemini STT if Whisper is unavailable

### 📝 AI Notes Generation
- Structured markdown notes with summary, action items, decisions, dates, and insights
- Productivity rating (X/10) for each meeting
- Smart auto-title extraction from notes
- Context-aware: references past meetings, ongoing projects, and user profile

### ⚡ Post-Meeting Automation
After recording stops, the system automatically:
1. Transcribes the full recording via Whisper
2. Generates structured notes via Gemini (Groq Llama fallback)
3. Extracts dates and deadlines
4. Injects dates into Google Calendar
5. Saves notes to Obsidian vault as markdown
6. Saves to SQLite database for history
7. Sends compact summary to Telegram

### 🔍 Real-time Context (`Ctrl+Shift+R`)
- Hardcoded 30-second audio window
- On-demand transcription + AI analysis during live meetings
- Shows current topic, key points, suggested questions, and sentiment
- 10-second cooldown prevents API spam

### 🔎 Search (`Ctrl+Shift+Q`)
- Searches local `data/` directory for matching files
- AI-powered analysis of search results
- Automatic chart/graph generation from CSV data

### 📊 Daily Digest
- 8 AM Telegram digest with today's calendar events
- Meeting stats (total meetings, average rating, weekly count)

### 🛡️ Resilience
- `safeGenerate()` wrapper: Gemini → Groq Llama automatic failover
- Retry with exponential backoff for rate-limited APIs
- Full audio recording saved to disk even if transcription fails
- Telegram messages fall back to plain text if markdown parsing fails

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Runtime** | Electron + Node.js |
| **Database** | SQLite via sql.js |
| **AI (Primary)** | Google Gemini 2.5 Flash Lite |
| **AI (Fallback)** | Groq Llama 3.3 70B Versatile |
| **Transcription** | Groq Whisper Large V3 Turbo |
| **Notifications** | Telegram Bot API |
| **Calendar** | Google Calendar API (OAuth2) |
| **Notes Export** | Obsidian-compatible Markdown |
| **Audio** | MediaRecorder API (WebM/Opus) |
| **Agent** | OpenClaw (autonomous AI assistant) |
| **UI** | Vanilla HTML/CSS/JS with glassmorphism dark theme |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [Git](https://git-scm.com/)
- A working microphone (for meeting recording)
- API keys (all free tier — see [API Keys](#api-keys))

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/KrabsBucket/Relio.git
cd Relio
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
GEMINI_API_KEY=       # https://aistudio.google.com/apikey
GROQ_API_KEY=         # https://console.groq.com
TELEGRAM_BOT_TOKEN=   # https://t.me/BotFather
TELEGRAM_CHAT_ID=     # Your Telegram chat ID
USER_NAME=YourName    # Used in greetings and digest
OAUTH_BROWSER=start   # 'start' on Windows, 'open' on macOS, 'xdg-open' on Linux
```

### 4. Google Calendar setup (optional)

1. Create a [Google Cloud project](https://console.cloud.google.com/)
2. Enable the **Google Calendar API**
3. Create **OAuth2 Desktop** credentials
4. Download as `credentials.json` in the project root
5. First run will prompt for OAuth authorization in your browser

### 5. Run the application

```bash
npm start
```

> **Development mode** (with extra logging):
> ```bash
> npm run dev
> ```

---

## Usage

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+M` | Start / Stop meeting recording |
| `Ctrl+Shift+R` | Get AI context for last 30 seconds (during recording) |
| `Ctrl+Shift+Q` | Open search overlay |
| `Escape` | Close search overlay |

### Typical Workflow

1. **Before a meeting** — Relio sends a pre-meeting brief to Telegram (1 hour prior, if calendar is connected).
2. **Start recording** — Press `Ctrl+Shift+M`. The UI shows a live timer and mic volume.
3. **During the meeting** — Press `Ctrl+Shift+R` anytime to get instant AI context of the last 30 seconds.
4. **End recording** — Press `Ctrl+Shift+M` again. Relio automatically transcribes, generates notes, syncs calendar, saves to vault, and notifies via Telegram.
5. **Search later** — Press `Ctrl+Shift+Q` to query your meeting history and data files with AI-powered analysis.

---

## 🦞 OpenClaw Integration

Relio ships with an **[OpenClaw](https://openclaw.ai)** agent workspace in `agent_core/`. OpenClaw is an open-source, autonomous personal AI assistant that runs locally on your machine and can interact with you through messaging platforms like Telegram, WhatsApp, Discord, and more.

### What is OpenClaw?

OpenClaw is a **local-first AI agent** that acts as your personal assistant. It can:
- 💬 Communicate via Telegram, WhatsApp, Discord, Slack, Signal, or iMessage
- 🧠 Maintain persistent memory across sessions
- 🔧 Execute tasks autonomously (file management, web browsing, shell commands)
- ⏰ Run scheduled checks via heartbeats and cron jobs
- 🔌 Extend with community-built skills and plugins

### Why OpenClaw + Relio?

When combined with Relio, OpenClaw can serve as an **always-on meeting intelligence layer**:
- Proactively check your calendar and send pre-meeting briefs
- Query your meeting history and notes through natural conversation
- Manage and organize your Obsidian vault of meeting notes
- Trigger meeting-related workflows from any chat platform
- Maintain context about your projects, people, and ongoing tasks across sessions

### Installing OpenClaw

#### Windows (PowerShell)

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

#### macOS / Linux / WSL2

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

#### Alternative: Install via npm

```bash
npm install -g openclaw@latest
```

> **Requirement:** Node.js v22+ is recommended. The installer script handles this automatically.

### Setting Up OpenClaw with Relio

1. **Run onboarding** — This walks you through choosing an LLM provider, entering your API key, and connecting a messaging channel:

   ```bash
   openclaw onboard --install-daemon
   ```

2. **Verify your setup:**

   ```bash
   openclaw doctor
   ```

3. **Check the gateway is running:**

   ```bash
   openclaw gateway status
   ```

4. **Open the dashboard** (optional):

   ```bash
   openclaw dashboard
   ```

### Relio's Agent Workspace

The `agent_core/` directory contains OpenClaw configuration files that are **pre-configured for Relio**:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Workspace rules, defining the MD-first context engine and token budgets |
| `SOUL.md` | Relio's personality, core truths, and behavioral guidelines |
| `IDENTITY.md` | Relio's identity, capabilities, and context sources |
| `USER.md` | Your profile, timezone, and preferences |
| `TOOLS.md` | Environment config (Gemini, Groq, Telegram, audio settings) |
| `HEARTBEAT.md` | Scheduled proactive tasks (pre-meeting briefs, daily digest) |

### Customizing the Agent

While the agent is pre-configured, you can personalize it further:
- **Set your preferences** in `USER.md` (timezone, how you like to be addressed)
- **Adjust boundaries** in `SOUL.md` (communication style, what it can do autonomously)
- **Tweak environment** in `TOOLS.md` (change models or integrations)
- **Add skills** from [ClawHub](https://clawhub.ai) or let the agent build its own

### Updating OpenClaw

```bash
# Stable releases
openclaw update --channel stable

# Development/preview builds
openclaw update --channel dev
```

### OpenClaw Resources

| Resource | Link |
| --- | --- |
| 🌐 Website | [openclaw.ai](https://openclaw.ai) |
| 📖 Documentation | [docs.openclaw.ai](https://docs.openclaw.ai/getting-started) |
| 💻 GitHub | [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw) |
| 🔌 Skill Hub | [clawhub.ai](https://clawhub.ai) |
| 💬 Discord Community | [discord.com/invite/clawd](https://discord.com/invite/clawd) |

---

## API Keys

All services used by Relio are **free tier** — no credit card required.

| Service | Cost | Get Key | Used For |
| --- | --- | --- | --- |
| **Gemini** | Free | [aistudio.google.com](https://aistudio.google.com/apikey) | Notes, context, search, date extraction |
| **Groq** | Free | [console.groq.com](https://console.groq.com) | Whisper transcription + Llama fallback |
| **Telegram** | Free | [t.me/BotFather](https://t.me/BotFather) | Meeting summaries + daily digest |
| **Google Calendar** | Free | [console.cloud.google.com](https://console.cloud.google.com) | Date/event injection (optional) |

---

## Models & Providers

| Layer | Primary | Fallback |
| --- | --- | --- |
| AI Tasks (Notes, Context, Search, Dates) | `gemini-2.5-flash-lite` (Google) | `llama-3.3-70b-versatile` (Groq) |
| Audio Transcription | `whisper-large-v3-turbo` (Groq) | Gemini STT |

Both providers are free tier. The `safeGenerate()` wrapper handles automatic failover transparently.

---

## Workspace Layout

```
Relio/
├── agent_core/              # 🦞 OpenClaw agent workspace
│   ├── AGENTS.md            #    Agent behavior rules
│   ├── SOUL.md              #    Personality & values
│   ├── IDENTITY.md          #    Agent identity
│   ├── USER.md              #    Your preferences
│   ├── TOOLS.md             #    Local environment notes
│   ├── BOOTSTRAP.md         #    First-run onboarding
│   └── HEARTBEAT.md         #    Periodic task config
├── src/
│   ├── main/
│   │   ├── main.js          # Electron main process, IPC, hotkeys, scheduling
│   │   └── preload.js       # Secure IPC bridge (main ↔ renderer)
│   ├── renderer/
│   │   ├── index.html       # Application shell & UI components
│   │   ├── index.css        # Dark theme with glassmorphism
│   │   └── app.js           # UI logic, recording, search, context display
│   └── services/
│       ├── gemini-client.js  # Multi-model AI client with Groq fallback
│       ├── whisper-service.js# Groq Whisper transcription
│       ├── telegram-bot.js   # Telegram meeting notifications
│       ├── calendar-sync.js  # Google Calendar OAuth2 & event sync
│       ├── context-engine.js # Context from identity, vault, history
│       ├── vault-search.js   # Local file search across data/
│       └── db.js             # SQLite database for meeting persistence
├── data/                     # CSV, JSON, and data files for search
├── vault/                    # Obsidian-compatible meeting notes
├── db/                       # SQLite database files
├── .env.example              # Environment variable template
├── .gitignore                # Git ignore rules
└── package.json              # Project configuration
```

> **Note:** Private runtime state is ignored by git, including `.env`, `credentials.json`, `token.json`, database files, recordings, and vault contents.

---

## AI Disclosure

This project uses the following AI tools and models:

- **Google Gemini 2.5 Flash Lite** — Primary AI for generating meeting notes, extracting dates, real-time context analysis, search result interpretation, and pre-meeting briefs.
- **Groq Whisper Large V3 Turbo** — Audio transcription engine. Converts recorded meeting audio (WebM) into text via Groq's free API.
- **Groq Llama 3.3 70B** — Automatic fallback AI when Gemini is rate-limited (429) or unavailable (503). Handles all the same tasks as Gemini.
- **OpenClaw** — Open-source autonomous AI agent framework for persistent memory, proactive task management, and multi-platform communication.
- **Obsidian** — Meeting notes are exported as Obsidian-compatible Markdown files to a local vault for long-term knowledge management.

All AI processing uses free-tier API keys. No audio or text data is stored on third-party servers beyond the API call duration.

---

## Team

**Relio** — Built by Team Relio

---

<div align="center">

Made with ☕ and 🦞

[Report a Bug](https://github.com/KrabsBucket/Relio/issues) · [Request a Feature](https://github.com/KrabsBucket/Relio/issues)

</div>


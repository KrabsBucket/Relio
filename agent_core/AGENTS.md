# AGENTS.md — Relio Workspace Rules

## Context Architecture

Relio uses a **markdown-first context system**. The AI builds its understanding from these files — not from a database.

### Context Layers (Priority Order)

1. **Agent Core** (`agent_core/*.md`) — Highest priority
   - `SOUL.md` — Personality, behavioral rules, boundaries
   - `IDENTITY.md` — What Relio is, capabilities, architecture
   - `USER.md` — User profile, preferences, timezone
   - `TOOLS.md` — Environment config, model details, integrations

2. **Vault Knowledge** (`vault/`) — Domain context
   - `02_Skills/` — Skills and expertise docs
   - `03_Projects/` — Active project context
   - `Templates/QMB_Snippets/` — Meeting formatting templates

3. **Meeting Memory** (`vault/01_Meetings/`) — Historical context
   - `Post-Meet/` — Past meeting notes with YAML frontmatter
   - `Pre-Meet/` — Pre-meeting briefs
   - SQLite DB supplements vault notes (deduplication applied)

4. **Task-Specific Data** — Injected per request
   - Search results, CSV data, real-time transcription

### How Context Is Built

The context engine (`src/services/context-engine.js`) reads MD files from this directory and the vault, then assembles a prioritized context window. Each AI task type has a token budget:

| Task | Agent Core | Knowledge | Meetings | Extras | Total |
| --- | --- | --- | --- | --- | --- |
| REALTIME | 600 | 400 | 800 | 200 | ~2,000 chars |
| NOTES | 1,500 | 1,500 | 3,000 | 2,000 | ~8,000 chars |
| PREP | 1,000 | 1,500 | 2,500 | 1,000 | ~6,000 chars |
| SEARCH | 600 | 1,000 | 1,000 | 1,400 | ~4,000 chars |

### Important: MD Files > Database

The SQLite database stores raw meeting records for persistence and stats. But the **primary context system is these markdown files**. The AI reads SOUL.md, IDENTITY.md, USER.md, and vault notes to understand who it is, who the user is, and what happened before. The database is a supplement, not the source of truth for context.

## Memory Management

- **Short-term:** Real-time transcription context (30-second windows, in-memory)
- **Medium-term:** Post-meeting notes in `vault/01_Meetings/Post-Meet/` (Markdown + YAML)
- **Long-term:** `MEMORY.md` (created over time, curated insights and patterns)
- **Structured:** SQLite for queryable meeting stats (counts, ratings, dates)

## Resilience Rules

- `safeGenerate()` handles all AI calls: Gemini → Groq Llama automatic failover
- Whisper → Gemini STT automatic failover for transcription
- Raw audio always saved to disk, even if transcription fails
- Telegram falls back to plain text if markdown parsing fails
- Context cache refreshes every 5 minutes

## File Ownership

| File | Updated By | When |
| --- | --- | --- |
| `SOUL.md` | User (manual) | When personality/behavior needs change |
| `IDENTITY.md` | Developer | When capabilities change |
| `USER.md` | User / Agent | Onboarding + over time |
| `TOOLS.md` | Developer / User | When environment changes |
| `HEARTBEAT.md` | User / Agent | When scheduled tasks change |
| `MEMORY.md` | Agent | Automatically, during heartbeats |
| `BOOTSTRAP.md` | System | First run only (then deleted) |

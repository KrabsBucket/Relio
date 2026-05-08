# HEARTBEAT.md — Relio Scheduled Tasks

## Pre-Meeting Briefs
- Check Google Calendar for events in the next 1 hour
- If event found, send Telegram brief with: event title, time, attendees, related past meetings
- Pull context from `vault/01_Meetings/Post-Meet/` for any meetings with similar topics or attendees

## Daily Digest (8:00 AM IST)
- Fetch today's calendar events from Google Calendar
- Query meeting stats from SQLite (total meetings, average rating, this week's count)
- Send formatted digest to Telegram with:
  - Today's scheduled events
  - Meeting statistics
  - Any outstanding action items from recent meetings

## Context Refresh
- Refresh context engine cache every 5 minutes during active sessions
- Scan `agent_core/` MD files for updates
- Scan `vault/` for new meeting notes

## Health Checks
- Verify Gemini API key is valid (test ping)
- Verify Groq API key is valid (test ping)
- Verify Telegram bot connection
- Log status to console on startup

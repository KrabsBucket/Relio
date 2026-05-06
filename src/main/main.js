// PrismClaw — Electron Main Process (v5)
// Enhanced: Ctrl+Shift+M meeting toggle, auto-prep Telegram, post-meeting pipeline
const { app, BrowserWindow, ipcMain, globalShortcut, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { initDB, saveMeeting, getRecentMeetings, getMeetingById, getMeetingStats } = require('../services/db');
const { generateNotes, extractDatesFromNotes, generateContext, generatePreMeetingBrief, analyzeSearchResults, transcribeAudioFile, transcribeAudioChunk } = require('../services/gemini-client');
const { authenticateCalendar, fetchUpcomingEvents, injectCalendarEvent } = require('../services/calendar-sync');
const { sendTelegramMessage, sendMeetingNotes, sendReminder } = require('../services/telegram-bot');
const { searchVault, parseCSVForGraph } = require('../services/vault-search');
const { getContextStatus, refreshCache, buildContext } = require('../services/context-engine');
const { transcribeWithWhisper, isWhisperAvailable } = require('../services/whisper-service');

// ── Retry wrapper for rate-limited APIs ──
async function withRetry(fn, label = 'API', maxRetries = 3, baseDelay = 3000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.message?.includes('429') || err.message?.includes('quota');
      if (isRateLimit && i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        console.log(`⏳ ${label}: Rate limited, retrying in ${delay / 1000}s... (attempt ${i + 2}/${maxRetries + 1})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

let mainWindow = null;
let calendarAuth = null;
let calendarAuthFailed = false;
let reminderInterval = null;
let rendererServer = null;

// Track which meetings already received prep messages (avoid duplicates)
const sentPreps = new Set();

const RENDERER_PORT = 9173;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// ── HTTP Server for renderer (required for Web Speech API mic access) ──

function startRendererServer() {
  return new Promise((resolve) => {
    const MIME = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2', '.ico': 'image/x-icon',
    };
    rendererServer = http.createServer((req, res) => {
      let filePath = path.join(RENDERER_DIR, req.url === '/' ? 'index.html' : req.url);
      const ext = path.extname(filePath);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404); res.end('Not found');
      }
    });
    rendererServer.listen(RENDERER_PORT, '127.0.0.1', () => {
      console.log(`✓ Renderer server on http://127.0.0.1:${RENDERER_PORT}`);
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0e0e',
    titleBarStyle: 'hiddenInset',
    frame: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  mainWindow.loadURL(`http://127.0.0.1:${RENDERER_PORT}/`);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Block Chromium's built-in shortcuts that conflict with our hotkeys
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift) {
      const key = input.key.toLowerCase();
      if (key === 'r' || key === 'm' || key === 'q') {
        event.preventDefault(); // Block Chromium's reload (Ctrl+Shift+R)
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ══════════════════════════════════════════════════════════
// IPC: Calendar
// ══════════════════════════════════════════════════════════

const DEMO_EVENTS = [
  { summary: 'Team Standup', start: { dateTime: futureDate(1, 9, 30) }, end: { dateTime: futureDate(1, 10, 0) } },
  { summary: 'Project Review — Q2 Goals', start: { dateTime: futureDate(2, 14, 0) }, end: { dateTime: futureDate(2, 15, 0) } },
  { summary: 'Client Call — TCS Partnership', start: { dateTime: futureDate(3, 11, 0) }, end: { dateTime: futureDate(3, 12, 0) } },
  { summary: '1:1 with Manager', start: { dateTime: futureDate(5, 16, 0) }, end: { dateTime: futureDate(5, 16, 30) } },
  { summary: 'Sprint Planning', start: { dateTime: futureDate(7, 10, 0) }, end: { dateTime: futureDate(7, 11, 30) } },
  { summary: 'Design Review', start: { dateTime: futureDate(10, 15, 0) }, end: { dateTime: futureDate(10, 16, 0) } },
  { summary: 'Monthly All-Hands', start: { dateTime: futureDate(14, 13, 0) }, end: { dateTime: futureDate(14, 14, 0) } },
  { summary: 'Code Freeze Deadline', start: { dateTime: futureDate(21, 18, 0) }, end: { dateTime: futureDate(21, 19, 0) } },
];

function futureDate(days, h, m) {
  const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const EXCLUDED = ['birthday', 'anniversary', 'bday', "b'day"];
function isRelevant(ev) {
  const t = (ev.summary || '').toLowerCase();
  return !EXCLUDED.some(kw => t.includes(kw));
}

ipcMain.handle('calendar:getEvents', async () => {
  try {
    if (calendarAuthFailed) return { ok: true, events: DEMO_EVENTS, isDemo: true };
    if (!calendarAuth) calendarAuth = await authenticateCalendar();
    let events = await fetchUpcomingEvents(calendarAuth, 30);
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 28);
    events = events.filter(ev => {
      const s = new Date(ev.start?.dateTime || ev.start?.date);
      return s <= cutoff && isRelevant(ev);
    });
    if (events.length === 0) return { ok: true, events: DEMO_EVENTS, isDemo: true };
    return { ok: true, events };
  } catch (err) {
    console.error('Calendar:', err.message);
    calendarAuthFailed = true;
    return { ok: true, events: DEMO_EVENTS, isDemo: true };
  }
});

// ══════════════════════════════════════════════════════════
// IPC: Real-time Context (Ctrl+Shift+R)
// ══════════════════════════════════════════════════════════

ipcMain.handle('meeting:getContext', async (_event, transcriptChunk) => {
  try {
    const context = await generateContext(transcriptChunk);
    return { ok: true, context };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Post-Meeting Notes Generation
// ══════════════════════════════════════════════════════════

ipcMain.handle('notes:generate', async (_event, transcript) => {
  try {
    const dbMeetings = getRecentMeetings(30);
    const notes = await withRetry(() => generateNotes(transcript, dbMeetings), 'Notes', 3, 5000);
    let dates = [];
    try {
      dates = await withRetry(() => extractDatesFromNotes(notes), 'Dates', 2, 3000);
    } catch (dateErr) {
      console.error('Date extraction failed (non-fatal):', dateErr.message);
    }

    // Extract productivity rating from notes
    let rating = 0;
    const ratingMatch = notes.match(/(\d+(?:\.\d)?)\s*\/\s*10/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);

    return { ok: true, notes, dates, rating };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Audio File Transcription (WSL workaround)
// ══════════════════════════════════════════════════════════

ipcMain.handle('audio:pickAndTranscribe', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select audio/video recording',
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'webm', 'flac', 'm4a', 'aac', 'wma'] },
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, error: 'No file selected' };
    }
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) {
      return { ok: false, error: 'File too large (max 20MB). Trim the recording and try again.' };
    }
    console.log(`📁 Transcribing: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    const transcript = await transcribeAudioFile(filePath);
    return { ok: true, transcript };
  } catch (err) {
    console.error('Transcribe error:', err);
    return { ok: false, error: err.message };
  }
});

// ══════════════════════════════════════════════════════════
// IPC: Live Audio Chunk Transcription (MediaRecorder → Gemini)
// ══════════════════════════════════════════════════════════

ipcMain.handle('audio:transcribeChunk', async (_event, base64Audio, mimeType) => {
  try {
    const mime = mimeType || 'audio/webm';
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    // Primary: Groq Whisper (free, separate quota)
    if (isWhisperAvailable()) {
      console.log('🎙️ Transcribing chunk via Groq Whisper...');
      const whisperResult = await transcribeWithWhisper(audioBuffer, mime);
      if (whisperResult.ok) {
        return { ok: true, text: whisperResult.rawText || whisperResult.text };
      }
      console.warn('Whisper failed, falling back to Gemini:', whisperResult.error);
    }

    // Fallback: Gemini (may be rate limited)
    console.log('🎙️ Transcribing chunk via Gemini...');
    const text = await transcribeAudioChunk(base64Audio, mime);
    return { ok: true, text };
  } catch (err) {
    console.error('Chunk transcribe error:', err.message);
    return { ok: false, error: err.message };
  }
});

// ══════════════════════════════════════════════════════════
// IPC: Full Recording Transcription (after meeting ends)
// Tries Groq Whisper first, then Gemini as fallback
// ══════════════════════════════════════════════════════════

ipcMain.handle('audio:transcribeFull', async (_event, base64Audio, mimeType) => {
  try {
    const mime = mimeType || 'audio/webm';
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    console.log(`🎙️ Full recording transcription: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`);

    // Save recording to disk for backup
    const recordingsDir = path.join(__dirname, '..', '..', 'data', 'recordings');
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
    const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'webm';
    const filename = `meeting_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    const filePath = path.join(recordingsDir, filename);
    fs.writeFileSync(filePath, audioBuffer);
    console.log(`💾 Recording saved: ${filename}`);

    // Primary: Groq Whisper
    if (isWhisperAvailable()) {
      console.log('🎙️ Full transcription via Groq Whisper...');
      const result = await transcribeWithWhisper(audioBuffer, mime);
      if (result.ok && result.text) {
        console.log(`✓ Whisper transcription: ${result.text.length} chars`);
        return { ok: true, text: result.text, savedAs: filename };
      }
      console.warn('Whisper full transcription failed:', result.error);
    }

    // Fallback: Gemini
    console.log('🎙️ Full transcription via Gemini...');
    const text = await withRetry(
      () => transcribeAudioFile(filePath),
      'Gemini transcription', 2, 5000
    );
    return { ok: true, text, savedAs: filename };
  } catch (err) {
    console.error('Full transcription error:', err);
    return { ok: false, error: err.message };
  }
});

// ══════════════════════════════════════════════════════════
// IPC: Pre-Meeting Brief
// ══════════════════════════════════════════════════════════

ipcMain.handle('meeting:preBrief', async (_event, meetingTitle) => {
  try {
    let eventsText = '';
    if (calendarAuth) {
      const events = await fetchUpcomingEvents(calendarAuth, 5);
      eventsText = events.map(e => `- ${e.summary} (${e.start?.dateTime || e.start?.date})`).join('\n');
    }
    const pastMeetings = getRecentMeetings(30);
    const pastNotes = pastMeetings.slice(0, 3).map(m => `### ${m.title}\n${(m.notes || '').substring(0, 800)}`).join('\n\n');
    const brief = await generatePreMeetingBrief(meetingTitle, eventsText, pastNotes, pastMeetings);
    return { ok: true, brief };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Full Post-Meeting Pipeline (Save + Calendar + Telegram + Obsidian)
// ══════════════════════════════════════════════════════════

ipcMain.handle('meeting:save', async (_event, { title, transcript, notes, dates, rating, durationSecs }) => {
  try {
    // 1. Save to SQLite with rating and duration
    const meetingId = saveMeeting(title, transcript, notes, JSON.stringify(dates || []), rating || 0, durationSecs || 0);

    // 2. Refresh context cache
    refreshCache();

    // 3. Save to Obsidian vault (Post-Meet QMB template)
    saveToObsidianVault(title, notes, dates, rating);

    // 4. Inject extracted dates into Google Calendar
    if (calendarAuth && dates?.length) {
      for (const d of dates) {
        try {
          await injectCalendarEvent(calendarAuth, {
            summary: d.summary || d.title,
            description: `Extracted by Relio from: ${title}`,
            date: d.date,
            endDate: d.endDate,
          });
          console.log(`✓ Calendar: ${d.summary} → ${d.date}`);
        } catch (e) { console.error('Cal inject:', e.message); }
      }
    }

    // 5. Send compact meeting summary to Telegram
    try {
      await sendMeetingNotes(title, notes, durationSecs);
    } catch (e) { console.error('Telegram:', e.message); }

    return { ok: true, meetingId };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Meeting History & Stats
// ══════════════════════════════════════════════════════════

ipcMain.handle('meetings:recent', async () => {
  try { return { ok: true, meetings: getRecentMeetings(90) }; }
  catch (err) { return { ok: false, error: err.message, meetings: [] }; }
});

ipcMain.handle('meetings:stats', async () => {
  try { return { ok: true, stats: getMeetingStats() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('meetings:getById', async (_event, id) => {
  try {
    const meeting = getMeetingById(id);
    return meeting ? { ok: true, meeting } : { ok: false, error: 'Not found' };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Search (Ctrl+Shift+Q)
// ══════════════════════════════════════════════════════════

ipcMain.handle('search:query', async (_event, query) => {
  try {
    console.log(`🔍 Search query: "${query}"`);
    const results = searchVault(query);
    console.log(`   Found ${results.length} results`);

    if (results.length === 0) return { ok: true, results: [], analysis: 'No matching files found in vault or data directories.', chartData: null };

    const searchSummary = results.slice(0, 5).map(r => {
      const mp = r.matches.map(m => `  L${m.line}: ${m.text}`).join('\n');
      return `File: ${r.file} (score: ${r.score})\n${mp}`;
    }).join('\n\n');

    let dataContent = '';
    const dataFile = results.find(r => r.fullContent);
    if (dataFile) dataContent = dataFile.fullContent.substring(0, 3000);

    let analysis = '';
    try {
      analysis = await analyzeSearchResults(query, searchSummary, dataContent);
    } catch (aiErr) {
      console.error('AI analysis error:', aiErr.message);
      analysis = `Found ${results.length} matching file(s). AI analysis unavailable: ${aiErr.message}`;
    }

    let chartData = null;
    if (dataFile?.ext === '.csv') chartData = parseCSVForGraph(dataFile.fullContent);
    if (!chartData && analysis) {
      const m = analysis.match(/```json\s*(\{[\s\S]*?"chartData"[\s\S]*?\})\s*```/);
      if (m) { try { chartData = JSON.parse(m[1]).chartData; } catch {} }
    }

    return {
      ok: true,
      results: results.map(r => ({ file: r.file, filename: r.filename, score: r.score, matches: r.matches })),
      analysis, chartData,
    };
  } catch (err) {
    console.error('Search error:', err);
    return { ok: false, error: err.message };
  }
});

// ══════════════════════════════════════════════════════════
// IPC: Telegram test
// ══════════════════════════════════════════════════════════

ipcMain.handle('telegram:test', async () => {
  try {
    await sendTelegramMessage('🔮 PrismClaw is connected!');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: Context Engine status
// ══════════════════════════════════════════════════════════

ipcMain.handle('context:status', async () => {
  try {
    return { ok: true, status: getContextStatus() };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════
// IPC: System audio check
// ══════════════════════════════════════════════════════════

ipcMain.handle('system:checkAudio', async () => {
  const isWSL = (() => {
    try {
      const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
      return release.includes('microsoft') || release.includes('wsl');
    } catch { return false; }
  })();
  let hasPulse = false;
  try {
    const { execSync } = require('child_process');
    execSync('pactl info', { timeout: 2000, stdio: 'pipe' });
    hasPulse = true;
  } catch { /* no pulseaudio */ }
  return { isWSL, hasPulse, micLikely: !isWSL || hasPulse };
});

// ══════════════════════════════════════════════════════════
// Obsidian Vault — QMB Template (Post-Meet)
// ══════════════════════════════════════════════════════════

function saveToObsidianVault(title, notes, dates, rating = 0) {
  const meetingDir = path.join(__dirname, '..', '..', 'vault', '01_Meetings', 'Post-Meet');
  if (!fs.existsSync(meetingDir)) fs.mkdirSync(meetingDir, { recursive: true });

  const dateStr = new Date().toISOString().split('T')[0];
  const safeTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').substring(0, 50).trim();
  const filename = `${dateStr}_${safeTitle.replace(/\s+/g, '_')}.md`;

  const content = `---
title: "${title}"
date: ${new Date().toISOString()}
type: meeting-notes
tags: [meeting, prismclaw, auto-generated]
dates_extracted: ${(dates || []).length}
rating: ${rating}
template: QMB_Meeting_Notes
---

# ${title}

> Auto-generated by PrismClaw on ${new Date().toLocaleString()}
> ⭐ Productivity Rating: ${rating}/10

${notes || ''}

---
## Extracted Dates & Deadlines
${(dates || []).map(d => `- **${d.date}**: ${d.summary}`).join('\n') || 'None extracted'}

---
*Filed by PrismClaw AI Meeting Assistant*
`;

  fs.writeFileSync(path.join(meetingDir, filename), content, 'utf-8');
  console.log(`✓ Obsidian vault: ${filename}`);
}

// ══════════════════════════════════════════════════════════
// Obsidian Vault — Pre-Meeting Brief Save
// ══════════════════════════════════════════════════════════

function savePreBriefToVault(meetingTitle, brief) {
  const preMeetDir = path.join(__dirname, '..', '..', 'vault', '01_Meetings', 'Pre-Meet');
  if (!fs.existsSync(preMeetDir)) fs.mkdirSync(preMeetDir, { recursive: true });

  const dateStr = new Date().toISOString().split('T')[0];
  const safeTitle = meetingTitle.replace(/[^a-zA-Z0-9\s-]/g, '').substring(0, 50).trim();
  const filename = `${dateStr}_PREP_${safeTitle.replace(/\s+/g, '_')}.md`;

  const content = `---
title: "Pre-Brief: ${meetingTitle}"
date: ${new Date().toISOString()}
type: pre-meeting-brief
tags: [meeting, prismclaw, pre-brief]
template: QMB_Pre_Brief
---

# Pre-Meeting Brief: ${meetingTitle}

> Auto-generated by PrismClaw on ${new Date().toLocaleString()}

${brief || ''}

---
*Pre-Meeting Prep by PrismClaw AI*
`;

  fs.writeFileSync(path.join(preMeetDir, filename), content, 'utf-8');
  console.log(`✓ Pre-brief saved: ${filename}`);
}

// ══════════════════════════════════════════════════════════
// Auto Pre-Meeting Prep — Telegram (1hr before meetings)
// Runs every 5 minutes, sends prep for meetings starting in ~1 hour
// ══════════════════════════════════════════════════════════

async function autoPreMeetingPrep() {
  try {
    if (!calendarAuth) return;
    const events = await fetchUpcomingEvents(calendarAuth, 10);
    const now = Date.now();

    for (const ev of events) {
      const start = new Date(ev.start?.dateTime || ev.start?.date).getTime();
      const minsUntil = (start - now) / 60000;
      const eventKey = `${ev.summary}_${ev.start?.dateTime || ev.start?.date}`;

      // 1-hour window: send prep 55-65 mins before
      if (minsUntil > 50 && minsUntil <= 65 && !sentPreps.has(eventKey)) {
        sentPreps.add(eventKey);
        console.log(`📋 Auto-prep for: ${ev.summary} (in ${Math.round(minsUntil)} mins)`);

        try {
          // Generate rich pre-meeting brief with full context
          const pastMeetings = getRecentMeetings(30);
          let eventsText = events.map(e => `- ${e.summary} (${e.start?.dateTime || e.start?.date})`).join('\n');
          const pastNotes = pastMeetings.slice(0, 5).map(m =>
            `### ${m.title}${m.rating ? ` (${m.rating}/10)` : ''}\n${(m.notes || '').substring(0, 600)}`
          ).join('\n\n');

          const brief = await generatePreMeetingBrief(ev.summary, eventsText, pastNotes, pastMeetings);

          // Save to Obsidian vault
          savePreBriefToVault(ev.summary, brief);

          // Send to Telegram
          const prepMsg = `📋 *Pre-Meeting Prep: ${ev.summary}*\n⏰ Starting in ~${Math.round(minsUntil)} minutes\n\n${brief}`;
          await sendTelegramMessage(prepMsg);
          console.log(`✓ Pre-meeting prep sent for: ${ev.summary}`);
        } catch (e) {
          console.error('Auto-prep failed:', e.message);
        }
      }

      // 15-minute reminder
      if (minsUntil > 10 && minsUntil <= 18) {
        const reminderKey = `reminder_${eventKey}`;
        if (!sentPreps.has(reminderKey)) {
          sentPreps.add(reminderKey);
          await sendReminder(ev.summary, minsUntil);
        }
      }
    }

    // Clean up old keys (>2 hours old)
    if (sentPreps.size > 50) sentPreps.clear();
  } catch (err) {
    console.error('Auto-prep loop:', err.message);
  }
}

// ══════════════════════════════════════════════════════════
// 8 AM Daily Digest — Telegram summary of today's meetings
// ══════════════════════════════════════════════════════════

let dailyDigestSent = false;

async function checkDailyDigest() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  // Send between 8:00-8:10 AM, once per day
  if (h === 8 && m <= 10 && !dailyDigestSent) {
    dailyDigestSent = true;
    setTimeout(() => { dailyDigestSent = false; }, 60 * 60 * 1000); // reset after 1hr

    try {
      const userName = process.env.USER_NAME || 'there';
      const greeting = `☀️ *Good morning, ${userName}!*\nHere's your day at a glance:\n`;

      let todayEvents = [];

      // Try to fetch calendar events, but don't fail if unavailable
      if (calendarAuth) {
        try {
          const events = await fetchUpcomingEvents(calendarAuth, 20);
          const today = now.toISOString().split('T')[0];
          todayEvents = events.filter(ev => {
            const start = ev.start?.dateTime || ev.start?.date || '';
            return start.startsWith(today);
          });
        } catch (calErr) {
          console.error('Calendar fetch for digest:', calErr.message);
        }
      }

      // Get recent meeting stats for the digest
      let statsLine = '';
      try {
        const stats = getMeetingStats();
        if (stats.totalMeetings > 0) {
          statsLine = `\n📊 *Stats:* ${stats.totalMeetings} total meets | ⭐ Avg ${stats.avgRating || '—'}/10 | ${stats.meetingsThisWeek} this week`;
        }
      } catch {}

      if (todayEvents.length === 0) {
        await sendTelegramMessage(`${greeting}\n🎉 No meetings scheduled — a free day to focus! Make it count. 💪${statsLine}`);
      } else {
        const eventsList = todayEvents.map((ev, i) => {
          const start = new Date(ev.start?.dateTime || ev.start?.date);
          const time = ev.start?.dateTime
            ? start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            : 'All day';
          return `${i + 1}. *${ev.summary}* — ${time}`;
        }).join('\n');

        const closing = todayEvents.length === 1
          ? '\n\n🎯 Just one meeting today — make it a good one!'
          : `\n\n💼 ${todayEvents.length} meetings today — you've got this! 🚀`;

        await sendTelegramMessage(`${greeting}\n📅 *Today's Schedule (${todayEvents.length} meetings):*\n${eventsList}${closing}${statsLine}`);
      }
      console.log(`✓ Daily digest sent: ${todayEvents.length} meetings`);
    } catch (err) {
      console.error('Daily digest error:', err.message);
    }
  }
}

// ══════════════════════════════════════════════════════════
// IPC: Get user name
// ══════════════════════════════════════════════════════════

ipcMain.handle('user:getName', async () => {
  return { ok: true, name: process.env.USER_NAME || 'there' };
});

// ══════════════════════════════════════════════════════════
// App Lifecycle
// ══════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  await initDB();

  await startRendererServer();
  createWindow();

  // ── Reminder + Auto-Prep + Daily Digest loop (every 5 min) ──
  reminderInterval = setInterval(() => {
    autoPreMeetingPrep();
    checkDailyDigest();
  }, 5 * 60 * 1000);

  // Run once on startup after a short delay
  setTimeout(() => {
    autoPreMeetingPrep();
    checkDailyDigest();
  }, 10000);

  // ── Global Hotkeys ──

  // Ctrl+Shift+M — Toggle meeting recording
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    console.log('⌨️ Hotkey: Ctrl+Shift+M pressed');
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('hotkey:toggle-meeting');
    }
  });

  // Ctrl+Shift+R — Real-time context during recording
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    console.log('⌨️ Hotkey: Ctrl+Shift+R pressed');
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('hotkey:realtime-context');
    }
  });

  // Ctrl+Shift+Q — Search/query overlay
  const searchShortcut = process.platform === 'linux' ? 'CommandOrControl+Shift+F' : 'CommandOrControl+Shift+Q';
  const registered = globalShortcut.register(searchShortcut, () => {
    console.log('⌨️ Hotkey: Ctrl+Shift+Q pressed');
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('hotkey:search');
    }
  });
  console.log(`✓ Hotkeys: Ctrl+Shift+M (meeting), Ctrl+Shift+R (context), ${searchShortcut} (search): ${registered ? 'OK' : 'FAILED'}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (reminderInterval) clearInterval(reminderInterval);
  if (rendererServer) rendererServer.close();
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

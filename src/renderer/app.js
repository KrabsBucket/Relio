// PrismClaw — Renderer v5
// Meeting lifecycle: Ctrl+Shift+M toggle, ratings, past meets, real-time context

const state = {
  isRecording: false, recognition: null, transcript: [], meetingStartTime: null,
  chart: null, searchChart: null, lastResult: null, searchOpen: false, durationTimer: null,
  audioCtx: null, analyser: null, micStream: null, vizRAF: null,
  fullRecordingChunks: [], // Track ALL audio for full-recording fallback
};

// ═══ Navigation ═══
document.querySelectorAll('.nav-btn[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-panel]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${btn.dataset.panel}`)?.classList.add('active');
    if (btn.dataset.panel === 'dashboard') loadDashboard();
    if (btn.dataset.panel === 'notes') loadNotesHistory();
    if (btn.dataset.panel === 'history') loadMeetingHistory();
  });
});

// ═══ Live Clock ═══
function updateClock() {
  const now = new Date();
  const el = document.getElementById('sidebar-datetime');
  if (el) el.textContent = now.toLocaleDateString('en-US', { weekday:'short', year:'numeric', month:'short', day:'numeric' }) + '  •  ' + now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
updateClock(); setInterval(updateClock, 1000);

// ═══ Audio Recording (MediaRecorder + Gemini Transcription) ═══
// Records audio locally, sends chunks to Gemini for transcription
// No Web Speech API needed — works in Electron

const CHUNK_INTERVAL = 15000; // 15 seconds per chunk
let chunkTimer = null;
let mediaRecorder = null;
let audioChunks = [];

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.micStream = stream;

    // Determine supported mime type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    state.fullRecordingChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
        state.fullRecordingChunks.push(e.data); // Keep a copy for full-recording fallback
      }
    };

    mediaRecorder.start(1000); // collect data every 1s for smooth chunks
    return true;
  } catch (err) {
    showToast('Microphone access denied: ' + err.message, 'error');
    return false;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
}

async function flushAndTranscribe() {
  if (!audioChunks.length || !state.isRecording) return;

  // Grab current chunks and reset
  const chunks = audioChunks.splice(0);
  const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });

  if (blob.size < 1000) return; // skip tiny chunks (silence)

  // Convert to base64
  const buffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mime = mediaRecorder?.mimeType?.split(';')[0] || 'audio/webm';

  const elapsed = state.meetingStartTime ? Math.floor((Date.now() - state.meetingStartTime) / 1000) : 0;
  const ts = formatTime(elapsed);

  // Show interim indicator
  updateInterimLine(ts, '⏳ Transcribing...');

  try {
    const result = await window.prismclaw.transcribeChunk(base64, mime);
    // Remove interim indicator
    document.getElementById('transcript-area')?.querySelector('.transcript-line.interim')?.remove();

    if (result.ok && result.text && !result.text.includes('[silence]')) {
      addTranscriptLine(ts, result.text);
      state.transcript.push({ timestamp: ts, text: result.text, isFinal: true });
    }
  } catch (err) {
    document.getElementById('transcript-area')?.querySelector('.transcript-line.interim')?.remove();
    console.error('Transcription chunk error:', err);
  }
}

// ═══ Meeting Lifecycle (Ctrl+Shift+M) ═══
function toggleMeeting() { state.isRecording ? stopMeeting() : startMeeting(); }

async function startMeeting() {
  const titleInput = document.getElementById('meeting-title');
  if (!titleInput.value.trim()) {
    titleInput.value = `Meeting — ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}`;
  }
  // Switch to record panel
  document.querySelector('.nav-btn[data-panel="record"]')?.click();

  // Start MediaRecorder
  const started = await startRecording();
  if (!started) return;

  state.isRecording = true;
  state.meetingStartTime = Date.now();
  state.transcript = [];
  document.getElementById('transcript-area').innerHTML = '<div class="transcript-line interim"><span class="timestamp">●</span>Recording — transcript will appear after meeting ends</div>';
  document.getElementById('btn-record').classList.add('recording');
  document.getElementById('btn-record').querySelector('span').textContent = 'End Meeting';
  document.querySelector('.record-dot').classList.add('active');
  document.querySelector('.record-label').textContent = 'Recording...';
  document.getElementById('badge-live').style.display = 'inline-flex';
  document.getElementById('badge-duration').style.display = 'inline-flex';
  document.getElementById('card-gen-notes').style.display = 'none';
  document.getElementById('card-context').style.display = 'none';

  // Duration timer
  state.durationTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - state.meetingStartTime) / 1000);
    document.getElementById('badge-duration').textContent = formatTime(secs);
  }, 1000);

  // NOTE: Real-time chunk transcription disabled — Groq rejects partial WebM
  // and Gemini is often rate-limited. Full transcription happens after meeting ends.

  startAudioAnalyser();
  showToast('Recording started — Whisper will transcribe after meeting', 'success');
}

async function stopMeeting() {
  const durationSecs = state.meetingStartTime ? Math.floor((Date.now() - state.meetingStartTime) / 1000) : 0;
  state.isRecording = false;
  if (state.durationTimer) { clearInterval(state.durationTimer); state.durationTimer = null; }
  stopRecording();
  stopAudioAnalyser();

  document.getElementById('btn-record').classList.remove('recording');
  document.getElementById('btn-record').querySelector('span').textContent = 'Start Meeting';
  document.querySelector('.record-dot').classList.remove('active');
  document.querySelector('.record-label').textContent = 'Transcribing...';
  document.getElementById('badge-live').style.display = 'none';

  // Clear the recording indicator
  document.getElementById('transcript-area').innerHTML = '';

  let fullTranscript = '';

  // Transcribe the full recording via Whisper (primary) or Gemini (fallback)
  if (state.fullRecordingChunks.length > 0) {
    showToast('Transcribing recording via Whisper...', 'info');
    document.querySelector('.record-label').textContent = 'Transcribing full recording...';
    try {
      const fullBlob = new Blob(state.fullRecordingChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      const buffer = await fullBlob.arrayBuffer();
      // Safe base64 conversion (btoa crashes on large buffers)
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
      }
      const base64 = btoa(binary);
      const mime = mediaRecorder?.mimeType?.split(';')[0] || 'audio/webm';
      const result = await window.prismclaw.transcribeFullRecording(base64, mime);
      if (result.ok && result.text && !result.text.includes('[silence]')) {
        fullTranscript = result.text;
        // Show transcript lines
        const lines = result.text.split('\n').filter(l => l.trim());
        lines.forEach(line => {
          const match = line.match(/^\[(\d{2}:\d{2})\]\s*(.+)/);
          if (match) addTranscriptLine(match[1], match[2]);
          else addTranscriptLine('00:00', line);
        });
        if (result.savedAs) showToast(`Recording saved: ${result.savedAs}`, 'success');
      }
    } catch (err) {
      console.error('Full recording transcription failed:', err);
      showToast('Transcription failed — recording saved to disk', 'error');
    }
  }

  if (!fullTranscript.trim()) {
    document.querySelector('.record-label').textContent = 'Ready to Record';
    document.getElementById('badge-duration').style.display = 'none';
    showToast('No speech detected', 'info');
    return;
  }

  showToast('Generating notes with AI...', 'info');
  document.querySelector('.record-label').textContent = 'Generating notes...';
  try {
    const result = await window.prismclaw.generateNotes(fullTranscript);
    if (result.ok) {
      document.getElementById('card-gen-notes').style.display = 'flex';
      document.getElementById('generated-notes-content').innerHTML = renderMarkdown(result.notes);
      const rating = result.rating || 0;
      document.getElementById('rating-display').innerHTML = rating ? `⭐ ${rating}/10` : '';

      // Auto-generate smart title from notes summary
      const titleInput = document.getElementById('meeting-title');
      const autoTitle = extractSmartTitle(result.notes, titleInput.value);
      if (autoTitle) titleInput.value = autoTitle;

      const durationStr = formatTime(durationSecs);
      showToast(`Notes ready! ${result.dates?.length || 0} dates · ⭐ ${rating}/10 · ${durationStr}`, 'success');
      state.lastResult = {
        title: titleInput.value,
        transcript: fullTranscript, notes: result.notes,
        dates: result.dates || [], rating, durationSecs,
      };

      // ── Auto-save: Save to DB + Calendar + Telegram + Obsidian automatically ──
      showToast('Auto-saving meeting...', 'info');
      document.querySelector('.record-label').textContent = 'Saving...';
      try {
        const saveResult = await window.prismclaw.saveMeeting(state.lastResult);
        if (saveResult.ok) {
          showToast('Meeting saved → Calendar + Telegram + Obsidian ✓', 'success');
        } else {
          showToast('Auto-save failed: ' + saveResult.error, 'error');
        }
      } catch (saveErr) {
        showToast('Auto-save error: ' + saveErr.message, 'error');
      }
    } else { showToast('Notes failed: ' + result.error, 'error'); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
  document.querySelector('.record-label').textContent = 'Ready to Record';
}

/**
 * Extract a smart, short title from AI-generated notes.
 * Falls back to the existing title if extraction fails.
 */
function extractSmartTitle(notes, fallback) {
  // Try to extract from "Meeting Summary" section
  const summaryMatch = notes.match(/Meeting Summary[*\s]*[—\-:]*\s*(.+?)(?:\.|$)/im);
  if (summaryMatch) {
    const title = summaryMatch[1].replace(/[*#]/g, '').trim();
    if (title.length > 5 && title.length < 80) return title;
  }
  return fallback;
}

// Transcript helpers
function addTranscriptLine(ts, text) {
  const area = document.getElementById('transcript-area');
  area.querySelector('.empty-state')?.remove();
  area.querySelector('.transcript-line.interim')?.remove();
  const div = document.createElement('div');
  div.className = 'transcript-line';
  div.innerHTML = `<span class="timestamp">${ts}</span>${escapeHtml(text)}`;
  area.appendChild(div); area.scrollTop = area.scrollHeight;
}
function updateInterimLine(ts, text) {
  const area = document.getElementById('transcript-area');
  let interim = area.querySelector('.transcript-line.interim');
  if (!interim) { interim = document.createElement('div'); interim.className = 'transcript-line interim'; area.appendChild(interim); }
  interim.innerHTML = `<span class="timestamp">${ts}</span>${escapeHtml(text)}`;
  area.scrollTop = area.scrollHeight;
}

// ═══ Hotkey Listeners ═══
console.log('Registering hotkey listeners...');

// Ctrl+Shift+R — Real-time Context (last 30s hardcoded window)
const CONTEXT_WINDOW_SECS = 30; // Hardcoded: always analyze last 30 seconds
let contextCooldown = false;

if (window.prismclaw?.onRealtimeContext) {
  window.prismclaw.onRealtimeContext(async () => {
    if (!state.isRecording) {
      showToast('Start a meeting first (Ctrl+Shift+M)', 'info');
      return;
    }
    if (contextCooldown) {
      showToast('Context cooling down — wait a few seconds', 'info');
      return;
    }

    // Cooldown: 10 seconds between context requests
    contextCooldown = true;
    setTimeout(() => { contextCooldown = false; }, 10000);

    document.getElementById('card-context').style.display = 'flex';
    document.getElementById('context-content').innerHTML = '<div class="loading-skeleton">Transcribing last 30s...</div>';
    showToast('Analyzing last 30 seconds...', 'info');

    try {
      // MediaRecorder fires ondataavailable every 1s → 30 chunks = 30 seconds
      const recentChunks = state.fullRecordingChunks.slice(-CONTEXT_WINDOW_SECS);
      if (recentChunks.length === 0) {
        document.getElementById('context-content').innerHTML = '<div class="empty-state">No audio yet — speak first</div>';
        return;
      }

      const blob = new Blob(recentChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
      }
      const base64 = btoa(binary);
      const mime = mediaRecorder?.mimeType?.split(';')[0] || 'audio/webm';

      // Transcribe the 30s window via Whisper
      document.getElementById('context-content').innerHTML = '<div class="loading-skeleton">Analyzing conversation...</div>';
      const txResult = await window.prismclaw.transcribeChunk(base64, mime);
      const recentText = txResult.ok ? txResult.text : '';

      if (!recentText.trim()) {
        document.getElementById('context-content').innerHTML = '<div class="empty-state">No speech detected in last 30s</div>';
        return;
      }

      // Get AI context analysis
      const result = await window.prismclaw.getContext(recentText);
      document.getElementById('context-content').innerHTML = result.ok
        ? renderMarkdown(result.context)
        : `<div class="empty-state">${result.error}</div>`;
      if (result.ok) showToast('Context updated ✓', 'success');
    } catch (err) {
      document.getElementById('context-content').innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
  });
}

// Ctrl+Shift+M — Meeting Toggle
if (window.prismclaw?.onToggleMeeting) {
  window.prismclaw.onToggleMeeting(() => {
    console.log('Hotkey: Ctrl+Shift+M received');
    toggleMeeting();
  });
}

// Ctrl+Shift+Q — Search
if (window.prismclaw?.onSearchHotkey) {
  window.prismclaw.onSearchHotkey(() => {
    console.log('Hotkey: Ctrl+Shift+Q received');
    toggleSearch();
  });
}

// ═══ Save Meeting ═══
document.getElementById('btn-save-meeting')?.addEventListener('click', async () => {
  if (!state.lastResult) { showToast('No notes to save', 'error'); return; }
  const btn = document.getElementById('btn-save-meeting');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const result = await window.prismclaw.saveMeeting(state.lastResult);
    if (result.ok) {
      showToast('Saved → Calendar + Telegram + Obsidian ✓', 'success');
      state.lastResult = null;
      document.getElementById('card-gen-notes').style.display = 'none';
    } else { showToast('Save failed: ' + result.error, 'error'); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
  btn.disabled = false;
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg> Save & Send';
});

// ═══ Pre-Meeting Brief ═══
async function getPreMeetingBrief() {
  const title = document.getElementById('meeting-title')?.value?.trim();
  if (!title) { showToast('Enter a meeting title first', 'info'); return; }
  showToast('Generating brief with full context...', 'info');
  document.getElementById('card-brief').style.display = 'flex';
  document.getElementById('brief-content').innerHTML = '<div class="loading-skeleton">Building context from vault + past meetings...</div>';
  try {
    const result = await window.prismclaw.getPreMeetingBrief(title);
    document.getElementById('brief-content').innerHTML = result.ok ? renderMarkdown(result.brief) : `<div class="empty-state">${result.error}</div>`;
  } catch (err) { document.getElementById('brief-content').innerHTML = `<div class="empty-state">${err.message}</div>`; }
}
document.getElementById('btn-pre-brief')?.addEventListener('click', getPreMeetingBrief);
document.getElementById('btn-prep-meeting')?.addEventListener('click', () => {
  document.querySelector('.nav-btn[data-panel="record"]')?.click();
  const firstEvent = document.querySelector('.event-title');
  if (firstEvent) document.getElementById('meeting-title').value = firstEvent.textContent;
  setTimeout(getPreMeetingBrief, 200);
});

// ═══ Search (Ctrl+Shift+Q) ═══
function toggleSearch() {
  const overlay = document.getElementById('search-overlay');
  if (state.searchOpen) { overlay.style.display = 'none'; state.searchOpen = false; }
  else {
    overlay.style.display = 'flex'; state.searchOpen = true;
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').style.display = 'none';
    setTimeout(() => document.getElementById('search-input').focus(), 50);
  }
}
document.getElementById('search-backdrop')?.addEventListener('click', toggleSearch);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.searchOpen) toggleSearch();
  // NOTE: Ctrl+Shift+Q is handled by Electron's globalShortcut in main.js
  // Do NOT add a renderer-side handler here — it causes a double-toggle bug
});

document.getElementById('search-input')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const query = e.target.value.trim();
  if (!query) return;
  const resultsDiv = document.getElementById('search-results');
  const filesDiv = document.getElementById('search-files');
  const analysisDiv = document.getElementById('search-analysis');
  const graphDiv = document.getElementById('search-graph');
  resultsDiv.style.display = 'flex';
  filesDiv.innerHTML = '<div class="loading-skeleton">Searching...</div>';
  analysisDiv.innerHTML = ''; graphDiv.innerHTML = '';
  try {
    const result = await window.prismclaw.searchQuery(query);
    if (!result.ok) { filesDiv.innerHTML = `<div class="empty-state">${result.error}</div>`; return; }
    filesDiv.innerHTML = result.results?.length
      ? result.results.map(r => `<div class="search-file-item"><div class="search-file-name">📄 ${escapeHtml(r.filename)}</div><div class="search-file-match">${r.matches.slice(0,3).map(m => `L${m.line}: ${escapeHtml(m.text)}`).join('<br>')}</div></div>`).join('')
      : '<div class="empty-state" style="min-height:30px">No files matched</div>';
    if (result.analysis) analysisDiv.innerHTML = renderMarkdown(result.analysis);
    if (result.chartData?.labels?.length) {
      graphDiv.innerHTML = '<canvas id="search-chart" height="200"></canvas>';
      const ctx = document.getElementById('search-chart').getContext('2d');
      if (state.searchChart) state.searchChart.destroy();
      const palette = ['#808080','#a0a0a0','#60a5fa','#4ade80','#fbbf24','#f87171','#67e8f9','#c084fc'];
      state.searchChart = new Chart(ctx, {
        type: result.chartData.chartType || 'bar',
        data: { labels: result.chartData.labels, datasets: [{ label: result.chartData.title || 'Data', data: result.chartData.values, backgroundColor: result.chartData.labels.map((_,i) => palette[i%8]+'99'), borderColor: result.chartData.labels.map((_,i) => palette[i%8]), borderWidth: 1, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: result.chartData.title || '', color: '#aaa', font: { size: 12 } } }, scales: { x: { grid: { display: false }, ticks: { color: '#555', font: { size: 9 } }, border: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#555', font: { size: 9 } }, border: { display: false } } } },
      });
    }
  } catch (err) { filesDiv.innerHTML = `<div class="empty-state">${err.message}</div>`; }
});

// ═══ Dashboard ═══
async function loadCalendarEvents() {
  const container = document.getElementById('events-list');
  container.innerHTML = '<div class="loading-skeleton">Loading events...</div>';
  try {
    if (!window.prismclaw?.getCalendarEvents) { container.innerHTML = '<div class="empty-state">Loading...</div>'; return; }
    const result = await window.prismclaw.getCalendarEvents();
    if (!result.ok) { container.innerHTML = `<div class="empty-state">⚠ ${result.error}</div>`; return; }
    if (!result.events.length) { container.innerHTML = '<div class="empty-state">No upcoming events</div>'; return; }
    const colors = ['blue', 'purple', 'green', 'cyan', 'amber'];
    let html = result.isDemo ? '<div style="font-size:9px;color:#555;text-align:center;padding:2px 0 8px;letter-spacing:1.5px">DEMO EVENTS</div>' : '';
    let lastDateLabel = '';
    const now = new Date();
    result.events.forEach((ev, i) => {
      const start = new Date(ev.start?.dateTime || ev.start?.date);
      const dateLabel = start.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      if (dateLabel !== lastDateLabel) {
        const daysAway = Math.ceil((start - now) / 86400000);
        const rel = daysAway <= 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `${daysAway}d`;
        html += `<div class="event-date-label">${dateLabel} <span style="float:right;color:#888;font-size:9px;text-transform:none;letter-spacing:0;font-weight:500">${rel}</span></div>`;
        lastDateLabel = dateLabel;
      }
      const timeStr = ev.start?.dateTime ? start.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }) : 'All day';
      html += `<div class="event-item"><span class="event-dot ${colors[i%5]}"></span><div class="event-info"><div class="event-title">${escapeHtml(ev.summary || 'Untitled')}</div><div class="event-time">${timeStr}</div></div></div>`;
    });
    container.innerHTML = html;
  } catch { container.innerHTML = '<div class="empty-state">Error loading</div>'; }
}

async function loadMeetingsChart() {
  try {
    if (!window.prismclaw?.getRecentMeetings) return;
    const result = await window.prismclaw.getRecentMeetings();
    const meetings = result.ok ? result.meetings : [];
    let labels, data, chartLabel;
    const rated = meetings.filter(m => m.rating > 0);
    if (rated.length >= 2) {
      labels = rated.slice(0, 10).reverse().map(m => m.title?.substring(0, 15) || 'Meeting');
      data = rated.slice(0, 10).reverse().map(m => m.rating);
      chartLabel = 'Productivity Rating';
    } else {
      labels = []; data = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('en-US', { month:'short', day:'numeric' }));
        data.push(meetings.filter(m => m.created_at?.startsWith(d.toISOString().split('T')[0])).length);
      }
      chartLabel = 'Meetings';
    }
    const ctx = document.getElementById('meetings-chart').getContext('2d');
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: chartLabel, data, backgroundColor: 'rgba(160,160,160,0.4)', borderColor: 'rgba(160,160,160,0.6)', borderWidth: 1, borderRadius: 4, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a1a1a', titleColor: '#ccc', bodyColor: '#aaa', borderColor: '#333', borderWidth: 1, cornerRadius: 6, padding: 8 } }, scales: { x: { grid: { display: false }, ticks: { color: '#555', font: { size: 9 }, maxRotation: 45 }, border: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#555', font: { size: 9 }, stepSize: 1 }, border: { display: false } } } },
    });
    // Stats badges
    try {
      const statsResult = await window.prismclaw.getMeetingStats();
      if (statsResult.ok) {
        const s = statsResult.stats;
        document.getElementById('stats-badges').innerHTML = `<span class="stat-badge">${s.totalMeetings} meets</span><span class="stat-badge">⭐ ${s.avgRating || '—'}</span><span class="stat-badge">${s.meetingsThisWeek} this week</span>`;
      }
    } catch {}
  } catch (err) { console.error('Chart:', err); }
}

async function loadRecentNotes() {
  const container = document.getElementById('recent-notes-list');
  try {
    if (!window.prismclaw?.getRecentMeetings) { container.innerHTML = '<div class="empty-state">Loading...</div>'; return; }
    const result = await window.prismclaw.getRecentMeetings();
    const meetings = result.ok ? result.meetings : [];
    if (!meetings.length) { container.innerHTML = '<div class="empty-state">No meetings yet</div>'; return; }
    container.innerHTML = meetings.slice(0, 5).map(m => {
      const rating = m.rating ? `⭐ ${m.rating}/10` : '';
      const dur = m.duration_secs ? ` · ${Math.round(m.duration_secs / 60)}min` : '';
      return `<div class="note-history-item"><div class="note-history-title">${escapeHtml(m.title)}</div><div class="note-history-date">${new Date(m.created_at).toLocaleString()}${rating ? ` · ${rating}` : ''}${dur}</div><div class="note-history-preview">${escapeHtml((m.notes||'').substring(0,120))}</div></div>`;
    }).join('');
  } catch { container.innerHTML = '<div class="empty-state">Error</div>'; }
}

// ═══ Past Meetings History ═══
async function loadMeetingHistory() {
  const container = document.getElementById('history-list');
  const statsContainer = document.getElementById('history-stats');
  container.innerHTML = '<div class="loading-skeleton">Loading...</div>';
  try {
    const result = await window.prismclaw.getRecentMeetings();
    const meetings = result.ok ? result.meetings : [];
    // Stats
    try {
      const statsResult = await window.prismclaw.getMeetingStats();
      if (statsResult.ok) {
        const s = statsResult.stats;
        statsContainer.innerHTML = `<span class="stat-badge">${s.totalMeetings} total</span><span class="stat-badge">⭐ Avg ${s.avgRating || '—'}/10</span><span class="stat-badge">⏱ ${s.totalDurationMins}min total</span><span class="stat-badge">${s.meetingsThisWeek} this week</span>`;
      }
    } catch {}
    if (!meetings.length) { container.innerHTML = '<div class="empty-state">No meetings recorded yet. Press Ctrl+Shift+M to start your first meeting.</div>'; return; }
    container.innerHTML = meetings.map(m => {
      const rating = m.rating || 0;
      const stars = rating > 0 ? '⭐'.repeat(Math.min(Math.round(rating / 2), 5)) : '—';
      const dur = m.duration_secs ? `${Math.round(m.duration_secs / 60)}min` : '—';
      const dateStr = new Date(m.created_at).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
      const timeStr = new Date(m.created_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
      const dates = (() => { try { return JSON.parse(m.dates_json || '[]'); } catch { return []; } })();
      const datesHtml = dates.length ? `<div class="history-dates">${dates.slice(0,3).map(d => `<span class="date-tag">📅 ${d.date?.substring(0,10)}: ${escapeHtml((d.summary||'').substring(0,40))}</span>`).join('')}</div>` : '';
      return `<div class="history-item" data-id="${m.id}">
        <div class="history-item-header">
          <div class="history-item-title">${escapeHtml(m.title)}</div>
          <div class="history-item-rating">${rating > 0 ? `${rating}/10` : '—'} ${stars}</div>
        </div>
        <div class="history-item-meta">${dateStr} · ${timeStr} · ⏱ ${dur}</div>
        ${datesHtml}
        <div class="history-item-notes">${renderMarkdown((m.notes||'').substring(0, 300))}</div>
      </div>`;
    }).join('');
  } catch { container.innerHTML = '<div class="empty-state">Error loading history</div>'; }
}

async function loadNotesHistory() {
  const container = document.getElementById('notes-history-list');
  try {
    const result = await window.prismclaw.getRecentMeetings();
    const meetings = result.ok ? result.meetings : [];
    if (!meetings.length) { container.innerHTML = '<div class="empty-state">No saved meetings</div>'; return; }
    container.innerHTML = meetings.map(m => `<div class="note-history-item"><div class="note-history-title">${escapeHtml(m.title)}${m.rating ? ` · ⭐ ${m.rating}/10` : ''}</div><div class="note-history-date">${new Date(m.created_at).toLocaleString()}</div><div class="note-history-preview">${renderMarkdown(m.notes||'')}</div></div>`).join('');
  } catch { container.innerHTML = '<div class="empty-state">Error</div>'; }
}

// ═══ Event Listeners ═══
document.getElementById('btn-record')?.addEventListener('click', toggleMeeting);
document.getElementById('btn-refresh-events')?.addEventListener('click', loadCalendarEvents);
document.getElementById('btn-test-telegram')?.addEventListener('click', async () => {
  showToast('Testing Telegram...', 'info');
  const r = await window.prismclaw.testTelegram();
  showToast(r.ok ? 'Telegram connected ✓' : 'Error: ' + r.error, r.ok ? 'success' : 'error');
});

// ═══ Utilities ═══
function formatTime(s) { return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; }
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function renderMarkdown(md) {
  if (!md) return '';
  return md.replace(/^### (.*$)/gm, '<h3>$1</h3>').replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^- (.*$)/gm, '• $1<br>')
    .replace(/\n/g, '<br>');
}
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('toast-exit'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ═══ Audio Level Analyser (Mic Visualizer) ═══
async function startAudioAnalyser() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.micStream = stream;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.5;
    const source = state.audioCtx.createMediaStreamSource(stream);
    source.connect(state.analyser);

    const micViz = document.getElementById('mic-viz');
    const micFill = document.getElementById('mic-fill');
    micViz.classList.add('active');
    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);

    function updateViz() {
      if (!state.isRecording) return;
      state.analyser.getByteFrequencyData(dataArray);
      // Average volume 0-255
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const level = Math.min(avg / 80, 1); // normalize to 0-1
      // Move the fill rect: y=32 means empty, y=0 means full
      const y = 32 - (level * 32);
      micFill.setAttribute('y', y);
      micViz.classList.toggle('loud', level > 0.5);
      state.vizRAF = requestAnimationFrame(updateViz);
    }
    updateViz();
  } catch (err) {
    console.log('Audio analyser unavailable:', err.message);
  }
}

function stopAudioAnalyser() {
  if (state.vizRAF) { cancelAnimationFrame(state.vizRAF); state.vizRAF = null; }
  if (state.micStream) { state.micStream.getTracks().forEach(t => t.stop()); state.micStream = null; }
  if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
  const micViz = document.getElementById('mic-viz');
  const micFill = document.getElementById('mic-fill');
  if (micViz) micViz.classList.remove('active', 'loud');
  if (micFill) micFill.setAttribute('y', 32);
}

// ═══ Greeting ═══
async function updateGreeting() {
  const h = new Date().getHours();
  let timeGreet, sub, emoji;
  if (h < 12) { timeGreet = 'Good morning'; emoji = '☀️'; sub = 'Ready to make today productive!'; }
  else if (h < 17) { timeGreet = 'Good afternoon'; emoji = '🌤️'; sub = 'Hope your meetings go great today!'; }
  else { timeGreet = 'Good evening'; emoji = '🌙'; sub = 'Wrapping up the day — great work!'; }
  let name = 'there';
  try {
    if (window.prismclaw?.getUserName) {
      const r = await window.prismclaw.getUserName();
      if (r.ok && r.name) name = r.name;
    }
  } catch {}
  const el = document.getElementById('greeting-text');
  const subEl = document.getElementById('greeting-sub');
  if (el) el.textContent = `${emoji} ${timeGreet}, ${name}`;
  if (subEl) subEl.textContent = sub;
}

// Safe API call wrapper — prevents crashes if prismclaw not yet loaded
async function safeCall(fn) {
  try { return await fn(); } catch (err) { console.error('API call failed:', err); return null; }
}

async function loadDashboard() {
  updateGreeting();
  try { await loadCalendarEvents(); } catch (e) { console.error('Calendar load error:', e); }
  try { await loadMeetingsChart(); } catch (e) { console.error('Chart load error:', e); }
  try { await loadRecentNotes(); } catch (e) { console.error('Notes load error:', e); }
}

// Init — load dashboard but don't let errors block anything
loadDashboard().catch(e => console.error('Dashboard init error:', e));

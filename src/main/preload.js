// PrismClaw — Preload Script (Context Bridge v5)
// Hotkeys: Ctrl+Shift+M (meeting), Ctrl+Shift+R (context), Ctrl+Shift+Q (search)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prismclaw', {
  // ── Calendar ──
  getCalendarEvents: () => ipcRenderer.invoke('calendar:getEvents'),

  // ── Gemini: During Meeting ──
  getContext: (transcriptChunk) => ipcRenderer.invoke('meeting:getContext', transcriptChunk),

  // ── Gemini: Post Meeting ──
  generateNotes: (transcript) => ipcRenderer.invoke('notes:generate', transcript),

  // ── Gemini: Pre Meeting ──
  getPreMeetingBrief: (meetingTitle) => ipcRenderer.invoke('meeting:preBrief', meetingTitle),

  // ── Save Meeting (DB + Calendar + Telegram + Obsidian) ──
  saveMeeting: (data) => ipcRenderer.invoke('meeting:save', data),

  // ── Meeting History ──
  getRecentMeetings: () => ipcRenderer.invoke('meetings:recent'),
  getMeetingStats: () => ipcRenderer.invoke('meetings:stats'),
  getMeetingById: (id) => ipcRenderer.invoke('meetings:getById', id),

  // ── Search (Ctrl+Shift+Q) ──
  searchQuery: (query) => ipcRenderer.invoke('search:query', query),

  // ── Telegram ──
  testTelegram: () => ipcRenderer.invoke('telegram:test'),

  // ── Audio File Transcription ──
  pickAndTranscribeAudio: () => ipcRenderer.invoke('audio:pickAndTranscribe'),
  transcribeChunk: (base64, mime) => ipcRenderer.invoke('audio:transcribeChunk', base64, mime),
  transcribeFullRecording: (base64, mime) => ipcRenderer.invoke('audio:transcribeFull', base64, mime),

  // ── System ──
  checkAudio: () => ipcRenderer.invoke('system:checkAudio'),
  getUserName: () => ipcRenderer.invoke('user:getName'),

  // ── Context Engine ──
  getContextStatus: () => ipcRenderer.invoke('context:status'),

  // ── Hotkey listeners ──
  onToggleMeeting: (cb) => ipcRenderer.on('hotkey:toggle-meeting', () => cb()),
  onRealtimeContext: (cb) => ipcRenderer.on('hotkey:realtime-context', () => cb()),
  onSearchHotkey: (cb) => ipcRenderer.on('hotkey:search', () => cb()),
});

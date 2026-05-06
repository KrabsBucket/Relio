// PrismClaw — Telegram Bot Service
// Compact, formal meeting notifications via Telegram
const TelegramBot = require('node-telegram-bot-api');

let bot = null;

function getBot() {
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('⚠ TELEGRAM_BOT_TOKEN not set — Telegram disabled');
    return null;
  }
  bot = new TelegramBot(token, { polling: false });
  return bot;
}

function getChatId() {
  return process.env.TELEGRAM_CHAT_ID || '';
}

/**
 * Send a plain text message (no markdown parsing — safe from formatting errors).
 */
async function sendTelegramMessage(text) {
  const b = getBot();
  const chatId = getChatId();
  if (!b || !chatId) return;
  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    // Fallback: send without parse_mode if markdown fails
    console.warn('Telegram markdown failed, sending as plain text');
    try {
      await b.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ''));
    } catch (e2) {
      console.error('Telegram send failed:', e2.message);
    }
  }
}

/**
 * Send a compact, formal meeting summary to Telegram.
 * Extracts key sections from the notes and formats a concise message.
 */
async function sendMeetingNotes(meetingTitle, notes, durationSecs = 0) {
  const b = getBot();
  const chatId = getChatId();
  if (!b || !chatId) return;

  // Extract key sections from notes
  const summary = extractSection(notes, 'Meeting Summary') || extractSection(notes, 'Summary') || '';
  const actions = extractBullets(notes, 'Action Items');
  const dates = extractBullets(notes, 'Important Dates');
  const decisions = extractBullets(notes, 'Decisions Made');
  const rating = extractRating(notes);
  const duration = durationSecs > 0 ? formatDuration(durationSecs) : '';

  // Build compact message
  const lines = [];
  lines.push(`📋 *${sanitize(cleanTitle(meetingTitle))}*`);
  const meta = [new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })];
  if (duration) meta.push(`⏱ ${duration}`);
  if (rating) meta.push(`⭐ ${rating}/10`);
  lines.push(meta.join(' · '));
  lines.push('');

  if (summary) {
    lines.push(sanitize(summary.substring(0, 300)));
    lines.push('');
  }

  if (actions.length) {
    lines.push('*Action Items:*');
    actions.slice(0, 5).forEach(a => lines.push(`  → ${sanitize(a)}`));
    lines.push('');
  }

  if (dates.length) {
    lines.push('*Dates:*');
    dates.slice(0, 4).forEach(d => lines.push(`  📅 ${sanitize(d)}`));
    lines.push('');
  }

  if (decisions.length) {
    lines.push('*Decisions:*');
    decisions.slice(0, 4).forEach(d => lines.push(`  ✓ ${sanitize(d)}`));
    lines.push('');
  }

  lines.push('— PrismClaw AI');

  const message = lines.join('\n');

  try {
    await b.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    // Fallback: send without formatting
    console.warn('Telegram markdown error, sending plain:', err.message);
    try {
      await b.sendMessage(chatId, message.replace(/[*_`\[\]]/g, ''));
    } catch (e2) {
      console.error('Telegram fallback failed:', e2.message);
    }
  }
}

/**
 * Send a meeting reminder.
 */
async function sendReminder(eventTitle, minutesUntil) {
  const b = getBot();
  const chatId = getChatId();
  if (!b || !chatId) return;

  const mins = Math.round(minutesUntil);
  const emoji = mins <= 5 ? '🚨' : '⏰';
  const msg = `${emoji} ${sanitize(eventTitle)} — ${mins} min`;
  try {
    await b.sendMessage(chatId, msg);
  } catch (e) { console.error('Telegram reminder error:', e.message); }
}

// ── Helpers ─────────────────────────────────────────

/**
 * Sanitize text for Telegram Markdown — remove problematic characters.
 */
function sanitize(text) {
  return (text || '')
    .replace(/[[\]()~`>#+\-=|{}.!]/g, '') // Remove markdown-breaking chars
    .replace(/\*\*/g, '')                   // Remove bold markers (we use our own)
    .replace(/\n{3,}/g, '\n\n')             // Collapse multiple newlines
    .trim();
}

/**
 * Clean meeting title — remove rating info already appended.
 */
function cleanTitle(title) {
  return title.replace(/\n⭐.*$/s, '').trim();
}

/**
 * Extract a section's content from AI-generated notes.
 */
function extractSection(notes, sectionName) {
  const regex = new RegExp(`(?:##?\\s*(?:📋|🎯|✅|📌|📅|🔄|💡|⭐)?\\s*)?${sectionName}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
  const match = notes.match(regex);
  if (!match) return '';
  return match[1]
    .replace(/^[\s-•*]+/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .substring(0, 500);
}

/**
 * Extract bullet points from a section.
 */
function extractBullets(notes, sectionName) {
  const regex = new RegExp(`(?:##?\\s*(?:📋|🎯|✅|📌|📅|🔄|💡|⭐)?\\s*)?${sectionName}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
  const match = notes.match(regex);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map(line => line.replace(/^[\s\-•*\[\]✅📌📅]+/, '').trim())
    .filter(line => line.length > 3);
}

/**
 * Extract rating from notes.
 */
function extractRating(notes) {
  const match = notes.match(/(\d+(?:\.\d)?)\s*\/\s*10/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Format seconds to human-readable duration.
 */
function formatDuration(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

module.exports = { sendTelegramMessage, sendMeetingNotes, sendReminder, getBot };

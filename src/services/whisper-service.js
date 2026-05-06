// PrismClaw — Whisper Transcription Service (via Groq API — FREE)
// Primary transcription engine: fast, accurate, generous free tier
// Get a free key at https://console.groq.com
const https = require('https');
const fs = require('fs');
const path = require('path');

const GROQ_API_URL = 'api.groq.com';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

/**
 * Transcribe an audio buffer using Groq's free Whisper API.
 * @param {Buffer} audioBuffer — Raw audio data
 * @param {string} mimeType — MIME type (e.g. 'audio/webm')
 * @param {string} [language='en'] — Language code
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function transcribeWithWhisper(audioBuffer, mimeType = 'audio/webm', language = 'en') {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'GROQ_API_KEY not set. Get a free key at https://console.groq.com' };
  }

  if (audioBuffer.length < 500) {
    return { ok: true, text: '' }; // Too small, likely silence
  }

  // Determine file extension from mime
  const extMap = {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
    'audio/x-m4a': 'm4a', 'audio/mp3': 'mp3',
  };
  const ext = extMap[mimeType] || 'webm';

  // Build multipart form data manually
  const boundary = '----PrismClawBoundary' + Date.now() + Math.random().toString(36).substring(7);

  const parts = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${WHISPER_MODEL}\r\n`
  ));

  // Language part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n` +
    `${language}\r\n`
  ));

  // Response format
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `verbose_json\r\n`
  ));

  // Temperature (0 for more accurate)
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="temperature"\r\n\r\n` +
    `0\r\n`
  ));

  // Close boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve) => {
    const options = {
      hostname: GROQ_API_URL,
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`Groq Whisper HTTP ${res.statusCode}: ${data.substring(0, 300)}`);
            resolve({ ok: false, error: `Groq API error (${res.statusCode})` });
            return;
          }
          const json = JSON.parse(data);
          const text = json.text?.trim() || '';
          if (json.segments?.length) {
            // Build timestamped transcript from segments
            const timestamped = json.segments
              .map(s => `[${formatSecs(s.start)}] ${s.text.trim()}`)
              .filter(line => line.length > 7) // skip empty segments
              .join('\n');
            resolve({ ok: true, text: timestamped || text, rawText: text });
          } else {
            resolve({ ok: true, text, rawText: text });
          }
        } catch (err) {
          console.error('Groq Whisper parse error:', err.message);
          resolve({ ok: false, error: err.message });
        }
      });
    });

    req.on('error', (err) => {
      console.error('Groq Whisper network error:', err.message);
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Groq Whisper request timed out' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Transcribe an audio file from disk.
 */
async function transcribeFileWithWhisper(filePath, language = 'en') {
  const audioBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.webm': 'audio/webm', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.aac': 'audio/aac',
  };
  const mimeType = mimeMap[ext] || 'audio/mpeg';

  console.log(`🎙️ Whisper: Transcribing ${path.basename(filePath)} (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  // Groq limit is 25MB per file. For larger files, we'd need to split.
  if (audioBuffer.length > 25 * 1024 * 1024) {
    return { ok: false, error: 'File too large for Groq Whisper (max 25MB)' };
  }

  return await transcribeWithWhisper(audioBuffer, mimeType, language);
}

function formatSecs(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/**
 * Check if Groq Whisper is available (API key configured).
 */
function isWhisperAvailable() {
  return !!process.env.GROQ_API_KEY;
}

module.exports = { transcribeWithWhisper, transcribeFileWithWhisper, isWhisperAvailable };

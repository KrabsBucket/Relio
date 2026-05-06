// Relio — Multi-Model AI Client
// Primary: Gemini 2.5 Flash Lite | Fallback: Groq Llama 3.3 70B
// Transcription: Groq Whisper (see whisper-service.js)
//
// Architecture:
//   ┌──────────────────────┬────────────────────────┬─────────────────────┐
//   │ Task                 │ Primary Model          │ Fallback            │
//   ├──────────────────────┼────────────────────────┼─────────────────────┤
//   │ All AI Tasks         │ gemini-2.5-flash-lite  │ llama-3.3-70b (Groq)│
//   │ Audio Transcription  │ whisper-large-v3-turbo │ Gemini STT          │
//   └──────────────────────┴────────────────────────┴─────────────────────┘

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { buildContext, refreshCache } = require('./context-engine');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ── Model Pool ──────────────────────────────────────────
const MODELS = {
  REALTIME:    'gemini-2.5-flash-lite',
  NOTES:       'gemini-2.5-flash-lite',
  PREP:        'gemini-2.5-flash-lite',
  SEARCH:      'gemini-2.5-flash-lite',
  EXTRACT:     'gemini-2.5-flash-lite',
};

// ── Groq Llama Fallback (free, fast) ────────────────────
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function getModel(key) {
  const modelName = MODELS[key] || MODELS.NOTES;
  console.log(`🤖 Using model: ${modelName} (${key})`);
  return genAI.getGenerativeModel({ model: modelName });
}

/**
 * Generate text with Groq's free Llama API (fallback when Gemini fails).
 */
function generateWithGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return Promise.reject(new Error('GROQ_API_KEY not set'));

  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Groq HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Try Gemini first, fall back to Groq Llama if Gemini fails.
 */
async function safeGenerate(modelKey, prompt) {
  try {
    const model = getModel(modelKey);
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    const code = err.message || '';
    if (code.includes('429') || code.includes('503') || code.includes('quota') || code.includes('Unavailable')) {
      console.log(`⚡ Gemini failed (${code.substring(0, 50)}...), falling back to Groq Llama`);
      if (process.env.GROQ_API_KEY) {
        return await generateWithGroq(prompt);
      }
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════
// DURING MEETING — Real-time context
// ═══════════════════════════════════════════════════
async function generateContext(transcriptChunk) {
  const ctx = buildContext('REALTIME');

  const prompt = `You are a real-time meeting assistant. Analyze this live transcript and provide brief context.

${ctx ? `## Your Context\n${ctx}\n\n` : ''}1. **Current Topic** — What is being discussed (1 sentence)
2. **Key Points** — Important points mentioned (bullet list)
3. **Suggested Questions** — 2-3 smart follow-ups
4. **Sentiment** — Overall tone

Be very concise — this is live context.

Transcript:
${transcriptChunk}`;

  return await safeGenerate('REALTIME', prompt);
}

// ═══════════════════════════════════════════════════
// POST-MEETING — Structured notes generation
// ═══════════════════════════════════════════════════
async function generateNotes(transcript, dbMeetings = []) {
  const ctx = buildContext('NOTES', { dbMeetings });

  const prompt = `You are an expert meeting note-taker for Relio AI. Generate comprehensive, actionable notes.

${ctx ? `${ctx}\n\n` : ''}
## Output Format (Markdown):
1. **📋 Meeting Summary** — 3-4 sentence overview
2. **🎯 Key Discussion Points** — Detailed bullet list
3. **✅ Decisions Made** — Agreements and conclusions
4. **📌 Action Items** — Tasks: [ ] Task — @Owner — Due: YYYY-MM-DD
5. **📅 Important Dates & Deadlines** — Format: "YYYY-MM-DD: Description"
6. **🔄 Follow-up Required** — Open questions
7. **💡 Key Insights** — Non-obvious observations
8. **⭐ Meeting Productivity Rating** — Rate this meeting X/10 based on how productive and actionable the discussion was. Explain briefly why. Format: "Rating: X/10 — reason"

IMPORTANT: Use the context above to:
- Reference related past meetings and decisions
- Flag if action items from previous meetings are relevant
- Note connections to ongoing projects or skills
- Tailor your tone and detail level to the user's preferences

## Full Meeting Transcript:
${transcript}

Generate thorough, actionable notes with a productivity rating:`;

  return await safeGenerate('NOTES', prompt);
}

// ═══════════════════════════════════════════════════
// DATE EXTRACTION — JSON output
// ═══════════════════════════════════════════════════
async function extractDatesFromNotes(notes) {
  const prompt = `Extract ALL dates, deadlines, and scheduled events from these notes.

Return ONLY a valid JSON array. Each item:
- "summary": short description (max 60 chars)
- "date": ISO 8601 datetime (YYYY-MM-DDTHH:mm:ss), default 09:00 if no time
- "endDate": ISO 8601 or null

If no dates found, return: []

Notes:
${notes}

JSON:`;

  const text = (await safeGenerate('EXTRACT', prompt)).trim();

  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Date parse error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════
// PRE-MEETING — Preparation brief
// ═══════════════════════════════════════════════════
async function generatePreMeetingBrief(meetingTitle, upcomingEvents, pastNotes, dbMeetings = []) {
  const ctx = buildContext('PREP', { dbMeetings, meetingTitle });

  const prompt = `You are a meeting preparation assistant. Create a pre-meeting brief.

${ctx ? `${ctx}\n\n` : ''}
## Upcoming Meeting:
Title: ${meetingTitle}

## Calendar Events:
${upcomingEvents || 'No events available'}

## Additional Past Meeting Notes:
${pastNotes || 'No past notes available'}

## Generate:
1. **📋 Meeting Preview** — What this meeting is likely about (use context from past meetings and projects)
2. **🔙 Last Meeting Recap** — Key takeaways from related past meetings
3. **📌 Outstanding Actions** — Unfinished tasks from before (check action items in context)
4. **❓ Questions to Ask** — 3-5 smart questions informed by past context
5. **📊 Expected Topics** — Likely discussion topics (informed by project knowledge)
6. **⚡ Quick Prep Checklist** — What to have ready
7. **🔗 Related Context** — Relevant skills, projects, or data from the knowledge base

Be specific and actionable. Reference specific past meetings or projects when relevant:`;

  return await safeGenerate('PREP', prompt);
}

// ═══════════════════════════════════════════════════
// SEARCH — Data analysis & interpretation
// ═══════════════════════════════════════════════════
async function analyzeSearchResults(query, searchResults, dataContent) {
  const ctx = buildContext('SEARCH', { extraData: dataContent.substring(0, 1000) });

  const prompt = `You are a data analyst. The user searched for "${query}" in their local vault. Analyze:

${ctx ? `${ctx}\n\n` : ''}
## Search Results:
${searchResults}

## Data Content:
${dataContent}

## Provide:
1. **🔍 Key Findings** — Most important data matching the query
2. **📊 Important Measurements** — Key numbers, metrics, trends
3. **⚠️ Notable Changes** — Significant shifts or anomalies
4. **📈 Data Summary** — Brief graph description
5. **💡 Insights** — What this data means in the context of the user's projects

If numerical data is suitable for graphing, also output:
\`\`\`json
{"chartData": {"labels": [...], "values": [...], "chartType": "line|bar|pie", "title": "..."}}
\`\`\`

Be concise and data-focused:`;

  return await safeGenerate('SEARCH', prompt);
}

// ═══════════════════════════════════════════════════
// Helpers — Legacy vault context (replaced by context-engine.js)
// Kept for backwards compatibility
// ═══════════════════════════════════════════════════
function loadVaultContext() {
  // Delegate to context engine — returns the full NOTES context
  return buildContext('NOTES');
}

// ═══════════════════════════════════════════════════
// AUDIO TRANSCRIPTION — For WSL environments without mic
// Uses Gemini's multimodal to transcribe uploaded audio files
// ═══════════════════════════════════════════════════
async function transcribeAudioFile(filePath) {
  const model = getModel('NOTES'); // Use the thorough model for transcription

  const audioBuffer = fs.readFileSync(filePath);
  const base64Audio = audioBuffer.toString('base64');

  // Detect MIME type from extension
  const ext = path.extname(filePath).toLowerCase();
  const AUDIO_MIMES = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.webm': 'audio/webm', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  };
  const mimeType = AUDIO_MIMES[ext] || 'audio/mpeg';

  console.log(`🎙️ Transcribing ${path.basename(filePath)} (${mimeType}, ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType,
        data: base64Audio,
      },
    },
    {
      text: `Transcribe this audio recording completely and accurately. This is a meeting recording.

Rules:
- Include ALL spoken words, don't skip anything
- Add timestamps approximately every 30-60 seconds in [MM:SS] format
- If multiple speakers are detectable, label them (Speaker 1, Speaker 2, etc.)
- Include filler words only if they seem intentional
- Format as a clean transcript

Output ONLY the transcript, no commentary.`,
    },
  ]);

  const transcript = result.response.text();
  console.log(`✓ Transcription complete (${transcript.length} chars)`);
  return transcript;
}

/**
 * Transcribe a base64-encoded audio chunk (from MediaRecorder).
 * Uses the fast REALTIME model for low-latency during live meetings.
 */
async function transcribeAudioChunk(base64Audio, mimeType = 'audio/webm') {
  const model = getModel('REALTIME');

  const result = await model.generateContent([
    {
      inlineData: { mimeType, data: base64Audio },
    },
    {
      text: `Transcribe this short audio clip. Output ONLY the spoken words, nothing else. If silence or no speech, output "[silence]".`,
    },
  ]);
  return result.response.text().trim();
}

module.exports = {
  generateNotes,
  extractDatesFromNotes,
  generateContext,
  generatePreMeetingBrief,
  analyzeSearchResults,
  transcribeAudioFile,
  transcribeAudioChunk,
  MODELS, // Exported for status display
};

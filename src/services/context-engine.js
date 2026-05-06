// PrismClaw — Context Engine
// Fuses OpenClaw agent identity + Obsidian QMB vault + DB history
// into a prioritized context window for each AI task
//
// Context Architecture:
//   ┌─────────────────────────────────────────────────────────┐
//   │ Layer 1: Agent Core (SOUL + IDENTITY + USER)           │
//   │   → Personality, user prefs, behavioral guidelines     │
//   │                                                        │
//   │ Layer 2: Vault Knowledge (Skills + Projects)           │
//   │   → Domain knowledge, active projects, expertise       │
//   │                                                        │
//   │ Layer 3: Meeting Memory (Post-Meet + DB history)       │
//   │   → Past meetings, decisions, action items, patterns   │
//   │                                                        │
//   │ Layer 4: Task-Specific (Templates + Data)              │
//   │   → QMB templates, CSV data, search results            │
//   └─────────────────────────────────────────────────────────┘
//
// Token Budgets (approximate chars, ~4 chars/token):
//   REALTIME context:  2,000 chars  (fast, minimal)
//   NOTES context:     8,000 chars  (thorough)
//   PREP context:      6,000 chars  (pre-meeting)
//   SEARCH context:    4,000 chars  (data-focused)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_CORE = path.join(ROOT, 'agent_core');
const VAULT_DIR = path.join(ROOT, 'vault');
const DATA_DIR = path.join(ROOT, 'data');

// ── Token budgets per context profile (in chars) ──
const BUDGETS = {
  REALTIME: { agentCore: 600,  knowledge: 400,  meetings: 800,  extras: 200 },
  NOTES:    { agentCore: 1500, knowledge: 1500, meetings: 3000, extras: 2000 },
  PREP:     { agentCore: 1000, knowledge: 1500, meetings: 2500, extras: 1000 },
  SEARCH:   { agentCore: 600,  knowledge: 1000, meetings: 1000, extras: 1400 },
};

// ── Cache (refreshed every 5 minutes) ──
let cache = { agentCore: null, knowledge: null, lastRefresh: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════
// Layer 1: Agent Core — OpenClaw Identity
// Reads SOUL.md, IDENTITY.md, USER.md, TOOLS.md
// ═══════════════════════════════════════════════════
function loadAgentCore() {
  if (cache.agentCore && Date.now() - cache.lastRefresh < CACHE_TTL) {
    return cache.agentCore;
  }

  const sections = [];

  // IDENTITY — Who is the AI?
  const identity = safeRead(path.join(AGENT_CORE, 'IDENTITY.md'));
  if (identity && !identity.includes('_(pick something')) {
    sections.push({ key: 'identity', priority: 10, content: identity, label: 'Agent Identity' });
  }

  // SOUL — Behavioral guidelines, personality
  const soul = safeRead(path.join(AGENT_CORE, 'SOUL.md'));
  if (soul) {
    // Extract just the core truths and vibe sections — skip boilerplate
    const coreMatch = soul.match(/## Core Truths[\s\S]*?(?=## Related|$)/);
    const vibeMatch = soul.match(/## Vibe[\s\S]*?(?=## Continuity|## Related|$)/);
    const extracted = [
      coreMatch ? coreMatch[0].trim() : '',
      vibeMatch ? vibeMatch[0].trim() : '',
    ].filter(Boolean).join('\n\n');
    if (extracted) {
      sections.push({ key: 'soul', priority: 9, content: extracted, label: 'Agent Personality' });
    }
  }

  // USER — Who is the human?
  const user = safeRead(path.join(AGENT_CORE, 'USER.md'));
  if (user && !user.includes('_(What do they care about')) {
    // Extract filled-in sections only
    const contextMatch = user.match(/## Context[\s\S]*?(?=---|## Related|$)/);
    const headerMatch = user.match(/- \*\*Name:\*\*[\s\S]*?(?=## Context|---)/);
    const parts = [headerMatch?.[0]?.trim(), contextMatch?.[0]?.trim()].filter(Boolean);
    if (parts.length) {
      sections.push({ key: 'user', priority: 8, content: parts.join('\n'), label: 'User Profile' });
    }
  }

  // TOOLS — Environment-specific notes
  const tools = safeRead(path.join(AGENT_CORE, 'TOOLS.md'));
  if (tools && !tools.includes('Things like:')) {
    sections.push({ key: 'tools', priority: 5, content: tools, label: 'Environment Notes' });
  }

  cache.agentCore = sections;
  cache.lastRefresh = Date.now();
  return sections;
}

// ═══════════════════════════════════════════════════
// Layer 2: Vault Knowledge — Skills + Projects
// Reads vault/02_Skills/ and vault/03_Projects/
// ═══════════════════════════════════════════════════
function loadKnowledge() {
  if (cache.knowledge && Date.now() - cache.lastRefresh < CACHE_TTL) {
    return cache.knowledge;
  }

  const sections = [];

  // Skills
  const skillsDir = path.join(VAULT_DIR, '02_Skills');
  if (fs.existsSync(skillsDir)) {
    const skillFiles = scanMarkdownFiles(skillsDir, 5);
    for (const f of skillFiles) {
      sections.push({
        key: `skill:${f.name}`,
        priority: 6,
        content: f.content,
        label: `Skill: ${f.name.replace('.md', '')}`,
      });
    }
  }

  // Projects
  const projectsDir = path.join(VAULT_DIR, '03_Projects');
  if (fs.existsSync(projectsDir)) {
    const projectFiles = scanMarkdownFiles(projectsDir, 5);
    for (const f of projectFiles) {
      sections.push({
        key: `project:${f.name}`,
        priority: 7,
        content: f.content,
        label: `Project: ${f.name.replace('.md', '')}`,
      });
    }
  }

  // QMB Snippets (template fragments for meeting formatting)
  const snippetsDir = path.join(VAULT_DIR, 'Templates', 'QMB_Snippets');
  if (fs.existsSync(snippetsDir)) {
    const snippetFiles = scanMarkdownFiles(snippetsDir, 3);
    for (const f of snippetFiles) {
      sections.push({
        key: `snippet:${f.name}`,
        priority: 4,
        content: f.content,
        label: `Template: ${f.name.replace('.md', '')}`,
      });
    }
  }

  cache.knowledge = sections;
  return sections;
}

// ═══════════════════════════════════════════════════
// Layer 3: Meeting Memory — Post-Meet notes + DB
// Reads vault/01_Meetings/Post-Meet/ (most recent)
// Also accepts DB meetings passed in
// ═══════════════════════════════════════════════════
function loadMeetingMemory(dbMeetings = []) {
  const sections = [];

  // Post-Meet vault notes (rich markdown, has YAML frontmatter)
  const postMeetDir = path.join(VAULT_DIR, '01_Meetings', 'Post-Meet');
  if (fs.existsSync(postMeetDir)) {
    const noteFiles = scanMarkdownFiles(postMeetDir, 8);
    for (const f of noteFiles) {
      // Extract frontmatter metadata
      const meta = extractFrontmatter(f.content);
      sections.push({
        key: `meeting:${f.name}`,
        priority: 7,
        content: f.content,
        label: meta.title || f.name.replace('.md', ''),
        date: meta.date || f.name.substring(0, 10),
        type: 'vault-note',
      });
    }
  }

  // Pre-Meet vault notes
  const preMeetDir = path.join(VAULT_DIR, '01_Meetings', 'Pre-Meet');
  if (fs.existsSync(preMeetDir)) {
    const preFiles = scanMarkdownFiles(preMeetDir, 3);
    for (const f of preFiles) {
      sections.push({
        key: `pre-meet:${f.name}`,
        priority: 5,
        content: f.content,
        label: `Pre-Brief: ${f.name.replace('.md', '')}`,
        type: 'pre-brief',
      });
    }
  }

  // DB meetings (supplement vault notes — may overlap)
  for (const m of dbMeetings.slice(0, 5)) {
    // Only add if not already in vault notes (by title)
    const alreadyInVault = sections.some(s =>
      s.label.toLowerCase().includes((m.title || '').toLowerCase().substring(0, 20))
    );
    if (!alreadyInVault && m.notes) {
      sections.push({
        key: `db:${m.id}`,
        priority: 6,
        content: `# ${m.title}\n> ${m.created_at}\n\n${m.notes}`,
        label: m.title,
        date: m.created_at,
        type: 'db-note',
      });
    }
  }

  // Sort by date (most recent first)
  sections.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return b.priority - a.priority;
  });

  return sections;
}

// ═══════════════════════════════════════════════════
// Context Builder — Assembles the final context string
// Fits within the token budget for each AI task type
// ═══════════════════════════════════════════════════

/**
 * Build a context window for a specific task type.
 *
 * @param {'REALTIME'|'NOTES'|'PREP'|'SEARCH'} profile — Which AI task
 * @param {Object} opts
 * @param {Array}  opts.dbMeetings   — Recent meetings from DB
 * @param {string} opts.meetingTitle — Current meeting title (for relevance)
 * @param {string} opts.extraData    — Additional data (search results, etc.)
 * @returns {string} — Formatted context block ready for prompt injection
 */
function buildContext(profile, opts = {}) {
  const budget = BUDGETS[profile] || BUDGETS.NOTES;
  const { dbMeetings = [], meetingTitle = '', extraData = '' } = opts;

  const blocks = [];

  // ── Layer 1: Agent Core ──
  const agentCore = loadAgentCore();
  let agentText = '';
  for (const section of agentCore.sort((a, b) => b.priority - a.priority)) {
    const candidate = agentText + `\n### ${section.label}\n${section.content}\n`;
    if (candidate.length <= budget.agentCore) {
      agentText = candidate;
    }
  }
  if (agentText.trim()) {
    blocks.push(`## 🧠 Agent Context\n${agentText.trim()}`);
  }

  // ── Layer 2: Knowledge ──
  const knowledge = loadKnowledge();
  let knowledgeText = '';
  // If we have a meeting title, prioritize relevant knowledge
  const scored = knowledge.map(k => ({
    ...k,
    relevance: meetingTitle ? computeRelevance(k.content + k.label, meetingTitle) : k.priority,
  })).sort((a, b) => b.relevance - a.relevance);

  for (const section of scored) {
    const candidate = knowledgeText + `\n### ${section.label}\n${section.content}\n`;
    if (candidate.length <= budget.knowledge) {
      knowledgeText = candidate;
    }
  }
  if (knowledgeText.trim()) {
    blocks.push(`## 📚 Knowledge Base\n${knowledgeText.trim()}`);
  }

  // ── Layer 3: Meeting Memory ──
  const meetings = loadMeetingMemory(dbMeetings);
  let meetingText = '';
  // Score by relevance to current meeting title
  const meetingScored = meetings.map(m => ({
    ...m,
    relevance: meetingTitle ? computeRelevance(m.content + m.label, meetingTitle) + m.priority : m.priority,
  })).sort((a, b) => b.relevance - a.relevance);

  for (const section of meetingScored) {
    // Truncate individual notes to fit budget
    const maxPerNote = Math.floor(budget.meetings / 3);
    const truncated = section.content.substring(0, maxPerNote);
    const candidate = meetingText + `\n### ${section.label}\n${truncated}\n`;
    if (candidate.length <= budget.meetings) {
      meetingText = candidate;
    }
  }
  if (meetingText.trim()) {
    blocks.push(`## 📝 Meeting History\n${meetingText.trim()}`);
  }

  // ── Layer 4: Extras ──
  if (extraData) {
    blocks.push(`## 📊 Additional Data\n${extraData.substring(0, budget.extras)}`);
  }

  const contextWindow = blocks.join('\n\n');

  // Log context stats
  const stats = {
    profile,
    totalChars: contextWindow.length,
    agentCore: agentText.length,
    knowledge: knowledgeText.length,
    meetings: meetingText.length,
    extras: extraData.length,
    sections: blocks.length,
  };
  console.log(`🧠 Context Engine [${profile}]: ${contextWindow.length} chars, ${blocks.length} sections`);

  return contextWindow;
}

/**
 * Get a summary of what's loaded in the context engine.
 * Useful for debugging / status display.
 */
function getContextStatus() {
  const agentCore = loadAgentCore();
  const knowledge = loadKnowledge();

  return {
    agentCore: agentCore.map(s => ({ key: s.key, label: s.label, chars: s.content.length })),
    knowledge: knowledge.map(s => ({ key: s.key, label: s.label, chars: s.content.length })),
    vaultPath: VAULT_DIR,
    agentCorePath: AGENT_CORE,
    cacheAge: cache.lastRefresh ? Math.floor((Date.now() - cache.lastRefresh) / 1000) + 's' : 'never',
  };
}

/**
 * Force-refresh the cache (after saving new notes, updating agent files, etc.)
 */
function refreshCache() {
  cache = { agentCore: null, knowledge: null, lastRefresh: 0 };
  console.log('🧠 Context cache cleared');
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch { return null; }
}

function scanMarkdownFiles(dir, maxFiles = 5) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort().reverse()
      .slice(0, maxFiles)
      .map(f => ({
        name: f,
        content: safeRead(path.join(dir, f)) || '',
      }))
      .filter(f => f.content.length > 0);
  } catch { return []; }
}

function extractFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

/**
 * Simple relevance scoring — counts matching terms between two texts.
 */
function computeRelevance(text, query) {
  const textLower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  let score = 0;
  for (const term of terms) {
    const count = (textLower.match(new RegExp(escapeRegex(term), 'g')) || []).length;
    score += Math.min(count, 5); // Cap at 5 per term to avoid bias
  }
  return score;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  buildContext,
  getContextStatus,
  refreshCache,
  loadAgentCore,
  loadKnowledge,
  loadMeetingMemory,
  BUDGETS,
};

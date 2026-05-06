// PrismClaw — SQLite Database Service (sql.js — pure WASM, no native build needed)
// v5: Added rating column, meeting duration, and enhanced queries
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', 'db');
const DB_PATH = path.join(DB_DIR, 'prismclaw.sqlite');

let db = null;

/**
 * Initialize the database asynchronously.
 * Must be called (and awaited) before any other DB function.
 */
async function initDB() {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  const SQL = await initSqlJs();

  // Load existing database file or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS meetings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      transcript    TEXT,
      notes         TEXT,
      dates_json    TEXT,
      rating        REAL DEFAULT 0,
      duration_secs INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS extracted_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      summary     TEXT NOT NULL,
      event_date  TEXT NOT NULL,
      event_end   TEXT,
      injected    INTEGER DEFAULT 0,
      gcal_id     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(created_at);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_meeting ON extracted_events(meeting_id);`);

  // Enable foreign keys
  db.run(`PRAGMA foreign_keys = ON;`);

  // Migrate: add rating/duration columns if missing (existing DBs)
  try {
    db.run(`ALTER TABLE meetings ADD COLUMN rating REAL DEFAULT 0;`);
  } catch { /* column already exists */ }
  try {
    db.run(`ALTER TABLE meetings ADD COLUMN duration_secs INTEGER DEFAULT 0;`);
  } catch { /* column already exists */ }

  console.log('✓ Database initialized at', DB_PATH);
  persistDB();
  return db;
}

/**
 * Write database to disk (sql.js is in-memory, needs manual persistence).
 */
function persistDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDB() {
  if (!db) throw new Error('Database not initialized — call initDB() first');
  return db;
}

function saveMeeting(title, transcript, notes, datesJson, rating = 0, durationSecs = 0) {
  const conn = getDB();
  conn.run(
    'INSERT INTO meetings (title, transcript, notes, dates_json, rating, duration_secs) VALUES (?, ?, ?, ?, ?, ?)',
    [title, transcript, notes, datesJson, rating, durationSecs]
  );
  const result = conn.exec('SELECT last_insert_rowid() as id');
  const meetingId = result[0]?.values[0]?.[0] || 0;
  persistDB();
  return meetingId;
}

function getRecentMeetings(days = 30) {
  const conn = getDB();
  const results = conn.exec(`
    SELECT id, title, notes, dates_json, rating, duration_secs, created_at
    FROM meetings
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
  `, [days]);

  if (!results.length || !results[0]) return [];
  return results[0].values.map(row => ({
    id: row[0],
    title: row[1],
    notes: row[2],
    dates_json: row[3],
    rating: row[4] || 0,
    duration_secs: row[5] || 0,
    created_at: row[6],
  }));
}

function getMeetingById(id) {
  const conn = getDB();
  const results = conn.exec(
    'SELECT id, title, transcript, notes, dates_json, rating, duration_secs, created_at FROM meetings WHERE id = ?',
    [id]
  );
  if (!results.length || !results[0]) return null;
  const row = results[0].values[0];
  return {
    id: row[0], title: row[1], transcript: row[2], notes: row[3],
    dates_json: row[4], rating: row[5] || 0, duration_secs: row[6] || 0, created_at: row[7],
  };
}

function getMeetingsByDateRange(startDate, endDate) {
  const conn = getDB();
  const results = conn.exec(`
    SELECT id, title, transcript, notes, dates_json, rating, duration_secs, created_at
    FROM meetings
    WHERE created_at BETWEEN ? AND ?
    ORDER BY created_at DESC
  `, [startDate, endDate]);

  if (!results.length || !results[0]) return [];
  return results[0].values.map(row => ({
    id: row[0], title: row[1], transcript: row[2], notes: row[3],
    dates_json: row[4], rating: row[5] || 0, duration_secs: row[6] || 0, created_at: row[7],
  }));
}

function getAllUpcomingEvents() {
  const conn = getDB();
  const results = conn.exec(`
    SELECT id, meeting_id, summary, event_date, event_end, injected, gcal_id, created_at
    FROM extracted_events
    WHERE injected = 0 AND event_date >= datetime('now')
    ORDER BY event_date ASC
  `);

  if (!results.length || !results[0]) return [];
  return results[0].values.map(row => ({
    id: row[0], meeting_id: row[1], summary: row[2], event_date: row[3],
    event_end: row[4], injected: row[5], gcal_id: row[6], created_at: row[7],
  }));
}

function getAverageRating() {
  const conn = getDB();
  const results = conn.exec(`SELECT AVG(rating) FROM meetings WHERE rating > 0`);
  return results[0]?.values[0]?.[0] || 0;
}

function getMeetingStats() {
  const conn = getDB();
  const total = conn.exec(`SELECT COUNT(*) FROM meetings`);
  const rated = conn.exec(`SELECT COUNT(*) FROM meetings WHERE rating > 0`);
  const avgRating = conn.exec(`SELECT AVG(rating) FROM meetings WHERE rating > 0`);
  const totalDuration = conn.exec(`SELECT SUM(duration_secs) FROM meetings`);
  const thisWeek = conn.exec(`SELECT COUNT(*) FROM meetings WHERE created_at >= datetime('now', '-7 days')`);

  return {
    totalMeetings: total[0]?.values[0]?.[0] || 0,
    ratedMeetings: rated[0]?.values[0]?.[0] || 0,
    avgRating: Math.round((avgRating[0]?.values[0]?.[0] || 0) * 10) / 10,
    totalDurationMins: Math.round((totalDuration[0]?.values[0]?.[0] || 0) / 60),
    meetingsThisWeek: thisWeek[0]?.values[0]?.[0] || 0,
  };
}

// Run migrations if called directly
if (require.main === module) {
  initDB().then(() => {
    console.log('Migration complete.');
    process.exit(0);
  });
}

module.exports = {
  initDB, getDB, saveMeeting, getRecentMeetings, getMeetingById,
  getMeetingsByDateRange, getAllUpcomingEvents, getAverageRating, getMeetingStats,
};

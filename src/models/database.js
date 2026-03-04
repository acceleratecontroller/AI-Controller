const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initialize() {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'draft',
      priority TEXT NOT NULL DEFAULT 'normal',
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      site_address TEXT,
      scheduled_date TEXT,
      assigned_to TEXT,
      estimated_hours REAL,
      notes TEXT,
      created_by TEXT DEFAULT 'system',
      reviewed_by TEXT,
      approved_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      changed_by TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS api_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      endpoint_url TEXT,
      api_key TEXT,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS servicem8_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      servicem8_uuid TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      synced_at TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT,
      source TEXT NOT NULL DEFAULT 'upload',
      uploaded_by TEXT DEFAULT 'user',
      sharepoint_url TEXT,
      sharepoint_synced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );
  `);

  console.log('Database initialized');
}

function generateJobNumber() {
  const conn = getDb();
  const date = new Date();
  const prefix = `WO-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const row = conn.prepare(
    "SELECT COUNT(*) as count FROM jobs WHERE job_number LIKE ? || '%'"
  ).get(prefix);
  const seq = String((row.count || 0) + 1).padStart(4, '0');
  return `${prefix}-${seq}`;
}

module.exports = { getDb, initialize, generateJobNumber };

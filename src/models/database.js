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

    -- BYDA / DBYD Enquiry tables
    CREATE TABLE IF NOT EXISTS byda_enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      address_text TEXT,
      address_structured TEXT,
      polygon_geojson TEXT,
      centroid_lat REAL,
      centroid_lng REAL,
      polygon_hash TEXT,
      address_hash TEXT,
      work_type TEXT,
      required_flag INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'not_required',
      provider TEXT DEFAULT 'manual',
      external_enquiry_id TEXT,
      lodged_at TEXT,
      expiry_at TEXT,
      reused_from_enquiry_id INTEGER,
      error_message TEXT,
      raw_provider_payload TEXT,
      triggered_by TEXT DEFAULT 'system',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id),
      FOREIGN KEY (reused_from_enquiry_id) REFERENCES byda_enquiries(id)
    );

    CREATE TABLE IF NOT EXISTS byda_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_name TEXT NOT NULL,
      field TEXT NOT NULL DEFAULT 'title',
      pattern TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains',
      result TEXT NOT NULL DEFAULT 'required',
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS byda_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      enquiry_id INTEGER,
      action TEXT NOT NULL DEFAULT 'lodge',
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      next_attempt_at TEXT DEFAULT (datetime('now')),
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id),
      FOREIGN KEY (enquiry_id) REFERENCES byda_enquiries(id)
    );
  `);

  // Add BYDA columns to jobs if not present (migration-safe)
  const jobCols = conn.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  if (!jobCols.includes('byda_required')) {
    conn.exec("ALTER TABLE jobs ADD COLUMN byda_required INTEGER DEFAULT 0");
  }
  if (!jobCols.includes('byda_status')) {
    conn.exec("ALTER TABLE jobs ADD COLUMN byda_status TEXT DEFAULT 'not_assessed'");
  }
  if (!jobCols.includes('byda_enquiry_id')) {
    conn.exec("ALTER TABLE jobs ADD COLUMN byda_enquiry_id INTEGER REFERENCES byda_enquiries(id)");
  }

  // Seed default BYDA rules if empty
  const ruleCount = conn.prepare("SELECT COUNT(*) as c FROM byda_rules").get().c;
  if (ruleCount === 0) {
    const defaultRules = [
      ['Excavation work', 'title', 'excavat', 'contains', 'required', 10],
      ['Trenching work', 'title', 'trench', 'contains', 'required', 10],
      ['Digging work', 'title', 'dig', 'contains', 'required', 10],
      ['Potholing work', 'title', 'pothole', 'contains', 'required', 10],
      ['Boring work', 'title', 'boring', 'contains', 'required', 10],
      ['Ploughing work', 'title', 'plough', 'contains', 'required', 10],
      ['Drilling work', 'title', 'drill', 'contains', 'required', 10],
      ['Civil works', 'title', 'civil', 'contains', 'required', 10],
      ['Underground work', 'description', 'underground', 'contains', 'required', 8],
      ['Cable laying', 'description', 'cable lay', 'contains', 'required', 8],
      ['Pipe install', 'description', 'pipe install', 'contains', 'required', 8],
      ['Design only - not required', 'title', 'design only', 'contains', 'not_required', 20],
      ['Admin task - not required', 'title', 'admin', 'contains', 'not_required', 20],
      ['Desk work - not required', 'title', 'desk', 'contains', 'not_required', 20],
    ];
    const insertRule = conn.prepare(
      "INSERT INTO byda_rules (rule_name, field, pattern, match_type, result, priority) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const r of defaultRules) insertRule.run(...r);
  }

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

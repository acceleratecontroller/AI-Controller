/**
 * BYDA Service Tests
 *
 * Tests polygon validation, reuse logic, idempotency, rules engine, and status transitions.
 * Run: node tests/byda.test.js
 */

const path = require('path');
process.env.NODE_ENV = 'test';

// Use a temp file for test database so it behaves like production
const fs = require('fs');
const os = require('os');
const testDbPath = path.join(os.tmpdir(), `byda-test-${Date.now()}.db`);

// Override the database module's DB_PATH before it's loaded
// We need to patch the module internals
const dbModule = require('../src/models/database');

// Force re-create the DB by patching getDb to use our test file
const Database = require('better-sqlite3');
let _testDb = new Database(testDbPath);
_testDb.pragma('journal_mode = WAL');
_testDb.pragma('foreign_keys = ON');

const origGetDb = dbModule.getDb;
dbModule.getDb = function () { return _testDb; };

// Manually run schema creation on the test DB since initialize() uses the closure-captured getDb
_testDb.exec(`
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
    FOREIGN KEY (job_id) REFERENCES jobs(id)
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
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
`);

// Add BYDA columns to jobs
try { _testDb.exec("ALTER TABLE jobs ADD COLUMN byda_required INTEGER DEFAULT 0"); } catch(e) {}
try { _testDb.exec("ALTER TABLE jobs ADD COLUMN byda_status TEXT DEFAULT 'not_assessed'"); } catch(e) {}
try { _testDb.exec("ALTER TABLE jobs ADD COLUMN byda_enquiry_id INTEGER"); } catch(e) {}

// Seed default rules
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
  ['Design only', 'title', 'design only', 'contains', 'not_required', 20],
  ['Admin task', 'title', 'admin', 'contains', 'not_required', 20],
  ['Desk work', 'title', 'desk', 'contains', 'not_required', 20],
];
const insertRule = _testDb.prepare("INSERT INTO byda_rules (rule_name, field, pattern, match_type, result, priority) VALUES (?, ?, ?, ?, ?, ?)");
for (const r of defaultRules) insertRule.run(...r);

console.log('Test database initialized');

const byda = require('../src/services/byda');

// Cleanup on exit
process.on('exit', () => {
  try { _testDb.close(); } catch(e) {}
  try { fs.unlinkSync(testDbPath); } catch(e) {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch(e) {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch(e) {}
});

let passed = 0;
let failed = 0;

async function runTests() {

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertClose(a, b, tolerance, msg) {
  const diff = Math.abs(a - b);
  if (diff <= tolerance) {
    passed++;
    console.log(`  PASS: ${msg} (${a} ≈ ${b})`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg} (expected ~${b}, got ${a}, diff ${diff})`);
  }
}

// ─── Helper: Create a test job ───

function createTestJob(overrides = {}) {
  const db = dbModule.getDb();
  const defaults = {
    job_number: 'WO-TEST-' + Date.now() + Math.random().toString(36).slice(2, 6),
    title: 'Test Job',
    description: 'Test description',
    source: 'manual',
    status: 'draft',
    priority: 'normal',
    site_address: '123 Test Street, Sydney NSW 2000',
    customer_name: 'Test Customer'
  };
  const data = { ...defaults, ...overrides };

  const result = db.prepare(`
    INSERT INTO jobs (job_number, title, description, source, status, priority, site_address, customer_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.job_number, data.title, data.description, data.source, data.status, data.priority, data.site_address, data.customer_name);

  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
}

// ─── Polygon Validation ───

console.log('\n=== Polygon Validation ===');

(function testValidPolygon() {
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.209, -33.868],
      [151.210, -33.868],
      [151.210, -33.867],
      [151.209, -33.867],
      [151.209, -33.868]
    ]]
  };
  const result = byda.validatePolygon(poly);
  assert(result.valid === true, 'Valid polygon is accepted');
  assert(result.area > 0, 'Area is computed and > 0');
  assert(result.centroid.lat !== 0, 'Centroid latitude computed');
  assert(result.centroid.lng !== 0, 'Centroid longitude computed');
})();

(function testInvalidType() {
  const result = byda.validatePolygon({ type: 'Point', coordinates: [0, 0] });
  assert(result.valid === false, 'Non-polygon type rejected');
  assert(result.error.includes('GeoJSON Polygon'), 'Error message mentions GeoJSON Polygon');
})();

(function testUnclosedRing() {
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.209, -33.868],
      [151.210, -33.868],
      [151.210, -33.867],
      [151.209, -33.867]
      // Not closed!
    ]]
  };
  const result = byda.validatePolygon(poly);
  assert(result.valid === false, 'Unclosed ring rejected');
})();

(function testTooFewPoints() {
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.209, -33.868],
      [151.210, -33.868],
      [151.209, -33.868]
    ]]
  };
  const result = byda.validatePolygon(poly);
  assert(result.valid === false, 'Too few points rejected');
})();

(function testNullPolygon() {
  assert(byda.validatePolygon(null).valid === false, 'Null polygon rejected');
  assert(byda.validatePolygon({}).valid === false, 'Empty object rejected');
})();

(function testAreaEstimate() {
  // ~100m x ~100m square near Sydney
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.2000, -33.8700],
      [151.2011, -33.8700],  // ~100m east
      [151.2011, -33.8709],  // ~100m south
      [151.2000, -33.8709],
      [151.2000, -33.8700]
    ]]
  };
  const result = byda.validatePolygon(poly);
  assert(result.valid, 'Square polygon valid');
  assertClose(result.area, 10000, 2000, 'Area ~10000 m² (100m x 100m)');
})();

// ─── Polygon Hashing ───

console.log('\n=== Polygon Hashing ===');

(function testHashDeterministic() {
  const poly = {
    type: 'Polygon',
    coordinates: [[[151.209, -33.868], [151.210, -33.868], [151.210, -33.867], [151.209, -33.868]]]
  };
  const h1 = byda.hashPolygon(poly);
  const h2 = byda.hashPolygon(poly);
  assert(h1 === h2, 'Same polygon produces same hash');
  assert(h1.length === 16, 'Hash is 16 chars');
})();

(function testHashDifferent() {
  const poly1 = { type: 'Polygon', coordinates: [[[151.209, -33.868], [151.210, -33.868], [151.210, -33.867], [151.209, -33.868]]] };
  const poly2 = { type: 'Polygon', coordinates: [[[151.209, -33.868], [151.211, -33.868], [151.211, -33.867], [151.209, -33.868]]] };
  assert(byda.hashPolygon(poly1) !== byda.hashPolygon(poly2), 'Different polygons produce different hashes');
})();

(function testAddressHash() {
  const h1 = byda.hashAddress('123 Test Street, Sydney NSW 2000');
  const h2 = byda.hashAddress('123 test street sydney nsw 2000');
  assert(h1 === h2, 'Address hash normalises case and special chars');
})();

// ─── Rules Engine ───

console.log('\n=== Rules Engine ===');

(function testExcavationRequired() {
  const job = { title: 'Excavation work at site', description: '', notes: '' };
  const result = byda.assessRequirement(job);
  assert(result.required === true, 'Excavation work is flagged as required');
  assert(result.reason.includes('Excavation'), 'Reason mentions excavation');
})();

(function testTrenchingRequired() {
  const job = { title: 'Trench digging for cables', description: '', notes: '' };
  const result = byda.assessRequirement(job);
  assert(result.required === true, 'Trenching work is flagged as required');
})();

(function testDesignNotRequired() {
  const job = { title: 'Design only - planning phase', description: '', notes: '' };
  const result = byda.assessRequirement(job);
  assert(result.required === false, 'Design only is not required');
})();

(function testUnmatchedDefault() {
  const job = { title: 'Office meeting', description: '', notes: '' };
  const result = byda.assessRequirement(job);
  assert(result.required === false, 'Unmatched job defaults to not required');
})();

(function testDescriptionMatch() {
  const job = { title: 'General work', description: 'Need to lay underground cables', notes: '' };
  const result = byda.assessRequirement(job);
  assert(result.required === true, 'Underground in description triggers required');
})();

// ─── Assess + Save Polygon (DB Integration) ───

console.log('\n=== Assess & Polygon Save ===');

(function testAssessJob() {
  const job = createTestJob({ title: 'Excavation at 123 Main St' });
  const result = byda.assess(job.id);
  assert(result.required === true, 'Assess returns required for excavation job');
  assert(result.currentStatus === 'needed', 'Status set to needed');

  // Verify DB updated
  const updated = dbModule.getDb().prepare('SELECT byda_required, byda_status FROM jobs WHERE id = ?').get(job.id);
  assert(updated.byda_required === 1, 'Job byda_required set to 1');
  assert(updated.byda_status === 'needed', 'Job byda_status set to needed');
})();

(function testSavePolygon() {
  const job = createTestJob({ title: 'Digging work' });
  byda.assess(job.id);

  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.209, -33.868],
      [151.210, -33.868],
      [151.210, -33.867],
      [151.209, -33.867],
      [151.209, -33.868]
    ]]
  };

  const result = byda.savePolygon(job.id, poly);
  assert(result.success === true, 'Polygon saved successfully');
  assert(result.area > 0, 'Area returned');
  assert(result.centroid !== null, 'Centroid returned');
  assert(result.enquiryId > 0, 'Enquiry ID returned');

  // Verify enquiry created
  const enquiry = dbModule.getDb().prepare('SELECT * FROM byda_enquiries WHERE job_id = ?').get(job.id);
  assert(enquiry !== undefined, 'Enquiry record created in DB');
  assert(enquiry.polygon_geojson !== null, 'Polygon stored');
  assert(enquiry.polygon_hash !== null, 'Polygon hash stored');
})();

(function testSaveInvalidPolygon() {
  const job = createTestJob({ title: 'Test job' });
  const result = byda.savePolygon(job.id, { type: 'Point' });
  assert(result.success === false, 'Invalid polygon rejected');
  assert(result.error !== undefined, 'Error message returned');
})();

// ─── Reuse Logic ───

console.log('\n=== Reuse Logic ===');

(function testFindReusable() {
  const db = dbModule.getDb();
  const address = '456 Reuse Test Ave, Melbourne VIC 3000';
  const addrHash = byda.hashAddress(address);
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [144.960, -37.810],
      [144.961, -37.810],
      [144.961, -37.809],
      [144.960, -37.809],
      [144.960, -37.810]
    ]]
  };

  // Create a "source" job with a lodged enquiry
  const sourceJob = createTestJob({ title: 'Source digging job', site_address: address });
  db.prepare(`
    INSERT INTO byda_enquiries (job_id, address_text, address_hash, polygon_geojson, polygon_hash,
      required_flag, status, provider, external_enquiry_id, lodged_at, expiry_at)
    VALUES (?, ?, ?, ?, ?, 1, 'lodged', 'manual', 'BYDA-REUSE-001', datetime('now'), datetime('now', '+28 days'))
  `).run(sourceJob.id, address, addrHash, JSON.stringify(poly), byda.hashPolygon(poly));

  // Now check reuse from a different job at same address with similar polygon
  const targetJob = createTestJob({ title: 'Another digging job', site_address: address });
  const reusable = byda.findReusableEnquiry(targetJob.id, address, poly, null);
  assert(reusable !== null, 'Reusable enquiry found for same address + polygon');
  assert(reusable.external_enquiry_id === 'BYDA-REUSE-001', 'Correct enquiry ID returned');
})();

(function testNoReuseDifferentAddress() {
  const reusable = byda.findReusableEnquiry(999, '999 Nowhere Street', null, null);
  assert(reusable === null, 'No reusable enquiry for different address');
})();

// ─── Lodge (Manual Mode) ───

console.log('\n=== Lodge (Manual Mode) ===');

await (async function testLodgeManualMode() {
  const job = createTestJob({ title: 'Trench work here' });
  byda.assess(job.id);

  const result = await byda.lodge(job.id, 'test');
  assert(result.status === 'manual_required', 'Lodge returns manual_required when API not configured');
  assert(result.exportData !== undefined, 'Export data provided for manual lodge');
  assert(result.exportData.address !== undefined, 'Export data includes address');

  // Verify DB
  const updated = dbModule.getDb().prepare('SELECT byda_status FROM jobs WHERE id = ?').get(job.id);
  assert(updated.byda_status === 'manual_required', 'Job status set to manual_required');
})();

// ─── Manual Link ───

console.log('\n=== Manual Link ===');

(function testManualLink() {
  const job = createTestJob({ title: 'Boring work' });
  byda.assess(job.id);

  const result = byda.manualLink(job.id, 'EXT-BYDA-12345', 'test-user');
  assert(result.status === 'lodged', 'Manual link sets status to lodged');
  assert(result.externalId === 'EXT-BYDA-12345', 'External ID stored');

  // Verify DB
  const updated = dbModule.getDb().prepare('SELECT byda_status FROM jobs WHERE id = ?').get(job.id);
  assert(updated.byda_status === 'lodged', 'Job status set to lodged after manual link');

  const enquiry = dbModule.getDb().prepare('SELECT * FROM byda_enquiries WHERE job_id = ?').get(job.id);
  assert(enquiry.external_enquiry_id === 'EXT-BYDA-12345', 'External ID in enquiry record');
  assert(enquiry.provider === 'manual', 'Provider set to manual');
})();

(function testManualLinkEmptyId() {
  const job = createTestJob({ title: 'Test job' });
  try {
    byda.manualLink(job.id, '', 'test');
    assert(false, 'Should throw for empty ID');
  } catch (err) {
    assert(err.message.includes('required'), 'Throws error for empty ID');
  }
})();

// ─── Idempotency ───

console.log('\n=== Idempotency ===');

await (async function testIdempotency() {
  const job = createTestJob({ title: 'Potholing job for idem test' });
  byda.assess(job.id);

  // First lodge
  await byda.lodge(job.id, 'test');

  // Second lodge should work (different state now)
  const result2 = await byda.lodge(job.id, 'test');
  // Since it's manual mode and already manual_required, it should still work
  assert(result2.status !== undefined, 'Second lodge returns a status');
})();

// ─── getEnquiry ───

console.log('\n=== getEnquiry ===');

(function testGetEnquiry() {
  const job = createTestJob({ title: 'Civil works project' });
  byda.assess(job.id);

  const result = byda.getEnquiry(job.id);
  assert(result !== null, 'getEnquiry returns data');
  assert(result.required === true, 'Shows required');
  assert(result.status === 'needed', 'Shows needed status');
  assert(result.isApiConfigured === false, 'API not configured');
})();

(function testGetEnquiryNonExistent() {
  const result = byda.getEnquiry(99999);
  assert(result === null, 'Non-existent job returns null');
})();

// ─── Overlap Estimation ───

console.log('\n=== Overlap Estimation ===');

(function testFullOverlap() {
  const poly = {
    type: 'Polygon',
    coordinates: [[
      [151.209, -33.868],
      [151.210, -33.868],
      [151.210, -33.867],
      [151.209, -33.867],
      [151.209, -33.868]
    ]]
  };
  const overlap = byda.estimateOverlap(poly, poly);
  assert(overlap > 90, `Identical polygons have >90% overlap (got ${overlap.toFixed(1)}%)`);
})();

(function testNoOverlap() {
  const poly1 = {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
  };
  const poly2 = {
    type: 'Polygon',
    coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]
  };
  const overlap = byda.estimateOverlap(poly1, poly2);
  assert(overlap < 5, `Non-overlapping polygons have <5% overlap (got ${overlap.toFixed(1)}%)`);
})();

// ─── Summary ───

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
return failed;
}

runTests().then(failures => process.exit(failures > 0 ? 1 : 0));

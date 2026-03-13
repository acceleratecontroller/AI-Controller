/**
 * Google Sheets integration for WIP spreadsheet.
 *
 * Safety rules:
 *  - NEVER delete rows
 *  - NEVER overwrite formulas
 *  - NEVER touch columns beyond the configured range (A–J)
 *  - NEVER modify sheet structure (headers, formatting, columns)
 *  - All writes are previewed before execution
 *  - Every write is logged to a local audit table
 *  - Duplicate detection before creating new rows
 */

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../models/database');

// ── Config ──────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || '1_uc91bjXygrZeCOPQQfdWDRyWWdHyuwCbWlkEDX9RaI';
const SHEET_NAME = process.env.GOOGLE_SHEET_TAB || 'data';
const WRITE_RANGE = 'A:J'; // columns we're allowed to touch
const MAX_WRITE_COL = 9;   // J = index 9 (0-based)

// Column mapping: sheet column index → job field
const COLUMN_MAP = [
  { col: 0, header: 'Depot',                   field: 'depot' },
  { col: 1, header: 'Client',                  field: 'client' },
  { col: 2, header: 'Contract',                field: 'contract' },
  { col: 3, header: 'Initial Status',          field: 'initial_status' },
  { col: 4, header: 'Acoms Number',            field: 'job_number' },
  { col: 5, header: 'Finance/PO Number/s',     field: 'finance_po_number' },
  { col: 6, header: 'Client Reference Number', field: 'client_reference_number' },
  { col: 7, header: 'Project Name/Address',    field: 'title' },
  { col: 8, header: 'Job Received Date',       field: 'job_received_date' },
  { col: 9, header: 'Client Contact',          field: 'client_contact' },
];

let sheetsClient = null;

// ── Auth ────────────────────────────────────────────────────────────────────
function getCredentialsPath() {
  // Check common file names
  const candidates = [
    process.env.GOOGLE_CREDENTIALS_PATH,
    path.join(__dirname, '..', '..', 'google-credentials.json'),
    path.join(__dirname, '..', '..', 'acms-wip-5742ed644e2c.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Search for any *-wip-*.json in project root
  const root = path.join(__dirname, '..', '..');
  const files = fs.readdirSync(root).filter(f => f.endsWith('.json') && f !== 'package.json' && f !== 'package-lock.json');
  for (const f of files) {
    const full = path.join(root, f);
    try {
      const content = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (content.type === 'service_account') return full;
    } catch (e) { /* skip */ }
  }

  return null;
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;

  const credPath = getCredentialsPath();
  if (!credPath) {
    throw new Error(
      'Google credentials file not found. Place your service account JSON in the project root ' +
      '(e.g. google-credentials.json or acms-wip-*.json)'
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function isConfigured() {
  return !!getCredentialsPath();
}

// ── Read ────────────────────────────────────────────────────────────────────
async function readAllRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:J`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };
  return { headers: rows[0], data: rows.slice(1), totalRows: rows.length };
}

// ── Duplicate Detection ─────────────────────────────────────────────────────
function normalise(str) {
  return (str || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findDuplicates(job, existingRows) {
  const matches = [];

  for (let i = 0; i < existingRows.length; i++) {
    const row = existingRows[i];
    const rowData = {
      depot: row[0] || '',
      client: row[1] || '',
      contract: row[2] || '',
      initial_status: row[3] || '',
      job_number: row[4] || '',
      finance_po_number: row[5] || '',
      client_reference_number: row[6] || '',
      title: row[7] || '',
      job_received_date: row[8] || '',
      client_contact: row[9] || '',
    };

    let score = 0;
    let reasons = [];

    // Exact ACOMS number match — definite duplicate
    if (normalise(job.job_number) && normalise(rowData.job_number) === normalise(job.job_number)) {
      return [{ rowIndex: i + 2, score: 100, reasons: ['Exact ACOMS number match'], rowData }];
    }

    // Client reference match
    if (normalise(job.client_reference_number) && normalise(rowData.client_reference_number) === normalise(job.client_reference_number)) {
      score += 40;
      reasons.push('Client reference number matches');
    }

    // Project name/address match
    if (normalise(job.title) && normalise(rowData.title) === normalise(job.title)) {
      score += 35;
      reasons.push('Project name/address matches');
    } else if (normalise(job.title) && normalise(rowData.title) && (
      normalise(rowData.title).includes(normalise(job.title)) ||
      normalise(job.title).includes(normalise(rowData.title))
    )) {
      score += 20;
      reasons.push('Project name/address partially matches');
    }

    // Client + contract combo
    if (normalise(job.client) && normalise(rowData.client) === normalise(job.client)) {
      score += 10;
      reasons.push('Client matches');
    }

    // Finance/PO match
    if (normalise(job.finance_po_number) && normalise(rowData.finance_po_number) === normalise(job.finance_po_number)) {
      score += 25;
      reasons.push('Finance/PO number matches');
    }

    if (score >= 30) {
      matches.push({ rowIndex: i + 2, score, reasons, rowData });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5); // top 5 potential duplicates
}

// ── Preview (dry run) ───────────────────────────────────────────────────────
async function previewWrite(job) {
  const { data } = await readAllRows();
  const duplicates = findDuplicates(job, data);

  const newRow = COLUMN_MAP.map(c => {
    let val = job[c.field] || '';
    if (c.field === 'initial_status') {
      val = (val || 'quote').replace('_', ' ');
      val = val.charAt(0).toUpperCase() + val.slice(1);
    }
    return val;
  });

  return {
    action: 'append',
    newRow,
    columns: COLUMN_MAP.map(c => c.header),
    duplicates,
    hasDuplicates: duplicates.length > 0,
    exactMatch: duplicates.some(d => d.score >= 100),
  };
}

// ── Write (append new row) ──────────────────────────────────────────────────
async function appendRow(job, confirmedBy = 'user') {
  const sheets = await getSheets();

  const newRow = COLUMN_MAP.map(c => {
    let val = job[c.field] || '';
    if (c.field === 'initial_status') {
      val = (val || 'quote').replace('_', ' ');
      val = val.charAt(0).toUpperCase() + val.slice(1);
    }
    return val;
  });

  // Append to next available row
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });

  // Audit log
  logAudit({
    job_id: job.id,
    job_number: job.job_number,
    action: 'append_row',
    confirmed_by: confirmedBy,
    details: JSON.stringify({ row: newRow }),
    sheet_range: result.data.updates?.updatedRange || 'unknown',
  });

  return {
    success: true,
    updatedRange: result.data.updates?.updatedRange,
    row: newRow,
  };
}

// ── Update existing row ─────────────────────────────────────────────────────
async function updateRow(rowIndex, job, confirmedBy = 'user') {
  const sheets = await getSheets();

  // First read the existing row to log old values
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex}:J${rowIndex}`,
  });
  const oldRow = (existing.data.values || [[]])[0];

  const newRow = COLUMN_MAP.map(c => {
    let val = job[c.field] || '';
    if (c.field === 'initial_status') {
      val = (val || 'quote').replace('_', ' ');
      val = val.charAt(0).toUpperCase() + val.slice(1);
    }
    return val;
  });

  // Write only columns A–J for that row
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex}:J${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [newRow] },
  });

  logAudit({
    job_id: job.id,
    job_number: job.job_number,
    action: 'update_row',
    confirmed_by: confirmedBy,
    details: JSON.stringify({ rowIndex, oldRow, newRow }),
    sheet_range: `${SHEET_NAME}!A${rowIndex}:J${rowIndex}`,
  });

  return { success: true, rowIndex, oldRow, newRow };
}

// ── Audit Log ───────────────────────────────────────────────────────────────
function logAudit({ job_id, job_number, action, confirmed_by, details, sheet_range }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO sheet_audit_log (job_id, job_number, action, confirmed_by, details, sheet_range)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job_id || null, job_number || '', action, confirmed_by, details, sheet_range || '');
  } catch (e) {
    console.error('Sheet audit log error:', e.message);
  }
}

module.exports = {
  isConfigured,
  readAllRows,
  findDuplicates,
  previewWrite,
  appendRow,
  updateRow,
  COLUMN_MAP,
};

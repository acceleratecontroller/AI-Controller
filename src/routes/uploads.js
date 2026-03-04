const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const { getDb, generateJobNumber } = require('../models/database');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'public', 'uploads'),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Upload Excel/CSV and preview the rows before importing
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    res.json({
      filename: req.file.originalname,
      totalRows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      preview: rows.slice(0, 10) // Show first 10 rows for preview
    });
  } catch (err) {
    res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
});

// Import rows from an uploaded Excel file as jobs
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const db = getDb();

    const columnMap = req.body.columnMap ? JSON.parse(req.body.columnMap) : {};

    const insertStmt = db.prepare(`
      INSERT INTO jobs (job_number, title, description, source, priority,
        customer_name, customer_email, customer_phone, site_address,
        scheduled_date, assigned_to, estimated_hours, notes, created_by)
      VALUES (?, ?, ?, 'excel', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const historyStmt = db.prepare(
      'INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, ?, ?, ?)'
    );

    const imported = [];
    const errors = [];

    const importAll = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const getValue = (field) => {
            const mappedCol = columnMap[field];
            return mappedCol ? (row[mappedCol] || '') : (row[field] || '');
          };

          const jobNumber = generateJobNumber();
          const title = getValue('title') || `Imported Job - Row ${i + 1}`;

          const result = insertStmt.run(
            jobNumber,
            title,
            getValue('description'),
            getValue('priority') || 'normal',
            getValue('customer_name'),
            getValue('customer_email'),
            getValue('customer_phone'),
            getValue('site_address'),
            getValue('scheduled_date'),
            getValue('assigned_to'),
            parseFloat(getValue('estimated_hours')) || null,
            getValue('notes'),
            'excel_import'
          );

          historyStmt.run(
            result.lastInsertRowid, 'created', 'excel_import',
            `Imported from ${req.file.originalname}, row ${i + 1}`
          );

          imported.push({ row: i + 1, jobNumber });
        } catch (err) {
          errors.push({ row: i + 1, error: err.message });
        }
      }
    });

    importAll();

    res.json({
      totalRows: rows.length,
      imported: imported.length,
      errors: errors.length,
      jobs: imported,
      errorDetails: errors
    });
  } catch (err) {
    res.status(400).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;

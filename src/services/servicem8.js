/**
 * ServiceM8 Integration Service
 *
 * Creates jobs in ServiceM8 when a work order is approved.
 * Uses ServiceM8 REST API with HTTP Basic Auth (email + API key as password).
 *
 * Required environment variables:
 *   SERVICEM8_API_URL   - Base URL (default: https://api.servicem8.com/api_1.0)
 *   SERVICEM8_USERNAME  - ServiceM8 account email
 *   SERVICEM8_API_KEY   - ServiceM8 API key (used as password)
 */

const { getDb } = require('../models/database');

const CONFIG = {
  apiUrl: process.env.SERVICEM8_API_URL || 'https://api.servicem8.com/api_1.0',
  username: process.env.SERVICEM8_USERNAME,
  apiKey: process.env.SERVICEM8_API_KEY
};

function isConfigured() {
  return !!(CONFIG.username && CONFIG.apiKey);
}

function getAuthHeader() {
  const credentials = Buffer.from(`${CONFIG.username}:${CONFIG.apiKey}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Create a single job in ServiceM8.
 * Returns the UUID of the created job.
 */
async function createServiceM8Job(jobData) {
  const res = await fetch(`${CONFIG.apiUrl}/job.json`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      status: 'Quote',
      job_description: jobData.title,
      job_address: jobData.site_address || '',
      company_name: jobData.customer_name || '',
      description: jobData.description || '',
      work_order_date: jobData.scheduled_date || new Date().toISOString().split('T')[0]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ServiceM8 API error ${res.status}: ${errText}`);
  }

  // ServiceM8 returns the UUID in the x-record-uuid header
  const uuid = res.headers.get('x-record-uuid');
  if (!uuid) {
    // Try to get it from response body
    const body = await res.json().catch(() => ({}));
    return body.uuid || null;
  }
  return uuid;
}

/**
 * Create one or more ServiceM8 jobs for an approved ACOMS work order.
 *
 * @param {number} jobId - The ACOMS job ID
 * @param {Array} subjobs - Array of { title, description } for each ServiceM8 job to create.
 *                          If empty/null, creates a single job using the parent work order data.
 * @returns {{ created: number, errors: Array }}
 */
async function createJobsForApproval(jobId, subjobs) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found');

  // If no sub-jobs specified, create a single job from parent data
  if (!subjobs || subjobs.length === 0) {
    subjobs = [{
      title: job.title,
      description: job.description || ''
    }];
  }

  const insertStmt = db.prepare(`
    INSERT INTO servicem8_jobs (job_id, title, description, status, servicem8_uuid, error_message, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const results = { created: 0, errors: [] };

  for (const sub of subjobs) {
    try {
      const uuid = await createServiceM8Job({
        title: sub.title,
        description: sub.description,
        site_address: job.site_address,
        customer_name: job.customer_name,
        scheduled_date: job.scheduled_date
      });

      insertStmt.run(
        jobId,
        sub.title,
        sub.description || '',
        'synced',
        uuid,
        null,
        new Date().toISOString()
      );

      results.created++;
    } catch (err) {
      insertStmt.run(
        jobId,
        sub.title,
        sub.description || '',
        'failed',
        null,
        err.message,
        null
      );

      results.errors.push({ title: sub.title, error: err.message });
    }
  }

  // Log to job history
  const db2 = getDb();
  if (results.errors.length === 0) {
    db2.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'servicem8_sync', 'system', ?)"
    ).run(jobId, `Created ${results.created} ServiceM8 job(s)`);
  } else {
    db2.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'servicem8_error', 'system', ?)"
    ).run(jobId, `ServiceM8: ${results.created} created, ${results.errors.length} failed`);
  }

  return results;
}

/**
 * Get all ServiceM8 jobs linked to an ACOMS job
 */
function getServiceM8Jobs(jobId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM servicem8_jobs WHERE job_id = ? ORDER BY created_at ASC'
  ).all(jobId);
}

module.exports = {
  isConfigured,
  createJobsForApproval,
  getServiceM8Jobs,
  createServiceM8Job
};

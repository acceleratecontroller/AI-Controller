/**
 * BYDA / DBYD (Dial Before You Dig) Enquiry Service
 *
 * Handles:
 * - Rules-based assessment of whether BYDA is required
 * - Polygon validation and storage
 * - Provider abstraction (SmarterWX API or manual fallback)
 * - Enquiry reuse logic (same address + overlapping polygon + valid expiry)
 * - Lodge queue with retries and idempotency
 *
 * Env vars (all optional — falls back to manual mode):
 *   BYDA_PROVIDER       - "smarterwx" or "manual" (default: manual)
 *   BYDA_API_URL        - SmarterWX API endpoint
 *   BYDA_CLIENT_ID      - SmarterWX client ID
 *   BYDA_CLIENT_SECRET  - SmarterWX client secret
 *   BYDA_API_KEY        - SmarterWX API key (alternative to client ID/secret)
 *   BYDA_AUTO_LODGE     - "true" to auto-lodge on job creation (default: false)
 *   BYDA_EXPIRY_DAYS    - Days until an enquiry expires (default: 28)
 *   BYDA_REUSE_OVERLAP  - Min polygon overlap % for reuse (default: 70)
 *   GEOCODE_API_KEY     - API key for geocoding (Nominatim used by default, no key needed)
 */

const { getDb } = require('../models/database');
const crypto = require('crypto');

// ── Config ──

const SMARTERWX_BASE_URL = 'https://smarterwx.1100.com.au';
const SMARTERWX_AUTH_URL = SMARTERWX_BASE_URL + '/api/community/auth/tokens';
const SMARTERWX_API_URL = SMARTERWX_BASE_URL + '/api';

const CONFIG = {
  provider: process.env.BYDA_PROVIDER || 'manual',
  apiUrl: process.env.BYDA_API_URL || SMARTERWX_API_URL,
  clientId: process.env.BYDA_CLIENT_ID || '',
  clientSecret: process.env.BYDA_CLIENT_SECRET || '',
  apiKey: process.env.BYDA_API_KEY || '',
  autoLodge: process.env.BYDA_AUTO_LODGE === 'true',
  expiryDays: parseInt(process.env.BYDA_EXPIRY_DAYS) || 28,
  reuseOverlap: parseInt(process.env.BYDA_REUSE_OVERLAP) || 70,
  geocodeApiKey: process.env.GEOCODE_API_KEY || ''
};

// Token cache for OAuth flow
let tokenCache = { token: null, expiresAt: 0 };

function hasCredentials() {
  return !!(CONFIG.clientId && CONFIG.clientSecret) || !!CONFIG.apiKey;
}

function isApiConfigured() {
  return CONFIG.provider === 'smarterwx' && CONFIG.apiUrl && hasCredentials();
}

/**
 * Get a valid Bearer token.
 * If using client ID/secret, exchanges them for a short-lived token via OAuth.
 * If using a static API key, returns it directly.
 */
async function getAccessToken() {
  if (CONFIG.apiKey) {
    return CONFIG.apiKey;
  }

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const tokenUrl = SMARTERWX_AUTH_URL;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`BYDA token exchange failed (${res.status}): ${errText}`);
  }

  const rawText = await res.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`BYDA token exchange returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  console.log('BYDA token exchange response keys:', Object.keys(body));
  const token = body.token || body.access_token;
  if (!token) {
    throw new Error(`BYDA token exchange returned no token. Response keys: ${Object.keys(body).join(', ')}. Body: ${rawText.slice(0, 300)}`);
  }

  console.log('BYDA token obtained, length:', token.length, 'starts with:', token.slice(0, 10) + '...');

  // Cache with expiry (default 1 hour if not specified)
  const expiresIn = (body.expires_in || 3600) * 1000;
  tokenCache = { token, expiresAt: Date.now() + expiresIn };

  return token;
}

// ── Polygon Utilities ──

/**
 * Validate a GeoJSON Polygon
 * Returns { valid: boolean, error?: string, area?: number, centroid?: {lat, lng} }
 */
function validatePolygon(geojson) {
  if (!geojson || geojson.type !== 'Polygon') {
    return { valid: false, error: 'Must be a GeoJSON Polygon' };
  }

  const coords = geojson.coordinates;
  if (!coords || !coords[0] || coords[0].length < 4) {
    return { valid: false, error: 'Polygon must have at least 4 coordinate pairs (closed ring)' };
  }

  const ring = coords[0];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { valid: false, error: 'Polygon ring must be closed (first and last points must match)' };
  }

  const area = computePolygonAreaM2(ring);

  if (area < 1) {
    return { valid: false, error: 'Polygon area is too small (< 1 m²)' };
  }

  // Max area: 10 km² (10,000,000 m²)
  if (area > 10000000) {
    return { valid: false, error: `Polygon area is very large (${(area / 1000000).toFixed(2)} km²). Max is 10 km².`, area };
  }

  // Warn if > 1 km²
  const warning = area > 1000000
    ? `Large area: ${(area / 1000000).toFixed(2)} km². Confirm this is correct.`
    : null;

  const centroid = computeCentroid(ring);

  return { valid: true, area, centroid, warning };
}

/**
 * Approximate polygon area in square metres using the Shoelace formula
 * on lat/lng projected to metres.
 */
function computePolygonAreaM2(ring) {
  // Convert to approximate metres using centroid latitude for scale
  const avgLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(avgLat * Math.PI / 180);

  const projected = ring.map(c => [c[0] * mPerDegLng, c[1] * mPerDegLat]);

  let area = 0;
  for (let i = 0; i < projected.length - 1; i++) {
    area += projected[i][0] * projected[i + 1][1];
    area -= projected[i + 1][0] * projected[i][1];
  }
  return Math.abs(area) / 2;
}

function computeCentroid(ring) {
  const n = ring.length - 1; // exclude closing point
  const sumLng = ring.slice(0, n).reduce((s, c) => s + c[0], 0);
  const sumLat = ring.slice(0, n).reduce((s, c) => s + c[1], 0);
  return { lat: sumLat / n, lng: sumLng / n };
}

/**
 * Compute a stable hash for a polygon (for idempotency).
 * Rounds coordinates to 6 decimal places.
 */
function hashPolygon(geojson) {
  if (!geojson || !geojson.coordinates) return null;
  const rounded = geojson.coordinates[0].map(c => [
    Math.round(c[0] * 1e6) / 1e6,
    Math.round(c[1] * 1e6) / 1e6
  ]);
  return crypto.createHash('sha256').update(JSON.stringify(rounded)).digest('hex').slice(0, 16);
}

function hashAddress(address) {
  if (!address) return null;
  const normalised = address.toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * Estimate polygon overlap percentage between two GeoJSON polygons.
 * Uses a simplified point-in-polygon sampling approach (not a full intersection).
 */
function estimateOverlap(poly1, poly2) {
  if (!poly1 || !poly2 || !poly1.coordinates || !poly2.coordinates) return 0;

  const ring1 = poly1.coordinates[0];
  const ring2 = poly2.coordinates[0];

  // Sample points from poly1 and check how many are inside poly2
  const samples = generateSamplePoints(ring1, 100);
  let inside = 0;
  for (const pt of samples) {
    if (pointInPolygon(pt, ring2)) inside++;
  }
  const overlap1 = samples.length > 0 ? (inside / samples.length) * 100 : 0;

  // Also sample poly2 into poly1 and average
  const samples2 = generateSamplePoints(ring2, 100);
  let inside2 = 0;
  for (const pt of samples2) {
    if (pointInPolygon(pt, ring1)) inside2++;
  }
  const overlap2 = samples2.length > 0 ? (inside2 / samples2.length) * 100 : 0;

  return Math.max(overlap1, overlap2);
}

function generateSamplePoints(ring, count) {
  // Bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of ring) {
    if (c[0] < minX) minX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] > maxY) maxY = c[1];
  }

  const points = [];
  let attempts = 0;
  while (points.length < count && attempts < count * 10) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (pointInPolygon([x, y], ring)) {
      points.push([x, y]);
    }
  }
  return points;
}

function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > point[1]) !== (yj > point[1]) &&
        point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Rules Engine ──

/**
 * Assess whether BYDA is required for a job using configurable rules.
 * Returns { required: boolean, reason: string, matchedRule?: string }
 */
function assessRequirement(job) {
  const db = getDb();
  const rules = db.prepare(
    "SELECT * FROM byda_rules WHERE is_active = 1 ORDER BY priority DESC, id ASC"
  ).all();

  for (const rule of rules) {
    const fieldValue = (job[rule.field] || '').toLowerCase();
    const pattern = rule.pattern.toLowerCase();
    let matched = false;

    if (rule.match_type === 'contains') {
      matched = fieldValue.includes(pattern);
    } else if (rule.match_type === 'starts_with') {
      matched = fieldValue.startsWith(pattern);
    } else if (rule.match_type === 'regex') {
      try { matched = new RegExp(pattern, 'i').test(fieldValue); } catch (e) { /* skip invalid regex */ }
    } else if (rule.match_type === 'exact') {
      matched = fieldValue === pattern;
    }

    if (matched) {
      return {
        required: rule.result === 'required',
        reason: rule.rule_name,
        matchedRule: rule.id,
        suggestedAction: rule.result === 'required' ? 'lodge' : 'none'
      };
    }
  }

  // Default: not required (can be overridden manually)
  return {
    required: false,
    reason: 'No matching rules — default to not required. You can override this manually.',
    matchedRule: null,
    suggestedAction: 'none'
  };
}

// ── Reuse Logic ──

/**
 * Find a reusable existing BYDA enquiry for the same address + overlapping polygon.
 */
function findReusableEnquiry(jobId, addressText, polygonGeojson, workType) {
  const db = getDb();
  const addrHash = hashAddress(addressText);
  if (!addrHash) return null;

  // Find valid (not expired, lodged) enquiries with same address hash
  const candidates = db.prepare(`
    SELECT * FROM byda_enquiries
    WHERE address_hash = ?
      AND status = 'lodged'
      AND expiry_at > datetime('now')
      AND job_id != ?
    ORDER BY lodged_at DESC
  `).all(addrHash, jobId);

  if (!polygonGeojson) {
    // If no polygon yet, just match on address + same work type
    const match = candidates.find(c => !workType || c.work_type === workType);
    return match || null;
  }

  for (const candidate of candidates) {
    if (!candidate.polygon_geojson) continue;
    try {
      const existingPoly = JSON.parse(candidate.polygon_geojson);
      const overlap = estimateOverlap(polygonGeojson, existingPoly);
      if (overlap >= CONFIG.reuseOverlap) {
        // Check work type matches if specified
        if (workType && candidate.work_type && candidate.work_type !== workType) continue;
        return { ...candidate, overlapPercent: overlap };
      }
    } catch (e) { continue; }
  }

  return null;
}

// ── Provider Abstraction ──

/**
 * Lodge a BYDA enquiry via the configured provider.
 * Returns { enquiryId, expiryDate, reference, metadata }
 */
async function lodgeWithProvider(enquiryData) {
  if (isApiConfigured()) {
    return lodgeViaSmarterWX(enquiryData);
  }
  // Manual fallback — just mark as needing manual lodgement
  return {
    enquiryId: null,
    expiryDate: null,
    reference: null,
    metadata: { manual: true, message: 'API not configured — manual lodgement required' }
  };
}

async function lodgeViaSmarterWX(data) {
  const token = await getAccessToken();

  const payload = {
    address: data.address_text,
    polygon: data.polygon_geojson ? JSON.parse(data.polygon_geojson) : null,
    work_type: data.work_type || 'general',
    job_reference: data.job_number || '',
    contact_name: data.customer_name || '',
    scheduled_date: data.scheduled_date || ''
  };

  const res = await fetch(CONFIG.apiUrl + '/enquiries', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`BYDA API error ${res.status}: ${errText}`);
  }

  const body = await res.json();

  const expiryDate = body.expiry_date || new Date(
    Date.now() + CONFIG.expiryDays * 24 * 60 * 60 * 1000
  ).toISOString();

  return {
    enquiryId: body.enquiry_id || body.id,
    expiryDate,
    reference: body.reference_url || body.reference || null,
    metadata: body
  };
}

// ── Core Operations ──

/**
 * Assess a job for BYDA requirement and update the job record.
 */
function assess(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found');

  const result = assessRequirement(job);

  db.prepare(`
    UPDATE jobs SET byda_required = ?, byda_status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(result.required ? 1 : 0, result.required ? 'needed' : 'not_required', jobId);

  // Log
  db.prepare(
    "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_assess', 'system', ?)"
  ).run(jobId, `BYDA assessment: ${result.required ? 'Required' : 'Not required'} — ${result.reason}`);

  return {
    required: result.required,
    reason: result.reason,
    matchedRule: result.matchedRule,
    suggestedAction: result.suggestedAction,
    currentStatus: result.required ? 'needed' : 'not_required'
  };
}

/**
 * Save a polygon for a job's BYDA enquiry.
 */
function savePolygon(jobId, geojson) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found');

  const validation = validatePolygon(geojson);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const polyHash = hashPolygon(geojson);
  const addrHash = hashAddress(job.site_address);

  // Upsert enquiry record
  let enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE job_id = ?').get(jobId);

  if (enquiry) {
    db.prepare(`
      UPDATE byda_enquiries
      SET polygon_geojson = ?, centroid_lat = ?, centroid_lng = ?,
          polygon_hash = ?, address_hash = ?, address_text = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(geojson),
      validation.centroid.lat,
      validation.centroid.lng,
      polyHash, addrHash,
      job.site_address,
      enquiry.id
    );
  } else {
    const result = db.prepare(`
      INSERT INTO byda_enquiries (job_id, address_text, address_hash, polygon_geojson, centroid_lat, centroid_lng, polygon_hash, required_flag, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId, job.site_address, addrHash,
      JSON.stringify(geojson),
      validation.centroid.lat, validation.centroid.lng,
      polyHash,
      job.byda_required ? 1 : 0,
      job.byda_status || 'needed'
    );
    enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE id = ?').get(result.lastInsertRowid);
    db.prepare("UPDATE jobs SET byda_enquiry_id = ? WHERE id = ?").run(enquiry.id, jobId);
  }

  db.prepare(
    "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_polygon', 'user', ?)"
  ).run(jobId, `Work area polygon saved (${validation.area.toFixed(0)} m²)`);

  return {
    success: true,
    area: validation.area,
    centroid: validation.centroid,
    warning: validation.warning,
    enquiryId: enquiry.id
  };
}

/**
 * Attempt to lodge a BYDA enquiry. Tries reuse first, then lodges new.
 */
async function lodge(jobId, triggeredBy = 'user') {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found');

  let enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE job_id = ?').get(jobId);

  // Create enquiry record if none exists
  if (!enquiry) {
    const addrHash = hashAddress(job.site_address);
    const result = db.prepare(`
      INSERT INTO byda_enquiries (job_id, address_text, address_hash, required_flag, status, triggered_by)
      VALUES (?, ?, ?, 1, 'needed', ?)
    `).run(jobId, job.site_address, addrHash, triggeredBy);
    enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE id = ?').get(result.lastInsertRowid);
    db.prepare("UPDATE jobs SET byda_enquiry_id = ? WHERE id = ?").run(enquiry.id, jobId);
  }

  // Reset failed or manual_required enquiries so they can be retried
  if (enquiry.status === 'failed' || enquiry.status === 'manual_required') {
    const prevStatus = enquiry.status;
    const prevError = enquiry.error_message || 'none';
    db.prepare("UPDATE byda_enquiries SET status = 'needed', error_message = NULL, updated_at = datetime('now') WHERE id = ?").run(enquiry.id);
    db.prepare("UPDATE jobs SET byda_status = 'needed', updated_at = datetime('now') WHERE id = ?").run(jobId);
    // Clear completed queue entries so retry isn't blocked
    db.prepare("UPDATE byda_queue SET status = 'completed' WHERE job_id = ? AND status IN ('pending', 'processing')").run(jobId);
    enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE id = ?').get(enquiry.id);

    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_retry', ?, ?)"
    ).run(jobId, triggeredBy, `Retrying BYDA lodge (previous status: ${prevStatus}, error: ${prevError})`);
  }

  // Check idempotency
  const idempotencyKey = `${jobId}-${enquiry.polygon_hash || 'nopoly'}-${enquiry.address_hash || 'noaddr'}-${job.title || ''}`;
  const existingQueue = db.prepare(
    "SELECT * FROM byda_queue WHERE idempotency_key = ? AND status IN ('pending', 'processing')"
  ).get(idempotencyKey);
  if (existingQueue) {
    return { status: 'already_queued', message: 'A lodge request is already in progress for this job' };
  }

  // Try to reuse an existing enquiry
  const polygonGeojson = enquiry.polygon_geojson ? JSON.parse(enquiry.polygon_geojson) : null;
  const reusable = findReusableEnquiry(jobId, job.site_address, polygonGeojson, enquiry.work_type);

  if (reusable) {
    // Reuse existing enquiry
    db.prepare(`
      UPDATE byda_enquiries
      SET status = 'lodged', external_enquiry_id = ?, lodged_at = ?,
          expiry_at = ?, reused_from_enquiry_id = ?, provider = ?,
          triggered_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      reusable.external_enquiry_id,
      reusable.lodged_at,
      reusable.expiry_at,
      reusable.id,
      reusable.provider,
      triggeredBy,
      enquiry.id
    );

    db.prepare("UPDATE jobs SET byda_status = 'lodged', updated_at = datetime('now') WHERE id = ?").run(jobId);

    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_reuse', ?, ?)"
    ).run(jobId, triggeredBy, `Reused BYDA enquiry #${reusable.id} (${reusable.external_enquiry_id || 'manual'}, overlap: ${(reusable.overlapPercent || 100).toFixed(0)}%)`);

    return {
      status: 'lodged',
      reused: true,
      reusedFrom: reusable.id,
      externalId: reusable.external_enquiry_id,
      expiryAt: reusable.expiry_at
    };
  }

  // No reusable enquiry — lodge new
  db.prepare("UPDATE byda_enquiries SET status = 'lodging', updated_at = datetime('now') WHERE id = ?").run(enquiry.id);
  db.prepare("UPDATE jobs SET byda_status = 'lodging', updated_at = datetime('now') WHERE id = ?").run(jobId);

  if (!isApiConfigured()) {
    // Manual mode — mark as needing manual lodgement
    db.prepare(`
      UPDATE byda_enquiries SET status = 'manual_required', provider = 'manual', triggered_by = ?, updated_at = datetime('now') WHERE id = ?
    `).run(triggeredBy, enquiry.id);
    db.prepare("UPDATE jobs SET byda_status = 'manual_required', updated_at = datetime('now') WHERE id = ?").run(jobId);

    const missing = [];
    if (CONFIG.provider !== 'smarterwx') missing.push(`BYDA_PROVIDER must be "smarterwx" (currently "${CONFIG.provider}")`);
    if (!CONFIG.apiUrl) missing.push('BYDA_API_URL is not set');
    if (!CONFIG.clientId && !CONFIG.apiKey) missing.push('BYDA_CLIENT_ID/BYDA_CLIENT_SECRET or BYDA_API_KEY not set');

    const manualDetails = [
      'BYDA API not configured — manual lodgement required',
      `Missing in .env: ${missing.join('; ')}`,
      `Address: ${job.site_address}`
    ].join(' | ');

    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_manual', ?, ?)"
    ).run(jobId, triggeredBy, manualDetails);

    return {
      status: 'manual_required',
      message: 'API not configured. Lodge manually at the BYDA website and paste the enquiry ID back.',
      exportData: {
        address: job.site_address,
        polygon: enquiry.polygon_geojson,
        jobTitle: job.title,
        jobNumber: job.job_number,
        customerName: job.customer_name,
        scheduledDate: job.scheduled_date
      }
    };
  }

  // API mode — attempt lodge
  try {
    const providerResult = await lodgeWithProvider({
      address_text: enquiry.address_text || job.site_address,
      polygon_geojson: enquiry.polygon_geojson,
      work_type: enquiry.work_type,
      job_number: job.job_number,
      customer_name: job.customer_name,
      scheduled_date: job.scheduled_date
    });

    const expiryAt = providerResult.expiryDate || new Date(
      Date.now() + CONFIG.expiryDays * 24 * 60 * 60 * 1000
    ).toISOString();

    db.prepare(`
      UPDATE byda_enquiries
      SET status = 'lodged', provider = 'smarterwx', external_enquiry_id = ?,
          lodged_at = datetime('now'), expiry_at = ?, triggered_by = ?,
          raw_provider_payload = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      providerResult.enquiryId,
      expiryAt,
      triggeredBy,
      JSON.stringify(providerResult.metadata),
      enquiry.id
    );

    db.prepare("UPDATE jobs SET byda_status = 'lodged', updated_at = datetime('now') WHERE id = ?").run(jobId);

    const lodgeDetails = [
      `BYDA enquiry lodged successfully via SmarterWX`,
      `Enquiry ID: ${providerResult.enquiryId || 'pending'}`,
      `Address: ${enquiry.address_text || job.site_address}`,
      `Expires: ${new Date(expiryAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      providerResult.reference ? `Reference: ${providerResult.reference}` : null
    ].filter(Boolean).join(' | ');

    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_lodged', ?, ?)"
    ).run(jobId, triggeredBy, lodgeDetails);

    return {
      status: 'lodged',
      reused: false,
      externalId: providerResult.enquiryId,
      expiryAt,
      reference: providerResult.reference
    };
  } catch (err) {
    db.prepare(`
      UPDATE byda_enquiries SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?
    `).run(err.message, enquiry.id);
    db.prepare("UPDATE jobs SET byda_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(jobId);

    // Queue for retry
    db.prepare(`
      INSERT OR IGNORE INTO byda_queue (job_id, enquiry_id, action, idempotency_key, status)
      VALUES (?, ?, 'lodge', ?, 'pending')
    `).run(jobId, enquiry.id, idempotencyKey);

    const errorDetails = [
      `BYDA lodge failed`,
      `Error: ${err.message}`,
      `Address: ${enquiry.address_text || job.site_address}`,
      `Provider: smarterwx`,
      `API URL: ${CONFIG.apiUrl}`,
      `Will retry automatically (queued)`
    ].join(' | ');

    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_error', ?, ?)"
    ).run(jobId, triggeredBy, errorDetails);

    return { status: 'failed', error: err.message };
  }
}

/**
 * Link a manually-lodged enquiry ID to the job.
 */
function manualLink(jobId, externalEnquiryId, triggeredBy = 'user') {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found');

  if (!externalEnquiryId || !externalEnquiryId.trim()) {
    throw new Error('External enquiry ID is required');
  }

  let enquiry = db.prepare('SELECT * FROM byda_enquiries WHERE job_id = ?').get(jobId);
  const expiryAt = new Date(Date.now() + CONFIG.expiryDays * 24 * 60 * 60 * 1000).toISOString();

  if (enquiry) {
    db.prepare(`
      UPDATE byda_enquiries
      SET status = 'lodged', external_enquiry_id = ?, provider = 'manual',
          lodged_at = datetime('now'), expiry_at = ?, triggered_by = ?,
          error_message = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(externalEnquiryId.trim(), expiryAt, triggeredBy, enquiry.id);
  } else {
    const addrHash = hashAddress(job.site_address);
    const result = db.prepare(`
      INSERT INTO byda_enquiries (job_id, address_text, address_hash, required_flag, status, provider, external_enquiry_id, lodged_at, expiry_at, triggered_by)
      VALUES (?, ?, ?, 1, 'lodged', 'manual', ?, datetime('now'), ?, ?)
    `).run(jobId, job.site_address, addrHash, externalEnquiryId.trim(), expiryAt, triggeredBy);
    enquiry = { id: result.lastInsertRowid };
  }

  db.prepare("UPDATE jobs SET byda_status = 'lodged', byda_enquiry_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(enquiry.id, jobId);

  db.prepare(
    "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'byda_manual_link', ?, ?)"
  ).run(jobId, triggeredBy, `Manual BYDA enquiry linked: ${externalEnquiryId.trim()}`);

  return { status: 'lodged', externalId: externalEnquiryId.trim(), expiryAt };
}

/**
 * Get the BYDA enquiry details for a job.
 */
function getEnquiry(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT byda_required, byda_status, byda_enquiry_id FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;

  const enquiry = job.byda_enquiry_id
    ? db.prepare('SELECT * FROM byda_enquiries WHERE id = ?').get(job.byda_enquiry_id)
    : db.prepare('SELECT * FROM byda_enquiries WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(jobId);

  return {
    required: !!job.byda_required,
    status: job.byda_status || 'not_assessed',
    enquiry: enquiry || null,
    isApiConfigured: isApiConfigured(),
    autoLodge: CONFIG.autoLodge
  };
}

/**
 * Get all BYDA rules.
 */
function getRules() {
  const db = getDb();
  return db.prepare("SELECT * FROM byda_rules ORDER BY priority DESC, id ASC").all();
}

/**
 * Save/update BYDA rules.
 */
function saveRules(rules) {
  const db = getDb();

  const transaction = db.transaction((ruleList) => {
    // Delete all and re-insert (simple approach for admin UI)
    db.prepare("DELETE FROM byda_rules").run();
    const insert = db.prepare(
      "INSERT INTO byda_rules (rule_name, field, pattern, match_type, result, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const r of ruleList) {
      insert.run(r.rule_name, r.field || 'title', r.pattern, r.match_type || 'contains', r.result || 'required', r.priority || 0, r.is_active !== undefined ? r.is_active : 1);
    }
  });

  transaction(rules);
  return getRules();
}

// ── Queue Processor ──

/**
 * Process pending items in the lodge queue. Call periodically.
 */
async function processQueue() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT * FROM byda_queue
    WHERE status = 'pending' AND next_attempt_at <= datetime('now') AND attempts < max_attempts
    ORDER BY created_at ASC LIMIT 5
  `).all();

  for (const item of pending) {
    db.prepare("UPDATE byda_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ?").run(item.id);

    try {
      const result = await lodge(item.job_id, 'queue');
      if (result.status === 'lodged' || result.status === 'manual_required') {
        db.prepare("UPDATE byda_queue SET status = 'completed' WHERE id = ?").run(item.id);
      } else if (result.status === 'failed') {
        const backoff = Math.pow(2, item.attempts + 1);
        db.prepare(`
          UPDATE byda_queue SET status = 'pending', error_message = ?,
            next_attempt_at = datetime('now', '+' || ? || ' seconds')
          WHERE id = ?
        `).run(result.error, backoff, item.id);
      }
    } catch (err) {
      const backoff = Math.pow(2, item.attempts + 1);
      db.prepare(`
        UPDATE byda_queue SET status = 'pending', error_message = ?,
          next_attempt_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(err.message, backoff, item.id);
    }
  }
}

// ── Geocoding ──

/**
 * Geocode an address using Nominatim (OSM).
 * Returns { lat, lng } or null.
 */
async function geocode(address) {
  if (!address) return null;

  try {
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: '1',
      countrycodes: 'au'
    });

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'ACOMS-WorkOrder/1.0' }
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data.length === 0) return null;

    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) {
    return null;
  }
}

module.exports = {
  // Core operations
  assess,
  savePolygon,
  lodge,
  manualLink,
  getEnquiry,
  geocode,

  // Rules management
  getRules,
  saveRules,

  // Queue
  processQueue,

  // Utilities (exported for testing)
  validatePolygon,
  hashPolygon,
  hashAddress,
  estimateOverlap,
  computePolygonAreaM2,
  assessRequirement,
  findReusableEnquiry,
  isApiConfigured,
  CONFIG
};

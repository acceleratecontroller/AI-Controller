/**
 * SharePoint Integration Service
 *
 * Syncs job attachments to a SharePoint document library.
 * Each job gets its own folder named by job number (e.g. WO-202603-0001).
 *
 * Required environment variables:
 *   SHAREPOINT_TENANT_ID     - Azure AD tenant ID
 *   SHAREPOINT_CLIENT_ID     - App registration client ID
 *   SHAREPOINT_CLIENT_SECRET - App registration client secret
 *   SHAREPOINT_SITE_URL      - SharePoint site URL (e.g. https://yourcompany.sharepoint.com/sites/ACOMS)
 *   SHAREPOINT_DRIVE_ID      - Document library drive ID (optional, uses default if not set)
 *   SHAREPOINT_ROOT_FOLDER   - Root folder path in the library (default: "Work Orders")
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../models/database');

const CONFIG = {
  tenantId: process.env.SHAREPOINT_TENANT_ID,
  clientId: process.env.SHAREPOINT_CLIENT_ID,
  clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
  siteUrl: process.env.SHAREPOINT_SITE_URL,
  driveId: process.env.SHAREPOINT_DRIVE_ID,
  rootFolder: process.env.SHAREPOINT_ROOT_FOLDER || 'Work Orders'
};

let accessToken = null;
let tokenExpiry = 0;

/**
 * Check if SharePoint integration is configured
 */
function isConfigured() {
  return !!(CONFIG.tenantId && CONFIG.clientId && CONFIG.clientSecret && CONFIG.siteUrl);
}

/**
 * Get an access token using client credentials flow (Microsoft Graph API)
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    scope: 'https://graph.microsoft.com/.default'
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get SharePoint token: ${res.status} ${err}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return accessToken;
}

/**
 * Get the SharePoint site ID from the site URL
 */
async function getSiteId() {
  const token = await getAccessToken();
  // Extract hostname and site path from URL
  const url = new URL(CONFIG.siteUrl);
  const sitePath = url.pathname;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${url.hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Failed to get site: ${res.status}`);
  const data = await res.json();
  return data.id;
}

/**
 * Get the drive (document library) to upload to
 */
async function getDriveId() {
  if (CONFIG.driveId) return CONFIG.driveId;

  const token = await getAccessToken();
  const siteId = await getSiteId();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Failed to get drive: ${res.status}`);
  const data = await res.json();
  return data.id;
}

/**
 * Upload a single file to SharePoint under the job's folder
 */
async function uploadFile(driveId, jobNumber, filePath, fileName) {
  const token = await getAccessToken();
  const folderPath = `${CONFIG.rootFolder}/${jobNumber}`;
  const uploadPath = `${folderPath}/${fileName}`;

  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fs.statSync(filePath).size;

  // For files under 4MB, use simple upload. For larger files, use upload session.
  if (fileSize < 4 * 1024 * 1024) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(uploadPath)}:/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: fileBuffer
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Upload failed for ${fileName}: ${res.status} ${err}`);
    }

    const data = await res.json();
    return data.webUrl;
  } else {
    // Create upload session for large files
    const sessionRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(uploadPath)}:/createUploadSession`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ item: { name: fileName } })
      }
    );

    if (!sessionRes.ok) throw new Error(`Upload session failed for ${fileName}`);
    const session = await sessionRes.json();

    // Upload in 4MB chunks
    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    let result;

    while (offset < fileSize) {
      const end = Math.min(offset + chunkSize, fileSize);
      const chunk = fileBuffer.slice(offset, end);

      const chunkRes = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': chunk.length.toString(),
          'Content-Range': `bytes ${offset}-${end - 1}/${fileSize}`
        },
        body: chunk
      });

      if (!chunkRes.ok && chunkRes.status !== 202) {
        throw new Error(`Chunk upload failed for ${fileName} at offset ${offset}`);
      }

      result = await chunkRes.json();
      offset = end;
    }

    return result.webUrl;
  }
}

/**
 * Sync all unsynced attachments for a job to SharePoint
 */
async function syncJobAttachments(jobId, jobNumber) {
  const db = getDb();
  const unsynced = db.prepare(
    'SELECT * FROM attachments WHERE job_id = ? AND sharepoint_synced = 0'
  ).all(jobId);

  if (unsynced.length === 0) {
    return { synced: 0, errors: 0 };
  }

  const driveId = await getDriveId();
  let synced = 0;
  let errors = 0;

  for (const attachment of unsynced) {
    try {
      if (!fs.existsSync(attachment.file_path)) {
        console.error(`File missing for attachment ${attachment.id}: ${attachment.file_path}`);
        errors++;
        continue;
      }

      const sharePointUrl = await uploadFile(
        driveId,
        jobNumber,
        attachment.file_path,
        attachment.original_name
      );

      db.prepare(
        'UPDATE attachments SET sharepoint_synced = 1, sharepoint_url = ? WHERE id = ?'
      ).run(sharePointUrl, attachment.id);

      synced++;
    } catch (err) {
      console.error(`SharePoint upload failed for ${attachment.original_name}:`, err.message);
      errors++;
    }
  }

  if (synced > 0) {
    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'sharepoint_sync', 'system', ?)"
    ).run(jobId, `Synced ${synced} file(s) to SharePoint`);
  }

  return { synced, errors };
}

module.exports = {
  isConfigured,
  syncJobAttachments,
  uploadFile,
  getAccessToken,
  getSiteId,
  getDriveId
};

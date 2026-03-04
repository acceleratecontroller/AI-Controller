# ACOMS — AI Controller Work Order Management System

A web-based work order management system for creating, tracking, and managing jobs through a structured approval workflow. Built to handle work orders from multiple intake sources (manual entry, email, bulk import) with file attachments and SharePoint integration.

## Current Features

### Job Management
- **Create work orders** with customer info, site address, priority, scheduling, and assignment
- **Unique job numbering** — auto-generated format: `WO-YYYYMM-XXXX`
- **Priority levels** — low, normal, high, urgent
- **Searchable job list** with status and keyword filtering

### Approval Workflow
Jobs follow a structured status pipeline with validation at each transition:

```
draft → submitted → in_review → approved → in_progress → completed
                              ↘ rejected
                    in_progress → on_hold
```

### File Attachments
- **Upload any file type** — PDFs, images, Word docs, spreadsheets, videos, CAD files, etc.
- **Drag-and-drop** or click-to-upload in the job detail view
- **Multi-file upload** — up to 20 files at once, 50MB per file
- **Download and delete** attachments from the UI
- **Source tracking** — files tagged as `upload` (manual) or `email` (from email intake)
- **Full audit trail** — all attachment actions logged in job history

### SharePoint Integration
- **Automatic sync** — attachments upload to SharePoint when configured
- **Folder-per-job** — files organized under `Work Orders/{job-number}/`
- **Large file support** — chunked upload sessions for files over 4MB
- **Manual sync trigger** — API endpoint to re-sync if needed
- See [SharePoint Setup](#sharepoint-setup) below

### ServiceM8 Integration
- **Auto-create ServiceM8 jobs on approval** — when a work order is approved, job(s) are created in ServiceM8 via their API
- **Blocking approval** — if ServiceM8 creation fails, the approval is blocked with an error message
- **Multi-job splitting** — checkbox to split one work order into multiple ServiceM8 sub-jobs (e.g. different phases, trades, or floors)
- **Sub-job builder modal** — add as many sub-jobs as needed, each with its own title and description; all other data (customer, address, date) inherits from the parent work order
- **Linked job tracking** — ServiceM8 UUIDs stored and visible in the job detail view
- See [ServiceM8 Setup](#servicem8-setup) below

### Bulk Import
- **Excel/CSV upload** — import jobs from `.xlsx`, `.xls`, or `.csv` files
- **Preview before import** — review mapped data before committing
- **Column mapping** — flexible field mapping for different spreadsheet layouts

### Audit Trail
- Every status change, edit, attachment upload/removal is logged
- Full history visible in the job detail view

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) with WAL mode |
| Frontend | Vanilla HTML/CSS/JS (single-page app) |
| File uploads | Multer |
| SharePoint | Microsoft Graph API (client credentials) |

---

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload during development
npm run dev
```

The app runs at **http://localhost:3000** by default.

---

## SharePoint Setup

SharePoint sync is optional — attachments work locally without it.

1. **Register an app** in [Azure AD](https://portal.azure.com) → App registrations
2. **Grant permission**: Microsoft Graph → Application → `Sites.ReadWrite.All`
3. **Create a client secret**
4. **Copy** `.env.example` to `.env` and fill in your credentials:

```env
SHAREPOINT_TENANT_ID=your-azure-tenant-id
SHAREPOINT_CLIENT_ID=your-app-client-id
SHAREPOINT_CLIENT_SECRET=your-app-client-secret
SHAREPOINT_SITE_URL=https://yourcompany.sharepoint.com/sites/ACOMS
```

Once configured, all new attachments auto-sync to SharePoint under `Work Orders/{job-number}/`.

---

## ServiceM8 Setup

ServiceM8 integration is required for job creation on approval.

1. Get your API key from **ServiceM8 > Settings > API & Webhooks**
2. Add to your `.env`:

```env
SERVICEM8_USERNAME=your-email@company.com
SERVICEM8_API_KEY=your-servicem8-api-key
```

When configured, the approval flow will:
- Show a confirmation modal before approving
- Create one or more jobs in ServiceM8
- Block the approval if the API call fails (so you can retry)
- Store the ServiceM8 UUID for each created job

Without ServiceM8 configured, approvals still work normally — they just skip the API call.

---

## Project Structure

```
AI-Controller/
├── src/
│   ├── server.js              # Express app setup and routing
│   ├── models/
│   │   └── database.js        # SQLite schema and helpers
│   ├── routes/
│   │   ├── jobs.js            # Job CRUD and workflow API
│   │   ├── attachments.js     # File upload/download/delete API
│   │   └── uploads.js         # Excel/CSV bulk import API
│   ├── services/
│   │   ├── servicem8.js       # ServiceM8 job creation API
│   │   └── sharepoint.js      # Microsoft Graph SharePoint sync
│   ├── middleware/             # (reserved)
│   └── utils/                 # (reserved)
├── public/
│   └── app.html               # Single-page frontend
├── attachments/                # Uploaded files (gitignored)
├── data.db                     # SQLite database (gitignored)
├── .env.example                # Environment variable template
└── package.json
```

---

## API Endpoints

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | List jobs (query: `?status=`, `?search=`) |
| GET | `/api/jobs/:id` | Get job with history |
| POST | `/api/jobs` | Create job |
| PUT | `/api/jobs/:id` | Update job fields |
| POST | `/api/jobs/:id/status` | Change job status |
| DELETE | `/api/jobs/:id` | Delete draft job |

### Attachments
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs/:id/attachments` | List attachments for a job |
| POST | `/api/jobs/:id/attachments` | Upload files (multipart form) |
| GET | `/api/jobs/:id/attachments/:aid/download` | Download a file |
| DELETE | `/api/jobs/:id/attachments/:aid` | Delete an attachment |
| POST | `/api/jobs/:id/attachments/sync-sharepoint` | Trigger SharePoint sync |

### ServiceM8
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs/:id/servicem8` | List ServiceM8 jobs linked to a work order |

> ServiceM8 jobs are created automatically during the approval status change (`POST /api/jobs/:id/status` with `status: "approved"`). Pass `servicem8_jobs: [{ title, description }, ...]` in the body to create multiple sub-jobs.

### Bulk Import
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/uploads/preview` | Preview Excel/CSV data |
| POST | `/api/uploads/import` | Import jobs from file |

---

## Planned Features

- **Email intake** — automatically create jobs from incoming emails, carry over attachments
- **Email notifications** — notify team members on status changes and assignments
- **User authentication** — role-based access (admin, reviewer, field staff)
- **Dashboard analytics** — job volume, turnaround times, status breakdown charts
- **Mobile-friendly views** — optimized interface for field staff on tablets/phones
- **PDF report generation** — export job details and history as printable reports

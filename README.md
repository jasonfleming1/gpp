# ASD Tracker

An internal web application that consolidates timesheet data, task tracking, meeting metrics, developer performance, and software release management into a single platform for the ASD team.

---

## Problem It Solves

Before this tool, operational data lived across disconnected systems - timesheets in 3e, task tracking in spreadsheets, meeting notes in emails, release versions in shared documents. ASD Tracker brings all of this into one place with automated analysis, eliminating manual reconciliation and providing real-time visibility into team performance and project health.

---

## Core Capabilities

### 1. Timesheet Ingestion & Task Tracking

The system imports Excel exports from the 3e billing system and automatically:

- Parses developer time entries and groups them by TFS task ID
- Extracts task identifiers from timecard narratives using pattern matching
- Flags orphaned work (hours logged without a valid TFS ID)
- Calculates total actual hours, developer breakdowns, and date ranges per task
- Filters out non-work activities (PTO, holidays, leave)

This replaces the manual process of cross-referencing timesheets with task lists.

### 2. Automated Estimation & Quality Scoring

Two algorithms reduce subjective bias in project metrics:

**Estimation (Bell-Curve Method)**
- Groups tasks by developer or matter number
- Calculates the median actual hours and median absolute deviation for each group
- Produces statistically grounded estimates that are resilient to outlier tasks

**Quality Scoring (Variance-Based)**

| Score | Criteria | Meaning |
|-------|----------|---------|
| 5 | 25%+ under budget | Excellent |
| 4 | 10-25% under budget | Good |
| 3 | Within 25% of estimate | Meets expectations |
| 2 | More than 25% over budget | Below average |

Both can be run in bulk across the entire task set or applied individually.

### 3. Developer Scorecard

Aggregates per-developer performance metrics including:

- Total hours worked and task count
- Hours and tasks without a TFS ID (untracked work)
- Average quality scores
- Quarterly trend charts showing workload over time

This provides an objective, data-driven view of individual contribution and workload balance.

### 4. Meeting Analytics

Tracks meetings by type (standup, 1:1, requirements, leadership, etc.) and attendee, with:

- Total and average duration metrics
- Monthly trend analysis
- Distribution by day of week
- Breakdowns by meeting type and employee/team

Answers questions like: "How much time does the team spend in standups vs. requirements sessions?" and "Are meeting hours trending up or down?"

### 5. Manager Task Tracking

A dedicated task board for management-level work items with:

- Status tracking (Not Started, In Progress, Closed)
- Application assignment and quality scoring (1-5)
- File attachments (documents, images, spreadsheets)
- Filtering by status and application

### 6. Release Management

Tracks software releases across three environments:

| Environment | Purpose |
|-------------|---------|
| TQA | Testing/QA build version |
| UAT | User acceptance testing version |
| Production | Live deployment version |

Each release maintains a full change history (snapshots of every update) for audit purposes, and supports file attachments for release documentation.

### 7. Administration

A built-in admin panel provides:

- **Configurable dropdowns** - Application names, task statuses, meeting types, and employee lists are stored in the database and editable without code changes
- **Database tools** - Export any collection as JSON, import data from JSON backups, view collection sizes and document counts
- **Bulk operations** - Clear and reimport data, recalculate totals, fix low estimates

---

## Dashboard

The home page provides an at-a-glance overview with:

- **Summary cards** - Total tasks, hours tracked, average quality, task completion rate
- **8 interactive charts** powered by Chart.js:
  - Task status distribution (needs estimate / needs quality / complete)
  - Quality score distribution across all tasks
  - Top 10 developers by hours worked
  - Estimated vs. actual hours comparison
  - Meeting hours by type and by employee/team
  - Monthly meeting trends
  - Meeting distribution by day of week

---

## Technical Summary

| Aspect | Detail |
|--------|--------|
| **Runtime** | Node.js with Express web framework |
| **Database** | MongoDB (document database) |
| **Frontend** | Server-rendered HTML with vanilla JavaScript and Chart.js |
| **File Handling** | Excel import/export via ExcelJS, file uploads via Multer |
| **Dependencies** | 6 production packages (Express, Mongoose, EJS, ExcelJS, Multer, dotenv) |
| **API** | ~70 REST endpoints across 6 routers |
| **Hosting** | Self-hosted, single-server deployment |
| **Configuration** | 2 environment variables (port and database connection string) |

There is no frontend framework (React, Angular, etc.), no build step, and no external service dependencies beyond MongoDB. This keeps the deployment simple and the maintenance burden low.

---

## Architecture

```
                   Browser
                     |
              HTTP Requests
                     |
                     v
            +-----------------+
            |  Express Server |
            |  (Node.js)      |
            +--------+--------+
                     |
          +----------+----------+
          |                     |
    Page Routes           API Routes
    (EJS HTML)           (JSON Data)
          |                     |
          v                     v
    +----------+        +-------------+
    | Templates |        |  MongoDB    |
    | (9 views) |        |  (6 colls)  |
    +----------+        +-------------+
                              |
                     +--------+--------+
                     |                 |
               File Storage      Excel I/O
              (uploads dir)    (import/export)
```

### Data Collections

| Collection | Records | Purpose |
|------------|---------|---------|
| **tfstasks** | Core dataset | Tasks with embedded time entries, estimates, quality scores |
| **developers** | Derived | Developer profiles with aggregated statistics |
| **managertasks** | Independent | Manager-level task tracking with attachments |
| **meetings** | Independent | Meeting records with duration and type |
| **releases** | Independent | Software release versions with history |
| **appoptions** | Configuration | Editable dropdown values for all forms |

---

## Data Flow

### Import Pipeline

```
3e Excel Export  -->  Upload to ASD Tracker  -->  Parse timesheet rows
                                                        |
                                    Extract TFS IDs from narratives
                                                        |
                                    Group entries by task, aggregate hours
                                                        |
                                    Merge with scorebyTFS metadata
                                                        |
                                    Create/update task + developer records
```

### Estimation Pipeline

```
Tasks without estimates  -->  Group by developer/matter
                                       |
                              Calculate median + MAD per group
                                       |
                              Generate estimates (median + 0.5 * MAD)
                                       |
                              Ensure estimate >= actual hours
```

### Quality Pipeline

```
Tasks with estimates  -->  Calculate variance %
                                    |
                           Apply threshold scoring (2-5)
                                    |
                           Update quality field
```

---

## Project Structure

```
gpp/
├── server.js               # Application entry point
├── models/                 # 6 database schemas
│   ├── TfsTask.js          # Core task entity with time entries
│   ├── Developer.js        # Developer profiles
│   ├── ManagerTask.js      # Manager tasks with attachments
│   ├── Meeting.js          # Meeting records
│   ├── Release.js          # Release versions with history
│   └── AppOption.js        # Configurable dropdown values
├── routes/
│   ├── pages.js            # Page rendering (9 pages)
│   └── api/                # REST API (6 route files)
│       ├── tfs.js          # Task operations + analytics
│       ├── managertasks.js # Manager task operations
│       ├── meetings.js     # Meeting operations + analytics
│       ├── releases.js     # Release operations
│       ├── options.js      # Dropdown management
│       └── admin.js        # Database administration
├── services/
│   └── excelParser.js      # 3e Excel import logic
├── views/                  # HTML templates (self-contained)
├── public/                 # CSS design system + shared JS
└── uploads/                # File attachment storage
```

---

## Pages

| Page | Purpose |
|------|---------|
| **Dashboard** (`/`) | Summary stats and 8 interactive charts |
| **Tasks** (`/tasks`) | Task list with filtering, sorting, pagination, bulk operations |
| **Task Detail** (`/tasks/:id`) | Individual task with time entry breakdown |
| **Scorecard** (`/scorecard`) | Developer performance metrics and trend charts |
| **Meetings** (`/meetings`) | Meeting tracking with type/employee filtering |
| **Manager Tasks** (`/managertasks`) | Manager task board with status and quality tracking |
| **Releases** (`/releases`) | Release version tracking across environments |
| **Admin** (`/admin`) | Database management, dropdown configuration, import/export |

---

## Running the Application

```bash
npm install       # Install dependencies (one-time)
npm run dev       # Development mode (auto-reload on changes)
npm start         # Production mode
```

Requires Node.js and a running MongoDB instance. Configuration is handled by two environment variables in a `.env` file:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3000 | Server port |
| `MONGODB_URI` | `mongodb://localhost:27017/gpp_tfs_tracker` | Database connection |

On startup, the application automatically seeds default dropdown values (application names, task statuses, meeting types, employee names) if they don't already exist.

---

## Excel Import Specification

The import accepts an Excel workbook with two sheets:

### Sheet 1: "3e" (Timesheet Data)

| Column | Description |
|--------|-------------|
| TimekeeperNumber | Employee ID |
| FirstName / LastName | Employee name |
| Title | Job title |
| WorkDate | Date of work |
| WorkHrs | Hours worked (decimal) |
| TimecardNarrative | Work description (parsed for TFS task ID) |
| ActivityCode / ActivityCodeDesc | Activity classification |
| MatterNumber / MatterName | Billing matter reference |

### Sheet 2: "scorebyTFS" (Task Metadata)

| Column | Description |
|--------|-------------|
| ID | TFS task ID |
| Title | Task description |
| Estimated | Estimated hours |
| Quality | Quality score (1-5) |

### TFS ID Extraction

The parser identifies task IDs from narrative text using these patterns:

| Pattern | Example |
|---------|---------|
| "TFS Task XXXXX" | "TFS Task 19479 - Bug fix" |
| "TFS XXXXX" | "TFS 19455 development" |
| "Task XXXXX" | "Task 19532 complete" |
| "XXXXX - description" | "19542 - UI updates" |

Entries where no TFS ID can be extracted are flagged as orphaned work.

### Filtered Activities

Non-work activities are automatically excluded: PTO/Vacation, Holiday, Death in Family, Leave Without Pay, Administrative Shutdown.

---

## API Reference

### Task Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tfs` | List tasks (paginated, filterable, sortable) |
| GET | `/api/tfs/:id` | Single task detail |
| POST | `/api/tfs` | Create task |
| PUT | `/api/tfs/:id` | Update task |
| DELETE | `/api/tfs/:id` | Delete task |
| POST | `/api/tfs/import` | Import Excel workbook |
| GET | `/api/tfs/export/xlsx` | Export all tasks to Excel |
| GET | `/api/tfs/stats` | Summary statistics |
| GET | `/api/tfs/developers/scorecard` | Developer performance data |
| POST | `/api/tfs/calculate-estimates` | Run bell-curve estimation |
| POST | `/api/tfs/calculate-quality` | Run quality scoring |

### Meeting Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/meetings` | List meetings (paginated) |
| POST | `/api/meetings` | Create meeting |
| PUT | `/api/meetings/:id` | Update meeting |
| DELETE | `/api/meetings/:id` | Delete meeting |
| GET | `/api/meetings/stats` | Meeting statistics |

### Manager Task Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/managertasks` | List tasks (paginated) |
| POST | `/api/managertasks` | Create task |
| PUT | `/api/managertasks/:id` | Update task |
| DELETE | `/api/managertasks/:id` | Delete task |
| POST | `/api/managertasks/:id/attachments` | Upload files |

### Release Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/releases` | List releases |
| POST | `/api/releases` | Create release |
| PUT | `/api/releases/:id` | Update release |
| DELETE | `/api/releases/:id` | Delete release |
| GET | `/api/releases/:id/history` | View change history |
| POST | `/api/releases/:id/attachments` | Upload files |

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/collections` | List collections with counts |
| GET | `/api/admin/export/:collection` | Export collection as JSON |
| POST | `/api/admin/import/:collection` | Import JSON data |
| GET | `/api/options/:category` | Get dropdown values |
| PUT | `/api/options/:category` | Update dropdown values |

### Chart Endpoints

| Endpoint | Chart Type | Data |
|----------|------------|------|
| `/api/tfs/charts/task-status` | Doughnut | Needs Estimate / Needs Quality / Complete |
| `/api/tfs/charts/quality-distribution` | Bar | Tasks per quality score (1-5) |
| `/api/tfs/charts/hours-by-developer` | Horizontal Bar | Top 10 developers by hours |
| `/api/tfs/charts/estimate-accuracy` | Grouped Bar | Estimated vs. actual (last 20 tasks) |
| `/api/meetings/charts/by-type` | Doughnut | Meeting hours by type |
| `/api/meetings/charts/by-employee` | Horizontal Bar | Meeting hours by employee |
| `/api/meetings/charts/monthly-trend` | Dual-axis Line | Monthly meeting count and hours |
| `/api/meetings/charts/weekly-distribution` | Bar | Meeting hours by day of week |

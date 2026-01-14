# ASD Time Tracker

A corporate time tracking and analytics application for managing TFS tasks, developer scorecards, and meeting metrics.

## Table of Contents

- [Chart.js Measures](#chartjs-measures)
  - [Dashboard Task Analytics](#dashboard-task-analytics)
  - [Dashboard Meeting Analytics](#dashboard-meeting-analytics)
  - [Scorecard Charts](#scorecard-charts)
- [Data Loading Logic](#data-loading-logic)
  - [Task Data Loading](#task-data-loading)
  - [Meeting Data Loading](#meeting-data-loading)
  - [Chart Data Aggregation](#chart-data-aggregation)
- [Excel Import Requirements](#excel-import-requirements)
  - [Required Workbook Structure](#required-workbook-structure)
  - [Sheet 1: "3e" (Timesheet Data)](#sheet-1-3e-timesheet-data)
  - [Sheet 2: "scorebyTFS" (Task Metadata)](#sheet-2-scorebytfs-task-metadata)
  - [TFS ID Extraction Patterns](#tfs-id-extraction-patterns)
  - [Skipped Activities](#skipped-activities)
  - [Special Processing Rules](#special-processing-rules)

---

## Chart.js Measures

### Dashboard Task Analytics

The dashboard displays 4 task analytics charts loaded from `/api/tfs/charts/*` endpoints:

#### 1. Task Status Chart (Doughnut)

**Endpoint:** `/api/tfs/charts/task-status`

| Metric | Description |
|--------|-------------|
| Needs Estimate | Tasks with actual hours > 0 but no estimated hours set |
| Needs Quality | Tasks with estimated hours set but no quality score |
| Complete | Tasks with both estimated hours AND quality score assigned |

**Calculation:**
- Total tasks with `totalActualHours > 0`
- Tasks with estimates: `estimated !== null`
- Complete tasks: `estimated !== null AND quality !== null`
- Needs Estimate = Total - Tasks with estimates
- Needs Quality = Tasks with estimates - Complete

---

#### 2. Quality Distribution Chart (Bar)

**Endpoint:** `/api/tfs/charts/quality-distribution`

| Score | Label | Description |
|-------|-------|-------------|
| 1 | Poor | Lowest quality rating |
| 2 | Below Avg | Below average quality |
| 3 | Average | Meets expectations |
| 4 | Good | Above average quality |
| 5 | Excellent | Highest quality rating |

**Calculation:** Groups tasks by quality score (1-5) and counts tasks in each category. Only includes tasks where `quality !== null`.

---

#### 3. Hours by Developer Chart (Horizontal Bar)

**Endpoint:** `/api/tfs/charts/hours-by-developer`

| Metric | Description |
|--------|-------------|
| Developer Name | Full name (firstName + lastName) |
| Total Hours | Sum of all `workHrs` from time entries for this developer |

**Calculation:**
- Aggregates all time entries across all tasks
- Groups by developer name
- Sums hours per developer
- Returns top 10 developers sorted by hours descending

---

#### 4. Estimated vs Actual Hours Chart (Grouped Bar)

**Endpoint:** `/api/tfs/charts/estimate-accuracy`

| Metric | Color | Description |
|--------|-------|-------------|
| Estimated | Gold | Hours estimated for the task |
| Actual | Blue | Total actual hours worked (`totalActualHours`) |

**Calculation:**
- Filters tasks with both `estimated !== null` AND `totalActualHours > 0`
- Returns last 20 tasks (sorted by tfsId descending)
- Displays side-by-side comparison for estimation accuracy analysis

---

### Dashboard Meeting Analytics

The dashboard displays 4 meeting analytics charts loaded from `/api/meetings/charts/*` endpoints:

#### 1. Hours by Meeting Type (Doughnut)

**Endpoint:** `/api/meetings/charts/by-type`

| Meeting Type | Description |
|--------------|-------------|
| 1:1 | One-on-one meetings |
| ASD Standup | Daily standup meetings |
| ASD Monthly | Monthly team meetings |
| Requirements | Requirements gathering sessions |
| Leadership | Leadership/management meetings |
| Steering | Steering committee meetings |
| Design | Design review sessions |

**Calculation:** Groups all meetings by type, sums `meetingDuration` for each type.

---

#### 2. Hours by Employee/Team (Horizontal Bar)

**Endpoint:** `/api/meetings/charts/by-employee`

| Employee/Team | Description |
|---------------|-------------|
| ASD | ASD team meetings |
| Kevin Crabb | Individual employee |
| Jason Fleming | Individual employee |
| Miriah Pooler | Individual employee |
| Curtis Smith | Individual employee |
| Claus Michelsen | Individual employee |
| Amy Lake | Individual employee |
| Sales | Sales team |
| Project Team | Project team meetings |

**Calculation:** Groups meetings by employee field, sums `meetingDuration` and counts meetings per employee.

---

#### 3. Monthly Meeting Trend (Dual-axis Line)

**Endpoint:** `/api/meetings/charts/monthly-trend`

| Metric | Axis | Description |
|--------|------|-------------|
| Hours | Left Y-axis | Total meeting hours per month |
| Count | Right Y-axis | Number of meetings per month |

**Calculation:**
- Extracts year and month from meeting dates
- Groups by year-month combination
- Sums hours and counts meetings per month
- Sorted chronologically

---

#### 4. Meetings by Day of Week (Bar)

**Endpoint:** `/api/meetings/charts/weekly-distribution`

| Day | Description |
|-----|-------------|
| Sun | Sunday (day 1) |
| Mon | Monday (day 2) |
| Tue | Tuesday (day 3) |
| Wed | Wednesday (day 4) |
| Thu | Thursday (day 5) |
| Fri | Friday (day 6) |
| Sat | Saturday (day 7) |

**Calculation:** Extracts day of week from meeting dates, groups and sums hours per day.

---

### Scorecard Charts

The developer scorecard page displays performance charts:

#### 1. Developer Mini Sparkline Charts (Line)

Small charts embedded in each developer card showing quarterly performance.

| Metric | Style | Description |
|--------|-------|-------------|
| Total Hours | Solid line | Hours worked per quarter |
| Admin Hours | Dashed line | Administrative hours (TFS ID 7300) per quarter |

---

#### 2. Hours Comparison Chart (Horizontal Bar)

| Metric | Description |
|--------|-------------|
| Developer | Top 10 developers by hours |
| Hours | Total hours worked |

**Sorting:** Descending by total hours.

---

#### 3. Quality Scores Comparison (Horizontal Bar)

| Metric | Color Coding | Description |
|--------|--------------|-------------|
| Average Quality >= 4 | Green | Good to excellent quality |
| Average Quality >= 3 | Orange | Average quality |
| Average Quality < 3 | Red | Below average quality |

**Calculation:** Average of all quality scores per developer.

---

#### 4. Quarterly Workload Trends (Multi-line)

| Metric | Style | Description |
|--------|-------|-------------|
| Developer Hours | Solid colored lines | Top 5 developers' quarterly hours |
| Team Admin | Dashed gray line | Team admin hours (TFS ID 7300) |

**X-axis Labels:** Quarter format (Q1 2025, Q2 2025, etc.)

---

## Data Loading Logic

### Task Data Loading

**Endpoint:** `GET /api/tfs`

**Query Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number for pagination |
| `limit` | 25 | Tasks per page |
| `search` | - | Search by TFS ID (numeric) or title/developer name (text) |
| `filter` | all | Filter type (see below) |
| `sortField` | tfsId | Sort field |
| `sortOrder` | desc | Sort direction (asc/desc) |
| `year` | - | Filter by year of time entries |

**Filter Values:**

| Filter | Criteria | Description |
|--------|----------|-------------|
| `all` | No filter applied | Shows all tasks in the system regardless of completion status. Use this to see the complete task list. |
| `needsEstimate` | `estimated === null AND totalActualHours > 0` | Tasks that have logged work hours but no estimate has been entered. These tasks need an estimate to be added so variance can be calculated. Typically used during sprint planning or retrospectives to ensure all worked tasks have estimates. |
| `needsQuality` | `quality === null AND estimated !== null` | Tasks that have an estimate but are missing a quality score. These tasks have been estimated but not yet reviewed for quality. Use this filter to find tasks awaiting quality assessment after completion. |
| `complete` | `estimated !== null AND quality !== null` | Fully completed tasks with both an estimate and quality score assigned. These tasks are ready for reporting and metrics analysis. The "complete" status indicates all required fields are filled. |
| `noActual` | `totalActualHours === 0 OR totalActualHours === null` | Tasks with no developer time entries logged. These may be placeholder tasks, tasks imported from the scorebyTFS sheet without matching timesheet data, or tasks created manually that haven't been worked yet. |

**Response Structure:**

```json
{
  "tasks": [
    {
      "tfsId": 12345,
      "title": "Task description",
      "estimated": 8,
      "quality": 4,
      "totalActualHours": 7.5,
      "developers": ["John Doe", "Jane Smith"]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 150,
    "pages": 6
  }
}
```

---

### Meeting Data Loading

**Endpoint:** `GET /api/meetings`

**Query Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number |
| `limit` | 25 | Meetings per page |
| `type` | - | Filter by meeting type |
| `search` | - | Search in summary text |
| `sortField` | date | Sort field |
| `sortOrder` | desc | Sort direction |

---

### Chart Data Aggregation

All chart endpoints use MongoDB aggregation pipelines:

**Quality Distribution Pipeline:**
```javascript
[
  { $match: { quality: { $ne: null } } },
  { $group: { _id: "$quality", count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]
```

**Hours by Developer Pipeline:**
```javascript
[
  { $unwind: "$timeEntries" },
  { $group: {
      _id: { $concat: ["$timeEntries.firstName", " ", "$timeEntries.lastName"] },
      hours: { $sum: "$timeEntries.workHrs" }
  }},
  { $sort: { hours: -1 } },
  { $limit: 10 }
]
```

---

## Excel Import Requirements

### Required Workbook Structure

The import requires an Excel file (`.xlsx` or `.xls`) with exactly two sheets:

| Sheet Name | Purpose |
|------------|---------|
| `3e` | Timesheet/time entry data |
| `scorebyTFS` | Task metadata (estimates and quality scores) |

---

### Sheet 1: "3e" (Timesheet Data)

This sheet contains raw timesheet entries. **All columns are required.**

| Column Name | Data Type | Description | Example |
|-------------|-----------|-------------|---------|
| `TimekeeperNumber` | Number | Unique employee identifier | 12345 |
| `FirstName` | Text | Employee first name | John |
| `LastName` | Text | Employee last name | Doe |
| `Title` | Text | Employee job title | Developer |
| `WorkDate` | Date | Date work was performed | 2025-01-15 |
| `WorkHrs` | Number | Hours worked (decimal) | 2.5 |
| `TimecardNarrative` | Text | Work description (contains TFS ID) | "TFS Task 19479 - Bug fix" |
| `ActivityCode` | Text | Activity type code | DEV |
| `ActivityCodeDesc` | Text | Activity description | Development |
| `MatterNumber` | Text | Alternative task ID (fallback) | PROJ-001 |
| `MatterName` | Text | Alternative task name | Project Alpha |

**Important Notes:**
- The first row must be column headers (exact names as shown above)
- `WorkDate` can be Excel date format or text date
- `TimecardNarrative` is parsed to extract TFS ID (see patterns below)
- If no TFS ID is found in narrative, `MatterNumber` is used as fallback

---

### Sheet 2: "scorebyTFS" (Task Metadata)

This sheet contains task estimates and quality scores.

| Column Name | Data Type | Required | Description | Example |
|-------------|-----------|----------|-------------|---------|
| `ID` | Number | Yes | TFS Task ID | 19479 |
| `Title` | Text | No | Task description | Fix login bug |
| `Estimated` | Number | No | Estimated hours | 8 |
| `Quality` | Number | No | Quality score (1-5) | 4 |

**Important Notes:**
- `ID` must match TFS IDs extracted from the "3e" sheet
- `Estimated` should be a positive number or empty/null
- `Quality` must be 1, 2, 3, 4, or 5 (or empty/null)
- Rows with missing `ID` are skipped

---

### TFS ID Extraction Patterns

The parser extracts TFS IDs from the `TimecardNarrative` column using these patterns (in priority order):

| Pattern | Example | Extracted ID |
|---------|---------|--------------|
| `TFS Task XXXXX` | "TFS Task 19479 - Bug fix" | 19479 |
| `TFS XXXXX` | "TFS 19455 development" | 19455 |
| `Task XXXXX` | "Task 19532 complete" | 19532 |
| `XXXXX - description` | "19542 - UI updates" | 19542 |
| `<tag>XXXXX</tag>` | "`<task>19542</task>`" | 19542 |

**Rules:**
- Pattern matching is case-insensitive
- Only 5-digit numbers are matched (XXXXX)
- First matching pattern wins
- If no pattern matches, `MatterNumber` is used as the task identifier

---

### Skipped Activities

The following activity types are automatically excluded from import:

| Activity Description | Reason |
|---------------------|--------|
| PTO/Vacation | Non-work time |
| Holiday | Non-work time |
| Death in Family | Leave time |
| Leave Without Pay | Leave time |
| Administrative Shutdown | Non-work time |

Matching is case-insensitive and checks the `ActivityCodeDesc` column.

---

### Special Processing Rules

#### Miriah Pooler Auto-Assignment

When a task has time entries from Miriah Pooler:
- If `quality` is null, it is automatically set to **4**
- If `estimated` is null, it is automatically set to `totalActualHours`

#### TFS ID Not Entered Flag

Tasks where the TFS ID came from `MatterNumber` (not from narrative) are marked with `[TFS ID Not Entered]` prefix in the title.

#### Data Merging Logic

When importing:
1. Timesheet data ("3e") is parsed first
2. Score data ("scorebyTFS") is parsed second
3. Records are matched by TFS ID
4. For matching records:
   - Title is updated from score data if better
   - `estimated` and `quality` are added from score data
5. Orphan score records (no timesheet entries) are added as empty tasks
6. All data is sorted by TFS ID descending

#### Import Modes

| Mode | Behavior |
|------|----------|
| Standard Import | Upserts tasks (creates new, updates existing) |
| Clear & Import | Deletes ALL existing tasks and developers before import |

**Upsert Behavior:**
- If task exists: Updates title, estimated, quality, merges time entries
- If task is new: Creates new task record
- Developer statistics are recalculated after import

---

## Data Models

### TfsTask Schema

```javascript
{
  tfsId: Number,           // Unique task identifier (required, indexed)
  title: String,           // Task description
  application: String,     // Software application name
  estimated: Number,       // Estimated hours (min: 0)
  quality: Number,         // Quality score (1-5)
  timeEntries: [{          // Array of work time entries
    timekeeperNumber: Number,
    firstName: String,
    lastName: String,
    title: String,
    workDate: Date,
    workHrs: Number,
    narrative: String,
    activityCode: String
  }],
  totalActualHours: Number,  // Calculated sum of all workHrs
  developerBreakdown: Map    // { developerName: hours }
}
```

### Meeting Schema

```javascript
{
  date: Date,              // Meeting date (required)
  type: String,            // Meeting type enum (required)
  employee: String,        // Employee/team enum (required)
  meetingDuration: Number, // Duration in hours (required, min: 0)
  summary: String          // Meeting notes/summary
}
```

---

## API Endpoints Reference

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tfs` | List tasks (paginated) |
| GET | `/api/tfs/:id` | Get single task |
| POST | `/api/tfs` | Create task |
| PUT | `/api/tfs/:id` | Update task |
| DELETE | `/api/tfs/:id` | Delete task |
| POST | `/api/tfs/import` | Import Excel file |
| GET | `/api/tfs/export/xlsx` | Export to Excel |
| GET | `/api/tfs/stats` | Dashboard statistics |
| GET | `/api/tfs/years` | Available years |
| GET | `/api/tfs/developers/scorecard` | Developer scorecard data |

### Meetings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/meetings` | List meetings (paginated) |
| GET | `/api/meetings/:id` | Get single meeting |
| POST | `/api/meetings` | Create meeting |
| PUT | `/api/meetings/:id` | Update meeting |
| DELETE | `/api/meetings/:id` | Delete meeting |

### Charts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tfs/charts/task-status` | Task status distribution |
| GET | `/api/tfs/charts/quality-distribution` | Quality score distribution |
| GET | `/api/tfs/charts/hours-by-developer` | Hours per developer |
| GET | `/api/tfs/charts/estimate-accuracy` | Estimated vs actual hours |
| GET | `/api/meetings/charts/by-type` | Meeting hours by type |
| GET | `/api/meetings/charts/by-employee` | Meeting hours by employee |
| GET | `/api/meetings/charts/monthly-trend` | Monthly meeting trends |
| GET | `/api/meetings/charts/weekly-distribution` | Meetings by day of week |

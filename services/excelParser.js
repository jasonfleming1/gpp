const ExcelJS = require('exceljs');
const path = require('path');

class ExcelParser {
  constructor(filePath) {
    this.filePath = filePath;
    this.workbook = null;
  }

  async load() {
    this.workbook = new ExcelJS.Workbook();
    await this.workbook.xlsx.readFile(this.filePath);
    return this;
  }

  getSheetNames() {
    return this.workbook.worksheets.map(ws => ws.name);
  }

  parseSheet(sheetName) {
    const sheet = this.workbook.getWorksheet(sheetName);
    if (!sheet) return [];

    const rows = [];
    const headers = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        // First row is headers
        row.eachCell((cell, colNumber) => {
          headers[colNumber] = cell.value;
        });
      } else {
        // Data rows
        const rowData = {};
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber];
          if (header) {
            rowData[header] = cell.value;
          }
        });
        if (Object.keys(rowData).length > 0) {
          rows.push(rowData);
        }
      }
    });

    return rows;
  }

  // Activity codes to skip (non-work entries)
  static SKIP_ACTIVITIES = [
    'PTO/Vacation',
    'Holiday',
    'Death in Family',
    'Leave Without Pay',
    'Administrative Shutdown'
  ];

  // Check if activity should be skipped
  shouldSkipActivity(activityCodeDesc) {
    if (!activityCodeDesc) return false;
    const desc = activityCodeDesc.toLowerCase();
    return ExcelParser.SKIP_ACTIVITIES.some(skip =>
      desc.includes(skip.toLowerCase())
    );
  }

  // Extract TFS ID from narrative text
  // Patterns: "TFS Task 19479", "TFS 19455", "Task 19532", "19542 - description", "^ 19626"
  extractTfsId(narrative) {
    if (!narrative) return null;

    const patterns = [
      /TFS\s*Task\s*(\d+)/i,    // TFS Task 19479
      /TFS\s+(\d+)/i,           // TFS 19455
      /Task\s+(\d+)/i,          // Task 19532
      /^(\d{5})\s*[-–]/,        // 19542 - description (5 digit ID at start)
      /\^\s*(\d{5})(?:\s|[A-Za-z]|$)/, // ^ 19626 or ^19591Update (ID after caret, followed by space, letter, or end)
      />\s*\^\s*(\d{5})(?:\s|[A-Za-z]|$)/, // </p>^ 19626 (ID after closing tag and caret)
      /(?:^|[>\s])(\d{5})\s+\w/  // Standalone 5-digit ID followed by text (fallback)
    ];

    for (const pattern of patterns) {
      const match = narrative.match(pattern);
      if (match) {
        const id = parseInt(match[1], 10);
        // Validate it looks like a TFS ID (5 digits, typically 19xxx range)
        if (id >= 10000 && id <= 99999) {
          return id;
        }
      }
    }

    return null;
  }

  // Parse the 3e timesheet data
  // Grouping rules:
  // 1. TFS ID entries: Group by TFS ID + Developer (one task per developer per TFS ID)
  // 2. Non-TFS entries: Group by Developer + Date (one task per developer per day)
  parseTimesheetData() {
    const data = this.parseSheet('3e');
    const taskMap = new Map();
    let generatedIdCounter = -1; // Negative IDs for generated task IDs

    // Track which TFS IDs have multiple developers (for ID generation)
    const tfsDevCount = new Map(); // tfsId -> Set of developer names

    // First pass: count developers per TFS ID
    data.forEach(row => {
      if (this.shouldSkipActivity(row.ActivityCodeDesc)) return;
      if (row.FirstName === 'Miriah' && row.LastName === 'Pooler') return;

      const tfsId = this.extractTfsId(row.TimecardNarrative);
      if (tfsId) {
        if (!tfsDevCount.has(tfsId)) tfsDevCount.set(tfsId, new Set());
        tfsDevCount.get(tfsId).add(`${row.FirstName} ${row.LastName}`);
      }
    });

    // Second pass: create tasks
    data.forEach(row => {
      // Skip PTO, Holiday, and other non-work entries
      if (this.shouldSkipActivity(row.ActivityCodeDesc)) {
        return;
      }

      // Skip Miriah Pooler's time entries
      if (row.FirstName === 'Miriah' && row.LastName === 'Pooler') {
        return;
      }

      const devName = `${row.FirstName} ${row.LastName}`;
      const dateStr = this.parseExcelDate(row.WorkDate)?.toISOString().split('T')[0] || '';

      // Try to extract TFS ID from narrative
      let tfsId = this.extractTfsId(row.TimecardNarrative);
      let mapKey;
      let taskId;
      let title = '';
      let tfsIdNotEntered = false;
      let originalTfsId = null; // Store original TFS ID for reference

      if (tfsId) {
        const devCount = tfsDevCount.get(tfsId)?.size || 1;
        if (devCount === 1) {
          // Single developer - use TFS ID directly
          mapKey = `tfs-${tfsId}`;
          taskId = tfsId;
        } else {
          // Multiple developers - generate unique ID per developer, store original TFS ID
          mapKey = `tfs-${tfsId}-${devName}`;
          originalTfsId = tfsId;
          taskId = generatedIdCounter--;
          title = `[TFS ${tfsId}] - ${devName}`;
        }
      } else {
        // No TFS ID - each entry becomes its own task (no grouping)
        // This preserves activity type granularity for reporting
        mapKey = `orphan-${generatedIdCounter}`;
        taskId = generatedIdCounter--;
        title = `${row.MatterName || 'Unknown'} - ${devName} (${dateStr})`;
        tfsIdNotEntered = true;
      }

      if (!taskMap.has(mapKey)) {
        taskMap.set(mapKey, {
          tfsId: taskId,
          originalTfsId, // Reference to original TFS ID when split by developer
          title,
          tfsIdNotEntered,
          matterNumber: row.MatterNumber,
          timeEntries: [],
          totalActualHours: 0,
          developerBreakdown: new Map(),
          developerBreakdownByDate: new Map()
        });
      }

      const task = taskMap.get(mapKey);
      // Update title if we have a better one
      if (!task.title && row.MatterName) {
        task.title = row.MatterName;
      }

      const parsedDate = this.parseExcelDate(row.WorkDate);
      const dateOnly = parsedDate ? parsedDate.toISOString().split('T')[0] : null;

      const entry = {
        timekeeperNumber: row.TimekeeperNumber,
        lastName: row.LastName,
        firstName: row.FirstName,
        title: row.Title,
        workDate: parsedDate,
        workDateOnly: dateOnly,
        workHrs: row.WorkHrs || 0,
        narrative: row.TimecardNarrative,
        activityCode: row.ActivityCode,
        activityCodeDesc: row.ActivityCodeDesc
      };

      task.timeEntries.push(entry);
      task.totalActualHours += entry.workHrs;

      const devKey = `${entry.firstName} ${entry.lastName}`;
      task.developerBreakdown.set(
        devKey,
        (task.developerBreakdown.get(devKey) || 0) + entry.workHrs
      );

      // Build per-date breakdown
      if (dateOnly) {
        if (!task.developerBreakdownByDate.has(devKey)) {
          task.developerBreakdownByDate.set(devKey, {});
        }
        const devDates = task.developerBreakdownByDate.get(devKey);
        devDates[dateOnly] = (devDates[dateOnly] || 0) + entry.workHrs;
      }
    });

    return Array.from(taskMap.values());
  }

  // Parse scorebyTFS sheet for existing TFS tasks with titles
  parseTfsScoreData() {
    const data = this.parseSheet('scorebyTFS');
    return data.map(row => ({
      tfsId: row.ID,
      title: row.Title || '',
      estimated: row.Estimated || null,
      quality: row.Quality || null
    })).filter(item => item.tfsId);
  }

  // Merge timesheet data with TFS score data
  getMergedData() {
    const timesheetData = this.parseTimesheetData();
    const scoreData = this.parseTfsScoreData();

    // Create a map of score data by TFS ID
    const scoreMap = new Map(scoreData.map(s => [s.tfsId, s]));

    // Merge timesheet data with score data
    const merged = timesheetData.map(task => {
      const score = scoreMap.get(task.tfsId);
      if (score) {
        task.title = score.title || task.title;
        task.estimated = score.estimated;
        task.quality = score.quality;
        scoreMap.delete(task.tfsId);
      }
      return task;
    });

    // Add any TFS tasks from score sheet that weren't in timesheet data
    scoreMap.forEach((score, tfsId) => {
      merged.push({
        tfsId,
        title: score.title,
        estimated: score.estimated,
        quality: score.quality,
        timeEntries: [],
        totalActualHours: 0,
        developerBreakdown: new Map(),
        developerBreakdownByDate: new Map()
      });
    });

    return merged.sort((a, b) => b.tfsId - a.tfsId);
  }

  parseExcelDate(excelDate) {
    if (!excelDate) return null;
    if (excelDate instanceof Date) return excelDate;
    if (typeof excelDate === 'string') return new Date(excelDate);
    // Excel serial date number
    const date = new Date((excelDate - 25569) * 86400 * 1000);
    return date;
  }
}

module.exports = ExcelParser;

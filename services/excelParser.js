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
      /\^\s*(\d{5})\b/,         // ^ 19626 or ^19626 (ID after caret)
      />\s*\^\s*(\d{5})\b/,     // </p>^ 19626 (ID after closing tag and caret)
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

  // Parse the 3e timesheet data and group by TFS ID
  // Non-TFS entries (no TFS ID found) become standalone tasks with unique negative IDs
  parseTimesheetData() {
    const data = this.parseSheet('3e');
    const taskMap = new Map();
    let standaloneCounter = -1; // Negative IDs for non-TFS entries

    data.forEach(row => {
      // Skip PTO, Holiday, and other non-work entries
      if (this.shouldSkipActivity(row.ActivityCodeDesc)) {
        return;
      }

      // Skip Miriah Pooler's time entries
      if (row.FirstName === 'Miriah' && row.LastName === 'Pooler') {
        return;
      }

      // Try to extract TFS ID
      let taskId = this.extractTfsId(row.TimecardNarrative);
      let title = '';
      let tfsIdNotEntered = false;

      if (!taskId) {
        // No TFS ID found - create standalone entry with unique negative ID
        taskId = standaloneCounter--;
        title = row.MatterName || '';
        tfsIdNotEntered = true;

        // For standalone entries, include developer and date in title for clarity
        const devName = `${row.FirstName} ${row.LastName}`;
        const dateStr = this.parseExcelDate(row.WorkDate)?.toISOString().split('T')[0] || '';
        title = `${title} - ${devName} (${dateStr})`.trim();
      }

      if (!taskId) return;

      if (!taskMap.has(taskId)) {
        taskMap.set(taskId, {
          tfsId: taskId,
          title,
          tfsIdNotEntered,
          matterNumber: row.MatterNumber, // Preserve original matter number
          timeEntries: [],
          totalActualHours: 0,
          developerBreakdown: new Map(),
          developerBreakdownByDate: new Map()
        });
      }

      const task = taskMap.get(taskId);
      // Update title if we have a better one (MatterName for non-TFS entries)
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

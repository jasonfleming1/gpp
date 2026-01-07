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
  // Patterns: "TFS Task 19479", "TFS 19455", "Task 19532", "19542 - description"
  extractTfsId(narrative) {
    if (!narrative) return null;

    const patterns = [
      /TFS\s*Task\s*(\d+)/i,    // TFS Task 19479
      /TFS\s+(\d+)/i,           // TFS 19455
      /Task\s+(\d+)/i,          // Task 19532
      /^(\d{5})\s*[-–]/,        // 19542 - description (5 digit ID at start)
      /<[^>]*>.*?(\d{5})/       // ID inside HTML tags
    ];

    for (const pattern of patterns) {
      const match = narrative.match(pattern);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    return null;
  }

  // Parse the 3e timesheet data and group by TFS ID or MatterNumber
  parseTimesheetData() {
    const data = this.parseSheet('3e');
    const taskMap = new Map();

    data.forEach(row => {
      // Skip PTO, Holiday, and other non-work entries
      if (this.shouldSkipActivity(row.ActivityCodeDesc)) {
        return;
      }

      // Try to extract TFS ID first, fall back to MatterNumber
      let taskId = this.extractTfsId(row.TimecardNarrative);
      let title = '';
      let tfsIdNotEntered = false;

      if (!taskId) {
        // Use MatterNumber as the task ID for non-TFS entries
        taskId = row.MatterNumber;
        title = row.MatterName || '';
        tfsIdNotEntered = true;
      }

      if (!taskId) return;

      if (!taskMap.has(taskId)) {
        taskMap.set(taskId, {
          tfsId: taskId,
          title,
          tfsIdNotEntered,
          timeEntries: [],
          totalActualHours: 0,
          developerBreakdown: new Map()
        });
      }

      const task = taskMap.get(taskId);
      // Update title if we have a better one (MatterName for non-TFS entries)
      if (!task.title && row.MatterName) {
        task.title = row.MatterName;
      }

      const entry = {
        timekeeperNumber: row.TimekeeperNumber,
        lastName: row.LastName,
        firstName: row.FirstName,
        title: row.Title,
        workDate: this.parseExcelDate(row.WorkDate),
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
        developerBreakdown: new Map()
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

const express = require('express');
const router = express.Router();
const multer = require('multer');
const TfsTask = require('../../models/TfsTask');
const Developer = require('../../models/Developer');
const ExcelParser = require('../../services/excelParser');
const path = require('path');
const fs = require('fs');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'import_' + Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================
// HELPER FUNCTIONS FOR BELL CURVE CALCULATIONS
// ============================================

// Get primary developer (one with most hours) from a task
function getPrimaryDeveloper(task) {
  if (!task.developerBreakdown || Object.keys(task.developerBreakdown).length === 0) {
    return 'Unknown';
  }
  const breakdown = task.developerBreakdown instanceof Map
    ? Object.fromEntries(task.developerBreakdown)
    : task.developerBreakdown;
  const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

// Helper to calculate median
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Calculate estimates for tasks without estimates using median (reduces outlier impact)
async function calculateBellCurveEstimates(groupBy = 'developer') {
  const tasks = await TfsTask.find({
    totalActualHours: { $gt: 0 },
    $or: [{ estimated: null }, { estimated: { $exists: false } }]
  });

  if (tasks.length === 0) {
    return { updated: 0, groups: 0 };
  }

  // Group tasks
  const groups = new Map();
  tasks.forEach(task => {
    const key = groupBy === 'matter'
      ? (task.matterNumber || 'Unknown')
      : getPrimaryDeveloper(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  });

  // Calculate stats and update using median instead of mean
  let updated = 0;
  for (const [key, groupTasks] of groups) {
    const actuals = groupTasks.map(t => t.totalActualHours);
    const med = median(actuals);

    // Calculate MAD (Median Absolute Deviation) - more robust than std dev
    const deviations = actuals.map(v => Math.abs(v - med));
    const mad = median(deviations);

    // Estimate = median + small buffer (0.5 * MAD)
    // Round to whole number, but for 100+ round UP to nearest 10
    const raw = med + 0.5 * mad;
    const estimate = raw >= 100 ? Math.ceil(raw / 10) * 10 : Math.round(raw) || 1;

    for (const task of groupTasks) {
      // Estimate should be at least equal to actual hours
      task.estimated = Math.max(estimate, Math.ceil(task.totalActualHours));
      task.estimateSource = 'bell-curve';
      task.estimateGroup = key;
      await task.save();
      updated++;
    }
  }

  return { updated, groups: groups.size };
}

// Calculate quality based on absolute variance thresholds
// 3 = meets expectation (on target), 1-2 = over budget, 4-5 = under budget
async function calculateBellCurveQuality() {
  const tasks = await TfsTask.find({
    totalActualHours: { $gt: 0 },
    estimated: { $ne: null, $gt: 0 },
    $or: [{ quality: null }, { quality: { $exists: false } }]
  });

  if (tasks.length === 0) {
    return { updated: 0 };
  }

  let updated = 0;
  for (const task of tasks) {
    const variancePercent = (task.totalActualHours - task.estimated) / task.estimated;

    // Adjusted thresholds - 3 (average) should be most common
    // Tighter bands for 5 and 2, no 1s
    let quality;
    if (variancePercent <= -0.25) {
      quality = 5; // 25%+ under budget - excellent (rare)
    } else if (variancePercent <= -0.10) {
      quality = 4; // 10-25% under budget - good
    } else if (variancePercent <= 0.25) {
      quality = 3; // Within 25% over or 10% under - meets expectation (most common)
    } else {
      quality = 2; // More than 25% over budget (handful, no 1s)
    }

    task.quality = quality;
    await task.save();
    updated++;
  }

  return { updated };
}

// Fix estimates that are less than actual hours
async function fixLowEstimates() {
  const tasks = await TfsTask.find({
    totalActualHours: { $gt: 0 },
    estimated: { $ne: null },
    $expr: { $lt: ['$estimated', '$totalActualHours'] }
  });

  let fixed = 0;
  for (const task of tasks) {
    task.estimated = Math.ceil(task.totalActualHours);
    await task.save();
    fixed++;
  }

  return { fixed };
}

// ============================================
// STATIC ROUTES FIRST (before :id param routes)
// ============================================

// GET /api/tfs - Get all TFS tasks with pagination and sorting
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const filter = req.query.filter || 'all';
    const sortField = req.query.sortField || 'tfsId';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const year = req.query.year ? parseInt(req.query.year) : null;

    let query = {};

    // Year filter - match tasks with time entries in the specified year
    if (year) {
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
      query['timeEntries.workDate'] = { $gte: startOfYear, $lte: endOfYear };
    }

    if (search) {
      const searchNum = parseInt(search);
      const searchRegex = { $regex: search, $options: 'i' };
      if (!isNaN(searchNum)) {
        query.$or = [
          { tfsId: searchNum },
          { title: searchRegex },
          { 'timeEntries.firstName': searchRegex },
          { 'timeEntries.lastName': searchRegex }
        ];
      } else {
        query.$or = [
          { title: searchRegex },
          { 'timeEntries.firstName': searchRegex },
          { 'timeEntries.lastName': searchRegex }
        ];
      }
    }

    if (filter === 'needsEstimate') {
      query.$and = query.$and || [];
      query.$and.push(
        { $or: [{ estimated: null }, { estimated: { $exists: false } }] },
        { totalActualHours: { $gt: 0 } }
      );
    } else if (filter === 'needsQuality') {
      query.$and = query.$and || [];
      query.$and.push(
        { $or: [{ quality: null }, { quality: { $exists: false } }] },
        { totalActualHours: { $gt: 0 } }
      );
    } else if (filter === 'complete') {
      query.estimated = { $ne: null, $exists: true };
      query.quality = { $ne: null, $exists: true };
    } else if (filter === 'orphanedEntries') {
      // Tasks where TFS ID was not entered (negative ID or flag set)
      query.$or = [
        { tfsId: { $lt: 0 } },
        { tfsIdNotEntered: true }
      ];
    } else if (filter === 'orphanedTasks') {
      // Tasks with no time entries (0 actuals) but have valid positive IDs
      query.$and = query.$and || [];
      query.$and.push(
        { $or: [
          { totalActualHours: { $eq: 0 } },
          { totalActualHours: { $exists: false } },
          { timeEntries: { $size: 0 } },
          { timeEntries: { $exists: false } }
        ]},
        { tfsId: { $gte: 0 } },
        { tfsIdNotEntered: { $ne: true } }
      );
    }

    // Map dateRange sort to firstDate (ascending) or lastDate (descending)
    // Ascending: oldest work first (by firstDate)
    // Descending: most recent activity first (by lastDate)
    const actualSortField = sortField === 'dateRange'
      ? (sortOrder === 1 ? 'firstDate' : 'lastDate')
      : sortField;
    const sort = {};
    sort[actualSortField] = sortOrder;

    // For orphanedEntries with developer sort, fetch all and sort in JS (no pagination needed)
    const sortByDeveloperInMemory = filter === 'orphanedEntries' && sortField === 'developers';

    let tasks, total;
    if (sortByDeveloperInMemory) {
      tasks = await TfsTask.find(query).lean();
      total = tasks.length;
    } else {
      [tasks, total] = await Promise.all([
        TfsTask.find(query).sort(sort).skip(skip).limit(limit).lean(),
        TfsTask.countDocuments(query)
      ]);
    }

    let tasksWithDevs = tasks.map(task => {
      const devNames = [];
      if (task.developerBreakdown) {
        Object.keys(task.developerBreakdown).forEach(name => devNames.push(name));
      }

      // Use stored firstDate/lastDate, or calculate from time entries if not present
      let firstDate = task.firstDate;
      let lastDate = task.lastDate;
      if (!firstDate && task.timeEntries && task.timeEntries.length > 0) {
        const dates = task.timeEntries
          .map(e => e.workDateOnly || (e.workDate ? new Date(e.workDate).toISOString().split('T')[0] : null))
          .filter(d => d)
          .sort();
        if (dates.length > 0) {
          firstDate = dates[0];
          lastDate = dates[dates.length - 1];
        }
      }

      return { ...task, developers: devNames, firstDate, lastDate };
    });

    // Sort by developer name in memory for orphanedEntries
    if (sortByDeveloperInMemory) {
      tasksWithDevs.sort((a, b) => {
        const devA = a.developers[0] || '';
        const devB = b.developers[0] || '';
        return sortOrder === 1
          ? devA.localeCompare(devB)
          : devB.localeCompare(devA);
      });
    }

    res.json({
      tasks: tasksWithDevs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tfs - Create a new task
router.post('/', async (req, res) => {
  try {
    const { tfsId, title, estimated, quality, actualHours, developers, workDate } = req.body;

    if (!tfsId) {
      return res.status(400).json({ error: 'ASD ID is required' });
    }

    // Check if task already exists
    const existing = await TfsTask.findOne({ tfsId: parseInt(tfsId) });
    if (existing) {
      return res.status(400).json({ error: 'A task with this ASD ID already exists' });
    }

    // Parse work date or default to today
    const entryDate = workDate ? new Date(workDate) : new Date();

    // Build time entries and developer breakdown from developers array
    const timeEntries = [];
    const developerBreakdown = {};
    const developerBreakdownByDate = {};
    let totalActualHours = 0;
    const dateOnly = entryDate.toISOString().split('T')[0];

    if (developers && Array.isArray(developers)) {
      developers.forEach(dev => {
        if (dev.name && dev.hours > 0) {
          const nameParts = dev.name.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';

          timeEntries.push({
            timekeeperNumber: 0,
            firstName,
            lastName,
            title: '',
            workDate: entryDate,
            workDateOnly: dateOnly,
            workHrs: dev.hours,
            narrative: 'Manually entered',
            activityCode: '',
            activityCodeDesc: ''
          });

          developerBreakdown[dev.name] = dev.hours;
          developerBreakdownByDate[dev.name] = { [dateOnly]: dev.hours };
          totalActualHours += dev.hours;
        }
      });
    }

    // Use provided actualHours or sum from developers
    const finalActualHours = actualHours ? parseFloat(actualHours) : totalActualHours;

    const task = await TfsTask.create({
      tfsId: parseInt(tfsId),
      title: title?.trim() || null,
      estimated: estimated ? parseFloat(estimated) : null,
      quality: quality ? parseInt(quality) : null,
      timeEntries,
      totalActualHours: finalActualHours,
      developerBreakdown,
      developerBreakdownByDate
    });

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/stats - Get summary statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await TfsTask.getSummaryStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/years - Get distinct years from time entries
router.get('/years', async (req, res) => {
  try {
    const years = await TfsTask.aggregate([
      { $unwind: '$timeEntries' },
      { $group: { _id: { $year: '$timeEntries.workDate' } } },
      { $sort: { _id: -1 } }
    ]);
    res.json(years.map(y => y._id).filter(y => y));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tfs/import - Import data from Excel file
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    let excelPath;
    let cleanupFile = false;
    const clearData = req.body.clearData === 'true';

    if (req.file) {
      excelPath = req.file.path;
      cleanupFile = true;
    } else {
      excelPath = path.join(__dirname, '../../2025_data.xlsx');
      if (!fs.existsSync(excelPath)) {
        return res.status(400).json({ error: 'No file uploaded and no default file found' });
      }
    }

    if (clearData) {
      await TfsTask.deleteMany({});
      await Developer.deleteMany({});
    }

    const parser = new ExcelParser(excelPath);
    await parser.load();

    const mergedData = parser.getMergedData();
    let imported = 0;
    let updated = 0;
    const developerMap = new Map();

    for (const taskData of mergedData) {
      for (const entry of taskData.timeEntries) {
        const key = entry.timekeeperNumber;
        if (!developerMap.has(key)) {
          developerMap.set(key, {
            timekeeperNumber: entry.timekeeperNumber,
            firstName: entry.firstName,
            lastName: entry.lastName,
            title: entry.title,
            totalHours: 0,
            taskIds: new Set(),
            taskIdsWithoutId: new Set(),
            hoursWithoutId: 0
          });
        }
        const dev = developerMap.get(key);
        dev.totalHours += entry.workHrs;
        dev.taskIds.add(taskData.tfsId);

        // Track tasks/hours where TFS ID was not entered
        if (taskData.tfsIdNotEntered) {
          dev.taskIdsWithoutId.add(taskData.tfsId);
          dev.hoursWithoutId += entry.workHrs;
        }
      }

      // Mark title if TFS ID was not entered
      let taskTitle = taskData.title;
      if (taskData.tfsIdNotEntered && !taskTitle?.includes('[TFS ID Not Entered]')) {
        taskTitle = taskTitle ? `${taskTitle} [TFS ID Not Entered]` : '[TFS ID Not Entered]';
      }

      const existingTask = await TfsTask.findOne({ tfsId: taskData.tfsId });

      if (existingTask) {
        existingTask.timeEntries = taskData.timeEntries;
        existingTask.title = taskTitle || existingTask.title;
        existingTask.tfsIdNotEntered = taskData.tfsIdNotEntered || false;
        existingTask.recalculateTotals();
        await existingTask.save();
        updated++;
      } else {
        const developerBreakdown = {};
        taskData.developerBreakdown.forEach((hours, name) => {
          developerBreakdown[name] = hours;
        });

        const developerBreakdownByDate = {};
        taskData.developerBreakdownByDate.forEach((dates, name) => {
          developerBreakdownByDate[name] = dates;
        });

        // Calculate firstDate and lastDate from time entries
        let firstDate = null;
        let lastDate = null;
        if (taskData.timeEntries && taskData.timeEntries.length > 0) {
          const dates = taskData.timeEntries
            .map(e => e.workDateOnly || (e.workDate ? new Date(e.workDate).toISOString().split('T')[0] : null))
            .filter(d => d)
            .sort();
          if (dates.length > 0) {
            firstDate = dates[0];
            lastDate = dates[dates.length - 1];
          }
        }

        await TfsTask.create({
          tfsId: taskData.tfsId,
          title: taskTitle,
          estimated: taskData.estimated,
          quality: taskData.quality,
          timeEntries: taskData.timeEntries,
          totalActualHours: taskData.totalActualHours,
          developerBreakdown,
          developerBreakdownByDate,
          tfsIdNotEntered: taskData.tfsIdNotEntered || false,
          firstDate,
          lastDate
        });
        imported++;
      }
    }

    for (const [, dev] of developerMap) {
      await Developer.findOneAndUpdate(
        { timekeeperNumber: dev.timekeeperNumber },
        {
          firstName: dev.firstName,
          lastName: dev.lastName,
          title: dev.title,
          totalHours: dev.totalHours,
          taskCount: dev.taskIds.size,
          taskCountWithoutId: dev.taskIdsWithoutId.size,
          hoursWithoutId: dev.hoursWithoutId
        },
        { upsert: true, new: true }
      );
    }

    if (cleanupFile && fs.existsSync(excelPath)) {
      fs.unlinkSync(excelPath);
    }

    // Auto-calculate bell curve estimates for tasks without estimates
    const estimateResult = await calculateBellCurveEstimates('developer');

    // Fix any estimates that are less than actuals
    const fixedEstimates = await fixLowEstimates();

    // Auto-calculate bell curve quality for tasks without quality
    const qualityResult = await calculateBellCurveQuality();

    res.json({
      success: true,
      message: `Import complete: ${imported} new tasks, ${updated} updated, ${developerMap.size} developers. Auto-calculated ${estimateResult.updated} estimates (${fixedEstimates.fixed} corrected), ${qualityResult.updated} quality scores.`,
      imported,
      updated,
      developers: developerMap.size,
      estimatesCalculated: estimateResult.updated,
      estimatesCorrected: fixedEstimates.fixed,
      qualityCalculated: qualityResult.updated
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tfs/delete-all - Delete all data (using POST for reliability)
router.post('/delete-all', async (req, res) => {
  try {
    const [tasksResult, devsResult] = await Promise.all([
      TfsTask.deleteMany({}),
      Developer.deleteMany({})
    ]);

    res.json({
      success: true,
      message: `Deleted ${tasksResult.deletedCount} tasks and ${devsResult.deletedCount} developers`,
      tasksDeleted: tasksResult.deletedCount,
      developersDeleted: devsResult.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tfs/recalculate-all - Recalculate totals for all tasks (updates primaryDeveloper, etc.)
router.post('/recalculate-all', async (req, res) => {
  try {
    const tasks = await TfsTask.find({});
    let updated = 0;

    for (const task of tasks) {
      task.recalculateTotals();
      await task.save();
      updated++;
    }

    res.json({
      success: true,
      message: `Recalculated totals for ${updated} tasks`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/developers/scorecard - Get developer scorecard data
router.get('/developers/scorecard', async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    // Include all tasks with actual hours OR orphaned entries (which always have time entries)
    const tasks = await TfsTask.find({
      $or: [
        { totalActualHours: { $gt: 0 } },
        { tfsIdNotEntered: true },
        { tfsId: { $lt: 0 } }
      ]
    }).lean();

    // Build developer stats from task data
    const devStats = new Map();
    // Track orphaned entry stats per developer (calculated live, not from Developer model)
    const orphanedStats = new Map();

    for (const task of tasks) {
      const isOrphanedEntry = task.tfsIdNotEntered === true || task.tfsId < 0;

      // Process time entries to calculate hours per developer (filtered by year if specified)
      const devHoursFromEntries = new Map();
      const taskIdsProcessed = new Set();

      if (task.timeEntries) {
        for (const entry of task.timeEntries) {
          const entryDate = new Date(entry.workDate);
          const entryYear = entryDate.getFullYear();

          // Skip entries not in the selected year (if year filter is active)
          if (year && entryYear !== year) continue;

          const entryDevName = `${entry.firstName} ${entry.lastName}`;
          devHoursFromEntries.set(entryDevName, (devHoursFromEntries.get(entryDevName) || 0) + entry.workHrs);
        }
      }

      // If year filter is active and no entries match, skip this task
      if (year && devHoursFromEntries.size === 0) continue;

      // Always calculate from time entries if developerBreakdown is missing/empty
      // This ensures orphaned entries and tasks with missing breakdown are counted
      let hoursSource;
      if (year) {
        hoursSource = devHoursFromEntries;
      } else if (task.developerBreakdown && Object.keys(task.developerBreakdown).length > 0) {
        hoursSource = new Map(Object.entries(task.developerBreakdown));
      } else {
        // Fall back to calculating from time entries
        hoursSource = devHoursFromEntries;
      }

      for (const [name, hours] of hoursSource) {
        if (!devStats.has(name)) {
          devStats.set(name, {
            name,
            totalHours: 0,
            taskCount: 0,
            qualitySum: 0,
            qualityCount: 0,
            quarterlyHours: {},
            quarterlyAdminHours: {},
            adminHours: 0
          });
        }

        // Initialize orphaned stats for this developer
        if (!orphanedStats.has(name)) {
          orphanedStats.set(name, { hoursWithoutId: 0, taskCountWithoutId: 0 });
        }

        const dev = devStats.get(name);
        dev.totalHours += hours;
        dev.taskCount += 1;

        // Track orphaned entry stats (calculated live from TfsTask data)
        if (isOrphanedEntry) {
          const orphaned = orphanedStats.get(name);
          orphaned.hoursWithoutId += hours;
          orphaned.taskCountWithoutId += 1;
        }

        // Track admin hours (tfsId 7300)
        if (task.tfsId === 7300) {
          dev.adminHours += hours;
        }

        if (task.quality !== null && task.quality !== undefined) {
          dev.qualitySum += task.quality;
          dev.qualityCount += 1;
        }

        // Track quarterly hours from time entries
        if (task.timeEntries) {
          for (const entry of task.timeEntries) {
            const entryDevName = `${entry.firstName} ${entry.lastName}`;
            if (entryDevName === name && entry.workDate) {
              const date = new Date(entry.workDate);
              const entryYear = date.getFullYear();

              // Skip entries not in the selected year (if year filter is active)
              if (year && entryYear !== year) continue;

              const quarter = `Q${Math.ceil((date.getMonth() + 1) / 3)} ${date.getFullYear()}`;
              dev.quarterlyHours[quarter] = (dev.quarterlyHours[quarter] || 0) + entry.workHrs;

              // Track quarterly admin hours (tfsId 7300)
              if (task.tfsId === 7300) {
                dev.quarterlyAdminHours[quarter] = (dev.quarterlyAdminHours[quarter] || 0) + entry.workHrs;
              }
            }
          }
        }
      }
    }

    // Convert to array and calculate averages
    // Use calculated orphaned stats instead of Developer model (which requires re-import)
    const developers = Array.from(devStats.values()).map(dev => {
      const orphaned = orphanedStats.get(dev.name) || { hoursWithoutId: 0, taskCountWithoutId: 0 };
      return {
        name: dev.name,
        totalHours: Math.round(dev.totalHours * 100) / 100,
        taskCount: dev.taskCount,
        avgQuality: dev.qualityCount > 0 ? Math.round((dev.qualitySum / dev.qualityCount) * 100) / 100 : null,
        quarterlyHours: dev.quarterlyHours,
        quarterlyAdminHours: dev.quarterlyAdminHours,
        taskCountWithoutId: orphaned.taskCountWithoutId,
        hoursWithoutId: Math.round(orphaned.hoursWithoutId * 100) / 100,
        adminHours: Math.round(dev.adminHours * 100) / 100
      };
    });

    // Sort by total hours descending
    developers.sort((a, b) => b.totalHours - a.totalHours);

    // Get all quarters and sort them
    const allQuarters = new Set();
    developers.forEach(dev => {
      Object.keys(dev.quarterlyHours).forEach(q => allQuarters.add(q));
    });
    const sortedQuarters = Array.from(allQuarters).sort((a, b) => {
      const [qa, ya] = a.replace('Q', '').split(' ');
      const [qb, yb] = b.replace('Q', '').split(' ');
      return (parseInt(ya) * 4 + parseInt(qa)) - (parseInt(yb) * 4 + parseInt(qb));
    });

    // Calculate total team admin hours per quarter
    const teamAdminHoursByQuarter = {};
    developers.forEach(dev => {
      if (dev.quarterlyAdminHours) {
        Object.entries(dev.quarterlyAdminHours).forEach(([quarter, hours]) => {
          teamAdminHoursByQuarter[quarter] = (teamAdminHoursByQuarter[quarter] || 0) + hours;
        });
      }
    });

    res.json({
      developers,
      quarters: sortedQuarters,
      teamAdminHoursByQuarter
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/applications - Get distinct applications
router.get('/applications', async (req, res) => {
  try {
    const applications = await TfsTask.distinct('application', {
      application: { $ne: null, $ne: '' }
    });
    // Sort alphabetically and filter out empty/null values
    const sorted = applications.filter(a => a && a.trim()).sort((a, b) => a.localeCompare(b));
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CHART ROUTES (must be before :id routes)
// ============================================

// GET /api/tfs/charts/quality-distribution
router.get('/charts/quality-distribution', async (req, res) => {
  try {
    const distribution = await TfsTask.aggregate([
      { $match: { quality: { $ne: null } } },
      { $group: { _id: '$quality', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    const labels = ['1 - Poor', '2 - Below Avg', '3 - Average', '4 - Good', '5 - Excellent'];
    const data = [0, 0, 0, 0, 0];

    distribution.forEach(d => {
      if (d._id >= 1 && d._id <= 5) {
        data[d._id - 1] = d.count;
      }
    });

    res.json({ labels, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/charts/hours-by-developer
router.get('/charts/hours-by-developer', async (req, res) => {
  try {
    // Calculate hours from TfsTask data including orphaned entries
    const tasks = await TfsTask.find({
      $or: [
        { totalActualHours: { $gt: 0 } },
        { tfsIdNotEntered: true },
        { tfsId: { $lt: 0 } }
      ]
    }).lean();

    const devHours = new Map();
    for (const task of tasks) {
      // Use developerBreakdown if available, otherwise calculate from timeEntries
      let hoursSource;
      if (task.developerBreakdown && Object.keys(task.developerBreakdown).length > 0) {
        hoursSource = Object.entries(task.developerBreakdown);
      } else if (task.timeEntries && task.timeEntries.length > 0) {
        const entryHours = new Map();
        for (const entry of task.timeEntries) {
          const name = `${entry.firstName} ${entry.lastName}`;
          entryHours.set(name, (entryHours.get(name) || 0) + entry.workHrs);
        }
        hoursSource = Array.from(entryHours.entries());
      } else {
        hoursSource = [];
      }

      for (const [name, hours] of hoursSource) {
        devHours.set(name, (devHours.get(name) || 0) + hours);
      }
    }

    // Sort by hours descending and take top 10
    const sorted = Array.from(devHours.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const labels = sorted.map(([name]) => name);
    const data = sorted.map(([, hours]) => Math.round(hours * 100) / 100);
    res.json({ labels, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/charts/estimate-accuracy
router.get('/charts/estimate-accuracy', async (req, res) => {
  try {
    const tasks = await TfsTask.find({
      estimated: { $ne: null },
      totalActualHours: { $gt: 0 }
    }).sort({ tfsId: -1 }).limit(20).lean();

    const labels = tasks.map(t => `TFS ${t.tfsId}`);
    const estimated = tasks.map(t => t.estimated);
    const actual = tasks.map(t => t.totalActualHours);

    res.json({ labels, estimated, actual });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/charts/task-status
router.get('/charts/task-status', async (req, res) => {
  try {
    // Include tasks with actual hours OR orphaned entries
    const baseQuery = {
      $or: [
        { totalActualHours: { $gt: 0 } },
        { tfsIdNotEntered: true },
        { tfsId: { $lt: 0 } }
      ]
    };

    const [total, withEstimates, withQuality, complete] = await Promise.all([
      TfsTask.countDocuments(baseQuery),
      TfsTask.countDocuments({ ...baseQuery, estimated: { $ne: null } }),
      TfsTask.countDocuments({ ...baseQuery, quality: { $ne: null } }),
      TfsTask.countDocuments({ ...baseQuery, estimated: { $ne: null }, quality: { $ne: null } })
    ]);

    res.json({
      labels: ['Needs Estimate', 'Needs Quality', 'Complete'],
      data: [total - withEstimates, withEstimates - complete, complete]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ============================================
// EXPORT ROUTES
// ============================================

// GET /api/tfs/export/xlsx - Export tasks to Excel file
router.get('/export/xlsx', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');

    // Get filter parameters (same as main list)
    const search = req.query.search || '';
    const filter = req.query.filter || 'all';

    let query = {};

    if (search) {
      const searchNum = parseInt(search);
      const searchRegex = { $regex: search, $options: 'i' };
      if (!isNaN(searchNum)) {
        query.$or = [
          { tfsId: searchNum },
          { title: searchRegex },
          { 'timeEntries.firstName': searchRegex },
          { 'timeEntries.lastName': searchRegex }
        ];
      } else {
        query.$or = [
          { title: searchRegex },
          { 'timeEntries.firstName': searchRegex },
          { 'timeEntries.lastName': searchRegex }
        ];
      }
    }

    if (filter === 'needsEstimate') {
      query.$and = [
        { $or: [{ estimated: null }, { estimated: { $exists: false } }] },
        { totalActualHours: { $gt: 0 } }
      ];
    } else if (filter === 'needsQuality') {
      query.$and = [
        { $or: [{ quality: null }, { quality: { $exists: false } }] },
        { totalActualHours: { $gt: 0 } }
      ];
    } else if (filter === 'complete') {
      query.estimated = { $ne: null, $exists: true };
      query.quality = { $ne: null, $exists: true };
    } else if (filter === 'orphanedEntries') {
      query.$or = [
        { tfsId: { $lt: 0 } },
        { tfsIdNotEntered: true }
      ];
    } else if (filter === 'orphanedTasks') {
      query.$and = query.$and || [];
      query.$and.push(
        { $or: [
          { totalActualHours: { $eq: 0 } },
          { totalActualHours: { $exists: false } },
          { timeEntries: { $size: 0 } },
          { timeEntries: { $exists: false } }
        ]},
        { tfsId: { $gte: 0 } },
        { tfsIdNotEntered: { $ne: true } }
      );
    }

    const tasks = await TfsTask.find(query).sort({ tfsId: 1 }).lean();

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ASD Time Tracker';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Tasks');

    // Define columns
    worksheet.columns = [
      { header: 'ASD ID', key: 'tfsId', width: 12 },
      { header: 'Title', key: 'title', width: 50 },
      { header: 'Application', key: 'application', width: 20 },
      { header: 'Estimated Hours', key: 'estimated', width: 15 },
      { header: 'Actual Hours', key: 'actual', width: 15 },
      { header: 'Variance', key: 'variance', width: 12 },
      { header: 'Variance %', key: 'variancePercent', width: 12 },
      { header: 'Quality', key: 'quality', width: 10 },
      { header: 'Developers', key: 'developers', width: 40 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Add data rows
    for (const task of tasks) {
      const variance = task.estimated !== null ? task.estimated - task.totalActualHours : null;
      const variancePercent = task.estimated !== null && task.estimated !== 0
        ? ((task.estimated - task.totalActualHours) / task.estimated * 100).toFixed(1) + '%'
        : null;

      const devNames = task.developerBreakdown
        ? Object.entries(task.developerBreakdown)
            .map(([name, hours]) => name + ' (' + hours.toFixed(2) + 'h)')
            .join(', ')
        : '';

      worksheet.addRow({
        tfsId: task.tfsId,
        title: task.title || '',
        application: task.application || '',
        estimated: task.estimated,
        actual: task.totalActualHours,
        variance: variance,
        variancePercent: variancePercent,
        quality: task.quality,
        developers: devNames
      });
    }

    // Set number formats
    worksheet.getColumn('estimated').numFmt = '0.00';
    worksheet.getColumn('actual').numFmt = '0.00';
    worksheet.getColumn('variance').numFmt = '0.00';

    // Set response headers
    const filename = 'tasks_export_' + new Date().toISOString().split('T')[0] + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BELL CURVE ESTIMATE CALCULATION
// ============================================

// POST /api/tfs/calculate-estimates - Calculate estimates using bell curve method
router.post('/calculate-estimates', async (req, res) => {
  try {
    const { groupBy } = req.body; // 'matter' or 'developer'

    if (!groupBy || !['matter', 'developer'].includes(groupBy)) {
      return res.status(400).json({ error: 'groupBy must be "matter" or "developer"' });
    }

    // 1. Get all tasks with actuals but no estimate
    const tasks = await TfsTask.find({
      totalActualHours: { $gt: 0 },
      $or: [{ estimated: null }, { estimated: { $exists: false } }]
    });

    if (tasks.length === 0) {
      return res.json({ success: true, updated: 0, groups: 0, message: 'No tasks need estimates' });
    }

    // Helper to get primary developer (the one with most hours)
    const getPrimaryDeveloper = (task) => {
      if (!task.developerBreakdown || Object.keys(task.developerBreakdown).length === 0) {
        return 'Unknown';
      }
      const breakdown = task.developerBreakdown instanceof Map
        ? Object.fromEntries(task.developerBreakdown)
        : task.developerBreakdown;
      const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      return sorted[0][0];
    };

    // 2. Group tasks by category
    const groups = new Map();
    tasks.forEach(task => {
      const key = groupBy === 'matter'
        ? (task.matterNumber || 'Unknown')
        : getPrimaryDeveloper(task);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    });

    // 3. Calculate stats per group and update estimates using median
    let updated = 0;
    const groupStats = [];

    for (const [key, groupTasks] of groups) {
      const actuals = groupTasks.map(t => t.totalActualHours);
      const med = median(actuals);

      // Calculate MAD (Median Absolute Deviation) - more robust than std dev
      const deviations = actuals.map(v => Math.abs(v - med));
      const mad = median(deviations);

      // Estimate = median + 0.5 MAD (slight buffer for uncertainty)
      // Round to whole number, but for 100+ round UP to nearest 10
      const raw = med + 0.5 * mad;
      const estimate = raw >= 100 ? Math.ceil(raw / 10) * 10 : Math.round(raw) || 1;

      groupStats.push({
        group: key,
        taskCount: groupTasks.length,
        median: Math.round(med * 100) / 100,
        mad: Math.round(mad * 100) / 100,
        estimate
      });

      // Update tasks in this group - estimate should be at least equal to actual
      for (const task of groupTasks) {
        task.estimated = Math.max(estimate, Math.ceil(task.totalActualHours));
        task.estimateSource = 'bell-curve';
        task.estimateGroup = key;
        await task.save();
        updated++;
      }
    }

    res.json({
      success: true,
      updated,
      groups: groups.size,
      groupStats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/estimate-preview - Preview bell curve estimates without saving
router.get('/estimate-preview', async (req, res) => {
  try {
    const { groupBy } = req.query;

    if (!groupBy || !['matter', 'developer'].includes(groupBy)) {
      return res.status(400).json({ error: 'groupBy must be "matter" or "developer"' });
    }

    // Get all tasks with actuals but no estimate
    const tasks = await TfsTask.find({
      totalActualHours: { $gt: 0 },
      $or: [{ estimated: null }, { estimated: { $exists: false } }]
    }).lean();

    if (tasks.length === 0) {
      return res.json({ groups: [], totalTasks: 0 });
    }

    const getPrimaryDeveloper = (task) => {
      if (!task.developerBreakdown || Object.keys(task.developerBreakdown).length === 0) {
        return 'Unknown';
      }
      const sorted = Object.entries(task.developerBreakdown).sort((a, b) => b[1] - a[1]);
      return sorted[0][0];
    };

    const groups = new Map();
    tasks.forEach(task => {
      const key = groupBy === 'matter'
        ? (task.matterNumber || 'Unknown')
        : getPrimaryDeveloper(task);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    });

    const groupStats = [];
    for (const [key, groupTasks] of groups) {
      const actuals = groupTasks.map(t => t.totalActualHours);
      const sorted = [...actuals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const med = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

      // Calculate MAD
      const deviations = actuals.map(v => Math.abs(v - med));
      const sortedDev = [...deviations].sort((a, b) => a - b);
      const midDev = Math.floor(sortedDev.length / 2);
      const mad = sortedDev.length % 2 !== 0 ? sortedDev[midDev] : (sortedDev[midDev - 1] + sortedDev[midDev]) / 2;

      const raw = med + 0.5 * mad;
      const estimate = raw >= 100 ? Math.ceil(raw / 10) * 10 : Math.round(raw) || 1;

      groupStats.push({
        group: key,
        taskCount: groupTasks.length,
        taskIds: groupTasks.map(t => t.tfsId),
        median: Math.round(med * 100) / 100,
        mad: Math.round(mad * 100) / 100,
        estimate,
        range: {
          low: Math.round(med - mad) || 1,
          high: Math.round(med + mad) || 1
        }
      });
    }

    groupStats.sort((a, b) => b.taskCount - a.taskCount);

    res.json({
      groups: groupStats,
      totalTasks: tasks.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BELL CURVE QUALITY CALCULATION
// ============================================

// POST /api/tfs/fix-low-estimates - Fix estimates that are less than actuals
router.post('/fix-low-estimates', async (req, res) => {
  try {
    const result = await fixLowEstimates();
    res.json({
      success: true,
      fixed: result.fixed,
      message: result.fixed > 0
        ? `Fixed ${result.fixed} estimates that were below actual hours`
        : 'No estimates needed fixing'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tfs/calculate-quality - Calculate quality using bell curve method
router.post('/calculate-quality', async (req, res) => {
  try {
    const result = await calculateBellCurveQuality();
    res.json({
      success: true,
      updated: result.updated,
      message: result.updated > 0
        ? `Updated ${result.updated} tasks with quality scores`
        : 'No tasks need quality scores (must have estimate and actuals)'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/quality-preview - Preview quality calculations
router.get('/quality-preview', async (req, res) => {
  try {
    const tasks = await TfsTask.find({
      totalActualHours: { $gt: 0 },
      estimated: { $ne: null, $gt: 0 },
      $or: [{ quality: null }, { quality: { $exists: false } }]
    }).lean();

    if (tasks.length === 0) {
      return res.json({ tasks: [], totalTasks: 0 });
    }

    const preview = tasks.map(task => {
      const variancePercent = (task.totalActualHours - task.estimated) / task.estimated;

      // Adjusted thresholds - 3 should be most common, no 1s
      let quality;
      if (variancePercent <= -0.25) quality = 5;      // 25%+ under budget (rare)
      else if (variancePercent <= -0.10) quality = 4; // 10-25% under budget
      else if (variancePercent <= 0.25) quality = 3;  // Within 25% over or 10% under (most common)
      else quality = 2;                                // 25%+ over (handful, no 1s)

      return {
        tfsId: task.tfsId,
        title: task.title,
        estimated: task.estimated,
        actual: task.totalActualHours,
        variancePercent: Math.round(variancePercent * 100),
        predictedQuality: quality
      };
    });

    // Group by predicted quality for summary (no 1s in new system)
    const summary = { 2: 0, 3: 0, 4: 0, 5: 0 };
    preview.forEach(p => summary[p.predictedQuality]++);

    res.json({
      tasks: preview.slice(0, 50), // Limit preview to 50 tasks
      totalTasks: tasks.length,
      summary
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PARAM ROUTES (must be last)
// ============================================

// GET /api/tfs/:id - Get single TFS task
router.get('/:id', async (req, res) => {
  try {
    const task = await TfsTask.findOne({ tfsId: parseInt(req.params.id) });
    if (!task) {
      return res.status(404).json({ error: 'TFS task not found' });
    }
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/tfs/:id - Update task including ID change, merge, and developer names
router.put('/:id', async (req, res) => {
  try {
    const originalId = parseInt(req.params.id);
    const { tfsId, title, application, estimated, quality, actualHours, developers, workDate, mergeWithExisting } = req.body;
    const newTfsId = tfsId ? parseInt(tfsId) : originalId;

    // Parse work date or default to today
    const entryDate = workDate ? new Date(workDate) : new Date();

    const task = await TfsTask.findOne({ tfsId: originalId });
    if (!task) {
      return res.status(404).json({ error: 'TFS task not found' });
    }

    // Handle ID change with potential merge
    if (newTfsId !== originalId) {
      const existingTarget = await TfsTask.findOne({ tfsId: newTfsId });

      if (existingTarget && mergeWithExisting) {
        // Merge tasks: combine time entries, sum hours, keep best estimates
        existingTarget.timeEntries = [...existingTarget.timeEntries, ...task.timeEntries];
        existingTarget.totalActualHours += task.totalActualHours;

        // Sum or take the new estimated value
        if (estimated !== undefined && estimated !== '' && estimated !== null) {
          const newEst = parseFloat(estimated);
          existingTarget.estimated = existingTarget.estimated !== null
            ? existingTarget.estimated + newEst
            : newEst;
        } else if (task.estimated !== null) {
          existingTarget.estimated = existingTarget.estimated !== null
            ? existingTarget.estimated + task.estimated
            : task.estimated;
        }

        // Use provided quality or keep existing
        if (quality !== undefined && quality !== '' && quality !== null) {
          existingTarget.quality = parseInt(quality);
        }

        // Update title if provided
        if (title !== undefined && title.trim()) {
          existingTarget.title = title.trim();
        }

        // Recalculate developer breakdown
        existingTarget.recalculateTotals();
        await existingTarget.save();

        // Delete the original task
        await TfsTask.deleteOne({ tfsId: originalId });

        return res.json(existingTarget);
      } else if (existingTarget) {
        return res.status(400).json({ error: 'Target ID already exists. Enable merge to combine tasks.' });
      } else {
        // Just change the ID
        task.tfsId = newTfsId;
      }
    }

    // Update basic fields
    if (title !== undefined) {
      task.title = title.trim() || null;
    }
    if (application !== undefined) {
      task.application = application.trim() || null;
    }
    if (estimated !== undefined) {
      task.estimated = estimated === '' || estimated === null ? null : parseFloat(estimated);
    }
    if (quality !== undefined) {
      task.quality = quality === '' || quality === null ? null : parseInt(quality);
    }

    // Update developers - only replace time entries if task has no imported data
    // (i.e., was manually created or has no time entries)
    const hasImportedData = task.timeEntries && task.timeEntries.length > 0 &&
      task.timeEntries.some(e => e.narrative !== 'Manually entered');

    if (developers && Array.isArray(developers) && !hasImportedData) {
      // Task was manually created - safe to replace time entries
      const timeEntries = [];
      const developerBreakdown = {};
      const developerBreakdownByDate = {};
      let totalActualHours = 0;
      const dateOnly = entryDate.toISOString().split('T')[0];

      developers.forEach(dev => {
        if (dev.name && dev.hours > 0) {
          const nameParts = dev.name.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';

          timeEntries.push({
            timekeeperNumber: 0,
            firstName,
            lastName,
            title: '',
            workDate: entryDate,
            workDateOnly: dateOnly,
            workHrs: dev.hours,
            narrative: 'Manually entered',
            activityCode: '',
            activityCodeDesc: ''
          });

          developerBreakdown[dev.name] = dev.hours;
          developerBreakdownByDate[dev.name] = { [dateOnly]: dev.hours };
          totalActualHours += dev.hours;
        }
      });

      task.timeEntries = timeEntries;
      task.developerBreakdown = developerBreakdown;
      task.developerBreakdownByDate = developerBreakdownByDate;
      task.totalActualHours = actualHours ? parseFloat(actualHours) : totalActualHours;
    } else if (actualHours !== undefined && !hasImportedData) {
      // Update just actualHours if no developers provided and no imported data
      task.totalActualHours = actualHours === '' || actualHours === null ? 0 : parseFloat(actualHours);
    }
    // If task has imported data, we only update estimated/quality/title (done above)
    // The time entries, developer breakdown, and dates are preserved

    await task.save();
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tfs/:id - Delete a single task
router.delete('/:id', async (req, res) => {
  try {
    const tfsId = parseInt(req.params.id);
    const task = await TfsTask.findOne({ tfsId });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await TfsTask.deleteOne({ tfsId });

    res.json({
      success: true,
      message: `Task ${tfsId} deleted successfully`,
      deletedId: tfsId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tfs/:id/developers - Get developer breakdown
router.get('/:id/developers', async (req, res) => {
  try {
    const task = await TfsTask.findOne({ tfsId: parseInt(req.params.id) }).lean();
    if (!task) {
      return res.status(404).json({ error: 'TFS task not found' });
    }

    const breakdown = [];
    if (task.developerBreakdown) {
      // developerBreakdown is stored as an object, not a Map
      Object.entries(task.developerBreakdown).forEach(([name, hours]) => {
        const byDate = task.developerBreakdownByDate?.[name] || {};
        breakdown.push({
          name,
          hours: parseFloat(hours).toFixed(2),
          byDate: Object.entries(byDate)
            .map(([date, hrs]) => ({ date, hours: parseFloat(hrs).toFixed(2) }))
            .sort((a, b) => a.date.localeCompare(b.date))
        });
      });
    }

    breakdown.sort((a, b) => parseFloat(b.hours) - parseFloat(a.hours));

    res.json({
      tfsId: task.tfsId,
      totalHours: task.totalActualHours || 0,
      developers: breakdown
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

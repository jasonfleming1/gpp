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
    } else if (filter === 'noActual') {
      query.$or = [
        { totalActualHours: { $eq: 0 } },
        { totalActualHours: { $exists: false } },
        { timeEntries: { $size: 0 } },
        { timeEntries: { $exists: false } }
      ];
    }

    const sort = {};
    sort[sortField] = sortOrder;

    const [tasks, total] = await Promise.all([
      TfsTask.find(query).sort(sort).skip(skip).limit(limit).lean(),
      TfsTask.countDocuments(query)
    ]);

    const tasksWithDevs = tasks.map(task => {
      const devNames = [];
      if (task.developerBreakdown) {
        Object.keys(task.developerBreakdown).forEach(name => devNames.push(name));
      }

      // Calculate date range from time entries
      let firstDate = null;
      let lastDate = null;
      if (task.timeEntries && task.timeEntries.length > 0) {
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

        await TfsTask.create({
          tfsId: taskData.tfsId,
          title: taskTitle,
          estimated: taskData.estimated,
          quality: taskData.quality,
          timeEntries: taskData.timeEntries,
          totalActualHours: taskData.totalActualHours,
          developerBreakdown,
          developerBreakdownByDate
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

    res.json({
      success: true,
      message: `Import complete: ${imported} new tasks, ${updated} updated, ${developerMap.size} developers`,
      imported,
      updated,
      developers: developerMap.size
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

// GET /api/tfs/developers/scorecard - Get developer scorecard data
router.get('/developers/scorecard', async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    const tasks = await TfsTask.find({ totalActualHours: { $gt: 0 } }).lean();

    // Build developer stats from task data
    const devStats = new Map();

    for (const task of tasks) {
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

      // Use filtered hours if year is specified, otherwise use developerBreakdown
      const hoursSource = year ? devHoursFromEntries : (task.developerBreakdown ? new Map(Object.entries(task.developerBreakdown)) : new Map());

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

        const dev = devStats.get(name);
        dev.totalHours += hours;
        dev.taskCount += 1;

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

    // Get developer records for hoursWithoutId stats
    const devRecords = await Developer.find().lean();
    const devRecordMap = new Map(devRecords.map(d => [`${d.firstName} ${d.lastName}`, d]));

    // Convert to array and calculate averages
    const developers = Array.from(devStats.values()).map(dev => {
      const devRecord = devRecordMap.get(dev.name);
      return {
        name: dev.name,
        totalHours: Math.round(dev.totalHours * 100) / 100,
        taskCount: dev.taskCount,
        avgQuality: dev.qualityCount > 0 ? Math.round((dev.qualitySum / dev.qualityCount) * 100) / 100 : null,
        quarterlyHours: dev.quarterlyHours,
        quarterlyAdminHours: dev.quarterlyAdminHours,
        taskCountWithoutId: devRecord?.taskCountWithoutId || 0,
        hoursWithoutId: Math.round((devRecord?.hoursWithoutId || 0) * 100) / 100,
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
    const developers = await Developer.find().sort({ totalHours: -1 }).limit(10).lean();
    const labels = developers.map(d => `${d.firstName} ${d.lastName}`);
    const data = developers.map(d => d.totalHours);
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
    const [total, withEstimates, withQuality, complete] = await Promise.all([
      TfsTask.countDocuments({ totalActualHours: { $gt: 0 } }),
      TfsTask.countDocuments({ estimated: { $ne: null }, totalActualHours: { $gt: 0 } }),
      TfsTask.countDocuments({ quality: { $ne: null } }),
      TfsTask.countDocuments({ estimated: { $ne: null }, quality: { $ne: null } })
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
    } else if (filter === 'noActual') {
      query.$or = [
        { totalActualHours: { $eq: 0 } },
        { totalActualHours: { $exists: false } },
        { timeEntries: { $size: 0 } },
        { timeEntries: { $exists: false } }
      ];
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

    // Update developers - replace time entries and breakdown with new developer data
    if (developers && Array.isArray(developers)) {
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
    } else if (actualHours !== undefined) {
      // Update just actualHours if no developers provided
      task.totalActualHours = actualHours === '' || actualHours === null ? 0 : parseFloat(actualHours);
    }

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

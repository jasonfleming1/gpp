const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ManagerTask = require('../../models/ManagerTask');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/managertasks');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit per file
  fileFilter: (req, file, cb) => {
    // Allow common document and image types
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt|csv|zip|rar/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    if (extname) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Allowed: images, PDF, Office docs, text, archives'));
  }
});

// ============================================
// STATIC ROUTES FIRST
// ============================================

// GET /api/managertasks - Get all tasks with pagination and filtering
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Build query from filters
    let query = {};

    if (req.query.status && req.query.status !== 'all') {
      query.status = req.query.status;
    }

    if (req.query.application && req.query.application !== 'all') {
      query.application = req.query.application;
    }

    if (req.query.search) {
      query.$or = [
        { description: { $regex: req.query.search, $options: 'i' } },
        { rustId: { $regex: req.query.search, $options: 'i' } },
        { release: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    // Date range filtering
    if (req.query.startDate || req.query.endDate) {
      query.date = {};
      if (req.query.startDate) {
        query.date.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        query.date.$lte = new Date(req.query.endDate);
      }
    }

    const sort = {};
    sort[sortField] = sortOrder;

    const [tasks, total] = await Promise.all([
      ManagerTask.find(query).sort(sort).skip(skip).limit(limit).lean(),
      ManagerTask.countDocuments(query)
    ]);

    res.json({
      tasks,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/managertasks - Create a new task
router.post('/', async (req, res) => {
  try {
    const { rustId, date, application, description, release, status, qualityMeasure } = req.body;

    if (!application) {
      return res.status(400).json({ error: 'Application is required' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const taskData = {
      application,
      description,
      release: release || '',
      status: status || 'Not Started'
    };

    if (rustId && rustId.trim()) {
      taskData.rustId = rustId.trim();
    }

    if (date) {
      taskData.date = new Date(date);
    }

    if (qualityMeasure !== undefined && qualityMeasure !== null && qualityMeasure !== '') {
      taskData.qualityMeasure = parseInt(qualityMeasure);
    }

    const task = await ManagerTask.create(taskData);

    res.status(201).json(task);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: 'A task with this Rust ID already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/stats - Get summary statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await ManagerTask.getSummaryStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/by-application - Get tasks grouped by application
router.get('/by-application', async (req, res) => {
  try {
    const data = await ManagerTask.getByApplication();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/by-status - Get tasks grouped by status
router.get('/by-status', async (req, res) => {
  try {
    const data = await ManagerTask.getByStatus();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/applications - Get distinct applications
router.get('/applications', async (req, res) => {
  try {
    const applications = ManagerTask.schema.path('application').enumValues;
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/statuses - Get distinct statuses
router.get('/statuses', async (req, res) => {
  try {
    const statuses = ManagerTask.schema.path('status').enumValues;
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CHART DATA ROUTES
// ============================================

// GET /api/managertasks/charts/by-application - Task count by application
router.get('/charts/by-application', async (req, res) => {
  try {
    const data = await ManagerTask.aggregate([
      { $group: {
        _id: '$application',
        count: { $sum: 1 }
      }},
      { $sort: { count: -1 } }
    ]);

    res.json({
      labels: data.map(d => d._id),
      counts: data.map(d => d.count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/charts/by-status - Task count by status
router.get('/charts/by-status', async (req, res) => {
  try {
    const data = await ManagerTask.aggregate([
      { $group: {
        _id: '$status',
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    res.json({
      labels: data.map(d => d._id),
      counts: data.map(d => d.count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/charts/quality-distribution - Quality measure distribution
router.get('/charts/quality-distribution', async (req, res) => {
  try {
    const data = await ManagerTask.aggregate([
      { $match: { qualityMeasure: { $ne: null } } },
      { $group: {
        _id: '$qualityMeasure',
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    res.json({
      labels: data.map(d => `Quality ${d._id}`),
      counts: data.map(d => d.count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PARAM ROUTES (must be last)
// ============================================

// GET /api/managertasks/:id - Get single task by ID
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const task = await ManagerTask.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/managertasks/:id - Update a task
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const { rustId, date, application, description, release, status, qualityMeasure } = req.body;

    const updateData = {};
    if (rustId !== undefined) updateData.rustId = rustId.trim() || null;
    if (date !== undefined) updateData.date = date ? new Date(date) : null;
    if (application !== undefined) updateData.application = application;
    if (description !== undefined) updateData.description = description;
    if (release !== undefined) updateData.release = release;
    if (status !== undefined) updateData.status = status;
    if (qualityMeasure !== undefined) {
      updateData.qualityMeasure = qualityMeasure === '' || qualityMeasure === null ? null : parseInt(qualityMeasure);
    }

    const task = await ManagerTask.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: 'A task with this Rust ID already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/managertasks/:id - Delete a task
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const task = await ManagerTask.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({
      success: true,
      message: 'Task deleted successfully',
      deletedId: req.params.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/managertasks/delete-all - Delete all tasks
router.post('/delete-all', async (req, res) => {
  try {
    const result = await ManagerTask.deleteMany({});
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} manager tasks`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FILE ATTACHMENT ROUTES
// ============================================

// POST /api/managertasks/:id/attachments - Upload files to a task
router.post('/:id/attachments', upload.array('files', 10), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const task = await ManagerTask.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Add file info to task attachments
    const newAttachments = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      uploadedAt: new Date()
    }));

    task.attachments.push(...newAttachments);
    await task.save();

    res.json({
      success: true,
      message: `Uploaded ${req.files.length} file(s)`,
      attachments: task.attachments
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/managertasks/:id/attachments/:attachmentId - Download a file
router.get('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const task = await ManagerTask.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const attachment = task.attachments.id(req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const filePath = path.join(__dirname, '../../uploads/managertasks', attachment.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(filePath, attachment.originalName);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/managertasks/:id/attachments/:attachmentId - Delete a file
router.delete('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid task ID format' });
    }

    const task = await ManagerTask.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const attachment = task.attachments.id(req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, '../../uploads/managertasks', attachment.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from task
    task.attachments.pull(req.params.attachmentId);
    await task.save();

    res.json({
      success: true,
      message: 'Attachment deleted',
      attachments: task.attachments
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

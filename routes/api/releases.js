const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Release = require('../../models/Release');
const AppOption = require('../../models/AppOption');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/releases');
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

// GET /api/releases - Get all releases with pagination and filtering
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Build query from filters
    let query = {};

    if (req.query.application && req.query.application !== 'all') {
      query.application = req.query.application;
    }

    if (req.query.search) {
      query.$or = [
        { application: { $regex: req.query.search, $options: 'i' } },
        { tqa: { $regex: req.query.search, $options: 'i' } },
        { uat: { $regex: req.query.search, $options: 'i' } },
        { prod: { $regex: req.query.search, $options: 'i' } },
        { notes: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const sort = {};
    sort[sortField] = sortOrder;

    const [releases, total] = await Promise.all([
      Release.find(query).sort(sort).skip(skip).limit(limit).lean(),
      Release.countDocuments(query)
    ]);

    res.json({
      releases,
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

// POST /api/releases - Create a new release
router.post('/', async (req, res) => {
  try {
    const { application, releaseDate, tqa, uat, prod, notes } = req.body;

    if (!application) {
      return res.status(400).json({ error: 'Application is required' });
    }

    const releaseData = {
      application,
      releaseDate: releaseDate ? new Date(releaseDate) : null,
      tqa: tqa || '',
      uat: uat || '',
      prod: prod || '',
      notes: notes || '',
      history: []
    };

    const release = await Release.create(releaseData);

    res.status(201).json(release);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/stats - Get summary statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await Release.getSummaryStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/by-application - Get releases grouped by application
router.get('/by-application', async (req, res) => {
  try {
    const data = await Release.getByApplication();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/applications - Get applications from options
router.get('/applications', async (req, res) => {
  try {
    const applications = await AppOption.getValues('applications');
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CHART DATA ROUTES
// ============================================

// GET /api/releases/charts/by-application - Release count by application
router.get('/charts/by-application', async (req, res) => {
  try {
    const data = await Release.aggregate([
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

// ============================================
// PARAM ROUTES (must be last)
// ============================================

// GET /api/releases/:id/history - Get release history
router.get('/:id/history', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findById(req.params.id).select('history application');
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    // Return history sorted by date descending (most recent first)
    const history = release.history.sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));

    res.json({
      application: release.application,
      history
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/:id - Get single release by ID
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    res.json(release);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/releases/:id - Update a release
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const { application, releaseDate, tqa, uat, prod, notes } = req.body;

    // Find the release first to create a history snapshot
    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    // Create a snapshot of current state before updating
    release.createSnapshot();

    // Update fields
    if (application !== undefined) release.application = application;
    if (releaseDate !== undefined) release.releaseDate = releaseDate ? new Date(releaseDate) : null;
    if (tqa !== undefined) release.tqa = tqa;
    if (uat !== undefined) release.uat = uat;
    if (prod !== undefined) release.prod = prod;
    if (notes !== undefined) release.notes = notes;

    await release.save();

    res.json(release);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/releases/:id - Delete a release
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findByIdAndDelete(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    res.json({
      success: true,
      message: 'Release deleted successfully',
      deletedId: req.params.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/releases/delete-all - Delete all releases
router.post('/delete-all', async (req, res) => {
  try {
    const result = await Release.deleteMany({});
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} releases`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FILE ATTACHMENT ROUTES
// ============================================

// POST /api/releases/:id/attachments - Upload files to a release
router.post('/:id/attachments', upload.array('files', 10), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Add file info to release attachments
    const newAttachments = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      uploadedAt: new Date()
    }));

    release.attachments.push(...newAttachments);
    await release.save();

    res.json({
      success: true,
      message: `Uploaded ${req.files.length} file(s)`,
      attachments: release.attachments
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/releases/:id/attachments/:attachmentId - Download a file
router.get('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    const attachment = release.attachments.id(req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const filePath = path.join(__dirname, '../../uploads/releases', attachment.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(filePath, attachment.originalName);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/releases/:id/attachments/:attachmentId - Delete a file
router.delete('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    const attachment = release.attachments.id(req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, '../../uploads/releases', attachment.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from release
    release.attachments.pull(req.params.attachmentId);
    await release.save();

    res.json({
      success: true,
      message: 'Attachment deleted',
      attachments: release.attachments
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

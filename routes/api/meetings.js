const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Meeting = require('../../models/Meeting');
const AppOption = require('../../models/AppOption');

// ============================================
// STATIC ROUTES FIRST
// ============================================

// GET /api/meetings - Get all meetings with pagination and filtering
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'date';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Build query from filters
    let query = {};

    if (req.query.type) {
      query.type = req.query.type;
    }

    if (req.query.employee) {
      query.employee = req.query.employee;
    }

    if (req.query.startDate || req.query.endDate) {
      query.date = {};
      if (req.query.startDate) {
        query.date.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        query.date.$lte = new Date(req.query.endDate);
      }
    }

    if (req.query.search) {
      query.summary = { $regex: req.query.search, $options: 'i' };
    }

    const sort = {};
    sort[sortField] = sortOrder;

    const [meetings, total] = await Promise.all([
      Meeting.find(query).sort(sort).skip(skip).limit(limit).lean(),
      Meeting.countDocuments(query)
    ]);

    res.json({
      meetings,
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

// POST /api/meetings - Create a new meeting
router.post('/', async (req, res) => {
  try {
    const { date, type, employee, meetingDuration, summary } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    if (!type) {
      return res.status(400).json({ error: 'Meeting type is required' });
    }
    if (!employee) {
      return res.status(400).json({ error: 'Employee is required' });
    }
    if (meetingDuration === undefined || meetingDuration === null) {
      return res.status(400).json({ error: 'Meeting duration is required' });
    }

    const meeting = await Meeting.create({
      date: new Date(date),
      type,
      employee,
      meetingDuration: parseFloat(meetingDuration),
      summary: summary || ''
    });

    res.status(201).json(meeting);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/stats - Get summary statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await Meeting.getSummaryStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/by-type - Get meetings grouped by type
router.get('/by-type', async (req, res) => {
  try {
    const data = await Meeting.getByType();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/by-employee - Get meetings grouped by employee
router.get('/by-employee', async (req, res) => {
  try {
    const data = await Meeting.getByEmployee();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/types - Get meeting types from options
router.get('/types', async (req, res) => {
  try {
    const types = await AppOption.getValues('meetingTypes');
    res.json(types);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/employees - Get employees from options
router.get('/employees', async (req, res) => {
  try {
    const employees = await AppOption.getValues('meetingEmployees');
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CHART DATA ROUTES
// ============================================

// GET /api/meetings/charts/by-type - Meeting count and duration by type
router.get('/charts/by-type', async (req, res) => {
  try {
    const data = await Meeting.aggregate([
      { $group: {
        _id: '$type',
        count: { $sum: 1 },
        totalDuration: { $sum: '$meetingDuration' }
      }},
      { $sort: { totalDuration: -1 } }
    ]);

    res.json({
      labels: data.map(d => d._id),
      counts: data.map(d => d.count),
      durations: data.map(d => d.totalDuration)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/charts/by-employee - Meeting hours by employee
router.get('/charts/by-employee', async (req, res) => {
  try {
    const data = await Meeting.aggregate([
      { $group: {
        _id: '$employee',
        count: { $sum: 1 },
        totalDuration: { $sum: '$meetingDuration' }
      }},
      { $sort: { totalDuration: -1 } }
    ]);

    res.json({
      labels: data.map(d => d._id),
      counts: data.map(d => d.count),
      durations: data.map(d => d.totalDuration)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/charts/monthly-trend - Meetings over time by month
router.get('/charts/monthly-trend', async (req, res) => {
  try {
    const data = await Meeting.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' }
          },
          count: { $sum: 1 },
          totalDuration: { $sum: '$meetingDuration' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const labels = data.map(d => {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[d._id.month - 1]} ${d._id.year}`;
    });

    res.json({
      labels,
      counts: data.map(d => d.count),
      durations: data.map(d => d.totalDuration)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/charts/type-duration-avg - Average duration by meeting type
router.get('/charts/type-duration-avg', async (req, res) => {
  try {
    const data = await Meeting.aggregate([
      { $group: {
        _id: '$type',
        avgDuration: { $avg: '$meetingDuration' },
        count: { $sum: 1 }
      }},
      { $sort: { avgDuration: -1 } }
    ]);

    res.json({
      labels: data.map(d => d._id),
      averages: data.map(d => Math.round(d.avgDuration * 10) / 10),
      counts: data.map(d => d.count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/meetings/charts/weekly-distribution - Meetings by day of week
router.get('/charts/weekly-distribution', async (req, res) => {
  try {
    const data = await Meeting.aggregate([
      {
        $group: {
          _id: { $dayOfWeek: '$date' },
          count: { $sum: 1 },
          totalDuration: { $sum: '$meetingDuration' }
        }
      },
      { $sort: { '_id': 1 } }
    ]);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const result = dayNames.map((day, index) => {
      const dayData = data.find(d => d._id === index + 1);
      return {
        day,
        count: dayData ? dayData.count : 0,
        duration: dayData ? dayData.totalDuration : 0
      };
    });

    res.json({
      labels: result.map(r => r.day),
      counts: result.map(r => r.count),
      durations: result.map(r => r.duration)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PARAM ROUTES (must be last)
// ============================================

// GET /api/meetings/:id - Get single meeting by ID
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid meeting ID format' });
    }

    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    res.json(meeting);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/meetings/:id - Update a meeting
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid meeting ID format' });
    }

    const { date, type, employee, meetingDuration, summary } = req.body;

    const updateData = {};
    if (date !== undefined) updateData.date = new Date(date);
    if (type !== undefined) updateData.type = type;
    if (employee !== undefined) updateData.employee = employee;
    if (meetingDuration !== undefined) updateData.meetingDuration = parseFloat(meetingDuration);
    if (summary !== undefined) updateData.summary = summary;

    const meeting = await Meeting.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    res.json(meeting);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/meetings/:id - Delete a meeting
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid meeting ID format' });
    }

    const meeting = await Meeting.findByIdAndDelete(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    res.json({
      success: true,
      message: 'Meeting deleted successfully',
      deletedId: req.params.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

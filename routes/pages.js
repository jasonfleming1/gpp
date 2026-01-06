const express = require('express');
const router = express.Router();
const TfsTask = require('../models/TfsTask');

// GET / - Dashboard home page
router.get('/', async (req, res) => {
  try {
    const stats = await TfsTask.getSummaryStats();
    const recentTasks = await TfsTask.find({ totalActualHours: { $gt: 0 } })
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    res.render('home', {
      title: 'ASD Time Tracker',
      stats,
      recentTasks
    });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

// GET /tasks - Task list page
router.get('/tasks', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const filter = req.query.filter || 'all';
    const search = req.query.search || '';

    res.render('tasks', {
      title: 'ASD Tasks',
      currentPage: page,
      filter,
      search
    });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

// GET /tasks/:id - Task detail page
router.get('/tasks/:id', async (req, res) => {
  try {
    const task = await TfsTask.findOne({ tfsId: parseInt(req.params.id) });
    if (!task) {
      return res.status(404).render('error', { error: 'Task not found' });
    }

    res.render('task-detail', {
      title: `ASD ${task.tfsId}`,
      task
    });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

// GET /scorecard - Developer scorecard page
router.get('/scorecard', async (req, res) => {
  try {
    res.render('scorecard', {
      title: 'Developer Scorecard'
    });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

module.exports = router;

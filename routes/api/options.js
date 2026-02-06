const express = require('express');
const router = express.Router();
const AppOption = require('../../models/AppOption');

// GET /api/options - Get all option categories
router.get('/', async (req, res) => {
  try {
    const options = await AppOption.find().sort({ category: 1 }).lean();
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/options/:category - Get values for a specific category
router.get('/:category', async (req, res) => {
  try {
    const option = await AppOption.findOne({ category: req.params.category }).lean();
    if (!option) {
      return res.status(404).json({ error: 'Category not found' });
    }
    res.json(option);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/options/:category - Update values for a category
router.put('/:category', async (req, res) => {
  try {
    const { values } = req.body;

    if (!Array.isArray(values)) {
      return res.status(400).json({ error: 'Values must be an array' });
    }

    // Filter out empty strings and trim
    const cleaned = values.map(v => v.trim()).filter(v => v.length > 0);

    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'At least one value is required' });
    }

    const option = await AppOption.findOneAndUpdate(
      { category: req.params.category },
      { values: cleaned },
      { new: true }
    );

    if (!option) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json(option);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

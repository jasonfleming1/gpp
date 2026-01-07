require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gpp_tfs_tracker';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
const tfsApiRoutes = require('./routes/api/tfs');
const pageRoutes = require('./routes/pages');

app.use('/api/tfs', tfsApiRoutes);
app.use('/', pageRoutes);

// Developers API
const Developer = require('./models/Developer');
app.get('/api/developers', async (req, res) => {
  try {
    const developers = await Developer.find().sort({ lastName: 1, firstName: 1 }).lean();
    res.json(developers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { error: err.message });
});

// Database connection and server start
async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Also accessible on your local network at http://<your-ip>:${PORT}`);
      console.log('\nTo get started:');
      console.log('1. Click "Import Data" to load the Excel file');
      console.log('2. View tasks and add estimates/quality scores');
    });
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    console.log('\nMake sure MongoDB is running. You can:');
    console.log('1. Install MongoDB locally: https://www.mongodb.com/try/download/community');
    console.log('2. Or use MongoDB Atlas and set MONGODB_URI in .env file');
    process.exit(1);
  }
}

start();

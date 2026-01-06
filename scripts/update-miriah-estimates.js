const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gpp_tfs_tracker';

async function updateMiriahTasks() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const TfsTask = require('../models/TfsTask');

  // Find all tasks where Miriah Pooler has hours in developerBreakdown
  const tasks = await TfsTask.find({
    'developerBreakdown.Miriah Pooler': { $exists: true }
  });

  console.log(`Found ${tasks.length} tasks with Miriah Pooler entries`);

  let updated = 0;
  for (const task of tasks) {
    if (task.estimated !== task.totalActualHours) {
      const oldEstimate = task.estimated;
      task.estimated = task.totalActualHours;
      await task.save();
      updated++;
      console.log(`Updated task ${task.tfsId}: ${oldEstimate || 'null'} -> ${task.totalActualHours}`);
    }
  }

  console.log(`\nDone! Updated ${updated} tasks`);
  await mongoose.disconnect();
}

updateMiriahTasks().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

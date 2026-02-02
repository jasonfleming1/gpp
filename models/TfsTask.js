const mongoose = require('mongoose');

const timeEntrySchema = new mongoose.Schema({
  timekeeperNumber: { type: Number, required: true },
  lastName: { type: String, required: true },
  firstName: { type: String, required: true },
  title: String,
  workDate: { type: Date, required: true },
  workDateOnly: { type: String },  // Date-only string (YYYY-MM-DD)
  workHrs: { type: Number, required: true },
  narrative: String,
  activityCode: String,
  activityCodeDesc: String
});

const tfsTaskSchema = new mongoose.Schema({
  tfsId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  title: {
    type: String,
    default: ''
  },
  application: {
    type: String,
    default: null,
    index: true
  },
  estimated: {
    type: Number,
    default: null,
    min: 0
  },
  quality: {
    type: Number,
    default: null,
    min: 1,
    max: 5
  },
  timeEntries: [timeEntrySchema],
  totalActualHours: {
    type: Number,
    default: 0
  },
  developerBreakdown: {
    type: Map,
    of: Number,
    default: new Map()
  },
  // Per-date breakdown: { "Developer Name": { "2025-04-02": 8.5, "2025-04-03": 6.0 } }
  developerBreakdownByDate: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  }
}, {
  timestamps: true
});

// Virtual for variance (estimated - actual)
tfsTaskSchema.virtual('variance').get(function() {
  if (this.estimated === null) return null;
  return this.estimated - this.totalActualHours;
});

// Virtual for variance percentage
tfsTaskSchema.virtual('variancePercent').get(function() {
  if (this.estimated === null || this.estimated === 0) return null;
  return ((this.estimated - this.totalActualHours) / this.estimated * 100).toFixed(1);
});

// Method to recalculate totals from time entries
tfsTaskSchema.methods.recalculateTotals = function() {
  this.totalActualHours = this.timeEntries.reduce((sum, entry) => sum + entry.workHrs, 0);

  const breakdown = new Map();
  const breakdownByDate = new Map();

  this.timeEntries.forEach(entry => {
    const key = `${entry.firstName} ${entry.lastName}`;
    breakdown.set(key, (breakdown.get(key) || 0) + entry.workHrs);

    // Calculate per-date breakdown
    const dateStr = entry.workDateOnly || (entry.workDate ? new Date(entry.workDate).toISOString().split('T')[0] : null);
    if (dateStr) {
      if (!breakdownByDate.has(key)) {
        breakdownByDate.set(key, {});
      }
      const devDates = breakdownByDate.get(key);
      devDates[dateStr] = (devDates[dateStr] || 0) + entry.workHrs;
    }
  });

  this.developerBreakdown = breakdown;
  this.developerBreakdownByDate = breakdownByDate;

  return this;
};

// Static method to get average quality score
tfsTaskSchema.statics.getAverageQuality = async function() {
  const result = await this.aggregate([
    { $match: { quality: { $ne: null } } },
    { $group: { _id: null, avgQuality: { $avg: '$quality' }, count: { $sum: 1 } } }
  ]);
  return result.length > 0 ? result[0] : { avgQuality: 0, count: 0 };
};

// Static method to get summary stats
tfsTaskSchema.statics.getSummaryStats = async function() {
  const result = await this.aggregate([
    {
      $group: {
        _id: null,
        totalTasks: { $sum: 1 },
        tasksWithEstimates: { $sum: { $cond: [{ $ne: ['$estimated', null] }, 1, 0] } },
        tasksWithQuality: { $sum: { $cond: [{ $ne: ['$quality', null] }, 1, 0] } },
        totalEstimatedHours: { $sum: { $ifNull: ['$estimated', 0] } },
        totalActualHours: { $sum: '$totalActualHours' },
        avgQuality: { $avg: '$quality' },
        totalAdminHours: {
          $sum: { $cond: [{ $eq: ['$tfsId', 7300] }, '$totalActualHours', 0] }
        }
      }
    }
  ]);
  return result.length > 0 ? result[0] : {
    totalTasks: 0,
    tasksWithEstimates: 0,
    tasksWithQuality: 0,
    totalEstimatedHours: 0,
    totalActualHours: 0,
    avgQuality: null,
    totalAdminHours: 0
  };
};

tfsTaskSchema.set('toJSON', { virtuals: true });
tfsTaskSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('TfsTask', tfsTaskSchema);

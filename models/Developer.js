const mongoose = require('mongoose');

const developerSchema = new mongoose.Schema({
  timekeeperNumber: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  totalHours: {
    type: Number,
    default: 0
  },
  taskCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Virtual for full name
developerSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Static method to get developer stats
developerSchema.statics.getStats = async function() {
  return this.aggregate([
    {
      $group: {
        _id: null,
        totalDevelopers: { $sum: 1 },
        totalHours: { $sum: '$totalHours' },
        avgHoursPerDev: { $avg: '$totalHours' }
      }
    }
  ]);
};

developerSchema.set('toJSON', { virtuals: true });
developerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Developer', developerSchema);

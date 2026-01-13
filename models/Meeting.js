const mongoose = require('mongoose');

const meetingSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  type: {
    type: String,
    enum: ['1:1', 'ASD Standup', 'ASD Monthly', 'Requirements', 'Leadership', 'Steering', 'Design'],
    required: true
  },
  employee: {
    type: String,
    enum: ['ASD', 'Kevin Crabb', 'Jason Fleming', 'Miriah Pooler', 'Curtis Smith', 'Claus Michelsen', 'Amy Lake', 'Sales', 'Project Team'],
    required: true
  },
  meetingDuration: {
    type: Number,
    required: true,
    min: 0
  },
  summary: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Virtual for formatted date
meetingSchema.virtual('formattedDate').get(function() {
  if (!this.date) return null;
  return this.date.toISOString().split('T')[0];
});

// Virtual for month/year grouping
meetingSchema.virtual('monthYear').get(function() {
  if (!this.date) return null;
  const date = new Date(this.date);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
});

// Static method to get summary stats
meetingSchema.statics.getSummaryStats = async function() {
  const result = await this.aggregate([
    {
      $group: {
        _id: null,
        totalMeetings: { $sum: 1 },
        totalDuration: { $sum: '$meetingDuration' },
        avgDuration: { $avg: '$meetingDuration' }
      }
    }
  ]);
  return result.length > 0 ? result[0] : {
    totalMeetings: 0,
    totalDuration: 0,
    avgDuration: 0
  };
};

// Static method to get meetings by type
meetingSchema.statics.getByType = async function() {
  return this.aggregate([
    { $group: { _id: '$type', count: { $sum: 1 }, totalDuration: { $sum: '$meetingDuration' } } },
    { $sort: { count: -1 } }
  ]);
};

// Static method to get meetings by employee
meetingSchema.statics.getByEmployee = async function() {
  return this.aggregate([
    { $group: { _id: '$employee', count: { $sum: 1 }, totalDuration: { $sum: '$meetingDuration' } } },
    { $sort: { totalDuration: -1 } }
  ]);
};

meetingSchema.set('toJSON', { virtuals: true });
meetingSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Meeting', meetingSchema);

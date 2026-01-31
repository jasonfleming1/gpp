const mongoose = require('mongoose');

// Schema for file attachments
const attachmentSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true
  },
  originalName: {
    type: String,
    required: true
  },
  mimetype: {
    type: String
  },
  size: {
    type: Number
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const managerTaskSchema = new mongoose.Schema({
  rustId: {
    type: String,
    unique: true,
    sparse: true
  },
  date: {
    type: Date,
    default: null
  },
  attachments: [attachmentSchema],
  application: {
    type: String,
    enum: ['ASD Manager', 'CARMS', 'RSRS', 'namelessApp', 'DESI', 'DNN', 'MailgunAPI', 'Other', 'Portal', 'SmartScan', 'SmartKey', 'WebApp', 'Process', 'Administrative'],
    required: true
  },
  description: {
    type: String,
    required: true
  },
  release: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Not Started', 'In Progress', 'Closed'],
    default: 'Not Started'
  },
  qualityMeasure: {
    type: Number,
    enum: [1, 2, 3, 4, 5],
    default: null
  }
}, {
  timestamps: true
});

// Virtual for status badge class
managerTaskSchema.virtual('statusClass').get(function() {
  switch (this.status) {
    case 'Not Started': return 'warning';
    case 'In Progress': return 'info';
    case 'Closed': return 'success';
    default: return 'info';
  }
});

// Virtual for quality display
managerTaskSchema.virtual('qualityDisplay').get(function() {
  if (!this.qualityMeasure) return '-';
  return this.qualityMeasure;
});

// Static method to get summary stats
managerTaskSchema.statics.getSummaryStats = async function() {
  const result = await this.aggregate([
    {
      $group: {
        _id: null,
        totalTasks: { $sum: 1 },
        notStarted: { $sum: { $cond: [{ $eq: ['$status', 'Not Started'] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] }, 1, 0] } },
        closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } },
        avgQuality: { $avg: '$qualityMeasure' }
      }
    }
  ]);
  return result.length > 0 ? result[0] : {
    totalTasks: 0,
    notStarted: 0,
    inProgress: 0,
    closed: 0,
    avgQuality: null
  };
};

// Static method to get tasks by application
managerTaskSchema.statics.getByApplication = async function() {
  return this.aggregate([
    { $group: { _id: '$application', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
};

// Static method to get tasks by status
managerTaskSchema.statics.getByStatus = async function() {
  return this.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
};

managerTaskSchema.set('toJSON', { virtuals: true });
managerTaskSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ManagerTask', managerTaskSchema);

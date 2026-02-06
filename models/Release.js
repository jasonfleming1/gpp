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

// Schema for history snapshots
const releaseHistorySchema = new mongoose.Schema({
  application: String,
  releaseDate: Date,
  tqa: String,
  uat: String,
  prod: String,
  notes: String,
  changedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const releaseSchema = new mongoose.Schema({
  application: {
    type: String,
    required: true
  },
  releaseDate: {
    type: Date,
    default: null
  },
  tqa: {
    type: String,
    default: ''
  },
  uat: {
    type: String,
    default: ''
  },
  prod: {
    type: String,
    default: ''
  },
  notes: {
    type: String,
    default: ''
  },
  attachments: [attachmentSchema],
  history: [releaseHistorySchema]
}, {
  timestamps: true
});

// Virtual for display of version or dash
releaseSchema.virtual('tqaDisplay').get(function() {
  return this.tqa || '-';
});

releaseSchema.virtual('uatDisplay').get(function() {
  return this.uat || '-';
});

releaseSchema.virtual('prodDisplay').get(function() {
  return this.prod || '-';
});

releaseSchema.virtual('releaseDateFormatted').get(function() {
  return this.releaseDate ? this.releaseDate.toLocaleDateString() : '-';
});

// Method to create a history snapshot
releaseSchema.methods.createSnapshot = function() {
  this.history.push({
    application: this.application,
    releaseDate: this.releaseDate,
    tqa: this.tqa,
    uat: this.uat,
    prod: this.prod,
    notes: this.notes,
    changedAt: new Date()
  });
};

// Static method to get summary stats
releaseSchema.statics.getSummaryStats = async function() {
  const result = await this.aggregate([
    {
      $group: {
        _id: null,
        totalReleases: { $sum: 1 },
        withTqa: { $sum: { $cond: [{ $and: [{ $ne: ['$tqa', ''] }, { $ne: ['$tqa', null] }] }, 1, 0] } },
        withUat: { $sum: { $cond: [{ $and: [{ $ne: ['$uat', ''] }, { $ne: ['$uat', null] }] }, 1, 0] } },
        withProd: { $sum: { $cond: [{ $and: [{ $ne: ['$prod', ''] }, { $ne: ['$prod', null] }] }, 1, 0] } }
      }
    }
  ]);
  return result.length > 0 ? result[0] : {
    totalReleases: 0,
    withTqa: 0,
    withUat: 0,
    withProd: 0
  };
};

// Static method to get releases by application
releaseSchema.statics.getByApplication = async function() {
  return this.aggregate([
    { $group: { _id: '$application', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
};

releaseSchema.set('toJSON', { virtuals: true });
releaseSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Release', releaseSchema);

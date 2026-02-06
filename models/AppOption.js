const mongoose = require('mongoose');

const appOptionSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  label: {
    type: String,
    required: true
  },
  values: [{
    type: String,
    required: true
  }]
}, {
  timestamps: true
});

// Seed default options if they don't exist
appOptionSchema.statics.seedDefaults = async function() {
  const defaults = [
    {
      category: 'applications',
      label: 'Applications',
      values: ['ASD Manager', 'CARMS', 'RSRS', 'namelessApp', 'DESI', 'DNN', 'MailgunAPI', 'Other', 'Portal', 'SmartScan', 'SmartKey', 'WebApp', 'Process', 'Administrative']
    },
    {
      category: 'taskStatuses',
      label: 'Task Statuses',
      values: ['Not Started', 'In Progress', 'Closed']
    },
    {
      category: 'meetingTypes',
      label: 'Meeting Types',
      values: ['1:1', 'ASD Standup', 'ASD Monthly', 'Requirements', 'Leadership', 'Steering', 'Design']
    },
    {
      category: 'meetingEmployees',
      label: 'Meeting Employees',
      values: ['ASD', 'Kevin Crabb', 'Jason Fleming', 'Miriah Pooler', 'Curtis Smith', 'Naga Surapaneni', 'Claus Michelsen', 'Amy Lake', 'Sales', 'Project Team']
    }
  ];

  for (const opt of defaults) {
    await this.findOneAndUpdate(
      { category: opt.category },
      { $setOnInsert: opt },
      { upsert: true }
    );
  }
};

// Get values for a specific category
appOptionSchema.statics.getValues = async function(category) {
  const option = await this.findOne({ category }).lean();
  return option ? option.values : [];
};

module.exports = mongoose.model('AppOption', appOptionSchema);

// models/Billboard.js
const mongoose = require('mongoose');

const BillboardSchema = new mongoose.Schema({
  message: String,
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Billboard', BillboardSchema);

// models/File.js
const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
  originalName: String,
  filename: String,
  url: { type: String, required: true },
  type: { type: String, enum: ['images','videos','audio','pdfs','other'], default: 'other' },
  mimeType: String,
  size: Number,
  publicId: String,
  uploadedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('File', FileSchema);

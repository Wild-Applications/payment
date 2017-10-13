var mongoose = require('mongoose');

var schema = new mongoose.Schema({
  owner: { type : Number, required : true, index: true},
  customer: { type: String, required: true, index: true }
}, {
  timestamps: true
});


module.exports = mongoose.model('Customer', schema);

var mongoose = require('mongoose');

var schema = new mongoose.Schema({
  owner: { type : Number, required : true, index: true, unique: true},
  stripe_id: { type: String, required: true, index: true }
}, {
  timestamps: true
});


module.exports = mongoose.model('Premises', schema);

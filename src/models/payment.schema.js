var mongoose = require('mongoose');

var schema = new mongoose.Schema({
  stripe_id: { type: String, required: true, index: true },
  order: { type: String, required: true, index: true },
  captured: { type: Boolean, required: true, default: false, index: true},
  refunded: { type: Boolean, required: true, default: false, index: true}
}, {
  timestamps: true
});


module.exports = mongoose.model('Payment', schema);

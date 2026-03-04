// Sample model
const mongoose = require('mongoose');

const ExampleSchema = new mongoose.Schema({
    name: String,
    value: Number,
});

module.exports = mongoose.model('Example', ExampleSchema);
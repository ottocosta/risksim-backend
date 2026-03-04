// routes/analysis.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

// Set your Claude API key here
const CLAUDE_API_KEY = 'YOUR_CLAUDE_API_KEY';

// Endpoint for country risk assessment
router.get('/country-risk/:country', async (req, res) => {
    const country = req.params.country;
    try {
        const response = await axios.post('https://claude.api.endpoint/country-risk', {
            country: country
        }, {
            headers: { 'Authorization': `Bearer ${CLAUDE_API_KEY}` }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint for news data integration
router.get('/news/:topic', async (req, res) => {
    const topic = req.params.topic;
    try {
        const response = await axios.post('https://claude.api.endpoint/news', {
            topic: topic
        }, {
            headers: { 'Authorization': `Bearer ${CLAUDE_API_KEY}` }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

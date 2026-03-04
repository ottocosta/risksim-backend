const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { analyzeSupplierRisk, generateRecommendedQuestions } = require('./utils/claudeService');
const countryData = require('./utils/countryData');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.post('/api/analyze', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }
        const analysis = await analyzeSupplierRisk(query, countryData);
        const recommendations = await generateRecommendedQuestions(query);
        res.json({ analysis, recommendedQuestions: recommendations });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/countries', (req, res) => {
    res.json(countryData);
});

app.get('/api/country/:name', (req, res) => {
    const country = req.params.name;
    if (countryData[country]) {
        res.json(countryData[country]);
    } else {
        res.status(404).json({ error: 'Country not found' });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        const response = await analyzeSupplierRisk(message, countryData);
        res.json({ response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'RiskSim Backend is running' });
});

app.listen(PORT, () => {
    console.log(`RiskSim Backend running on port ${PORT}`);
});

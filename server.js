const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const countryData = {
    'Vietnam': { tariff: 8, regulatory: 6, currency: 5, geopolitical: 'Stable' },
    'China': { tariff: 12, regulatory: 8, currency: 7, geopolitical: 'Tense' },
    'India': { tariff: 10, regulatory: 7, currency: 6, geopolitical: 'Stable' },
    'Thailand': { tariff: 7, regulatory: 5, currency: 4, geopolitical: 'Stable' },
    'Indonesia': { tariff: 9, regulatory: 6, currency: 5, geopolitical: 'Stable' },
    'Philippines': { tariff: 8, regulatory: 6, currency: 4, geopolitical: 'Stable' },
    'USA': { tariff: 3, regulatory: 2, currency: 1, geopolitical: 'Stable' },
    'Canada': { tariff: 2, regulatory: 2, currency: 2, geopolitical: 'Stable' },
    'Mexico': { tariff: 4, regulatory: 3, currency: 3, geopolitical: 'Moderate' },
    'Brazil': { tariff: 11, regulatory: 7, currency: 8, geopolitical: 'Moderate' },
    'Germany': { tariff: 2, regulatory: 1, currency: 1, geopolitical: 'Stable' },
    'UK': { tariff: 3, regulatory: 2, currency: 3, geopolitical: 'Stable' },
    'Japan': { tariff: 5, regulatory: 3, currency: 4, geopolitical: 'Stable' },
    'South Korea': { tariff: 6, regulatory: 4, currency: 5, geopolitical: 'Moderate' },
    'Singapore': { tariff: 1, regulatory: 1, currency: 2, geopolitical: 'Stable' }
};

app.post('/api/analysis/calculate', (req, res) => {
    const { productCost, sellingPrice, shippingCost = 0, country } = req.body;
    if (!productCost || !sellingPrice || !country) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const countryInfo = countryData[country];
    if (!countryInfo) {
        return res.status(400).json({ error: 'Country not found' });
    }
    const baseMargin = ((sellingPrice - productCost - shippingCost) / sellingPrice) * 100;
    const totalRisk = (countryInfo.tariff + countryInfo.regulatory + countryInfo.currency) / 3;
    const riskAdjustedMargin = baseMargin - (totalRisk * 0.5);
    res.json({
        baseMargin: parseFloat(baseMargin.toFixed(2)),
        riskAdjustedMargin: parseFloat(riskAdjustedMargin.toFixed(2)),
        riskScore: parseFloat(totalRisk.toFixed(2)),
        country,
        tariffRisk: countryInfo.tariff,
        regulatoryRisk: countryInfo.regulatory,
        currencyVolatility: countryInfo.currency,
        geopoliticalAlert: countryInfo.geopolitical,
        recommendation: riskAdjustedMargin > 20 ? 'Strong Buy' : riskAdjustedMargin > 10 ? 'Buy' : 'Reconsider'
    });
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'RiskSim Backend is running!' });
});

app.listen(PORT, () => {
    console.log(`RiskSim Backend running on port ${PORT}`);
});
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Allow iframe embedding from Shopify
app.use((req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', '');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// n8n DATA STORE — in-memory, resets on deploy
// ============================================================
const dataStore = {
    alerts: [],
    tariffs: [],
    ports: [],
    commodities: [],
    currency: [],
    alertsByIndustry: {
        technology: [],
        textiles: [],
        automotive: [],
        food: [],
        pharma: [],
        rawMaterials: [],
        consumerGoods: [],
        general: []
    }
};

// Auth middleware for n8n POST routes
function requireDataKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!process.env.DATA_API_KEY || key !== process.env.DATA_API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
}

// ---------- POST routes (n8n pushes data here) ----------

app.post('/api/data/alerts', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.alerts = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} alerts (general)`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/alerts/:industry', requireDataKey, (req, res) => {
    const industry = req.params.industry;
    const valid = Object.keys(dataStore.alertsByIndustry);
    if (!valid.includes(industry)) {
        return res.status(400).json({ error: 'Invalid industry. Valid: ' + valid.join(', ') });
    }
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.alertsByIndustry[industry] = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} alerts for: ${industry}`);
    res.json({ success: true, count: items.length, industry });
});

app.post('/api/data/tariffs', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.tariffs = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} tariffs`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/ports', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.ports = items.slice(0, 50);
    console.log(`[n8n] Received ${items.length} ports`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/commodities', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.commodities = items.slice(0, 50);
    console.log(`[n8n] Received ${items.length} commodities`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/currency', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.currency = items.slice(0, 30);
    console.log(`[n8n] Received ${items.length} currency rates`);
    res.json({ success: true, count: items.length });
});

// ---------- GET routes (frontend reads from here) ----------

app.get('/api/data/alerts', (req, res) => {
    res.json(dataStore.alerts);
});

app.get('/api/data/alerts/:industry', (req, res) => {
    const industry = req.params.industry;
    const industryData = dataStore.alertsByIndustry[industry];
    if (industryData && industryData.length > 0) {
        return res.json(industryData);
    }
    if (dataStore.alertsByIndustry.general && dataStore.alertsByIndustry.general.length > 0) {
        return res.json(dataStore.alertsByIndustry.general);
    }
    res.json(dataStore.alerts);
});

app.get('/api/data/tariffs', (req, res) => {
    res.json(dataStore.tariffs);
});

app.get('/api/data/ports', (req, res) => {
    res.json(dataStore.ports);
});

app.get('/api/data/commodities', (req, res) => {
    res.json(dataStore.commodities);
});

app.get('/api/data/currency', (req, res) => {
    res.json(dataStore.currency);
});

app.get('/api/data/status', (req, res) => {
    const industryCounts = {};
    for (const [key, val] of Object.entries(dataStore.alertsByIndustry)) {
        industryCounts[key] = val.length;
    }
    res.json({
        status: 'ok',
        counts: {
            alerts: dataStore.alerts.length,
            alertsByIndustry: industryCounts,
            tariffs: dataStore.tariffs.length,
            ports: dataStore.ports.length,
            commodities: dataStore.commodities.length,
            currency: dataStore.currency.length
        },
        lastChecked: new Date().toISOString()
    });
});

// ============================================================
// EXISTING ROUTES — Chat + Audit
// ============================================================

function buildSystemPrompt(profile) {
    let prompt = 'You are Jarvis, the AI assistant inside RiskSim AI. You are a world-class supply chain intelligence system. ' +
'Speak in short, natural sentences. Address the user as "sir" or "ma\'am" at all times. ' +
'IMPORTANT: Never use markdown formatting of any kind. Never use **asterisks**, never use bullet points, never use dashes as lists, never use headers. Write in plain sentences only, like you are speaking out loud. ' +
'If a response would be long, give a brief spoken summary and say "for a full breakdown, I recommend reviewing the chat." ' +
'Be confident, calm, and precise — like Jarvis from Iron Man.\n\n' +

'SCORING SYSTEM:\n' +
'Political/Operational Risk Score (0-100, higher = more risky): measures geopolitical instability, corruption, logistics, conflict.\n' +
'Sourcing Attractiveness Score (0-100, higher = better): measures manufacturing capacity, supplier ecosystem, lead times, specialization.\n\n' +

'Industry sourcing scores:\n' +
'Technology: China 95, Taiwan 95, South Korea 88, Japan 88, Malaysia 60, Vietnam 55.\n' +
'Textiles/Apparel: Bangladesh 88, Vietnam 85, China 75, India 70, Turkey 70, Cambodia 65.\n' +
'Automotive: Germany 95, Japan 92, Mexico 88, South Korea 80, Czech Republic 72, Slovakia 68.\n' +
'Pharmaceuticals: India 92, Ireland 88, Switzerland 85, United States 70, Germany 65.\n' +
'General Manufacturing: China 95, Germany 78, Mexico 78, India 72, United States 65.\n' +
'Consumer Goods: China 92, India 65, Vietnam 62, Thailand 55, Indonesia 45.\n\n' +

'When asked about sourcing, comparisons, or where to source from, reference these scores naturally in conversation.';

    if (profile && (profile.companyType || profile.homeCountry || profile.industry)) {
        prompt += '\n\n## User Company Profile\n';
        if (profile.companyName) prompt += `- **Company Name**: ${profile.companyName}\n`;
        if (profile.companyType) prompt += `- **Company Type**: ${profile.companyType}\n`;
        if (profile.homeCountry) prompt += `- **Home Country / HQ**: ${profile.homeCountry}\n`;
        if (profile.industry) prompt += `- **Industry**: ${profile.industry}\n`;
        if (profile.sourcingCountries && profile.sourcingCountries.length > 0) {
            prompt += `- **Primary Sourcing Countries**: ${profile.sourcingCountries.join(', ')}\n`;
        }
        if (profile.revenue) prompt += `- **Annual Revenue Range**: ${profile.revenue}\n`;
        if (profile.employees) prompt += `- **Company Size**: ${profile.employees} employees\n`;
        if (profile.products) prompt += `- **Main Products/Services**: ${profile.products}\n`;
        if (profile.suppliers) prompt += `- **Key Suppliers**: ${profile.suppliers}\n`;
        if (profile.concern) {
            const concernLabels = {
                geopolitical: 'Geopolitical Risk',
                disruption: 'Supply Disruption',
                tariffs: 'Tariffs & Trade Policy',
                labor: 'Labor & ESG',
                climate: 'Climate Risk',
                quality: 'Quality Control',
                cost: 'Cost Optimization'
            };
            prompt += `- **Primary Concern**: ${concernLabels[profile.concern] || profile.concern}\n`;
        }
        if (profile.businessDescription) prompt += `- **Additional Context**: ${profile.businessDescription}\n`;
        prompt += '\nYou know this company well. Always tailor your analysis to their specific situation. ' +
            'Reference their products, suppliers, sourcing countries, and primary concerns in your answers. ' +
            'When they ask about risks, focus on risks to THEIR specific supply chain. ' +
            'When they ask about costs, reference THEIR sourcing regions and industry. ' +
            'When they ask about suppliers, consider THEIR listed key suppliers. ' +
            'Make every response feel like it was written specifically for this company, not generic advice.';
    }

    return prompt;
}

app.post('/api/chat', async (req, res) => {
    try {
        const { message, messages, profile } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const history = Array.isArray(messages) ? messages.slice(-20) : [];
        const allMessages = [...history, { role: 'user', content: message }];

        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            system: buildSystemPrompt(profile),
            messages: allMessages
        });

        const reply = response.content[0]?.text || 'No response';
        res.json({ reply });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/audit-custom', async (req, res) => {
    try {
        const { supplierName, context, profile } = req.body;

        if (!supplierName || supplierName.trim().length === 0) {
            return res.status(400).json({ error: 'Supplier name is required' });
        }

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const systemPrompt = `You are a supply chain risk intelligence analyst for RiskSim AI. You generate detailed supplier risk audits based on available information. You must ALWAYS respond with valid JSON only — no markdown, no backticks, no explanation text outside the JSON.

Your analysis should be thorough, professional, and data-driven. When you have limited information about a supplier, use reasonable estimates based on the country, industry, company size, and general risk factors for that region. Be honest about confidence levels.

Always respond in this exact JSON format:
{
  "supplierName": "Full Company Name",
  "country": "Country of origin",
  "industry": "Industry/sector",
  "founded": "Year or estimate",
  "employees": "Estimate range",
  "riskScore": 45,
  "confidence": "high/medium/low",
  "metrics": {
    "fraudRisk": { "score": 35, "change": -5, "summary": "Brief 1-sentence assessment" },
    "financialStability": { "score": 62, "change": 3, "summary": "Brief 1-sentence assessment" },
    "supplyReliability": { "score": 58, "change": -2, "summary": "Brief 1-sentence assessment" },
    "compliance": { "score": 71, "change": 1, "summary": "Brief 1-sentence assessment" }
  },
  "summary": "A detailed 150-200 word executive summary analyzing the supplier's overall risk profile, key strengths, vulnerabilities, and contextual factors affecting their risk rating. Reference specific geopolitical, economic, or industry factors.",
  "recommendations": [
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" },
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" },
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" }
  ],
  "alternativeSuppliers": [
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" },
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" },
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" }
  ],
  "riskFactors": ["Specific risk factor 1", "Specific risk factor 2", "Specific risk factor 3"],
  "strengths": ["Specific strength 1", "Specific strength 2"]
}

Risk score ranges: 0-14 Low risk, 15-29 Low-Medium, 30-44 Medium, 45-59 Medium-High, 60-79 High, 80-100 Critical.
Score realistically based on country risk, industry, company size, and known information.`;

        const userMessage = `Generate a comprehensive supply chain risk audit for this supplier:

Supplier Name: ${supplierName.trim()}
${context ? 'Additional Context: ' + context : ''}
${profile && profile.industry ? 'Requesting Company Industry: ' + profile.industry : ''}
${profile && profile.sourcingCountries ? 'Requesting Company Sourcing Countries: ' + profile.sourcingCountries.join(', ') : ''}

Analyze this supplier thoroughly. If you have knowledge about this company, use it. If this is a smaller or unknown company, make reasonable assessments based on the country, industry, and any context provided.`;

        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        });

        const rawText = response.content[0].text;

        let auditData;
        try {
            const cleanText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            auditData = JSON.parse(cleanText);
        } catch (parseError) {
            console.error('Failed to parse audit JSON:', parseError);
            return res.status(500).json({ error: 'Failed to parse audit data' });
        }

        res.json({ audit: auditData });

    } catch (error) {
        console.error('Custom audit error:', error);
        res.status(500).json({ error: 'Failed to generate audit. Please try again.' });
    }
});

app.listen(PORT, () => console.log(`RiskSim running on ${PORT}`));

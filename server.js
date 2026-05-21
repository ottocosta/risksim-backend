const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
    contentSecurityPolicy: false, // managed below per-route
    crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', 'https://risksim.ai');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Heavy Claude endpoints — audit and price extraction
const claudeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

// Chat endpoint — needs more room for conversations
const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: 'Too many requests, please try again later.' }
});

// General limit on all routes
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(generalLimiter);
app.use('/api/audit-custom', claudeLimiter);
app.use('/api/price-extract', claudeLimiter);
app.use('/api/chat', chatLimiter);

// Input sanitisation helper — strips HTML tags
function stripHtml(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/<[^>]*>/g, '').trim();
}

const MAX_INPUT = 5000;

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

// ============================================================
// EMAIL SUBSCRIBER STORE — in-memory, resets on deploy
// ============================================================
const emailSubscribers = {};
// Format: { "user@email.com": { email, industry, sourcingCountries, companyName, preferences: { weeklyDigest, criticalAlerts }, subscribedAt, updatedAt } }

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
    let prompt = 'You are Risksim, the AI assistant inside RiskSim AI. You are a world-class supply chain intelligence system. ' +
'Speak in short, natural sentences.' +
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

'When asked about sourcing, comparisons, or where to source from, reference these scores naturally in conversation.' +

'\n\nSTRUCTURED INCIDENT CARDS (the ONLY exception to the plain text rule above):\n' +
'When a question is specifically about an active supply chain disruption — a port closure, typhoon, strike, factory shutdown, logistics incident, or similar real-time event that directly affects the user\'s sourcing regions or named suppliers — append the following block on a new line AFTER your complete spoken response. Do not alter your spoken response; only add the block after it. The user never sees this block; it drives UI rendering only.\n\n' +
'Format (copy exactly, including the sentinel lines):\n' +
'[BLOCKS_START]\n' +
'[{"type":"incident_card","data":{"severity":"P1","category":"logistics","title":"<event title, max 60 chars>","subtitle":"<one-line event summary, max 60 chars>","location":{"display":"<REGION · LOCATION, uppercase, max 25 chars, e.g. SOUTH CHINA · YANTIAN>","primary":"<primary marker name, uppercase, e.g. YANTIAN>","sub":"<sub label, uppercase, e.g. SHENZHEN>","region":"<south_china|red_sea|na_east_coast|northern_europe|mediterranean>"},"direct_exposure_usd":<estimated USD number, use 0 if unknown>,"affected_pos_count":<estimated count, use 0 if unknown>,"suppliers_hit":[{"name":"<supplier name relevant to user profile or disruption location>","exposure_usd":<number, use 0 if unknown>}],"delay_risk":"<e.g. 9-14 days to North America DCs>","recommended_action":{"text":"<one concrete sentence recommending an action>","impact_estimate":"<brief estimated benefit, e.g. Saves ~$180K in delay costs>","cta_label":"Run mitigation"},"recommendedActions":[{"text":"<action description, plain text only, no HTML or asterisks, max 120 chars>","impact":"<primary impact tag, e.g. Preserves $X · saves Y>","impact2":"<optional second impact line for item 0 only>","cta":"<button label, uppercase, max 20 chars, e.g. INITIATE REROUTE>"},{"text":"<second action, plain text>","impact":"<impact>","cta":"<button label>"},{"text":"<third action, plain text>","impact":"<impact>","cta":"<button label>"}]}},{"type":"follow_up_chips","options":["<3-6 word chip>","<3-6 word chip>","<3-6 word chip>"]}]\n' +
'[BLOCKS_END]\n\n' +
'When you include an incident_card, the location field is required. Use short uppercase labels: display is REGION · LOCATION (max 25 chars), primary is the port or city name, sub is the broader city or region. When you include the location field, region must also be included alongside display, primary, and sub. Use south_china for incidents in mainland China, Hong Kong, Taiwan, or the Pearl River Delta. Use red_sea for incidents in the Suez Canal, Egypt, Eastern Mediterranean, Gulf of Aden, or Arabian Peninsula. Use na_east_coast for incidents in US East Coast ports: Newark, NY, Norfolk, Charleston, Savannah, Baltimore, etc. Use northern_europe for incidents in North Sea ports: Rotterdam, Hamburg, Antwerp, Felixstowe, Bremerhaven, etc. Use mediterranean for incidents in Mediterranean ports: Piraeus, Genoa, Valencia, Algeciras, Trieste, etc.\n\n' +
'When you include an incident_card, recommendedActions (exactly 3 items) is required. Action text must be plain text — no HTML, no asterisks, no markdown. Prioritize concrete supply chain actions: rerouting POs, holding shipments, notifying suppliers. impact2 is optional and for item 0 only.\n\n' +
'When to append a block — YES:\n' +
'  - "Typhoon hitting Yantian port, what\'s my exposure?"\n' +
'  - "There\'s a port strike in Shanghai — how does that affect me?"\n' +
'  - "I heard the Red Sea shipping lanes are disrupted"\n\n' +
'When NOT to append a block — NO:\n' +
'  - General risk questions: "What are my biggest risks?"\n' +
'  - Sourcing comparisons: "Should I source from Vietnam or China?"\n' +
'  - Tariff or strategy questions: "How do I reduce costs?"\n' +
'  - Vague or casual questions: "What\'s the vibe of supply chain?"\n' +
'  - Identity questions: "Who are you?"\n\n' +
'If uncertain whether a question warrants a block, do NOT include one. Err on the side of plain text.';

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
        let { message, messages, profile } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0)
            return res.status(400).json({ error: 'Message required' });
        if (message.length > MAX_INPUT)
            return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
        message = stripHtml(message);

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

        const rawText = response.content[0]?.text || 'No response';
        let reply = rawText;
        let blocks = [];
        const blockStart = rawText.indexOf('[BLOCKS_START]');
        if (blockStart !== -1) {
            reply = rawText.slice(0, blockStart).trim();
            const blockEnd = rawText.indexOf('[BLOCKS_END]', blockStart);
            if (blockEnd !== -1) {
                try {
                    blocks = JSON.parse(rawText.slice(blockStart + 14, blockEnd).trim());
                } catch (e) {
                    console.error('blocks parse error:', e.message);
                    blocks = [];
                }
            }
        }
        res.json({ reply, blocks });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/audit-custom', async (req, res) => {
    try {
        let { supplierName, context, profile } = req.body;

        if (!supplierName || typeof supplierName !== 'string' || supplierName.trim().length === 0)
            return res.status(400).json({ error: 'Supplier name is required' });
        if (supplierName.length > MAX_INPUT)
            return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
        supplierName = stripHtml(supplierName);
        if (context) {
            if (context.length > MAX_INPUT)
                return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
            context = stripHtml(context);
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

Risk score ranges: 0-14 Low risk, 15-29 Low-Medium, 30-44 Medium, 45-59 Medium-High, 60-84 High, 85-100 Critical. Only assign Critical for active conflict zones, complete port shutdowns, or government-imposed trade bans directly affecting the supplier.
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

app.post('/api/price-extract', async (req, res) => {
    try {
        let { fileType, fileName, fileData, fileContent, mimeType } = req.body;

        if (!fileType || typeof fileType !== 'string' || fileType.trim().length === 0)
            return res.status(400).json({ error: 'fileType required' });
        fileType = stripHtml(fileType);
        if (fileName) fileName = stripHtml(fileName);
        if (fileContent) {
            if (fileContent.length > MAX_INPUT)
                return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
            fileContent = stripHtml(fileContent);
        }

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const systemPrompt = `You are a pricing data extraction specialist. Extract all pricing information from the provided document and return ONLY valid JSON — no markdown, no backticks, no text outside the JSON.

Return this exact format:
{
  "manufacturer": "Company or brand name if identifiable, else null",
  "effectiveDate": "Date string if found, else null",
  "currency": "USD or detected currency",
  "items": [
    {
      "partNumber": "Part or SKU number",
      "description": "Item description",
      "oldPrice": 0.00,
      "newPrice": 0.00,
      "unit": "each/kg/box/etc"
    }
  ],
  "summary": {
    "totalItems": 0,
    "avgChangePercent": 0.0,
    "largestIncrease": 0.0,
    "smallestChange": 0.0,
    "increasedCount": 0,
    "decreasedCount": 0,
    "unchangedCount": 0
  }
}

If oldPrice is not present in the document, set oldPrice to null. Extract every line item you can find. Be thorough.`;

        let messageContent;

        if (fileType === 'pdf') {
            messageContent = [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: fileData
                    }
                },
                {
                    type: 'text',
                    text: `Extract all pricing data from this document: ${fileName}`
                }
            ];
        } else if (fileType === 'csv' || fileType === 'text') {
            messageContent = `Extract all pricing data from this file (${fileName}):\n\n${fileContent}`;
        } else {
            // Excel or other binary — send as base64 with description
            messageContent = [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: mimeType || 'application/octet-stream',
                        data: fileData
                    }
                },
                {
                    type: 'text',
                    text: `Extract all pricing data from this spreadsheet: ${fileName}`
                }
            ];
        }

        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: 'user', content: messageContent }]
        });

        const rawText = response.content[0].text;

        let extracted;
        try {
            const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            extracted = JSON.parse(clean);
        } catch (e) {
            console.error('Price extract parse error:', e);
            return res.status(500).json({ error: 'Failed to parse extracted data' });
        }

        // Compute change percents server-side
        if (extracted.items) {
            extracted.items = extracted.items.map(item => {
                const change = (item.oldPrice != null && item.oldPrice !== 0)
                    ? ((item.newPrice - item.oldPrice) / item.oldPrice * 100)
                    : null;
                return { ...item, changePercent: change !== null ? parseFloat(change.toFixed(2)) : null };
            });
        }

        res.json({ data: extracted });
    } catch (error) {
        console.error('Price extract error:', error);
        res.status(500).json({ error: 'Failed to extract pricing data. Please try again.' });
    }
});

// ============================================================
// SYS_06 COST ENGINE — Exchange Rates + Landed Cost Calculator
// ============================================================

const FX_FALLBACK = {
    USD:1, EUR:0.92, GBP:0.79, CNY:7.24, JPY:149.5, KRW:1380, INR:84.5,
    VND:25400, THB:34.8, MXN:17.2, BRL:5.15, TWD:32.5, BDT:121, TRY:36.5,
    CAD:1.37, AUD:1.55, CHF:0.88, SGD:1.35, MYR:4.72, IDR:15800,
    PHP:56.5, PKR:278, CZK:23.5, ZAR:18.2, CLP:950, ILS:3.65,
    PLN:4.05, SEK:10.5, NOK:10.8, DKK:6.88, HKD:7.82, NZD:1.68
};

app.get('/api/exchange-rates', async (req, res) => {
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 4000 });
        res.json({ rates: response.data.rates, base: 'USD', updated: response.data.date });
    } catch (error) {
        res.json({ rates: FX_FALLBACK, base: 'USD', updated: new Date().toISOString().split('T')[0], fallback: true });
    }
});

app.post('/api/landed-cost', async (req, res) => {
    try {
        const {
            productName, unitPrice, unitCurrency, quantity,
            weightPerUnit, weightUnit, hsCode, productCategory,
            containerType, shippingMode, incoterms,
            destinationCountry, originCountries,
            insuranceRate, brokerFee, hmfRate, mpfRate,
            inlandTransport, resultCurrency
        } = req.body;

        if (!unitPrice || !originCountries || originCountries.length === 0) {
            return res.status(400).json({ error: 'Unit price and at least one origin country required' });
        }

        let rates = FX_FALLBACK;
        try {
            const fxRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 3000 });
            rates = fxRes.data.rates;
        } catch (e) { /* use fallback */ }

        const SHIPPING_RATES = {
            sea:  { Asia:0.15, Europe:0.18, Americas:0.12, Africa:0.22, default:0.17 },
            air:  { Asia:3.50, Europe:3.80, Americas:2.80, Africa:4.50, default:3.50 },
            rail: { Asia:0.45, Europe:0.55, Americas:0.40, Africa:null,  default:0.50 },
            road: { Asia:0.35, Europe:0.30, Americas:0.25, Africa:0.45, default:0.35 }
        };
        const TRANSIT = {
            sea:  { Asia:28, Europe:18, Americas:8,  Africa:32, default:25 },
            air:  { Asia:4,  Europe:3,  Americas:2,  Africa:5,  default:4  },
            rail: { Asia:18, Europe:14, Americas:5,  Africa:null,default:15},
            road: { Asia:null,Europe:8, Americas:4,  Africa:null,default:6 }
        };
        const REGIONS = {
            China:'Asia',Taiwan:'Asia',Vietnam:'Asia',India:'Asia','South Korea':'Asia',
            Japan:'Asia',Thailand:'Asia',Malaysia:'Asia',Indonesia:'Asia',Bangladesh:'Asia',
            Cambodia:'Asia',Philippines:'Asia',Myanmar:'Asia',Pakistan:'Asia','Sri Lanka':'Asia',
            Germany:'Europe',France:'Europe',Italy:'Europe',Spain:'Europe',Netherlands:'Europe',
            Belgium:'Europe',Poland:'Europe','Czech Republic':'Europe',Slovakia:'Europe',
            Turkey:'Europe',Ireland:'Europe',Switzerland:'Europe','United Kingdom':'Europe',
            Sweden:'Europe',Norway:'Europe',Israel:'Europe',
            Mexico:'Americas',Brazil:'Americas',Canada:'Americas',Chile:'Americas',
            Colombia:'Americas',Argentina:'Americas',
            'South Africa':'Africa',Ethiopia:'Africa',Nigeria:'Africa',
            Australia:'Asia'
        };
        const TARIFFS = {
            technology:{ China:{mfn:3.4,add:25,ad:0},Taiwan:{mfn:2.8,add:0,ad:0},'South Korea':{mfn:0,add:0,ad:0},Vietnam:{mfn:3.2,add:5,ad:0},Japan:{mfn:0,add:0,ad:0},Malaysia:{mfn:2.5,add:0,ad:0},India:{mfn:3.8,add:10,ad:0},Germany:{mfn:1.5,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},Thailand:{mfn:3.0,add:3,ad:0},Bangladesh:{mfn:4,add:0,ad:0},Indonesia:{mfn:3.5,add:0,ad:0} },
            textiles:{ China:{mfn:12,add:25,ad:0},Bangladesh:{mfn:16,add:0,ad:0},Vietnam:{mfn:12,add:0,ad:0},India:{mfn:14,add:5,ad:0},Turkey:{mfn:10,add:0,ad:0},Cambodia:{mfn:14,add:0,ad:0},Indonesia:{mfn:13,add:0,ad:0},Pakistan:{mfn:11,add:0,ad:0} },
            automotive:{ China:{mfn:2.5,add:25,ad:0},Germany:{mfn:2.5,add:0,ad:0},Japan:{mfn:2.5,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},'South Korea':{mfn:0,add:0,ad:0},'Czech Republic':{mfn:2.5,add:0,ad:0},Thailand:{mfn:2.5,add:2.5,ad:0} },
            food:{ China:{mfn:8,add:25,ad:0},Brazil:{mfn:5,add:0,ad:0},India:{mfn:8,add:5,ad:0},Thailand:{mfn:4,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},Vietnam:{mfn:6,add:0,ad:0} },
            pharma:{ China:{mfn:3,add:25,ad:0},India:{mfn:0,add:0,ad:0},Ireland:{mfn:0,add:0,ad:0},Switzerland:{mfn:0,add:0,ad:0},Germany:{mfn:0,add:0,ad:0},Israel:{mfn:0,add:0,ad:0} },
            rawMaterials:{ China:{mfn:2,add:25,ad:5},Australia:{mfn:0,add:0,ad:0},Brazil:{mfn:2,add:0,ad:0},'South Africa':{mfn:0,add:0,ad:0},Chile:{mfn:0,add:0,ad:0},Indonesia:{mfn:3,add:2,ad:0} },
            consumerGoods:{ China:{mfn:5,add:25,ad:0},Vietnam:{mfn:8,add:2,ad:0},India:{mfn:7,add:5,ad:0},Thailand:{mfn:4,add:1,ad:0},Indonesia:{mfn:5,add:2,ad:0},Mexico:{mfn:0,add:0,ad:0} }
        };
        const RISK = {
            China:{risk:42,sourcing:95,reliability:'High'},Taiwan:{risk:35,sourcing:95,reliability:'High'},
            Vietnam:{risk:38,sourcing:55,reliability:'Medium'},India:{risk:45,sourcing:72,reliability:'Medium'},
            Bangladesh:{risk:58,sourcing:88,reliability:'Medium'},'South Korea':{risk:18,sourcing:88,reliability:'High'},
            Japan:{risk:12,sourcing:88,reliability:'High'},Germany:{risk:8,sourcing:78,reliability:'High'},
            Mexico:{risk:48,sourcing:78,reliability:'Medium'},Thailand:{risk:32,sourcing:55,reliability:'Medium'},
            Turkey:{risk:52,sourcing:70,reliability:'Medium'},Cambodia:{risk:55,sourcing:65,reliability:'Low'},
            Malaysia:{risk:25,sourcing:60,reliability:'Medium'},Indonesia:{risk:40,sourcing:45,reliability:'Medium'},
            Brazil:{risk:42,sourcing:55,reliability:'Medium'},Ireland:{risk:6,sourcing:88,reliability:'High'},
            Switzerland:{risk:4,sourcing:85,reliability:'High'},'Czech Republic':{risk:12,sourcing:72,reliability:'High'},
            'South Africa':{risk:48,sourcing:40,reliability:'Low'},Chile:{risk:22,sourcing:45,reliability:'Medium'},
            Australia:{risk:8,sourcing:50,reliability:'High'},Israel:{risk:55,sourcing:65,reliability:'Medium'},
            Canada:{risk:6,sourcing:65,reliability:'High'},'United Kingdom':{risk:8,sourcing:70,reliability:'High'},
            Philippines:{risk:42,sourcing:50,reliability:'Medium'},Pakistan:{risk:62,sourcing:45,reliability:'Low'}
        };

        const DISTANCES = {
            China:{sea:19000,air:12000,rail:null,road:null},Vietnam:{sea:17500,air:14000,rail:null,road:null},
            India:{sea:15000,air:13000,rail:null,road:null},Mexico:{sea:3200,air:3000,rail:3200,road:3500},
            Germany:{sea:8500,air:7500,rail:null,road:null},Japan:{sea:16500,air:10500,rail:null,road:null},
            'South Korea':{sea:17000,air:11000,rail:null,road:null},Taiwan:{sea:17500,air:12500,rail:null,road:null},
            Bangladesh:{sea:16000,air:13500,rail:null,road:null},Thailand:{sea:16000,air:14000,rail:null,road:null},
            Turkey:{sea:10500,air:9000,rail:null,road:null},Brazil:{sea:8500,air:8000,rail:null,road:null},
            Canada:{sea:2000,air:1500,rail:2500,road:2500},'United Kingdom':{sea:6500,air:6000,rail:null,road:null},
            Indonesia:{sea:17000,air:15000,rail:null,road:null},Malaysia:{sea:17500,air:14500,rail:null,road:null},
            Pakistan:{sea:14000,air:12000,rail:null,road:null},Spain:{sea:7500,air:7000,rail:null,road:null},
            Italy:{sea:8000,air:7200,rail:null,road:null},France:{sea:7800,air:7000,rail:null,road:null},
            Poland:{sea:8200,air:7500,rail:null,road:null},Netherlands:{sea:7800,air:7000,rail:null,road:null},
        };
        const CO2_FACTORS = { sea:0.015, air:0.500, rail:0.025, road:0.065 };

        const catMap = { electronics:'technology',textiles:'textiles',automotive:'automotive',food:'food',pharma:'pharma',rawMaterials:'rawMaterials',consumerGoods:'consumerGoods',industrial:'technology',chemicals:'rawMaterials',other:'consumerGoods' };
        const cat = catMap[productCategory] || catMap[(productCategory||'').toLowerCase()] || 'technology';
        const unitCurrCode = unitCurrency || 'USD';
        const priceUSD = unitCurrCode === 'USD' ? parseFloat(unitPrice) : parseFloat(unitPrice) / (rates[unitCurrCode] || 1);
        const qty = parseInt(quantity) || 1000;
        const wtKg = (weightUnit === 'lbs' ? parseFloat(weightPerUnit||0.5) * 0.453592 : parseFloat(weightPerUnit||0.5));
        const resCurr = resultCurrency || 'USD';
        const resRate = rates[resCurr] || 1;
        const toRes = v => Math.round(v * resRate * 100) / 100;
        const r2 = v => Math.round(v * 100) / 100;

        const modesToCalc = ['sea','air','rail','road']; // always calculate all modes
        const results = {};
        let lowestCost = Infinity, optimalCountry = '', optimalMode = '';

        for (const country of originCountries) {
            const region = REGIONS[country] || 'default';
            const countryTariff = (TARIFFS[cat] || {})[country] || { mfn:5, add:0, ad:0 };
            const riskData = RISK[country] || { risk:50, sourcing:50, reliability:'Medium' };
            const countryResults = {};

            for (const mode of modesToCalc) {
                const modeRates = SHIPPING_RATES[mode] || {};
                const modeTimes = TRANSIT[mode] || {};
                const freightPerKg = modeRates[region] != null ? modeRates[region] : modeRates.default;
                const transit = modeTimes[region] != null ? modeTimes[region] : modeTimes.default;
                if (freightPerKg == null || transit == null) continue;

                const shipCostPerUnit = freightPerKg * wtKg;
                const effTariffRate = (countryTariff.mfn + countryTariff.add + countryTariff.ad) / 100;
                const tariffPerUnit = priceUSD * effTariffRate;

                const cargoVal = priceUSD * qty;
                const ins = cargoVal * ((insuranceRate || 0.5) / 100);
                const broker = parseFloat(brokerFee || 150);
                const hmf = cargoVal * ((hmfRate || 0.125) / 100);
                const mpfRaw = cargoVal * ((mpfRate || 0.3464) / 100);
                const mpf = Math.min(Math.max(mpfRaw, 31.67), 614.35);
                const inland = parseFloat(inlandTransport || 0);
                const totalFees = ins + broker + hmf + mpf + inland;
                const feesPerUnit = totalFees / qty;

                let unitsPerCont = null, contNeeded = null;
                const contCap = { '20ft':{ kg:28200 }, '40ft':{ kg:28800 }, '40hc':{ kg:28600 } };
                if (containerType && contCap[containerType]) {
                    unitsPerCont = wtKg > 0 ? Math.floor(contCap[containerType].kg / wtKg) : null;
                    if (unitsPerCont) contNeeded = Math.ceil(qty / unitsPerCont);
                }

                const totalPerUnit = priceUSD + shipCostPerUnit + tariffPerUnit + feesPerUnit;
                const costIncrease = r2(((totalPerUnit - priceUSD) / priceUSD) * 100);

                const distKm = (DISTANCES[country] || {})[mode] || null;
                const co2PerUnit = (distKm && wtKg > 0) ? r2((wtKg / 1000) * distKm * (CO2_FACTORS[mode] || 0)) : null;

                countryResults[mode] = {
                    mode, transit,
                    product: { unitPriceOriginal:parseFloat(unitPrice), unitCurrency:unitCurrCode, unitPriceUSD:r2(priceUSD), unitPriceResult:toRes(priceUSD), fxRate:r2((rates[unitCurrCode]||1)), quantity:qty, subtotal:toRes(priceUSD*qty) },
                    shipping: { freightPerKg:r2(freightPerKg), freightPerUnit:toRes(shipCostPerUnit), freightTotal:toRes(shipCostPerUnit*qty), mode, transitDays:transit, containerType:containerType||'N/A', unitsPerContainer:unitsPerCont, containersNeeded:contNeeded, distanceKm:distKm },
                    tariffs: { hsCode:hsCode||'N/A', mfnRate:countryTariff.mfn, additionalDuty:countryTariff.add, antidumping:countryTariff.ad, effectiveRate:r2(countryTariff.mfn+countryTariff.add+countryTariff.ad), costPerUnit:toRes(tariffPerUnit), costTotal:toRes(tariffPerUnit*qty) },
                    fees: { insurance:toRes(ins), brokerFee:toRes(broker), hmf:toRes(hmf), mpf:toRes(mpf), inland:toRes(inland), subtotal:toRes(totalFees), perUnit:toRes(feesPerUnit), insuranceRate:insuranceRate||0.5, hmfRate:hmfRate||0.125, mpfRate:mpfRate||0.3464 },
                    total: { perUnit:toRes(totalPerUnit), perShipment:toRes(totalPerUnit*qty), costIncrease, effectiveMarkup:costIncrease },
                    risk: { countryRiskScore:riskData.risk, sourcingScore:riskData.sourcing, reliability:riskData.reliability, leadTimeDays:transit },
                    co2PerUnit,
                    resultCurrency:resCurr
                };

                if (totalPerUnit < lowestCost) { lowestCost = totalPerUnit; optimalCountry = country; optimalMode = mode; }
            }
            if (Object.keys(countryResults).length) results[country] = countryResults;
        }

        // Collect tariff rates used (for frontend sensitivity slider)
        const tariffRates = {};
        for (const country of originCountries) {
            tariffRates[country] = (TARIFFS[cat] || {})[country] || { mfn:5, add:0, ad:0 };
        }

        res.json({
            results,
            optimal: { country:optimalCountry, mode:optimalMode, costPerUnit:toRes(lowestCost), currency:resCurr },
            meta: { productName, quantity:qty, calculatedAt:new Date().toISOString(), resultCurrency:resCurr },
            tariffRates,
            fxRates: rates,
            unitCurrency: unitCurrCode,
            priceUSD: r2(priceUSD)
        });

    } catch (error) {
        console.error('Landed cost error:', error);
        res.status(500).json({ error: 'Calculation failed. Please try again.' });
    }
});

// ============================================================
// SHOPIFY CHECKOUT
// ============================================================

app.post('/api/shopify-checkout', async (req, res) => {
  try {
    const { variantId, sellingPlanId } = req.body;

    console.log('[Checkout] variantId:', variantId, 'sellingPlanId:', sellingPlanId);

    const mutation = `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const lineItem = {
      merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: 1
    };
    if (sellingPlanId) {
      lineItem.sellingPlanId = `gid://shopify/SellingPlan/${sellingPlanId}`;
    }

    const variables = { input: { lines: [lineItem], discountCodes: ['FIRSTMONTHFREE'] } };

    const response = await fetch('https://risksim-ai.myshopify.com/api/2023-10/graphql.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const rawText = await response.text();
    console.log('[Checkout] Raw response:', rawText);
    const data = JSON.parse(rawText);

    if (data.errors) {
      return res.status(500).json({ error: 'GraphQL error', details: data.errors });
    }

    const cart = data?.data?.cartCreate?.cart;
    const userErrors = data?.data?.cartCreate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      return res.status(400).json({ error: userErrors[0].message });
    }

    if (!cart?.checkoutUrl) {
      return res.status(500).json({ error: 'No checkout URL returned' });
    }

    console.log('[Checkout] URL:', cart.checkoutUrl);
    res.json({ url: cart.checkoutUrl });

  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHOPIFY ADMIN TOKEN CACHE + RESTORE ACCESS
// ============================================================

let shopifyAdminToken = null;
let shopifyAdminTokenExpiry = 0;

async function getShopifyAdminToken() {
  if (shopifyAdminToken && Date.now() < shopifyAdminTokenExpiry - 60000) {
    return shopifyAdminToken;
  }
  const shopDomain = 'risksim-ai.myshopify.com';
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('[Shopify Token] Failed:', errText);
    throw new Error('Failed to get Shopify admin token');
  }
  const data = await response.json();
  shopifyAdminToken = data.access_token;
  shopifyAdminTokenExpiry = Date.now() + ((data.expires_in || 86400) * 1000);
  console.log('[Shopify Token] Refreshed successfully');
  return shopifyAdminToken;
}

app.post('/api/save-profile', async (req, res) => {
  try {
    const { email, profile } = req.body;
    if (!email || !email.includes('@') || !profile) {
      return res.status(400).json({ error: 'Email and profile required' });
    }

    console.log('[Save Profile] For:', email);

    const token = await getShopifyAdminToken();
    const shopDomain = 'risksim-ai.myshopify.com';

    // Find customer by email
    const customerQuery = `
      query getCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const customerRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: customerQuery,
        variables: { query: `email:${email}` }
      })
    });

    const customerData = await customerRes.json();
    const customer = customerData?.data?.customers?.edges?.[0]?.node;

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Save profile as metafield
    const metafieldMutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: metafieldMutation,
        variables: {
          metafields: [{
            ownerId: customer.id,
            namespace: 'risksim',
            key: 'profile',
            type: 'json',
            value: JSON.stringify(profile)
          }]
        }
      })
    });

    const metafieldData = await metafieldRes.json();
    console.log('[Save Profile] Result:', JSON.stringify(metafieldData));

    if (metafieldData?.data?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({
        error: 'Failed to save profile',
        details: metafieldData.data.metafieldsSet.userErrors
      });
    }

    return res.json({ success: true });

  } catch (err) {
    console.error('[Save Profile] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/restore-access', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    console.log('[Restore Access] Lookup for:', email);

    const token = await getShopifyAdminToken();
    const shopDomain = 'risksim-ai.myshopify.com';

    // Find customer by email
    const customerQuery = `
      query getCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email
              numberOfOrders
            }
          }
        }
      }
    `;

    const customerRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: customerQuery,
        variables: { query: `email:${email}` }
      })
    });

    const customerData = await customerRes.json();
    console.log('[Restore Access] Customer lookup:', JSON.stringify(customerData));

    const customer = customerData?.data?.customers?.edges?.[0]?.node;
    if (!customer) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    // Get customer's orders with subscription line items
    const ordersQuery = `
      query getCustomerOrders($customerId: ID!) {
        customer(id: $customerId) {
          orders(first: 20, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                cancelledAt
                lineItems(first: 10) {
                  edges {
                    node {
                      title
                      sellingPlan {
                        sellingPlanId
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const ordersRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: ordersQuery,
        variables: { customerId: customer.id }
      })
    });

    const ordersData = await ordersRes.json();
    console.log('[Restore Access] Orders:', JSON.stringify(ordersData));

    const orders = ordersData?.data?.customer?.orders?.edges || [];

    // Plan ID mapping
    const PLAN_IDS = {
      'gid://shopify/SellingPlan/692427948370': 'pro',          // Pro monthly
      'gid://shopify/SellingPlan/692434501970': 'pro',          // Pro annual
      'gid://shopify/SellingPlan/692427981138': 'enterprise',   // Enterprise monthly
      'gid://shopify/SellingPlan/692442923346': 'enterprise'    // Enterprise annual
    };

    let plan = null;
    for (const orderEdge of orders) {
      const order = orderEdge.node;
      if (order.cancelledAt) continue;

      for (const lineEdge of (order.lineItems?.edges || [])) {
        const line = lineEdge.node;
        if (line.sellingPlan?.sellingPlanId) {
          const planId = line.sellingPlan.sellingPlanId;
          if (PLAN_IDS[planId]) {
            plan = PLAN_IDS[planId];
            break;
          }
        }
      }
      if (plan) break;
    }

    if (!plan) {
      return res.status(404).json({ error: 'No active subscription found for this email' });
    }

    // Fetch saved profile metafield
    let profile = null;
    try {
      const profileQuery = `
        query getCustomerProfile($customerId: ID!) {
          customer(id: $customerId) {
            metafield(namespace: "risksim", key: "profile") {
              value
            }
          }
        }
      `;

      const profileRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({
          query: profileQuery,
          variables: { customerId: customer.id }
        })
      });

      const profileData = await profileRes.json();
      const metafieldValue = profileData?.data?.customer?.metafield?.value;
      if (metafieldValue) {
        profile = JSON.parse(metafieldValue);
        console.log('[Restore Access] Profile loaded from metafield');
      }
    } catch (e) {
      console.error('[Restore Access] Profile fetch error:', e);
    }

    return res.json({ success: true, plan, email, profile });

  } catch (err) {
    console.error('[Restore Access] Error:', err);
    return res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ============================================================
// EMAIL SUBSCRIBER ENDPOINTS
// ============================================================

// Subscribe / update preferences
app.post('/api/email/subscribe', (req, res) => {
    const { email, industry, sourcingCountries, companyName, preferences } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
    }
    const key = email.toLowerCase();
    emailSubscribers[key] = {
        email: key,
        industry: industry || 'technology',
        sourcingCountries: sourcingCountries || [],
        companyName: companyName || '',
        preferences: {
            weeklyDigest: preferences?.weeklyDigest !== false,
            criticalAlerts: preferences?.criticalAlerts !== false
        },
        subscribedAt: emailSubscribers[key]?.subscribedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    console.log('[Email] Subscriber updated:', key);
    res.json({ success: true, subscriber: emailSubscribers[key] });
});

// Unsubscribe
app.post('/api/email/unsubscribe', (req, res) => {
    const email = (req.body.email || req.query.email || '').toLowerCase();
    if (email && emailSubscribers[email]) {
        delete emailSubscribers[email];
        console.log('[Email] Unsubscribed:', email);
    }
    res.json({ success: true });
});

// GET unsubscribe (for email link clicks)
app.get('/api/email/unsubscribe', (req, res) => {
    const email = (req.query.email || '').toLowerCase();
    if (email && emailSubscribers[email]) {
        delete emailSubscribers[email];
        console.log('[Email] Unsubscribed via link:', email);
    }
    res.send('<html><body style="background:#111;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><div style="font-size:14px;letter-spacing:3px;margin-bottom:16px;">RISKSIM</div><div style="color:rgba(255,255,255,0.5);font-size:13px;">You have been unsubscribed.</div></div></body></html>');
});

// Get all subscribers — n8n uses this (protected)
app.get('/api/email/subscribers', requireDataKey, (req, res) => {
    const type = req.query.type;
    let subs = Object.values(emailSubscribers);
    if (type) subs = subs.filter(s => s.preferences[type] === true);
    res.json(subs);
});

// Get preferences for one email — frontend uses this
app.get('/api/email/preferences/:email', (req, res) => {
    const sub = emailSubscribers[req.params.email.toLowerCase()];
    if (!sub) return res.json({ subscribed: false, preferences: { weeklyDigest: false, criticalAlerts: false } });
    res.json({ subscribed: true, preferences: sub.preferences });
});

// Critical alert check — n8n uses this (protected)
app.get('/api/email/critical-check', requireDataKey, (req, res) => {
    const criticalKeywords = /\bwar\b|bombing|invasion|military.strike|armed.conflict|port.closure|factory.explosion/i;
    const criticalAlerts = [];
    for (const [industry, alerts] of Object.entries(dataStore.alertsByIndustry)) {
        for (const alert of alerts) {
            const title = alert.title || '';
            if (criticalKeywords.test(title)) {
                const pubDate = new Date(alert.pubDate || alert.isoDate || 0);
                const hoursSince = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60);
                if (hoursSince <= 6) {
                    criticalAlerts.push({
                        title,
                        industry,
                        pubDate: alert.pubDate || alert.isoDate,
                        link: alert.link,
                        source: (title.split(' - ').pop() || '').trim()
                    });
                }
            }
        }
    }
    res.json({ hasCritical: criticalAlerts.length > 0, alerts: criticalAlerts });
});

// Weekly digest data — n8n uses this (protected)
app.get('/api/email/digest-data', requireDataKey, (req, res) => {
    const industry = req.query.industry || 'general';
    const industryAlerts = dataStore.alertsByIndustry[industry] || [];
    const generalAlerts = dataStore.alertsByIndustry.general || [];
    const combined = [...industryAlerts, ...generalAlerts];
    const topStories = combined.slice(0, 10).map(a => ({
        title: (a.title || '').split(' - ').slice(0, -1).join(' - ').trim() || a.title,
        source: (a.title || '').split(' - ').pop().trim(),
        link: a.link,
        pubDate: a.pubDate || a.isoDate
    }));
    const criticalRe = /\bwar\b|bombing|invasion|military.strike|armed.conflict|port.closure|factory.explosion/i;
    const highRe = /strike|shortage|recession|congestion|disrupt|halt|suspend|crisis/i;
    let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;
    combined.forEach(a => {
        const t = (a.title || '').toLowerCase();
        if (criticalRe.test(t)) criticalCount++;
        else if (highRe.test(t)) highCount++;
        else if (/tariff|regulation|compliance|cost.*rise|review|probe/i.test(t)) mediumCount++;
        else lowCount++;
    });
    res.json({
        industry,
        totalAlerts: combined.length,
        severity: { critical: criticalCount, high: highCount, medium: mediumCount, low: lowCount },
        topStories,
        generatedAt: new Date().toISOString()
    });
});

app.post('/api/subscription/cancel-request', async (req, res) => {
  const { email, plan, timestamp } = req.body;
  const webhookUrl = process.env.DISCORD_CANCEL_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ success: false, error: 'internal' });
  }
  try {
    const content = `🚨 **CANCELLATION REQUEST**\n**Plan:** ${plan || 'unknown'}\n**Email:** ${email || 'not provided'}\n**Timestamp:** ${timestamp}\n**Action needed:** Cancel in Shopify admin → Subscriptions → Contracts`;
    const resp = await axios.post(webhookUrl, { content }, { headers: { 'Content-Type': 'application/json' } });
    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ success: true });
    }
    return res.status(500).json({ success: false, error: 'internal' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal' });
  }
});

app.listen(PORT, () => console.log(`RiskSim running on ${PORT}`));

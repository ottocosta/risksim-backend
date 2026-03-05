const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Allow iframe embedding from Shopify
app.use((req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', '');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
    try {
        const { message, userProfile } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const GOAL_MAP = {
            expand: 'expand to new markets',
            manufacturers: 'change or diversify manufacturers',
            costs: 'reduce supply chain costs',
            geopolitical: 'monitor geopolitical risks',
            tariffs: 'track tariff impacts',
            suppliers: 'find alternative suppliers',
        };

        let systemPrompt = 'You are a world-class supply chain risk analyst. Provide deep, actionable insights on geopolitical risks, tariffs, manufacturing costs, regulations, and supply chain resilience.';

        if (userProfile) {
            systemPrompt += '\n\nUser Context (personalize your response accordingly):';
            if (userProfile.company)  systemPrompt += '\n- Company: ' + userProfile.company;
            if (userProfile.country)  systemPrompt += '\n- HQ Country: ' + userProfile.country;
            if (userProfile.industry) systemPrompt += '\n- Industry: ' + userProfile.industry;
            if (userProfile.volume)   systemPrompt += '\n- Annual trade volume: ' + userProfile.volume;
            if (userProfile.goals && userProfile.goals.length) {
                const goalDescriptions = userProfile.goals.map(g => GOAL_MAP[g] || g).join(', ');
                systemPrompt += '\n- Primary objectives: ' + goalDescriptions;
            }
            systemPrompt += '\n\nTailor your analysis to be directly relevant to this user\'s industry, home country, and stated objectives. Reference their specific context when applicable.';
        }

        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: message }] });

        const reply = response.content[0]?.text || 'No response';
        res.json({ reply });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`✅ RiskSim running on ${PORT}`));
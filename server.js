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

function buildSystemPrompt(profile) {
    let prompt = 'You are RiskSim AI, a world-class supply chain risk analyst and cost optimization expert. ' +
        'Provide deep, actionable insights on geopolitical risks, tariffs, shipping costs, labor costs, regulatory compliance, ' +
        'and supply chain resilience. Be data-driven, specific, and professional. ' +
        'Format responses with markdown: use **bold** for key terms, bullet lists for multiple items, ' +
        'and clear section headers where appropriate. Keep responses focused and actionable.';

    if (profile && (profile.companyType || profile.homeCountry || profile.industry)) {
        prompt += '\n\n## User Company Profile\n';
        if (profile.companyType) prompt += `- **Company Type**: ${profile.companyType}\n`;
        if (profile.homeCountry) prompt += `- **Home Country / HQ**: ${profile.homeCountry}\n`;
        if (profile.industry) prompt += `- **Industry**: ${profile.industry}\n`;
        if (profile.sourcingCountries && profile.sourcingCountries.length > 0) {
            prompt += `- **Primary Sourcing Countries**: ${profile.sourcingCountries.join(', ')}\n`;
        }
        if (profile.revenue) prompt += `- **Annual Revenue Range**: ${profile.revenue}\n`;
        prompt += '\nAlways tailor your analysis to this company\'s profile. Reference their specific industry, ' +
            'home country, and sourcing relationships. Focus on cost savings and risk reduction recommendations ' +
            'that are directly relevant to their situation.';
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

        // Build conversation history (max 20 messages = 10 pairs)
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

app.listen(PORT, () => console.log(`✅ RiskSim running on ${PORT}`));
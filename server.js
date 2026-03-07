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
        'and clear section headers where appropriate. Keep responses focused and actionable.\n\n' +
        '## RiskSim Scoring System\n' +
        'The platform has two separate score modes:\n' +
        '1. **Political/Operational Risk Score** (0-100, higher = more risky): Measures geopolitical instability, corruption, logistics infrastructure, conflict risk.\n' +
        '2. **Sourcing Attractiveness Score** (0-100, higher = better for sourcing): Measures manufacturing capacity, export infrastructure maturity, supplier ecosystem density, lead time reliability, and industry specialization.\n\n' +
        'Industry categories for sourcing scores: Technology, Textiles/Apparel, General Manufacturing, Consumer Goods, Automotive, Pharmaceuticals.\n\n' +
        'Key sourcing insights by category:\n' +
        '- **Technology**: China (95), Taiwan (95), South Korea (88), Japan (88), Vietnam (55), Malaysia (60)\n' +
        '- **Textiles/Apparel**: Bangladesh (88), Vietnam (85), India (70), China (75), Turkey (70), Cambodia (65)\n' +
        '- **Automotive**: Germany (95), Japan (92), South Korea (80), Mexico (88), Czech Republic (72), Slovakia (68)\n' +
        '- **Pharmaceuticals**: India (92), Ireland (88), Switzerland (85), Germany (65), United States (70)\n' +
        '- **General Manufacturing**: China (95), Germany (78), Mexico (78), India (72), United States (65)\n' +
        '- **Consumer Goods**: China (92), India (65), Vietnam (62), Thailand (55), Indonesia (45)\n\n' +
        'When users ask about sourcing attractiveness, country comparisons, or "where should I source from," ' +
        'reference these industry-specific scores and manufacturing realities, not just political stability indices.';

    if (profile && (profile.companyType || profile.homeCountry || profile.industry)) {
        prompt += '\n\n## User Company Profile\n';
        if (profile.companyType) prompt += `- **Company Type**: ${profile.companyType}\n`;
        if (profile.homeCountry) prompt += `- **Home Country / HQ**: ${profile.homeCountry}\n`;
        if (profile.industry) prompt += `- **Industry**: ${profile.industry}\n`;
        if (profile.sourcingCountries && profile.sourcingCountries.length > 0) {
            prompt += `- **Primary Sourcing Countries**: ${profile.sourcingCountries.join(', ')}\n`;
        }
        if (profile.revenue) prompt += `- **Annual Revenue Range**: ${profile.revenue}\n`;
        if (profile.businessDescription) prompt += `- **Business Description**: ${profile.businessDescription}\n`;
        prompt += '\nAlways tailor your analysis to this company\'s profile. Reference their specific industry, ' +
            'home country, sourcing relationships, and any business description provided. Focus on cost savings and risk reduction recommendations ' +
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

app.listen(PORT, () => console.log(`RiskSim running on ${PORT}`));
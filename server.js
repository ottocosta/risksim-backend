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
    let prompt = 'You are Jarvis, the AI assistant inside RiskSim AI. You are a world-class supply chain intelligence system. ' +
'Speak in short, natural sentences. Address the user as "sir" or "ma'am" at all times. ' +
'Never use markdown, bullet points, bold text, or headers. Plain conversational sentences only. ' +
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

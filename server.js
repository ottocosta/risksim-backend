const express = require('express');
const { AnthropicClient } = require('anthropic-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const claudeApiKey = process.env.CLAUDE_API_KEY;
const client = new AnthropicClient(claudeApiKey);

// Root route
app.get('/', async (req, res) => {
    try {
        const response = await client.callModel('claude-3-5-sonnet-20241022', {
            prompt: 'Hello, Claude!',
            max_tokens: 100
        });
        res.send(response);
    } catch (error) {
        console.error('Error calling Claude API:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
// Import the required modules
const express = require('express');
const { Configuration, OpenAIApi } = require('openai');
const { Anthropic } = require('anthropic'); // Import the Anthropic SDK

const app = express();
const PORT = process.env.PORT || 3000;

// Shopify App Proxy endpoint
app.get('/proxy', (req, res) => {
    const html = `<!DOCTYPE html>\n<html>\n<head>\n    <title>Proxy Page</title>\n</head>\n<body>\n    <h1>Shopify App Proxy</h1>\n    <p>This is a Shopify App Proxy endpoint.</p>\n</body>\n</html>`;
    res.send(html);
});

// Initialize the Claude API integration
const configuration = new Configuration({
    apiKey: process.env.ANTHROPIC_API_KEY,
});
const anthropic = new Anthropic({ apiKey: configuration.apiKey });

app.post('/claude', async (req, res) => {
    const input = req.body.input; // Getting input from request
    try {
        const response = await anthropic.Completions.create({
            prompt: input,
        });
        res.json(response);
    } catch (error) {
        res.status(500).send('Error with Claude API: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize the Claude API Client
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY; // set your Claude API key in environment variables
const CLAUDE_API_URL = 'https://api.claude.ai/chat';

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
    const { question } = req.body;

    try {
        const response = await axios.post(CLAUDE_API_URL, {
            question: question,
        }, {
            headers: {
                'Authorization': `Bearer ${CLAUDE_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });
        return res.json({ answer: response.data.answer });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Error processing your request.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
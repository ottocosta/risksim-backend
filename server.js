const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk'); // Import the SDK

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON requests

// Health check route
app.get('/health', (req, res) => {
    res.send('Server is healthy');
});

// Root route
app.get('/', (req, res) => {
    res.send('Welcome to the Claude API integration');
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    const { message } = req.body; // Expecting a message in the request body

    try {
        const client = new Anthropic(); // Initialize the SDK
        const response = await client.chat(message); // Call the chat method
        res.send(response); // Send the response back to the client
    } catch (error) {
        console.error(error);
        res.status(500).send('Error communicating with Claude API');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

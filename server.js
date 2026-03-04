const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to serve static files
app.use(express.static('public'));

// Body parser for JSON
app.use(express.json());

// Sample API endpoint for Claude AI chat
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    // Integrate with Claude AI here (pseudo-code)
    // const aiResponse = await claudeAI.sendMessage(userMessage);
    const aiResponse = `Response to: ${userMessage}`; // Placeholder response
    res.json({response: aiResponse});
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

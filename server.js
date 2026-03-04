// server.js

// Import necessary modules
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Middleware for serving static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Set up the dark theme CSS
app.get('/style.css', (req, res) => {
    res.send(`
      body {
          background: linear-gradient(to bottom, #0a0e27, #1a2332);
          color: white;
      }
      .navbar { /* Navbar styles */ }
      .grid { /* Grid layout styles */ }
      .map { /* Styles for map section */ }
      .chat { /* Styles for chat section */ }
    `);
});

// Serve the index.html page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route for Claude API integration
app.post('/api/analyze', async (req, res) => {
    try {
        const response = await axios.post('CLAUDE_API_URL', req.body);
        res.json(response.data);
    } catch (error) {
        console.error('Error calling Claude API', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Event listeners and frontend code to be included in index.html or a separate js file
window.onload = function() {
    alert('Welcome to RiskSim!');
    // Set up map and chat functionalities here
};

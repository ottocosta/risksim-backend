// server.js

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Leaflet = require('leaflet');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(cors());
app.use(bodyParser.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'client/build')));

// Endpoint for Claude AI integration
app.post('/api/claude', (req, res) => {
    const query = req.body.query;
    // Logic for Claude AI processing
    res.json({ message: 'Claude AI response' });
});

// Socket connection for chat messaging
io.on('connection', (socket) => {
    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });
});

// Function to return risk countries data
const getRiskCountries = () => {
    return [
        { name: 'Country A', coords: [34.0522, -118.2437] },
        { name: 'Country B', coords: [48.8566, 2.3522] },
        // Add more countries here
    ];
};

// API endpoint for supply chain risk analysis
app.get('/api/risk-analysis', (req, res) => {
    const analysisResults = getRiskCountries();
    res.json(analysisResults);
});

// Quick analysis buttons
app.post('/api/quick-analysis', (req, res) => {
    const type = req.body.type;
    // Logic for quick analysis based on type
    res.json({ result: 'Analysis Result' });
});

// Send all requests to the React app
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
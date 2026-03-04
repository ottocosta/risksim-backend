const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON requests
app.use(express.json());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Sample API route for '/api/example'
app.get('/api/example', (req, res) => {
    res.json({ message: 'Hello, World!' });
});

// Additional routes can be added here
// Example: app.post('/api/example', (req, res) => { ... });

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

'use strict';

const express = require('express');
const path = require('path');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 3000;

// Middleware for logging requests
app.use(morgan('dev'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
    res.send('<h1>Welcome to RiskSim</h1>');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// 404 handling
app.use((req, res) => {
    res.status(404).send('Sorry, cannot find that!');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

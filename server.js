const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Sample route for API
app.get('/api/example', (req, res) => {
  res.json({ message: 'This is an example response' });
});

// More routes can be added here

// Fallback route for 404
app.use((req, res) => {
  res.status(404).send('404: Not Found');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
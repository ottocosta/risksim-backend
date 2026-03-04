// This is a sample route file
const express = require('express');
const router = express.Router();

router.get('/example', (req, res) => {
    res.json({ message: 'This is an example route' });
});

module.exports = router;
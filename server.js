const express = require('express');
const bodyParser = require('body-parser');
const routes = require('./src/routes/index');
const errorMiddleware = require('./src/middleware/errorMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use('/api', routes);
app.use(errorMiddleware);

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

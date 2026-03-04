// Importing the correct SDK for Claude API integration
import { Claude } from '@anthropic-ai/sdk';

// Your existing server code follows...

// To use Claude
const client = new Claude();
// Example of making a request to Claude API
async function getResponse(prompt) {
    const response = await client.complete({ prompt });
    return response;
}
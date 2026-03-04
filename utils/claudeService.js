const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

async function analyzeSupplierRisk(userQuery, countryData) {
    const systemPrompt = "You are an expert trade and supply chain risk analyst. Analyze supplier risks based on tariffs, regulatory environment, geopolitical factors, and currency volatility. Provide risk assessments as percentages (0-100%) for each risk category. Be professional and data-driven in your analysis.";
    const userMessage = `Analyze the following query regarding supply chain and country risk: "${userQuery}" Country data available: ${JSON.stringify(countryData, null, 2)} Please provide: 1. Overall risk percentage 2. Tariff risk percentage 3. Regulatory risk percentage 4. Geopolitical risk percentage 5. Currency volatility risk percentage 6. Detailed recommendations 7. Best alternative countries if applicable`;
    try {
        const message = await client.messages.create({ model: "claude-3-5-sonnet-20241022", max_tokens: 1024, messages: [{ role: "user", content: userMessage }], system: systemPrompt });
        return message.content[0].type === "text" ? message.content[0].text : null;
    } catch (error) {
        console.error("Claude API error:", error);
        throw error;
    }
}

async function generateRecommendedQuestions(context) {
    const message = await client.messages.create({ model: "claude-3-5-sonnet-20241022", max_tokens: 500, messages: [{ role: "user", content: `Based on this supply chain context: "${context}", generate 3-4 follow-up questions a user might ask about supplier risks. Return only the questions as a JSON array.` }] });
    try {
        const text = message.content[0].type === "text" ? message.content[0].text : "[]";
        return JSON.parse(text);
    } catch {
        return ["What are the main risks?", "Which countries are safest?"];  
    }
}

module.exports = { analyzeSupplierRisk, generateRecommendedQuestions };
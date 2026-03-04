const express = require('express');
const path = require('path');
const { Anthropic } = require('@anthropic-ai/sdk');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>RiskSim - Supply Chain Risk Analysis</title><style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; } .container { background: white; border-radius: 15px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); width: 100%; max-width: 600px; display: flex; flex-direction: column; height: 600px; } .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 15px 15px 0 0; text-align: center; } .header h1 { font-size: 24px; margin-bottom: 5px; } .header p { font-size: 14px; opacity: 0.9; } .messages { flex: 1; overflow-y: auto; padding: 20px; background: #f8f9fa; } .message { margin: 12px 0; animation: slideIn 0.3s ease; } @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } } .message.user { text-align: right; } .message.user .text { background: #667eea; color: white; padding: 12px 16px; border-radius: 12px; display: inline-block; max-width: 80%; word-wrap: break-word; } .message.bot .text { background: #e9ecef; color: #333; padding: 12px 16px; border-radius: 12px; display: inline-block; max-width: 80%; word-wrap: break-word; } .input-area { padding: 20px; border-top: 1px solid #e0e0e0; display: flex; gap: 10px; } input { flex: 1; padding: 12px; border: 2px solid #e0e0e0; border-radius: 25px; font-size: 14px; transition: border-color 0.3s; } input:focus { outline: none; border-color: #667eea; } button { background: #667eea; color: white; border: none; padding: 12px 24px; border-radius: 25px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.3s; } button:hover { background: #764ba2; } button:active { transform: scale(0.98); } .loading { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #667eea; margin: 0 3px; animation: bounce 1.4s infinite; } .loading:nth-child(1) { animation-delay: -0.32s; } .loading:nth-child(2) { animation-delay: -0.16s; } @keyframes bounce { 0%, 80%, 100% { transform: scale(0) translateY(0); opacity: 0.5; } 40% { transform: scale(1) translateY(-10px); opacity: 1; } }</style></head><body><div class="container"><div class="header"><h1>🎯 RiskSim AI</h1><p>Supply Chain Risk Analysis powered by Claude</p></div><div class="messages" id="messages"></div><div class="input-area"><input type="text" id="messageInput" placeholder="Ask about supply chain risks..."><button onclick="sendMessage()">Send</button></div></div><script>const messagesDiv = document.getElementById('messages'); const input = document.getElementById('messageInput'); async function sendMessage() { const message = input.value.trim(); if (!message) return; input.value = ''; addMessage(message, 'user'); const button = event.target; button.disabled = true; button.innerHTML = '<span class="loading"></span><span class="loading"></span><span class="loading"></span>'; try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) }); const data = await response.json(); addMessage(data.reply || 'No response received', 'bot'); } catch (error) { addMessage('Error: ' + error.message, 'bot'); } finally { button.disabled = false; button.innerHTML = 'Send'; } } function addMessage(text, sender) { const msgDiv = document.createElement('div'); msgDiv.className = 'message ' + sender; msgDiv.innerHTML = '<div class="text">' + escapeHtml(text) + '</div>'; messagesDiv.appendChild(msgDiv); messagesDiv.scrollTop = messagesDiv.scrollHeight; } function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; } input.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });</script></body></html>`);
});

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }
    try {
        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });
        }
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [{ role: 'user', content: message }] });
        const reply = response.content[0].type === 'text' ? response.content[0].text : 'No response';
        res.json({ reply });
    } catch (error) {
        console.error('Claude API Error:', error);
        res.status(500).json({ error: error.message || 'Failed to get response from Claude' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
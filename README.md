# RiskSim — Supply Chain Intelligence Platform

A professional, AI-powered supply chain intelligence platform that helps businesses monitor geopolitical risk, analyze sourcing costs, and optimize their global supply chains.

---

## Features

- **Interactive Global Risk Map** — 54+ countries with color-coded risk levels (critical → low), pulsing animated markers on hotspots, and animated trade-route connection lines
- **Cost Analysis Layers** — Toggle between Risk, Shipping Cost, Labor Cost, and Total Score map overlays
- **AI-Powered Chat** — Multi-turn conversation with Claude, personalized to your company profile. Maintains conversation history (last 10 exchange pairs)
- **Company Profile Onboarding** — Welcome modal collects company type, home country, industry, sourcing countries, and revenue range; stored in `localStorage`
- **5 Smart Analysis Modes** — Full Audit, Cost Comparison, Live Risk Alerts, Optimization Tips, Alternative Suppliers
- **Expandable/Collapsible Chat Panel** — Three layout states for flexible viewing
- **Shopify Section** — Drop-in Liquid section for embedding in a Shopify storefront

---

## Architecture

```
risksim-backend/
├── server.js                    # Express server — static files + /api/chat endpoint
├── public/
│   ├── index.html               # Single-page app (embedded CSS + JS, Leaflet maps)
│   ├── shopify-section.liquid   # Shopify theme section for iframe embedding
│   ├── chat.html                # Standalone chat page
│   └── calculator.html          # Standalone calculator page
├── utils/
│   ├── claudeService.js         # Claude API helper functions
│   └── countryData.js           # Country risk data constants
├── package.json
├── Procfile                     # Render/Heroku process file
└── .env.example                 # Environment variable template
```

---

## Setup

### Prerequisites
- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

### Local Development

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env and set CLAUDE_API_KEY=your_key_here

# Start the server
node server.js
# → Server running at http://localhost:3000
```

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `CLAUDE_API_KEY` | Anthropic API key | ✅ |
| `PORT` | Server port (default: 3000) | optional |

---

## Deployment (Render)

1. Push to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Set the **Start Command** to `node server.js`
4. Add the `CLAUDE_API_KEY` environment variable in the Render dashboard
5. Deploy — the app will be available at your Render URL

---

## API

### `POST /api/chat`

Send a message to the AI analyst with optional conversation history and company profile context.

**Request Body:**
```json
{
  "message": "What are the current risks for electronics manufacturing in China?",
  "messages": [
    { "role": "user", "content": "Previous question" },
    { "role": "assistant", "content": "Previous answer" }
  ],
  "profile": {
    "companyType": "Manufacturer",
    "homeCountry": "United States",
    "industry": "Electronics",
    "sourcingCountries": ["China", "Vietnam", "Taiwan"],
    "revenue": "$10M–$50M"
  }
}
```

**Response:**
```json
{
  "reply": "Based on your electronics manufacturing profile sourcing from China..."
}
```

---

## Shopify Integration

1. Copy `public/shopify-section.liquid` to your Shopify theme under `sections/risksim-embed.liquid`
2. In your theme JSON template (e.g. `templates/index.json`), add:
   ```json
   "risksim": { "type": "risksim-embed", "settings": {} }
   ```
3. In the Shopify Theme Editor, configure the section URL to your deployed Render app URL
4. Adjust the embed height as needed (default: 720px)

---

## Screenshots

_Add screenshots here_

---

## License

MIT

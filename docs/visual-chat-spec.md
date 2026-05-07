# RiskSim Visual Chat Responses — v1 Build Spec

## Vision
Transform the AI chat from text-only Q&A into a visually rich, explorable interface. Procurement managers ask questions and get short text + relevant visual + suggested follow-up chips. The product becomes screenshot-able and demo-able.

## v1 Scope
- One visual: Yantian-style incident alert card
- Follow-up chips: 2–3 suggested next questions per response
- Default response mode: short text + incident card + chips for relevant questions
- Fallback: plain text for questions that don't match a visual template

Not in v1: tariff card, supplier dependency card, risk-by-region card. Those come later, one at a time, after v1 ships.

## Architecture

Chat API returns a `blocks` array. Each block has a type and data. Frontend has a renderer for each type. Unknown block types fall back to text.

Example response:

```json
{
  "blocks": [
    { "type": "text", "content": "Your biggest active risk is the Yantian port closure..." },
    { "type": "incident_card", "data": { /* card fields below */ } },
    { "type": "follow_up_chips", "options": ["Show alternate suppliers", "Calculate delay impact", "Run mitigation"] }
  ]
}
```

## Incident Card Data Shape

Based on the Claude Design mockup. Fields:

- `severity` — P1 critical / P2 / etc.
- `category` — logistics / tariff / labor / etc.
- `title` — e.g. "Port closure at Shenzhen Yantian"
- `subtitle` — e.g. "Typhoon-related shutdown, 48–72hr ETA"
- `location` — lat/lng for map glyph + display name
- `direct_exposure_usd` — dollar exposure number
- `affected_pos_count` — number of POs hit
- `suppliers_hit` — array of `{ name, exposure_usd }`
- `delay_risk` — e.g. "9–14d to N. America DCs"
- `recommended_action` — `{ text, impact_estimate, cta_label }`

## Build Phases

**Phase 1: Frontend renderer (days 1–2)**
- Define `blocks` array shape (TypeScript types or JSDoc)
- Build incident card component using existing risksim design tokens
- Build follow-up chips component
- Build response parser: takes API response, renders each block in order
- Test with hardcoded mock data, no backend changes yet

**Phase 2: Backend integration (day 3)**
- Modify chat API endpoint to return `blocks` instead of plain text
- Chatbot can return text-only `blocks` for everything except incident-card patterns
- Wire frontend to consume real API responses

**Phase 3: Chatbot output (day 3–4)**
- Modify Kai's chatbot logic to return structured incident_card data when appropriate
- Test with real customer profile data
- Refine "when to render visual vs text" decision logic

**Phase 4: Polish + ship (day 4–5)**
- Edge cases: no relevant exposure? Partial data?
- Loading states, error states, fallback to text
- Test end-to-end with a real test customer
- Deploy with the same verification protocol as the onboarding work

## Open Questions

1. Where does the chat get the customer's supplier exposure data? (Onboarding profile + ?)
2. How does the chat get incident data? (n8n alerts feeding into chat context?)
3. Minimum data quality bar — skip visual if exposure < $X?
4. How does the recommended action button work in v1? (Probably just generates text, no real execution)
5. What happens if a chip is clicked? (Sends new chat message? Opens deeper view?)

## Risk Areas

- Modifying Kai's chatbot output without breaking quality
- Customer data being patchy or incomplete
- Real-time incident data requires n8n to be wired into chat context — unclear if it is today

## Success Criteria

- One real test customer asks "what's my biggest risk right now?" and gets a visual incident card with their actual data
- Card is screenshot-able and looks like the Claude Design mockup
- Follow-up chips work and feel natural
- Plain text questions still get plain text responses
- No regressions in chatbot quality

## Deploy Protocol

Same as the onboarding work this week:
1. Wait 90 seconds after deploy goes live before testing
2. If site appears broken: do NOT roll back immediately
3. Check Render runtime logs for `RiskSim running` and recent `[n8n]` activity
4. Get external eyes (Kai or Luukas) confirming the issue before any rollback
5. Only roll back if external person also can't reach site AND logs show server crash

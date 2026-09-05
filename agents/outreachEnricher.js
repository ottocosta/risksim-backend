'use strict';
// =============================================================================
// OUTREACH ENRICHMENT AGENT
// =============================================================================
// Polls Notion "To Enrich" DB for rows with Status = "Pending", runs each
// through a 6-step enrichment pipeline, and writes results to the "Prospects" DB.
//
// Step 1  Hunter Domain Search  — find decision-maker email (CRITICAL)
// Step 2  Hunter Email Verify   — verify if not already verified (quota-aware)
// Step 3  SerpAPI socials       — LinkedIn / Twitter / Instagram (best-effort)
// Step 4  Website scrape        — phone number extraction (best-effort)
// Step 5  Perplexity news       — recent 30-day signal (best-effort)
// Step 6  Claude ICP scoring    — fit score 0-10 + tariff hook (CRITICAL)
//
// Self-contained: owns its own Redis helper, Anthropic client, and quota tracking.
// No circular dependency on server.js.
// =============================================================================

const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// ============================================================
// CONFIG
// ============================================================

const NOTION_API_BASE  = 'https://api.notion.com/v1';
const NOTION_VERSION   = '2022-06-28';
const HUNTER_FIND_WARN = 22;    // warn at 22/25 monthly finds per key
const SERP_WARN        = 225;   // warn at 225/250 monthly searches per key
const PERPLEXITY_WARN  = 1800;  // warn at 1800 calls (~90% of $10 credit)

// Ordered from highest to lowest decision-maker priority (spec §Step 1)
const TITLE_PRIORITY = [
    { rank: 1,  patterns: ['ceo', 'chief executive officer', 'founder', 'co-founder', 'cofounder', 'owner'] },
    { rank: 2,  patterns: ['coo', 'chief operating officer'] },
    { rank: 3,  patterns: ['vp of operations', 'vp, operations', 'vice president of operations', 'vp operations'] },
    { rank: 4,  patterns: ['vp of supply chain', 'vice president of supply chain', 'vp supply chain'] },
    { rank: 5,  patterns: ['head of supply chain'] },
    { rank: 6,  patterns: ['head of procurement', 'head of sourcing'] },
    { rank: 7,  patterns: ['director of operations'] },
    { rank: 8,  patterns: ['director of supply chain'] },
    { rank: 9,  patterns: ['director of procurement'] },
    { rank: 10, patterns: ['supply chain manager'] },
];

// Valid values for Notion Select / Multi-select fields — must match option names exactly.
// Notion creates new options on mismatch; validation prevents polluting the DB.
const VALID_INDUSTRIES     = ['Consumer Electronics', 'Kitchen', 'Apparel', 'Home Goods', 'Wellness', 'Pet Supplies', 'Auto Parts', 'Sports', 'Toys', 'Beauty', 'Other'];
const VALID_REVENUES       = ['<$1M', '$1M-$5M', '$5M-$25M', '$25M-$100M', '>$100M'];
const VALID_EMPLOYEES      = ['<10', '10-50', '50-200', '200-500', '>500'];
const VALID_COUNTRIES      = ['China', 'Vietnam', 'Taiwan', 'Thailand', 'India', 'South Korea', 'Other'];

const ICP_SYSTEM = `You are an ICP analyst for risksim.ai, a supply chain risk platform targeting US importers.

ICP FILTER v1 (Sept 5, 2026):

TIER 1 — MUST HAVE (all required, otherwise auto-skip, score = 0):
- Revenue: $1M to $100M
- HQ: US only
- Business model: DTC brand, wholesale importer, multi-channel retailer, or small manufacturer that imports
- Imports from Asia (at least one of: China, Vietnam, Taiwan, Thailand, India, South Korea, Bangladesh, Cambodia, Indonesia, Malaysia)
- Product category: physical goods (not software/services)

TIER 2 — STRONG SIGNAL (adds 1-3 points if present):
+3: recent tariff news/complaint (last 90 days), recent supply chain/ops hire (last 90 days), publicly diversifying away from China, founder posts about supply chain pain
+2: new product launch in tariff-affected category (last 6 months), multiple sourcing countries, uses Shopify/WooCommerce, Consumer Electronics/Accessories/Peripherals vertical
+1: founder posts about ops on LinkedIn, headcount grew 20%+ last year, actively hiring supply chain roles

TIER 3 — ANTI-SIGNAL:
AUTO-SKIP (score = 0): publicly traded, revenue >$150M, software/services/consulting, real estate/finance/healthcare, uses Palantir/Coupa/Ivalua/SAP GTS, 100% US suppliers, restaurants/food service
-2 points: under 3 years old AND under 10 employees, no public web presence, no identifiable decision-maker

INDUSTRIES (use exact strings):
Highest priority: Consumer Electronics, Accessories (use Consumer Electronics), Peripherals (use Consumer Electronics)
Want-to-prove: Kitchen, Apparel, Home Goods, Wellness, Pet Supplies, Auto Parts, Sports, Toys, Beauty
Skip (score 0): Software, Consulting, Real Estate, Finance, Healthcare, Restaurants, Media — use Other if uncategorized

Respond ONLY with valid JSON:
{"fit_score":0,"industry_match":"","tariff_hook":"","revenue_estimate":"","employees_estimate":"","sourcing_countries":[],"reasoning":""}

Constraints:
- fit_score: integer 0-10
- industry_match: one of Consumer Electronics, Kitchen, Apparel, Home Goods, Wellness, Pet Supplies, Auto Parts, Sports, Toys, Beauty, Other
- revenue_estimate: one of <$1M, $1M-$5M, $5M-$25M, $25M-$100M, >$100M  (empty string if unknown)
- employees_estimate: one of <10, 10-50, 50-200, 200-500, >500  (empty string if unknown)
- sourcing_countries: array, each from China, Vietnam, Taiwan, Thailand, India, South Korea, Other
- tariff_hook: 1 sentence referencing specific product + sourcing country + tariff impact; empty string if score = 0
- reasoning: 1-2 sentences explaining the score`;

// ============================================================
// STATE
// ============================================================

let enrichmentJobRunning = false;
let prospectsDbSchema    = null;   // { displayName: { id, type } } — cached at startup

// ============================================================
// REDIS — self-contained, does not depend on server.js helpers
// ============================================================

async function redisSafe(command) {
    const url   = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    try {
        const r = await axios.post(url, command, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 5000
        });
        return r.data.result;
    } catch (e) { return null; }
}

// ============================================================
// API KEY DISCOVERY
// ============================================================

function getHunterKeys() {
    const keys = [];
    for (let i = 1; i <= 10; i++) {
        const k = process.env[`HUNTER_API_KEY_${i}`];
        if (!k) break;
        keys.push(k);
    }
    return keys;
}

function getSerpKeys() {
    const keys = [];
    for (let i = 1; i <= 10; i++) {
        const k = process.env[`SERP_API_KEY_${i}`];
        if (!k) break;
        keys.push(k);
    }
    return keys;
}

// ============================================================
// QUOTA TRACKING
// ============================================================

function monthKey() { return new Date().toISOString().slice(0, 7); }

async function getCallCount(service, index) {
    const v = await redisSafe(['GET', `outreach:quota:${service}:${index}:${monthKey()}`]);
    return parseInt(v || '0', 10);
}

async function incrCallCount(service, index) {
    await redisSafe(['INCR', `outreach:quota:${service}:${index}:${monthKey()}`]);
}

async function markKeyExhausted(service, index) {
    await redisSafe(['SET', `outreach:quota:${service}:${index}:exhausted`, '1', 'EX', '14400']); // 4-hour TTL
}

async function isKeyExhausted(service, index) {
    return (await redisSafe(['GET', `outreach:quota:${service}:${index}:exhausted`])) === '1';
}

// Pick the non-exhausted key with the lowest monthly call count.
async function pickKey(service, keys) {
    if (!keys.length) return null;
    let best = null, bestCount = Infinity;
    for (let i = 0; i < keys.length; i++) {
        if (await isKeyExhausted(service, i)) continue;
        const count = await getCallCount(service, i);
        if (count < bestCount) { bestCount = count; best = { key: keys[i], index: i }; }
    }
    return best;   // null if all exhausted
}

async function trackCostCall() {
    await redisSafe(['INCR', `outreach:cost:${monthKey()}`]);
}

async function getMonthlyStats() {
    const month = monthKey();
    const stats = { month, hunter: [], serp: [], perplexity: 0, totalCostCalls: 0 };
    for (const [i, _] of getHunterKeys().entries()) {
        stats.hunter.push({ index: i, calls: await getCallCount('hunter', i), exhausted: await isKeyExhausted('hunter', i) });
    }
    for (const [i, _] of getSerpKeys().entries()) {
        stats.serp.push({ index: i, calls: await getCallCount('serp', i), exhausted: await isKeyExhausted('serp', i) });
    }
    stats.perplexity   = await getCallCount('perplexity', 0);
    stats.totalCostCalls = parseInt(await redisSafe(['GET', `outreach:cost:${month}`]) || '0', 10);
    return stats;
}

// ============================================================
// NOTION HELPERS
// ============================================================

async function notionRequest(method, path, body) {
    const key = process.env.NOTION_API_KEY;
    if (!key) throw new Error('NOTION_API_KEY not set');
    const r = await axios({
        method,
        url:     NOTION_API_BASE + path,
        headers: {
            Authorization:    `Bearer ${key}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type':   'application/json'
        },
        data:    body,
        timeout: 10000
    });
    return r.data;
}

// Load Prospects DB schema at startup and cache. Returns { displayName: { id, type } }.
async function loadProspectsSchema() {
    if (prospectsDbSchema) return prospectsDbSchema;
    const dbId = process.env.NOTION_PROSPECTS_DB_ID;
    if (!dbId) throw new Error('NOTION_PROSPECTS_DB_ID not set');
    const db  = await notionRequest('GET', `/databases/${dbId}`);
    const map = {};
    for (const [name, prop] of Object.entries(db.properties || {})) {
        map[name] = { id: prop.id, type: prop.type };
    }
    prospectsDbSchema = map;
    console.log('[Outreach] Loaded Prospects DB schema:', Object.keys(map).join(', '));
    return map;
}

// Poll "To Enrich" DB for rows with Status = "Pending"
async function pollPendingRows() {
    const dbId = process.env.NOTION_TO_ENRICH_DB_ID;
    if (!dbId) throw new Error('NOTION_TO_ENRICH_DB_ID not set');
    const result = await notionRequest('POST', `/databases/${dbId}/query`, {
        filter:    { property: 'Status', select: { equals: 'Pending' } },
        page_size: 10
    });
    return result.results || [];
}

// Update a row's Status (and optionally Notes) in the To Enrich DB
async function updateRowStatus(pageId, status, notes) {
    const props = { Status: { select: { name: status } } };
    if (notes) {
        props.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 2000) } }] };
    }
    await notionRequest('PATCH', `/pages/${pageId}`, { properties: props });
}

// ---- Output field validation ----
function coerceSelect(value, valid, fallback = '') {
    if (!value) return fallback;
    const match = valid.find(v => v.toLowerCase() === String(value).toLowerCase());
    return match || fallback;
}

function coerceMultiSelect(values, valid) {
    if (!Array.isArray(values)) return [];
    return values
        .map(v => valid.find(o => o.toLowerCase() === String(v).toLowerCase()))
        .filter(Boolean);
}

// Build the Notion properties payload using cached schema IDs (robust against column renames)
function buildProspectProperties(schema, data) {
    const props = {};

    function set(displayName, payload) {
        const s = schema[displayName];
        if (!s) { console.warn('[Outreach] Schema missing property:', displayName); return; }
        props[s.id] = payload;
    }

    const testMode   = process.env.OUTREACH_AGENT_TEST_MODE === 'true';
    const companyVal = testMode ? `TEST: ${data.company}` : data.company;

    set('Name',                { title:      [{ text: { content: (data.name     || '').slice(0, 2000) } }] });
    set('Company',             { rich_text:  [{ text: { content:  companyVal.slice(0, 2000)           } }] });
    set('Title',               { rich_text:  [{ text: { content: (data.title    || '').slice(0, 200)  } }] });
    set('Tariff hook',         { rich_text:  [{ text: { content: (data.tariff_hook  || '').slice(0, 2000) } }] });
    set('Recent news',         { rich_text:  [{ text: { content: (data.recent_news  || '').slice(0, 2000) } }] });
    set('Notes',               { rich_text:  [{ text: { content: (data.notes    || '').slice(0, 2000) } }] });
    set('Status',              { select:     { name: 'New' } });
    set('Enriched at',         { date:       { start: new Date().toISOString() } });

    if (data.domain)     set('Domain',    { url: data.domain.startsWith('http') ? data.domain : `https://${data.domain}` });
    if (data.email)      set('Email',     { email: data.email });
    if (data.phone)      set('Phone',     { phone_number: data.phone });
    if (data.linkedin)   set('LinkedIn',  { url: data.linkedin });
    if (data.twitter)    set('Twitter',   { url: data.twitter });
    if (data.instagram)  set('Instagram', { url: data.instagram });

    if (data.fit_score != null) set('Fit score', { number: data.fit_score });

    const industry = coerceSelect(data.industry, VALID_INDUSTRIES, 'Other');
    set('Industry', { select: { name: industry } });

    const rev = coerceSelect(data.revenue_estimate, VALID_REVENUES);
    if (rev) set('Revenue estimate', { select: { name: rev } });

    const emp = coerceSelect(data.employees_estimate, VALID_EMPLOYEES);
    if (emp) set('Employees estimate', { select: { name: emp } });

    const countries = coerceMultiSelect(data.sourcing_countries, VALID_COUNTRIES);
    if (countries.length) set('Sourcing countries', { multi_select: countries.map(c => ({ name: c })) });

    return props;
}

async function writeProspectRow(data) {
    const schema = await loadProspectsSchema();
    const props  = buildProspectProperties(schema, data);
    await notionRequest('POST', '/pages', {
        parent:     { database_id: process.env.NOTION_PROSPECTS_DB_ID },
        properties: props
    });
    console.log(`[Outreach] Wrote Prospect: ${data.name} @ ${data.company} — fit: ${data.fit_score}/10 (${data.industry})`);
}

// ============================================================
// STUCK JOB CLEANUP
// ============================================================

async function resetStuckJobs() {
    const dbId = process.env.NOTION_TO_ENRICH_DB_ID;
    if (!dbId) return 0;
    let count = 0;
    try {
        const result = await notionRequest('POST', `/databases/${dbId}/query`, {
            filter:    { property: 'Status', select: { equals: 'Processing' } },
            page_size: 50
        });
        for (const row of (result.results || [])) {
            const ageMin = (Date.now() - new Date(row.last_edited_time).getTime()) / 60000;
            if (ageMin > 35) {
                await updateRowStatus(row.id, 'Pending', null);
                console.log(`[Outreach] Reset stuck job: ${row.id} (${Math.round(ageMin)}m old)`);
                count++;
            }
        }
    } catch (e) { console.error('[Outreach] resetStuckJobs error:', e.message); }
    return count;
}

// ============================================================
// TITLE MATCHING
// ============================================================

function getTitleRank(title) {
    if (!title) return 999;
    const t = title.toLowerCase();
    for (const tier of TITLE_PRIORITY) {
        if (tier.patterns.some(p => t.includes(p))) return tier.rank;
    }
    return 999;
}

// From Hunter's email array, return the highest-priority decision-maker or null.
function matchTitlePriority(emails) {
    if (!emails || !emails.length) return null;
    let best = null, bestRank = 999;
    for (const person of emails) {
        const rank = getTitleRank(person.position || '');
        if (rank < bestRank) { bestRank = rank; best = person; }
    }
    return bestRank < 999 ? best : null;
}

// ============================================================
// STEP 1 — HUNTER DOMAIN SEARCH  (CRITICAL)
// ============================================================

async function stepHunterDomainSearch(domain) {
    const keys = getHunterKeys();
    if (!keys.length) {
        console.warn('[Outreach] No Hunter keys configured');
        return null;
    }

    // Try current best key; on 429 rotate to next
    for (let attempt = 0; attempt < keys.length; attempt++) {
        const picked = await pickKey('hunter', keys);
        if (!picked) { console.warn('[Outreach] All Hunter keys exhausted'); return null; }
        const { key, index } = picked;
        try {
            const r = await axios.get('https://api.hunter.io/v2/domain-search', {
                params:  { domain, api_key: key, limit: 10 },
                timeout: 10000
            });
            await incrCallCount('hunter', index);

            const emails = r.data?.data?.emails || [];
            console.log(`[Outreach] Hunter domain-search: ${domain} → ${emails.length} emails`);

            const count = await getCallCount('hunter', index);
            if (count >= HUNTER_FIND_WARN) {
                console.warn(`[Outreach] WARN: Hunter key ${index} at ${count} monthly calls (approaching 25-find quota)`);
            }

            const contact = matchTitlePriority(emails);
            if (!contact) return null;

            const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
            return {
                name,
                title:          contact.position || '',
                email:          contact.value    || '',
                email_verified: (contact.confidence || 0) >= 90,
                all_contacts:   emails
            };
        } catch (err) {
            const status = err.response?.status;
            if (status === 429 || status === 403) {
                console.warn(`[Outreach] Hunter key ${index} returned ${status} — marking exhausted, trying next`);
                await markKeyExhausted('hunter', index);
                continue;   // rotate to next key
            }
            console.error('[Outreach] Hunter domain-search error:', err.message);
            return null;
        }
    }
    return null;
}

// ============================================================
// STEP 2 — HUNTER EMAIL VERIFY  (quota-aware, best-effort)
// ============================================================

async function stepHunterVerify(email) {
    const keys   = getHunterKeys();
    const picked = await pickKey('hunter', keys);
    if (!picked) return false;
    const { key, index } = picked;
    try {
        const r = await axios.get('https://api.hunter.io/v2/email-verifier', {
            params:  { email, api_key: key },
            timeout: 15000   // verification is slower
        });
        await incrCallCount('hunter', index);
        const d = r.data?.data;
        return d?.result === 'deliverable' || (d?.score || 0) >= 80;
    } catch (err) {
        const status = err.response?.status;
        if (status === 429 || status === 403) await markKeyExhausted('hunter', index);
        console.warn('[Outreach] Hunter verify failed (non-critical):', err.message);
        return false;
    }
}

// ============================================================
// STEP 3 — SERP SOCIAL SEARCH  (best-effort)
// ============================================================

function extractSocialUrl(results, checkDomains) {
    for (const r of results) {
        const link = r.link || '';
        if (checkDomains.some(d => link.includes(d))) return link;
    }
    return null;
}

async function stepSerpSocials(name, company) {
    const keys    = getSerpKeys();
    const socials = { linkedin: null, twitter: null, instagram: null };
    if (!keys.length) { console.warn('[Outreach] No SerpAPI keys configured'); return socials; }

    const queries = [
        { field: 'linkedin',  q: `"${name}" "${company}" site:linkedin.com/in`,  domains: ['linkedin.com'] },
        { field: 'twitter',   q: `"${name}" "${company}" (site:twitter.com OR site:x.com)`, domains: ['twitter.com', 'x.com'] },
        { field: 'instagram', q: `"${name}" "${company}" site:instagram.com`,    domains: ['instagram.com'] }
    ];

    for (const qSpec of queries) {
        const picked = await pickKey('serp', keys);
        if (!picked) { console.warn('[Outreach] All SerpAPI keys exhausted'); break; }
        const { key, index } = picked;
        try {
            const r = await axios.get('https://serpapi.com/search', {
                params:  { q: qSpec.q, api_key: key, engine: 'google', num: 5 },
                timeout: 10000
            });
            await incrCallCount('serp', index);

            const url = extractSocialUrl(r.data?.organic_results || [], qSpec.domains);
            if (url) socials[qSpec.field] = url;

            const count = await getCallCount('serp', index);
            if (count >= SERP_WARN) {
                console.warn(`[Outreach] WARN: SerpAPI key ${index} at ${count} monthly searches (approaching 250 quota)`);
            }
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) await markKeyExhausted('serp', index);
            console.warn(`[Outreach] SerpAPI ${qSpec.field} search failed (non-critical):`, err.message);
        }
    }
    return socials;
}

// ============================================================
// STEP 4 — WEBSITE SCRAPE  (best-effort, phone only)
// ============================================================

// Matches common US phone formats: (555) 555-5555, 555-555-5555, +1 555 555 5555, etc.
const PHONE_RE = /(\+?1[\s.\-]?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4})/g;

async function fetchText(url) {
    try {
        const r = await axios.get(url, {
            timeout:          8000,
            maxContentLength: 500000,
            headers:          { 'User-Agent': 'Mozilla/5.0 (compatible; RiskSimBot/1.0; +https://risksim.ai)' },
            validateStatus:   s => s < 400
        });
        const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        // Strip HTML tags and collapse whitespace for cleaner regex matching
        return body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    } catch (e) { return ''; }
}

async function stepWebScrape(domain) {
    const base  = domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`;
    const paths = ['', '/contact', '/about', '/team'];
    for (const p of paths) {
        const text    = await fetchText(base + p);
        const matches = text.match(PHONE_RE);
        if (matches && matches.length) {
            return { phone: matches[0].replace(/\s+/g, '-').trim() };
        }
    }
    return { phone: null };
}

// ============================================================
// STEP 5 — PERPLEXITY NEWS  (best-effort)
// ============================================================

async function stepPerplexityNews(companyName) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) { console.warn('[Outreach] PERPLEXITY_API_KEY not set — skipping news step'); return null; }

    const count = await getCallCount('perplexity', 0);
    if (count >= PERPLEXITY_WARN) {
        console.warn(`[Outreach] WARN: Perplexity at ${count} calls — approaching $10 credit cap`);
    }

    try {
        const r = await axios.post('https://api.perplexity.ai/chat/completions', {
            model:      'sonar-medium-online',
            max_tokens: 250,
            messages:   [{
                role:    'user',
                content: `Recent news about ${companyName} in the last 30 days related to supply chain, tariffs, funding, hiring, or product launches. Return 1-2 concise sentences of the most relevant news only. If nothing relevant exists, reply with exactly: No recent news found.`
            }]
        }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        await incrCallCount('perplexity', 0);
        await trackCostCall();

        const snippet = (r.data?.choices?.[0]?.message?.content || '').trim();
        if (snippet === 'No recent news found.' || !snippet) return null;
        return snippet;
    } catch (err) {
        console.warn('[Outreach] Perplexity news failed (non-critical):', err.message);
        return null;
    }
}

// ============================================================
// STEP 6 — CLAUDE ICP SCORING  (CRITICAL)
// ============================================================

async function stepClaudeScore(companyName, domain, enrichedData) {
    const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

    const context = {
        company:         companyName,
        domain,
        contact_name:    enrichedData.name,
        contact_title:   enrichedData.title,
        linkedin:        enrichedData.linkedin   || null,
        twitter:         enrichedData.twitter    || null,
        recent_news:     enrichedData.recent_news || 'none',
        phone_found:     !!enrichedData.phone,
        contacts_at_company: (enrichedData.all_contacts || []).slice(0, 10).map(c => ({
            name:  `${c.first_name || ''} ${c.last_name || ''}`.trim(),
            title: c.position || '',
            dept:  c.department || ''
        }))
    };

    const msg = await anthropic.messages.create({
        model:     'claude-sonnet-4-6',
        max_tokens: 600,
        system:    ICP_SYSTEM,
        messages:  [{ role: 'user', content: `Score this company:\n${JSON.stringify(context, null, 2)}` }]
    });
    await trackCostCall();

    const text      = msg.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 120)}`);

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[Outreach] Claude ICP: ${companyName} → ${result.fit_score}/10 (${result.industry_match})`);
    return result;
}

// ============================================================
// ORCHESTRATION — enrich one company (pure, no Notion status calls)
// ============================================================

async function enrichCompany(company, domain, notes) {
    console.log(`[Outreach] Enriching: ${company} (${domain})`);

    // Step 1 — CRITICAL
    const contact = await stepHunterDomainSearch(domain);
    if (!contact) {
        return { success: false, failReason: 'No decision-maker found at company — domain not indexed or no matching titles in Hunter' };
    }

    // Step 2 — verify only if confidence < 90 from domain search
    let emailVerified = contact.email_verified;
    if (!emailVerified && contact.email) {
        emailVerified = await stepHunterVerify(contact.email);
    }

    // Steps 3-5 — best-effort, never block on failure
    const [socials, { phone }, recent_news] = await Promise.allSettled([
        stepSerpSocials(contact.name, company),
        stepWebScrape(domain),
        stepPerplexityNews(company)
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : (r.reason && console.warn('[Outreach] Best-effort step failed:', r.reason.message), null)));

    const enrichedData = {
        name:         contact.name,
        title:        contact.title,
        email:        contact.email,
        phone:        phone || null,
        linkedin:     socials?.linkedin    || null,
        twitter:      socials?.twitter     || null,
        instagram:    socials?.instagram   || null,
        recent_news:  recent_news || null,
        all_contacts: contact.all_contacts
    };

    // Step 6 — CRITICAL (retry once after 30s)
    let scoring;
    try {
        scoring = await stepClaudeScore(company, domain, enrichedData);
    } catch (err) {
        console.warn('[Outreach] Claude scoring failed, retrying in 30s:', err.message);
        await new Promise(r => setTimeout(r, 30000));
        try {
            scoring = await stepClaudeScore(company, domain, enrichedData);
        } catch (err2) {
            return { success: false, failReason: `Claude ICP scoring failed after retry: ${err2.message}` };
        }
    }

    // Auto-skip on score 0
    if (!scoring.fit_score || scoring.fit_score === 0) {
        return { success: false, failReason: 'Fails ICP Tier 1 requirements (fit score: 0)' };
    }

    return {
        success: true,
        result: {
            name:               contact.name,
            company,
            domain,
            notes,
            title:              contact.title,
            fit_score:          scoring.fit_score,
            email:              contact.email,
            email_verified:     emailVerified,
            phone:              phone           || null,
            linkedin:           socials?.linkedin   || null,
            twitter:            socials?.twitter    || null,
            instagram:          socials?.instagram  || null,
            industry:           scoring.industry_match    || 'Other',
            sourcing_countries: scoring.sourcing_countries || [],
            revenue_estimate:   scoring.revenue_estimate  || '',
            employees_estimate: scoring.employees_estimate || '',
            tariff_hook:        scoring.tariff_hook       || '',
            recent_news:        recent_news               || '',
            all_contacts:       contact.all_contacts
        }
    };
}

// ============================================================
// MAIN JOB — poll Notion, process each row
// ============================================================

async function runEnrichmentJob() {
    if (enrichmentJobRunning) {
        console.log('[Outreach] Job already running — skipping tick');
        return { processed: 0, sent: 0, failed: 0, skipped: 1, reason: 'already-running' };
    }

    const missing = ['NOTION_API_KEY', 'NOTION_TO_ENRICH_DB_ID', 'NOTION_PROSPECTS_DB_ID']
        .filter(k => !process.env[k]);
    if (missing.length) {
        console.warn('[Outreach] Missing env vars — skipping job:', missing.join(', '));
        return { processed: 0, sent: 0, failed: 0, skipped: 1, reason: 'missing-config' };
    }

    enrichmentJobRunning = true;
    const summary = { processed: 0, sent: 0, failed: 0, skipped: 0 };

    try {
        // Reset any rows stuck in "Processing" from a prior crash
        await resetStuckJobs();

        // Load Prospects schema (cached after first call)
        try { await loadProspectsSchema(); }
        catch (e) {
            console.error('[Outreach] Failed to load Prospects DB schema:', e.message);
            return { ...summary, skipped: 1, reason: 'schema-load-failed' };
        }

        // Poll pending rows
        let rows;
        try { rows = await pollPendingRows(); }
        catch (e) {
            console.error('[Outreach] Notion poll failed:', e.message);
            return summary;
        }

        if (!rows.length) { console.log('[Outreach] No pending rows'); return summary; }
        console.log(`[Outreach] Found ${rows.length} pending row(s)`);

        for (const row of rows) {
            const pageId = row.id;
            const props  = row.properties || {};

            // Extract company name from the Title property (type-based, name-agnostic)
            let company = '';
            for (const prop of Object.values(props)) {
                if (prop.type === 'title' && prop.title?.length) {
                    company = prop.title[0]?.plain_text || ''; break;
                }
            }
            const domain = props['Domain']?.url || '';
            const notes  = props['Notes']?.rich_text?.[0]?.plain_text || '';

            if (!company || !domain) {
                await updateRowStatus(pageId, 'Failed', 'Missing company name or domain — fill both fields before re-queuing');
                summary.failed++; continue;
            }

            // Mark Processing (idempotency — poller only picks Pending)
            try { await updateRowStatus(pageId, 'Processing', null); }
            catch (e) { console.error('[Outreach] Failed to mark Processing:', pageId, e.message); summary.skipped++; continue; }

            // Redis lock as secondary guard (35-min TTL)
            await redisSafe(['SET', `outreach:lock:${pageId}`, '1', 'EX', '2100']);

            summary.processed++;

            try {
                const { success, result, failReason } = await enrichCompany(company, domain, notes);

                if (!success) {
                    await updateRowStatus(pageId, 'Failed', failReason);
                    summary.failed++;
                    console.log(`[Outreach] Failed: ${company} — ${failReason}`);
                    continue;
                }

                // Write to Prospects DB; on failure save to Redis for manual retry
                try {
                    await writeProspectRow(result);
                    await updateRowStatus(pageId, 'Done', null);
                    summary.sent++;
                    console.log(`[Outreach] Done: ${company} → ${result.name} (${result.email}) score ${result.fit_score}/10`);
                } catch (writeErr) {
                    await redisSafe(['SET', `outreach:enriched:${pageId}`, JSON.stringify(result), 'EX', String(7 * 24 * 3600)]);
                    await updateRowStatus(pageId, 'Failed', `Enrichment complete but Notion write failed: ${writeErr.message}`);
                    summary.failed++;
                    console.error('[Outreach] Notion write failed (enriched data saved to Redis for manual retry):', writeErr.message);
                }
            } catch (e) {
                await updateRowStatus(pageId, 'Failed', `Unexpected error: ${e.message}`);
                summary.failed++;
                console.error(`[Outreach] Unexpected error for ${company}:`, e.message);
            }

            // Brief gap between rows — respect Notion's 3 req/s rate limit
            await new Promise(r => setTimeout(r, 500));
        }
    } finally {
        enrichmentJobRunning = false;
    }

    console.log('[Outreach] Job summary:', JSON.stringify(summary));
    return summary;
}

// ============================================================
// SINGLE-ROW TEST  — called by /api/admin/enrich-one
// Bypasses Notion polling, no status updates on source row.
// ============================================================

async function processOneRow(company, domain, notes = '') {
    const missing = ['NOTION_API_KEY', 'NOTION_PROSPECTS_DB_ID'].filter(k => !process.env[k]);
    if (missing.length) throw new Error('Missing env vars: ' + missing.join(', '));
    await loadProspectsSchema();
    const { success, result, failReason } = await enrichCompany(company, domain, notes);
    if (!success) return { success: false, failReason };
    await writeProspectRow(result);
    return { success: true, result };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = { runEnrichmentJob, processOneRow, resetStuckJobs, getMonthlyStats };

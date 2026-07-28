const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
    contentSecurityPolicy: false, // managed below per-route
    crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', 'https://risksim.ai');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Heavy Claude endpoints — audit and price extraction
const claudeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

// Chat endpoint — needs more room for conversations
const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: 'Too many requests, please try again later.' },
    // Phase 3: the internal re-analysis job calls /api/analyze-shipment in a loop
    // (all from loopback); exempt authenticated internal calls so the daily job
    // isn't throttled. Normal users never hold DATA_API_KEY, so their limit is unchanged.
    skip: (req) => !!process.env.DATA_API_KEY && req.headers['x-api-key'] === process.env.DATA_API_KEY
});

// Demo request — low volume, high bot risk
const demoLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many requests, please try again later.' }
});

// OTP sign-in — tight per-IP limit to stop brute force on send + verify
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' }
});

// Reviewer password gate — 5 attempts per 10 min per IP
const REVIEWER_TOKEN = 'yc-fall-2026-rvw-a3xq7m2h';
const REVIEWER_PASSWORD_HASH = '$2b$12$3tAfKP6todjnQIHZf0VBMeiGOLZo6e8JM3KGEl47jrPrdavmgbCyi';
const reviewerLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { error: 'Too many attempts. Try again in 10 minutes.' }
});

// General limit on all routes
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(generalLimiter);
app.use('/api/audit-custom', claudeLimiter);
app.use('/api/price-extract', claudeLimiter);
app.use('/api/terminal/news', claudeLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/analyze-shipment', chatLimiter);
app.use('/api/demo-request', demoLimiter);
app.use('/api/send-otp', otpLimiter);
app.use('/api/verify-otp', otpLimiter);
app.use('/api/verify-reviewer', reviewerLimiter);

// Input sanitisation helper — strips HTML tags
function stripHtml(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/<[^>]*>/g, '').trim();
}

// Sanitise user-supplied strings before embedding in Discord messages.
// Strips @ (prevents @everyone/@here pings) and Discord markdown injection chars.
function sanitizeForDiscord(str) {
    if (!str) return '';
    return String(str)
        .replace(/@/g, '(at)')
        .replace(/`/g, "'")
        .replace(/[*_~|\\]/g, '')
        .trim()
        .slice(0, 200);
}

// Sanitise free-text fields before injecting into AI system prompts.
// Strips HTML, collapses newlines (prevents prompt injection via multi-line field values),
// removes [] delimiters that our card block parser uses, and caps length.
function sanitizeForPrompt(str) {
    if (!str) return '';
    return stripHtml(String(str))
        .replace(/[\r\n]+/g, ' ')
        .replace(/\[|\]/g, '')
        .replace(/#+/g, '')
        .trim()
        .slice(0, 300);
}

const MAX_INPUT = 5000;

// ============================================================
// TERMINAL NEWS CACHE — in-memory, resets on deploy
// ============================================================
const terminalNewsCache = {};
const TERMINAL_NEWS_TTL = 2 * 60 * 60 * 1000; // 2 hours

function terminalCacheKey(sourcingCountries, homeCountry, industry) {
    return (Array.isArray(sourcingCountries) ? sourcingCountries.slice().sort() : []).join(',')
        + '|' + (homeCountry || '').toLowerCase().trim()
        + '|' + (industry || 'general').toLowerCase().trim();
}

function extractJsonArray(text) {
    // Strip ```json fences first
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    // Bracket-match: first '[' to last ']'
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

// Allow iframe embedding from Shopify
app.use((req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', '');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// n8n DATA STORE — in-memory, resets on deploy
// ============================================================
const dataStore = {
    alerts: [],
    tariffs: [],
    ports: [],
    commodities: [],
    currency: [],
    alertsByIndustry: {
        technology: [],
        textiles: [],
        automotive: [],
        food: [],
        pharma: [],
        rawMaterials: [],
        consumerGoods: [],
        general: []
    }
};

// ============================================================
// SUBSCRIBER STORE — Upstash Redis via axios REST, in-memory fallback
// Architecture: server exposes data endpoints for n8n (push/poll) and
// handles direct email delivery via Resend REST API — no extra npm packages.
// Subscriber records survive deploys when UPSTASH_* env vars are set.
// ============================================================

const redisAvailable = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
if (!redisAvailable) {
    console.warn('[Redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — subscriber data will reset on deploy');
}

const emailSubscribersFallback = {};

async function redisCmd(command) {
    const r = await axios.post(process.env.UPSTASH_REDIS_REST_URL, command, {
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 5000
    });
    return r.data.result;
}

async function redisPipeline(commands) {
    const r = await axios.post(process.env.UPSTASH_REDIS_REST_URL + '/pipeline', commands, {
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 8000
    });
    return r.data.map(item => item.result);
}

const SUB_KEY = e => `email:subscriber:${e}`;
const SUB_INDEX = 'email:subscribers';

async function getSubscriber(email) {
    const key = email.toLowerCase();
    if (!redisAvailable) return emailSubscribersFallback[key] || null;
    try {
        const val = await redisCmd(['GET', SUB_KEY(key)]);
        return val ? JSON.parse(val) : null;
    } catch (e) {
        console.error('[Redis] getSubscriber error:', e.message);
        return emailSubscribersFallback[key] || null;
    }
}

async function setSubscriber(email, data) {
    const key = email.toLowerCase();
    emailSubscribersFallback[key] = data;
    if (!redisAvailable) return;
    try {
        await redisPipeline([
            ['SET', SUB_KEY(key), JSON.stringify(data)],
            ['SADD', SUB_INDEX, key]
        ]);
    } catch (e) {
        console.error('[Redis] setSubscriber error:', e.message);
    }
}

async function deleteSubscriber(email) {
    const key = email.toLowerCase();
    delete emailSubscribersFallback[key];
    if (!redisAvailable) return;
    try {
        await redisPipeline([
            ['DEL', SUB_KEY(key)],
            ['SREM', SUB_INDEX, key]
        ]);
    } catch (e) {
        console.error('[Redis] deleteSubscriber error:', e.message);
    }
}

async function listSubscribers(filterByPreference) {
    if (!redisAvailable) {
        const subs = Object.values(emailSubscribersFallback);
        return filterByPreference ? subs.filter(s => s.preferences?.[filterByPreference] === true) : subs;
    }
    try {
        const emails = await redisCmd(['SMEMBERS', SUB_INDEX]) || [];
        if (emails.length === 0) return [];
        const values = await redisPipeline(emails.map(e => ['GET', SUB_KEY(e)]));
        const subs = values.map(v => v ? JSON.parse(v) : null).filter(Boolean);
        return filterByPreference ? subs.filter(s => s.preferences?.[filterByPreference] === true) : subs;
    } catch (e) {
        console.error('[Redis] listSubscribers error:', e.message);
        const subs = Object.values(emailSubscribersFallback);
        return filterByPreference ? subs.filter(s => s.preferences?.[filterByPreference] === true) : subs;
    }
}

// Auth middleware for n8n POST routes
function requireDataKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!process.env.DATA_API_KEY || key !== process.env.DATA_API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
}

// ============================================================================
// REGIONAL MAP DATA  (Regional Map Data Project -- Day 1 scaffold)
// ----------------------------------------------------------------------------
// The Risk Intelligence Map is rendered client-side from an inline COUNTRY_DATA
// array in public/index.html. This module makes that dataset region-aware so an
// authenticated user can see supply-chain intelligence calibrated to their own
// home trade region rather than the default US import lens.
//
// Model:
//   - US_MAP_DATA is a verbatim copy of the current inline COUNTRY_DATA (85
//     countries). It IS the "us" region, so unauthenticated / US-assigned users
//     see byte-identical data to today (no behaviour change for existing users).
//   - regionalMapData holds one dataset per region. Region-specific values
//     (importer-relative tariff, proximity-based shipping cost, combined
//     costIndex) are calibrated per region; intrinsic country attributes
//     (risk, labor, infra, mfgCapacity, sourcing, coordinates) stay constant.
//   - Day 1 populates ONLY "us". The other 7 regions are scaffolded here and
//     populated in Day 2.
//
// Schema of one record (unchanged from the frontend):
//   { name, lat, lng, risk(0-100), shipping(1-10), labor(1-10), tariff(%),
//     infra(1-10), costIndex(0-100), mfgCapacity, exportInfra, supplierDensity,
//     leadTimeReliability, sourcing:{technology,textiles,generalMfg,
//     consumerGoods,automotive,pharma} }
// ============================================================================

const US_MAP_DATA = [
    {name:'North Korea',lat:40.3,lng:127.5,risk:98,shipping:9,labor:4,tariff:25,infra:3,costIndex:80,mfgCapacity:5,exportInfra:2,supplierDensity:2,leadTimeReliability:10,sourcing:{technology:2,textiles:3,generalMfg:3,consumerGoods:2,automotive:1,pharma:1}},
    {name:'Russia',lat:61.5,lng:90,risk:95,shipping:8,labor:5,tariff:35,infra:6,costIndex:75,mfgCapacity:55,exportInfra:50,supplierDensity:45,leadTimeReliability:40,sourcing:{technology:10,textiles:5,generalMfg:25,consumerGoods:10,automotive:15,pharma:20}},
    {name:'Iran',lat:32.4,lng:53.7,risk:93,shipping:7,labor:4,tariff:30,infra:5,costIndex:72,mfgCapacity:25,exportInfra:20,supplierDensity:18,leadTimeReliability:25,sourcing:{technology:5,textiles:15,generalMfg:15,consumerGoods:8,automotive:10,pharma:12}},
    {name:'Venezuela',lat:6.4,lng:-66.6,risk:89,shipping:6,labor:3,tariff:25,infra:3,costIndex:72,mfgCapacity:15,exportInfra:20,supplierDensity:10,leadTimeReliability:20,sourcing:{technology:3,textiles:5,generalMfg:8,consumerGoods:5,automotive:5,pharma:5}},
    {name:'Iraq',lat:33.2,lng:43.7,risk:88,shipping:7,labor:3,tariff:15,infra:3,costIndex:70,mfgCapacity:10,exportInfra:15,supplierDensity:8,leadTimeReliability:15,sourcing:{technology:2,textiles:3,generalMfg:5,consumerGoods:3,automotive:2,pharma:5}},
    {name:'Ukraine',lat:48.4,lng:31.2,risk:88,shipping:5,labor:3,tariff:10,infra:6,costIndex:60,mfgCapacity:35,exportInfra:40,supplierDensity:30,leadTimeReliability:25,sourcing:{technology:15,textiles:10,generalMfg:20,consumerGoods:10,automotive:15,pharma:10}},
    {name:'Myanmar',lat:17.1,lng:95.9,risk:85,shipping:8,labor:2,tariff:15,infra:3,costIndex:58,mfgCapacity:18,exportInfra:15,supplierDensity:12,leadTimeReliability:20,sourcing:{technology:2,textiles:25,generalMfg:10,consumerGoods:8,automotive:1,pharma:2}},
    {name:'Lebanon',lat:33.9,lng:35.5,risk:79,shipping:6,labor:4,tariff:15,infra:4,costIndex:65,mfgCapacity:8,exportInfra:15,supplierDensity:5,leadTimeReliability:10,sourcing:{technology:5,textiles:5,generalMfg:5,consumerGoods:5,automotive:2,pharma:8}},
    {name:'China',lat:35.8,lng:104.2,risk:28,shipping:7,labor:3,tariff:25,infra:7,costIndex:30,mfgCapacity:98,exportInfra:95,supplierDensity:99,leadTimeReliability:80,sourcing:{technology:95,textiles:75,generalMfg:95,consumerGoods:92,automotive:70,pharma:65}},
    {name:'Pakistan',lat:30.4,lng:69.3,risk:76,shipping:8,labor:2,tariff:17,infra:4,costIndex:55,mfgCapacity:40,exportInfra:35,supplierDensity:35,leadTimeReliability:45,sourcing:{technology:10,textiles:60,generalMfg:30,consumerGoods:25,automotive:8,pharma:15}},
    {name:'Nigeria',lat:9.1,lng:8.7,risk:72,shipping:7,labor:2,tariff:20,infra:4,costIndex:58,mfgCapacity:15,exportInfra:20,supplierDensity:12,leadTimeReliability:30,sourcing:{technology:3,textiles:10,generalMfg:10,consumerGoods:8,automotive:3,pharma:5}},
    {name:'India',lat:20.6,lng:79,risk:35,shipping:7,labor:2,tariff:10,infra:6,costIndex:25,mfgCapacity:80,exportInfra:68,supplierDensity:75,leadTimeReliability:60,sourcing:{technology:45,textiles:70,generalMfg:72,consumerGoods:65,automotive:50,pharma:92}},
    {name:'Turkey',lat:38.9,lng:35.2,risk:42,shipping:5,labor:4,tariff:5,infra:7,costIndex:32,mfgCapacity:60,exportInfra:65,supplierDensity:55,leadTimeReliability:65,sourcing:{technology:20,textiles:70,generalMfg:55,consumerGoods:40,automotive:55,pharma:20}},
    {name:'Bangladesh',lat:23.7,lng:90.4,risk:62,shipping:8,labor:1,tariff:12,infra:5,costIndex:42,mfgCapacity:60,exportInfra:50,supplierDensity:55,leadTimeReliability:55,sourcing:{technology:5,textiles:88,generalMfg:30,consumerGoods:35,automotive:3,pharma:5}},
    {name:'Vietnam',lat:14.1,lng:108.3,risk:32,shipping:7,labor:2,tariff:6,infra:6,costIndex:22,mfgCapacity:72,exportInfra:70,supplierDensity:65,leadTimeReliability:65,sourcing:{technology:55,textiles:85,generalMfg:65,consumerGoods:62,automotive:20,pharma:10}},
    {name:'Thailand',lat:15.9,lng:100.9,risk:30,shipping:7,labor:3,tariff:5,infra:7,costIndex:24,mfgCapacity:65,exportInfra:70,supplierDensity:58,leadTimeReliability:70,sourcing:{technology:40,textiles:30,generalMfg:55,consumerGoods:55,automotive:60,pharma:15}},
    {name:'Indonesia',lat:-0.8,lng:113.9,risk:38,shipping:7,labor:2,tariff:10,infra:5,costIndex:28,mfgCapacity:55,exportInfra:50,supplierDensity:45,leadTimeReliability:55,sourcing:{technology:15,textiles:40,generalMfg:40,consumerGoods:45,automotive:25,pharma:10}},
    {name:'Cambodia',lat:12.6,lng:104.9,risk:48,shipping:8,labor:2,tariff:12,infra:4,costIndex:38,mfgCapacity:30,exportInfra:30,supplierDensity:25,leadTimeReliability:50,sourcing:{technology:5,textiles:65,generalMfg:22,consumerGoods:18,automotive:2,pharma:3}},
    {name:'Brazil',lat:-14.2,lng:-51.9,risk:50,shipping:6,labor:4,tariff:18,infra:6,costIndex:42,mfgCapacity:60,exportInfra:60,supplierDensity:55,leadTimeReliability:55,sourcing:{technology:20,textiles:25,generalMfg:50,consumerGoods:35,automotive:45,pharma:30}},
    {name:'Mexico',lat:23.6,lng:-102.6,risk:42,shipping:4,labor:3,tariff:2,infra:7,costIndex:25,mfgCapacity:78,exportInfra:80,supplierDensity:72,leadTimeReliability:70,sourcing:{technology:35,textiles:30,generalMfg:78,consumerGoods:45,automotive:88,pharma:15}},
    {name:'Romania',lat:45.9,lng:24.9,risk:22,shipping:5,labor:4,tariff:3,infra:7,costIndex:26,mfgCapacity:40,exportInfra:50,supplierDensity:35,leadTimeReliability:65,sourcing:{technology:20,textiles:30,generalMfg:35,consumerGoods:25,automotive:50,pharma:20}},
    {name:'UAE',lat:23.4,lng:53.8,risk:30,shipping:6,labor:5,tariff:5,infra:9,costIndex:32,mfgCapacity:25,exportInfra:75,supplierDensity:20,leadTimeReliability:75,sourcing:{technology:10,textiles:5,generalMfg:18,consumerGoods:15,automotive:5,pharma:12}},
    {name:'South Korea',lat:35.9,lng:127.8,risk:28,shipping:7,labor:6,tariff:3,infra:9,costIndex:35,mfgCapacity:85,exportInfra:90,supplierDensity:82,leadTimeReliability:88,sourcing:{technology:88,textiles:10,generalMfg:70,consumerGoods:55,automotive:80,pharma:30}},
    {name:'Taiwan',lat:23.7,lng:120.9,risk:45,shipping:7,labor:6,tariff:5,infra:9,costIndex:30,mfgCapacity:82,exportInfra:88,supplierDensity:80,leadTimeReliability:85,sourcing:{technology:95,textiles:10,generalMfg:55,consumerGoods:40,automotive:25,pharma:20}},
    {name:'Czech Republic',lat:49.8,lng:15.5,risk:16,shipping:5,labor:5,tariff:3,infra:8,costIndex:26,mfgCapacity:55,exportInfra:65,supplierDensity:48,leadTimeReliability:75,sourcing:{technology:28,textiles:12,generalMfg:50,consumerGoods:30,automotive:72,pharma:30}},
    {name:'United States',lat:37.1,lng:-95.7,risk:18,shipping:4,labor:9,tariff:0,infra:9,costIndex:45,mfgCapacity:80,exportInfra:88,supplierDensity:75,leadTimeReliability:90,sourcing:{technology:70,textiles:8,generalMfg:65,consumerGoods:55,automotive:60,pharma:70}},
    {name:'Germany',lat:51.2,lng:10.4,risk:14,shipping:5,labor:8,tariff:3,infra:9,costIndex:48,mfgCapacity:90,exportInfra:92,supplierDensity:88,leadTimeReliability:92,sourcing:{technology:72,textiles:10,generalMfg:78,consumerGoods:55,automotive:95,pharma:65}},
    {name:'Japan',lat:36.2,lng:138.3,risk:18,shipping:7,labor:8,tariff:3,infra:9,costIndex:50,mfgCapacity:88,exportInfra:90,supplierDensity:85,leadTimeReliability:85,sourcing:{technology:88,textiles:10,generalMfg:75,consumerGoods:60,automotive:92,pharma:35}},
    {name:'Singapore',lat:1.4,lng:103.8,risk:10,shipping:6,labor:9,tariff:0,infra:10,costIndex:55,mfgCapacity:35,exportInfra:95,supplierDensity:30,leadTimeReliability:95,sourcing:{technology:50,textiles:2,generalMfg:25,consumerGoods:15,automotive:5,pharma:40}},
    {name:'Malaysia',lat:4.2,lng:101.9,risk:28,shipping:7,labor:3,tariff:5,infra:7,costIndex:24,mfgCapacity:60,exportInfra:68,supplierDensity:55,leadTimeReliability:72,sourcing:{technology:60,textiles:15,generalMfg:50,consumerGoods:40,automotive:25,pharma:15}},
    {name:'Philippines',lat:12.9,lng:121.8,risk:40,shipping:7,labor:2,tariff:10,infra:5,costIndex:28,mfgCapacity:40,exportInfra:45,supplierDensity:35,leadTimeReliability:55,sourcing:{technology:35,textiles:15,generalMfg:30,consumerGoods:25,automotive:10,pharma:8}},
    {name:'France',lat:46.2,lng:2.2,risk:16,shipping:5,labor:8,tariff:3,infra:9,costIndex:45,mfgCapacity:65,exportInfra:78,supplierDensity:60,leadTimeReliability:82,sourcing:{technology:38,textiles:15,generalMfg:48,consumerGoods:42,automotive:55,pharma:50}},
    {name:'Italy',lat:41.9,lng:12.6,risk:18,shipping:5,labor:7,tariff:3,infra:8,costIndex:40,mfgCapacity:65,exportInfra:72,supplierDensity:62,leadTimeReliability:78,sourcing:{technology:25,textiles:55,generalMfg:55,consumerGoods:50,automotive:50,pharma:40}},
    {name:'Netherlands',lat:52.1,lng:5.3,risk:12,shipping:5,labor:8,tariff:3,infra:10,costIndex:45,mfgCapacity:40,exportInfra:90,supplierDensity:35,leadTimeReliability:90,sourcing:{technology:30,textiles:5,generalMfg:30,consumerGoods:25,automotive:15,pharma:35}},
    {name:'Poland',lat:51.9,lng:19.1,risk:18,shipping:5,labor:5,tariff:3,infra:8,costIndex:25,mfgCapacity:55,exportInfra:62,supplierDensity:48,leadTimeReliability:72,sourcing:{technology:22,textiles:18,generalMfg:45,consumerGoods:30,automotive:55,pharma:20}},
    {name:'Morocco',lat:31.8,lng:-7.1,risk:38,shipping:5,labor:2,tariff:8,infra:6,costIndex:22,mfgCapacity:35,exportInfra:45,supplierDensity:28,leadTimeReliability:55,sourcing:{technology:10,textiles:40,generalMfg:30,consumerGoods:20,automotive:35,pharma:8}},
    {name:'South Africa',lat:-30.6,lng:22.9,risk:45,shipping:7,labor:3,tariff:10,infra:6,costIndex:30,mfgCapacity:40,exportInfra:50,supplierDensity:32,leadTimeReliability:55,sourcing:{technology:10,textiles:12,generalMfg:25,consumerGoods:18,automotive:30,pharma:15}},
    {name:'Saudi Arabia',lat:23.9,lng:45.1,risk:32,shipping:6,labor:4,tariff:5,infra:8,costIndex:35,mfgCapacity:20,exportInfra:65,supplierDensity:12,leadTimeReliability:70,sourcing:{technology:8,textiles:3,generalMfg:15,consumerGoods:10,automotive:5,pharma:10}},
    {name:'Egypt',lat:26.8,lng:30.8,risk:52,shipping:5,labor:2,tariff:15,infra:5,costIndex:38,mfgCapacity:30,exportInfra:38,supplierDensity:22,leadTimeReliability:45,sourcing:{technology:5,textiles:30,generalMfg:20,consumerGoods:15,automotive:10,pharma:8}},
    {name:'Australia',lat:-25.3,lng:133.8,risk:16,shipping:8,labor:8,tariff:5,infra:9,costIndex:48,mfgCapacity:30,exportInfra:65,supplierDensity:25,leadTimeReliability:78,sourcing:{technology:15,textiles:5,generalMfg:20,consumerGoods:15,automotive:5,pharma:15}},
    {name:'Canada',lat:56.1,lng:-106.3,risk:14,shipping:5,labor:8,tariff:1,infra:9,costIndex:40,mfgCapacity:50,exportInfra:70,supplierDensity:45,leadTimeReliability:80,sourcing:{technology:30,textiles:5,generalMfg:40,consumerGoods:30,automotive:45,pharma:40}},
    {name:'United Kingdom',lat:55.4,lng:-3.4,risk:14,shipping:5,labor:8,tariff:5,infra:9,costIndex:42,mfgCapacity:55,exportInfra:72,supplierDensity:55,leadTimeReliability:82,sourcing:{technology:40,textiles:8,generalMfg:45,consumerGoods:40,automotive:45,pharma:60}},
    {name:'Hungary',lat:47.2,lng:19.5,risk:20,shipping:5,labor:5,tariff:3,infra:7,costIndex:26,mfgCapacity:45,exportInfra:55,supplierDensity:40,leadTimeReliability:70,sourcing:{technology:20,textiles:15,generalMfg:38,consumerGoods:25,automotive:65,pharma:30}},
    {name:'Switzerland',lat:46.8,lng:8.2,risk:10,shipping:5,labor:9,tariff:3,infra:10,costIndex:58,mfgCapacity:45,exportInfra:80,supplierDensity:35,leadTimeReliability:92,sourcing:{technology:30,textiles:8,generalMfg:35,consumerGoods:30,automotive:20,pharma:85}},
    {name:'Ireland',lat:53.1,lng:-7.7,risk:12,shipping:5,labor:8,tariff:3,infra:9,costIndex:48,mfgCapacity:30,exportInfra:68,supplierDensity:25,leadTimeReliability:85,sourcing:{technology:35,textiles:3,generalMfg:20,consumerGoods:15,automotive:8,pharma:88}},
    {name:'Belgium',lat:50.5,lng:4.5,risk:12,shipping:5,labor:8,tariff:3,infra:9,costIndex:42,mfgCapacity:40,exportInfra:72,supplierDensity:38,leadTimeReliability:80,sourcing:{technology:18,textiles:8,generalMfg:35,consumerGoods:28,automotive:35,pharma:55}},
    {name:'Portugal',lat:39.4,lng:-8.2,risk:15,shipping:5,labor:6,tariff:3,infra:8,costIndex:30,mfgCapacity:35,exportInfra:60,supplierDensity:28,leadTimeReliability:72,sourcing:{technology:12,textiles:25,generalMfg:28,consumerGoods:20,automotive:22,pharma:18}},
    {name:'Slovakia',lat:48.7,lng:19.7,risk:18,shipping:5,labor:5,tariff:3,infra:7,costIndex:24,mfgCapacity:40,exportInfra:55,supplierDensity:35,leadTimeReliability:70,sourcing:{technology:15,textiles:10,generalMfg:32,consumerGoods:20,automotive:68,pharma:15}},
    {name:'Austria',lat:47.5,lng:14.6,risk:12,shipping:5,labor:8,tariff:3,infra:9,costIndex:42,mfgCapacity:48,exportInfra:70,supplierDensity:42,leadTimeReliability:82,sourcing:{technology:25,textiles:8,generalMfg:40,consumerGoods:30,automotive:45,pharma:35}},
    {name:'Bulgaria',lat:42.7,lng:25.5,risk:22,shipping:5,labor:4,tariff:3,infra:6,costIndex:22,mfgCapacity:30,exportInfra:42,supplierDensity:25,leadTimeReliability:60,sourcing:{technology:12,textiles:22,generalMfg:28,consumerGoods:18,automotive:30,pharma:12}},
    {name:'Sri Lanka',lat:7.9,lng:80.8,risk:52,shipping:7,labor:2,tariff:10,infra:5,costIndex:35,mfgCapacity:25,exportInfra:30,supplierDensity:20,leadTimeReliability:45,sourcing:{technology:5,textiles:40,generalMfg:15,consumerGoods:12,automotive:3,pharma:5}},
    {name:'Ethiopia',lat:9.1,lng:40.5,risk:55,shipping:8,labor:1,tariff:15,infra:3,costIndex:42,mfgCapacity:15,exportInfra:12,supplierDensity:10,leadTimeReliability:30,sourcing:{technology:2,textiles:25,generalMfg:8,consumerGoods:5,automotive:1,pharma:2}},
    {name:'Honduras',lat:14.1,lng:-86.2,risk:62,shipping:5,labor:2,tariff:8,infra:5,costIndex:35,mfgCapacity:25,exportInfra:25,supplierDensity:20,leadTimeReliability:45,sourcing:{technology:5,textiles:35,generalMfg:20,consumerGoods:15,automotive:5,pharma:3}},
    {name:'Colombia',lat:4.6,lng:-74.1,risk:50,shipping:5,labor:3,tariff:15,infra:6,costIndex:40,mfgCapacity:30,exportInfra:40,supplierDensity:25,leadTimeReliability:50,sourcing:{technology:10,textiles:20,generalMfg:22,consumerGoods:18,automotive:8,pharma:12}},
    {name:'Peru',lat:-9.2,lng:-75,risk:46,shipping:6,labor:3,tariff:10,infra:6,costIndex:38,mfgCapacity:25,exportInfra:35,supplierDensity:18,leadTimeReliability:50,sourcing:{technology:5,textiles:25,generalMfg:18,consumerGoods:12,automotive:5,pharma:5}},
    {name:'Argentina',lat:-38.4,lng:-63.6,risk:55,shipping:6,labor:4,tariff:20,infra:6,costIndex:45,mfgCapacity:35,exportInfra:40,supplierDensity:28,leadTimeReliability:45,sourcing:{technology:10,textiles:12,generalMfg:25,consumerGoods:18,automotive:25,pharma:18}},
    {name:'Chile',lat:-35.7,lng:-71.5,risk:25,shipping:6,labor:5,tariff:5,infra:7,costIndex:32,mfgCapacity:25,exportInfra:55,supplierDensity:18,leadTimeReliability:65,sourcing:{technology:8,textiles:5,generalMfg:15,consumerGoods:10,automotive:5,pharma:10}},
    {name:'Kazakhstan',lat:48.0,lng:68.0,risk:28,shipping:6,labor:4,tariff:8,infra:5,costIndex:42,mfgCapacity:30,exportInfra:35,supplierDensity:20,leadTimeReliability:45,sourcing:{technology:8,textiles:10,generalMfg:25,consumerGoods:10,automotive:5,pharma:5}},
    {name:'Uzbekistan',lat:41.3,lng:64.6,risk:38,shipping:7,labor:3,tariff:10,infra:4,costIndex:35,mfgCapacity:20,exportInfra:18,supplierDensity:12,leadTimeReliability:35,sourcing:{technology:5,textiles:30,generalMfg:18,consumerGoods:8,automotive:3,pharma:4}},
    {name:'Azerbaijan',lat:40.4,lng:49.9,risk:25,shipping:6,labor:4,tariff:7,infra:5,costIndex:45,mfgCapacity:22,exportInfra:40,supplierDensity:15,leadTimeReliability:50,sourcing:{technology:6,textiles:8,generalMfg:20,consumerGoods:7,automotive:4,pharma:3}},
    {name:'Georgia',lat:42.3,lng:43.4,risk:35,shipping:5,labor:4,tariff:6,infra:5,costIndex:40,mfgCapacity:15,exportInfra:30,supplierDensity:12,leadTimeReliability:48,sourcing:{technology:8,textiles:12,generalMfg:15,consumerGoods:10,automotive:3,pharma:5}},
    {name:'Lithuania',lat:55.2,lng:23.9,risk:22,shipping:4,labor:6,tariff:3,infra:7,costIndex:58,mfgCapacity:28,exportInfra:55,supplierDensity:30,leadTimeReliability:70,sourcing:{technology:20,textiles:10,generalMfg:30,consumerGoods:18,automotive:15,pharma:12}},
    {name:'Latvia',lat:56.9,lng:24.1,risk:24,shipping:4,labor:6,tariff:3,infra:7,costIndex:55,mfgCapacity:22,exportInfra:50,supplierDensity:25,leadTimeReliability:68,sourcing:{technology:18,textiles:8,generalMfg:25,consumerGoods:15,automotive:10,pharma:10}},
    {name:'Estonia',lat:58.6,lng:25.0,risk:15,shipping:4,labor:7,tariff:3,infra:8,costIndex:60,mfgCapacity:25,exportInfra:58,supplierDensity:28,leadTimeReliability:75,sourcing:{technology:30,textiles:5,generalMfg:22,consumerGoods:12,automotive:8,pharma:15}},
    {name:'Serbia',lat:44.0,lng:21.0,risk:55,shipping:5,labor:5,tariff:12,infra:5,costIndex:42,mfgCapacity:35,exportInfra:38,supplierDensity:28,leadTimeReliability:50,sourcing:{technology:12,textiles:18,generalMfg:35,consumerGoods:20,automotive:25,pharma:8}},
    {name:'Albania',lat:41.3,lng:20.0,risk:42,shipping:5,labor:3,tariff:8,infra:4,costIndex:35,mfgCapacity:12,exportInfra:20,supplierDensity:10,leadTimeReliability:40,sourcing:{technology:4,textiles:22,generalMfg:12,consumerGoods:8,automotive:3,pharma:3}},
    {name:'Oman',lat:21.5,lng:57.0,risk:20,shipping:4,labor:4,tariff:5,infra:7,costIndex:55,mfgCapacity:18,exportInfra:60,supplierDensity:15,leadTimeReliability:65,sourcing:{technology:8,textiles:5,generalMfg:15,consumerGoods:6,automotive:3,pharma:5}},
    {name:'Qatar',lat:25.3,lng:51.2,risk:14,shipping:3,labor:5,tariff:4,infra:8,costIndex:70,mfgCapacity:15,exportInfra:65,supplierDensity:12,leadTimeReliability:72,sourcing:{technology:10,textiles:3,generalMfg:12,consumerGoods:5,automotive:2,pharma:6}},
    {name:'Kuwait',lat:29.4,lng:47.9,risk:40,shipping:4,labor:5,tariff:5,infra:6,costIndex:65,mfgCapacity:10,exportInfra:45,supplierDensity:8,leadTimeReliability:55,sourcing:{technology:5,textiles:2,generalMfg:8,consumerGoods:4,automotive:2,pharma:4}},
    {name:'Jordan',lat:31.0,lng:36.6,risk:44,shipping:5,labor:4,tariff:8,infra:6,costIndex:48,mfgCapacity:18,exportInfra:48,supplierDensity:14,leadTimeReliability:55,sourcing:{technology:6,textiles:15,generalMfg:15,consumerGoods:10,automotive:4,pharma:18}},
    {name:'Kenya',lat:-1.3,lng:36.8,risk:38,shipping:6,labor:3,tariff:10,infra:5,costIndex:38,mfgCapacity:20,exportInfra:35,supplierDensity:18,leadTimeReliability:40,sourcing:{technology:5,textiles:18,generalMfg:15,consumerGoods:12,automotive:3,pharma:8}},
    {name:'Rwanda',lat:-1.9,lng:29.9,risk:27,shipping:7,labor:3,tariff:8,infra:4,costIndex:40,mfgCapacity:10,exportInfra:18,supplierDensity:8,leadTimeReliability:42,sourcing:{technology:6,textiles:10,generalMfg:8,consumerGoods:5,automotive:2,pharma:4}},
    {name:'Ghana',lat:7.9,lng:-1.0,risk:39,shipping:6,labor:3,tariff:10,infra:5,costIndex:38,mfgCapacity:18,exportInfra:32,supplierDensity:14,leadTimeReliability:40,sourcing:{technology:5,textiles:12,generalMfg:15,consumerGoods:10,automotive:3,pharma:6}},
    {name:'Mauritius',lat:-20.3,lng:57.6,risk:16,shipping:5,labor:5,tariff:5,infra:6,costIndex:52,mfgCapacity:12,exportInfra:40,supplierDensity:10,leadTimeReliability:60,sourcing:{technology:8,textiles:25,generalMfg:10,consumerGoods:12,automotive:2,pharma:6}},
    {name:'Tanzania',lat:-6.4,lng:34.9,risk:26,shipping:6,labor:3,tariff:10,infra:4,costIndex:35,mfgCapacity:15,exportInfra:28,supplierDensity:12,leadTimeReliability:38,sourcing:{technology:3,textiles:12,generalMfg:12,consumerGoods:8,automotive:2,pharma:5}},
    {name:'Costa Rica',lat:10.0,lng:-84.0,risk:13,shipping:4,labor:5,tariff:4,infra:7,costIndex:55,mfgCapacity:22,exportInfra:52,supplierDensity:20,leadTimeReliability:70,sourcing:{technology:25,textiles:8,generalMfg:20,consumerGoods:15,automotive:8,pharma:22}},
    {name:'Panama',lat:8.5,lng:-80.0,risk:52,shipping:3,labor:5,tariff:5,infra:7,costIndex:58,mfgCapacity:10,exportInfra:70,supplierDensity:8,leadTimeReliability:55,sourcing:{technology:5,textiles:3,generalMfg:8,consumerGoods:5,automotive:2,pharma:3}},
    {name:'Uruguay',lat:-34.9,lng:-56.2,risk:11,shipping:5,labor:6,tariff:6,infra:7,costIndex:60,mfgCapacity:15,exportInfra:45,supplierDensity:12,leadTimeReliability:68,sourcing:{technology:8,textiles:10,generalMfg:15,consumerGoods:10,automotive:5,pharma:8}},
    {name:'Paraguay',lat:-23.4,lng:-58.4,risk:43,shipping:7,labor:3,tariff:9,infra:4,costIndex:32,mfgCapacity:12,exportInfra:20,supplierDensity:8,leadTimeReliability:35,sourcing:{technology:3,textiles:8,generalMfg:10,consumerGoods:6,automotive:3,pharma:3}},
    {name:'Ecuador',lat:-1.8,lng:-78.2,risk:58,shipping:5,labor:3,tariff:10,infra:5,costIndex:38,mfgCapacity:15,exportInfra:30,supplierDensity:10,leadTimeReliability:38,sourcing:{technology:4,textiles:8,generalMfg:12,consumerGoods:8,automotive:3,pharma:5}},
    {name:'Finland',lat:61.9,lng:25.7,risk:12,shipping:4,labor:8,tariff:3,infra:9,costIndex:52,mfgCapacity:42,exportInfra:68,supplierDensity:35,leadTimeReliability:85,sourcing:{technology:35,textiles:5,generalMfg:32,consumerGoods:18,automotive:10,pharma:25}},
    {name:'Sweden',lat:60.1,lng:18.6,risk:10,shipping:4,labor:8,tariff:3,infra:9,costIndex:55,mfgCapacity:55,exportInfra:75,supplierDensity:48,leadTimeReliability:88,sourcing:{technology:45,textiles:8,generalMfg:48,consumerGoods:30,automotive:55,pharma:40}},
    {name:'Norway',lat:60.5,lng:8.5,risk:8,shipping:4,labor:9,tariff:3,infra:9,costIndex:62,mfgCapacity:30,exportInfra:65,supplierDensity:22,leadTimeReliability:88,sourcing:{technology:28,textiles:3,generalMfg:22,consumerGoods:12,automotive:8,pharma:18}},
    {name:'Denmark',lat:56.3,lng:9.5,risk:10,shipping:4,labor:8,tariff:3,infra:9,costIndex:55,mfgCapacity:45,exportInfra:72,supplierDensity:38,leadTimeReliability:90,sourcing:{technology:32,textiles:5,generalMfg:35,consumerGoods:22,automotive:12,pharma:55}},
    {name:'Iceland',lat:64.9,lng:-19.0,risk:6,shipping:5,labor:9,tariff:3,infra:8,costIndex:68,mfgCapacity:8,exportInfra:30,supplierDensity:5,leadTimeReliability:80,sourcing:{technology:12,textiles:2,generalMfg:5,consumerGoods:5,automotive:1,pharma:8}}
];

// ----------------------------------------------------------------------------
// Day 2 -- regional derivation engine.
// Region datasets are DERIVED from the US baseline (US_MAP_DATA) via a per-region
// trade profile. Only importer-relative fields change:
//   - tariff:    the tariff a region's importers face on goods FROM a country
//                (a low preferential rate for the region's own bloc / FTA
//                partners, an elevated rate for flagged trade-tension partners,
//                otherwise the region's MFN base rate).
//   - shipping:  a 1-10 cost index derived from the great-circle distance
//                between the source country and the region's main import hub.
//   - costIndex: the curated US costIndex shifted by the tariff & shipping
//                deltas vs the US baseline, so it stays anchored and realistic.
// Intrinsic country attributes (risk, labor, infra, mfgCapacity, exportInfra,
// supplierDensity, leadTimeReliability, sourcing, coordinates) are identical in
// every region.
//
// KNOWN LIMITATION: tariff/sourcing are modelled per single source country. Real
// supply chains multi-source a SKU across several countries, and the effective
// duty depends on HS code and rules-of-origin, not origin country alone. This
// regional layer is a directional lens, not a customs-grade calculation.

const REGION_HUBS = {
    us:          { lat: 39.0,  lng: -98.0 },   // continental US
    germany:     { lat: 50.1,  lng: 8.7 },     // Frankfurt
    china:       { lat: 31.2,  lng: 121.5 },   // Shanghai
    brazil:      { lat: -23.5, lng: -46.6 },   // Sao Paulo
    australia:   { lat: -33.9, lng: 151.2 },   // Sydney
    india:       { lat: 19.1,  lng: 72.9 },    // Mumbai
    uae:         { lat: 25.2,  lng: 55.3 },     // Dubai
    southafrica: { lat: -26.2, lng: 28.0 }     // Johannesburg
};

// Per-region tariff posture. `bloc` lists own-bloc / FTA partners charged the low
// `blocRate`; `high` maps flagged trade-tension partners to an elevated rate;
// `mfnBase` applies to everyone else. Rates are directional, not customs-grade.
const REGION_TARIFF_PROFILES = {
    germany: { // EU common external tariff + FTA network
        mfnBase: 6, blocRate: 2,
        bloc: ['Germany','France','Italy','Netherlands','Poland','Romania','Czech Republic','United Kingdom','Hungary','Switzerland','Ireland','Belgium','Portugal','Slovakia','Austria','Bulgaria','South Korea','Japan','Canada','Vietnam','Singapore','Mexico','Turkey'],
        high: { 'China': 12, 'Russia': 35 }
    },
    china: { // RCEP / ASEAN low, US retaliatory high
        mfnBase: 8, blocRate: 3,
        bloc: ['China','Vietnam','Thailand','Indonesia','Malaysia','Singapore','Cambodia','Philippines','Japan','South Korea','Australia'],
        high: { 'United States': 25 }
    },
    brazil: { // Mercosur; high common external tariff otherwise
        mfnBase: 14, blocRate: 2,
        bloc: ['Brazil','Argentina','Chile','Colombia','Peru'],
        high: {}
    },
    australia: { // broad FTA network, low tariffs
        mfnBase: 5, blocRate: 1,
        bloc: ['Australia','China','Japan','South Korea','United States','Vietnam','Thailand','Malaysia','Singapore','Indonesia','India','United Kingdom'],
        high: {}
    },
    india: { // high MFN, ASEAN/UAE preferential, China elevated
        mfnBase: 12, blocRate: 4,
        bloc: ['India','Vietnam','Thailand','Indonesia','Malaysia','Singapore','Japan','South Korea','UAE','Australia'],
        high: { 'China': 18 }
    },
    uae: { // GCC low uniform tariff, hub economy
        mfnBase: 5, blocRate: 0,
        bloc: ['UAE','Saudi Arabia','India'],
        high: {}
    },
    southafrica: { // SACU/SADC low, EU EPA low, moderate otherwise
        mfnBase: 10, blocRate: 2,
        bloc: ['South Africa','Germany','France','Italy','Netherlands','United Kingdom'],
        high: {}
    }
};

// Great-circle distance in km between two {lat,lng} points.
function haversineKm(a, b) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Map a distance (km) to a 1-10 shipping cost index.
function shippingIndexFromDistance(km) {
    if (km < 1000)  return 3;
    if (km < 3000)  return 4;
    if (km < 6000)  return 5;
    if (km < 9000)  return 6;
    if (km < 12000) return 7;
    if (km < 15000) return 8;
    return 9;
}

// Derive a region's dataset from the US baseline by recomputing only the
// importer-relative fields (tariff, shipping, costIndex).
function buildRegionData(regionKey) {
    const hub = REGION_HUBS[regionKey];
    const prof = REGION_TARIFF_PROFILES[regionKey];
    if (!hub || !prof) return US_MAP_DATA.map(c => ({ ...c, sourcing: { ...c.sourcing } }));
    return US_MAP_DATA.map(base => {
        let tariff;
        if (prof.high[base.name] != null)        tariff = prof.high[base.name];
        else if (prof.bloc.includes(base.name))  tariff = prof.blocRate;
        else                                     tariff = prof.mfnBase;
        const dist = haversineKm(hub, { lat: base.lat, lng: base.lng });
        const shipping = shippingIndexFromDistance(dist);
        const costIndex = Math.max(5, Math.min(95, Math.round(
            base.costIndex + 0.4 * (tariff - base.tariff) + 1.5 * (shipping - base.shipping)
        )));
        return {
            name: base.name, lat: base.lat, lng: base.lng,
            risk: base.risk, shipping, labor: base.labor, tariff, infra: base.infra,
            costIndex, mfgCapacity: base.mfgCapacity, exportInfra: base.exportInfra,
            supplierDensity: base.supplierDensity, leadTimeReliability: base.leadTimeReliability,
            sourcing: { ...base.sourcing }
        };
    });
}

// One materialised dataset per region. "us" is the curated baseline (byte-for-byte
// identical to the inline COUNTRY_DATA); the other 7 are derived at load time.
const regionalMapData = {
    us:          US_MAP_DATA,
    germany:     buildRegionData('germany'),
    china:       buildRegionData('china'),
    brazil:      buildRegionData('brazil'),
    australia:   buildRegionData('australia'),
    india:       buildRegionData('india'),
    uae:         buildRegionData('uae'),
    southafrica: buildRegionData('southafrica')
};

// Maps every country in the dataset to one of the 8 region keys. These are
// coarse trade-bloc groupings used only to pick which regional lens a user gets
// from their home country; a few countries straddle blocs (e.g. Turkey, Russia)
// and are assigned to their dominant grouping. Anything unmapped falls back to
// "us" via assignRegionToUser().
const countryToRegionMap = {
    // North America
    'United States':'us','Canada':'us','Mexico':'us',
    // Europe (+ western CIS)
    'Germany':'germany','France':'germany','Italy':'germany','Netherlands':'germany',
    'Poland':'germany','Romania':'germany','Czech Republic':'germany','United Kingdom':'germany',
    'Hungary':'germany','Switzerland':'germany','Ireland':'germany','Belgium':'germany',
    'Portugal':'germany','Slovakia':'germany','Austria':'germany','Bulgaria':'germany',
    'Ukraine':'germany','Russia':'germany',
    // East & Southeast Asia
    'China':'china','North Korea':'china','South Korea':'china','Taiwan':'china','Japan':'china',
    'Vietnam':'china','Thailand':'china','Indonesia':'china','Cambodia':'china','Malaysia':'china',
    'Philippines':'china','Singapore':'china','Myanmar':'china',
    // Latin America
    'Brazil':'brazil','Argentina':'brazil','Chile':'brazil','Colombia':'brazil','Peru':'brazil',
    'Venezuela':'brazil','Honduras':'brazil',
    // Oceania
    'Australia':'australia',
    // South Asia
    'India':'india','Pakistan':'india','Bangladesh':'india','Sri Lanka':'india',
    // Middle East / GCC
    'UAE':'uae','Saudi Arabia':'uae','Iran':'uae','Iraq':'uae','Lebanon':'uae','Turkey':'uae','Egypt':'uae',
    // Africa
    'South Africa':'southafrica','Nigeria':'southafrica','Ethiopia':'southafrica','Morocco':'southafrica',

    // ---- Extended coverage: remaining Home-Country dropdown options (Day 2) ----
    // These are offered in the onboarding dropdown but are not among the 85 map
    // dataset countries. Each is mapped to its dominant trade bloc so a user based
    // here still gets a sensible regional lens (borderline / landlocked cases go to
    // the nearest hub). Anything still unmapped falls back to "us".
    // Latin America & Caribbean
    'Costa Rica':'brazil','Cuba':'brazil','Dominican Republic':'brazil','El Salvador':'brazil',
    'Guatemala':'brazil','Nicaragua':'brazil','Panama':'brazil','Bolivia':'brazil','Ecuador':'brazil',
    'Paraguay':'brazil','Uruguay':'brazil',
    // Europe
    'Spain':'germany','Greece':'germany','Denmark':'germany','Sweden':'germany','Finland':'germany',
    'Norway':'germany','Cyprus':'germany','Malta':'germany','Luxembourg':'germany','Estonia':'germany',
    'Latvia':'germany','Lithuania':'germany','Slovenia':'germany','Croatia':'germany','Serbia':'germany',
    'Bosnia':'germany','North Macedonia':'germany','Albania':'germany','Moldova':'germany','Belarus':'germany',
    // Middle East / Caucasus
    'United Arab Emirates':'uae','Israel':'uae','Jordan':'uae','Oman':'uae','Qatar':'uae','Syria':'uae',
    'Yemen':'uae','Armenia':'uae','Azerbaijan':'uae',
    // South & Central Asia
    'Afghanistan':'india','Nepal':'india','Kazakhstan':'china','Uzbekistan':'china','Turkmenistan':'china','Laos':'china',
    // Africa
    'Algeria':'southafrica','Angola':'southafrica','Cameroon':'southafrica','Congo':'southafrica','Ghana':'southafrica',
    'Kenya':'southafrica','Mozambique':'southafrica','Senegal':'southafrica','South Sudan':'southafrica','Sudan':'southafrica',
    'Tanzania':'southafrica','Tunisia':'southafrica','Uganda':'southafrica','Zambia':'southafrica','Zimbabwe':'southafrica',
    // Oceania
    'New Zealand':'australia',
    // Dataset countries not offered in the dropdown (map-coverage completeness)
    'Georgia':'uae','Kuwait':'uae','Rwanda':'southafrica','Mauritius':'southafrica','Iceland':'germany'
};

// Common home-country aliases -> canonical dataset name, so profile values like
// "USA" or "UK" still resolve to a region.
const REGION_COUNTRY_ALIASES = {
    'usa':'United States','us':'United States','u.s.':'United States','u.s.a.':'United States',
    'united states of america':'United States','america':'United States',
    'uk':'United Kingdom','u.k.':'United Kingdom','great britain':'United Kingdom','england':'United Kingdom',
    'u.a.e.':'UAE','united arab emirates':'UAE','emirates':'UAE',
    'republic of korea':'South Korea','czechia':'Czech Republic'
};

// assignRegionToUser(country) -- takes a user's home country, returns one of the
// 8 region keys. Falls back to "us" for unknown / empty input.
function assignRegionToUser(country) {
    if (!country || typeof country !== 'string') return 'us';
    const raw = country.trim();
    if (!raw) return 'us';
    // exact match first, then alias-normalised match
    if (countryToRegionMap[raw]) return countryToRegionMap[raw];
    const canonical = REGION_COUNTRY_ALIASES[raw.toLowerCase()];
    if (canonical && countryToRegionMap[canonical]) return countryToRegionMap[canonical];
    // case-insensitive scan as a last resort
    const lc = raw.toLowerCase();
    for (const name in countryToRegionMap) {
        if (name.toLowerCase() === lc) return countryToRegionMap[name];
    }
    return 'us';
}

// Resolve which region dataset to serve from request params.
//   ?region=<key>   explicit override (Settings manual pick) - wins if valid
//   ?country=<name> derive region from a home country via assignRegionToUser
// Falls back to "us" for unauthenticated / unknown callers.
function resolveRegionKey({ region, country }) {
    if (region && Object.prototype.hasOwnProperty.call(regionalMapData, region)) return region;
    if (country) return assignRegionToUser(country);
    return 'us';
}

// GET /api/map-data — returns the region-appropriate map dataset. The frontend
// renders the Risk Intelligence Map from this when a user is signed in; if the
// call fails or the caller is anonymous it keeps its inline "us" dataset, so
// existing/anonymous behaviour is unchanged.
app.get('/api/map-data', (req, res) => {
    const region = resolveRegionKey({ region: req.query.region, country: req.query.country });
    const data = regionalMapData[region] || regionalMapData.us;
    res.json({ region, count: data.length, data });
});

// GET /api/debug/region — inspection endpoint (DATA_API_KEY required via x-api-key).
// Returns the region that would be assigned for the given ?region=/?country= inputs
// plus the full dataset being served, for debugging the personalisation pipeline.
app.get('/api/debug/region', requireDataKey, (req, res) => {
    const assignedRegion = resolveRegionKey({ region: req.query.region, country: req.query.country });
    const data = regionalMapData[assignedRegion] || regionalMapData.us;
    res.json({
        assignedRegion,
        input: { region: req.query.region || null, country: req.query.country || null },
        derivedFromCountry: req.query.country ? assignRegionToUser(req.query.country) : null,
        availableRegions: Object.keys(regionalMapData),
        count: data.length,
        data
    });
});

// ---------- POST routes (n8n pushes data here) ----------

app.post('/api/data/alerts', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.alerts = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} alerts (general)`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/alerts/:industry', requireDataKey, (req, res) => {
    const industry = req.params.industry;
    const valid = Object.keys(dataStore.alertsByIndustry);
    if (!valid.includes(industry)) {
        return res.status(400).json({ error: 'Invalid industry. Valid: ' + valid.join(', ') });
    }
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.alertsByIndustry[industry] = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} alerts for: ${industry}`);
    res.json({ success: true, count: items.length, industry });
});

app.post('/api/data/tariffs', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.tariffs = items.slice(0, 100);
    console.log(`[n8n] Received ${items.length} tariffs`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/ports', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.ports = items.slice(0, 50);
    console.log(`[n8n] Received ${items.length} ports`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/commodities', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.commodities = items.slice(0, 50);
    console.log(`[n8n] Received ${items.length} commodities`);
    res.json({ success: true, count: items.length });
});

app.post('/api/data/currency', requireDataKey, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    dataStore.currency = items.slice(0, 30);
    console.log(`[n8n] Received ${items.length} currency rates`);
    res.json({ success: true, count: items.length });
});

// ---------- GET routes (frontend reads from here) ----------

app.get('/api/data/alerts', (req, res) => {
    res.json(dataStore.alerts);
});

app.get('/api/data/alerts/:industry', (req, res) => {
    const industry = req.params.industry;
    const industryData = dataStore.alertsByIndustry[industry];
    if (industryData && industryData.length > 0) {
        return res.json(industryData);
    }
    if (dataStore.alertsByIndustry.general && dataStore.alertsByIndustry.general.length > 0) {
        return res.json(dataStore.alertsByIndustry.general);
    }
    res.json(dataStore.alerts);
});

app.get('/api/data/tariffs', (req, res) => {
    res.json(dataStore.tariffs);
});

app.get('/api/data/ports', (req, res) => {
    res.json(dataStore.ports);
});

app.get('/api/data/commodities', (req, res) => {
    res.json(dataStore.commodities);
});

app.get('/api/data/currency', (req, res) => {
    res.json(dataStore.currency);
});

app.get('/api/data/status', (req, res) => {
    const industryCounts = {};
    for (const [key, val] of Object.entries(dataStore.alertsByIndustry)) {
        industryCounts[key] = val.length;
    }
    res.json({
        status: 'ok',
        counts: {
            alerts: dataStore.alerts.length,
            alertsByIndustry: industryCounts,
            tariffs: dataStore.tariffs.length,
            ports: dataStore.ports.length,
            commodities: dataStore.commodities.length,
            currency: dataStore.currency.length
        },
        lastChecked: new Date().toISOString()
    });
});

// ============================================================
// EXISTING ROUTES — Chat + Audit
// ============================================================

function buildSystemPrompt(profile) {
    let prompt = 'You are Risksim, the AI assistant inside RiskSim AI. You are a world-class supply chain intelligence system. ' +
'Speak in short, natural sentences.' +
'IMPORTANT: Never use markdown formatting of any kind. Never use **asterisks**, never use bullet points, never use dashes as lists, never use headers. Write in plain sentences only, like you are speaking out loud. ' +
'If a response would be long, give a brief spoken summary and say "for a full breakdown, I recommend reviewing the chat." ' +
'Be confident, calm, and precise — like Jarvis from Iron Man.\n\n' +

'SCORING SYSTEM:\n' +
'Political/Operational Risk Score (0-100, higher = more risky): measures geopolitical instability, corruption, logistics, conflict.\n' +
'Sourcing Attractiveness Score (0-100, higher = better): measures manufacturing capacity, supplier ecosystem, lead times, specialization.\n\n' +

'Industry sourcing scores:\n' +
'Technology: China 95, Taiwan 95, South Korea 88, Japan 88, Malaysia 60, Vietnam 55.\n' +
'Textiles/Apparel: Bangladesh 88, Vietnam 85, China 75, India 70, Turkey 70, Cambodia 65.\n' +
'Automotive: Germany 95, Japan 92, Mexico 88, South Korea 80, Czech Republic 72, Slovakia 68.\n' +
'Pharmaceuticals: India 92, Ireland 88, Switzerland 85, United States 70, Germany 65.\n' +
'General Manufacturing: China 95, Germany 78, Mexico 78, India 72, United States 65.\n' +
'Consumer Goods: China 92, India 65, Vietnam 62, Thailand 55, Indonesia 45.\n\n' +

'When asked about sourcing, comparisons, or where to source from, reference these scores naturally in conversation.' +

'\n\nSTRUCTURED VISUAL CARDS (the ONLY exception to the plain text rule above):\n' +
'For specific question types, append a structured block AFTER your complete spoken response on a new line. The user never sees this block; it drives UI rendering only. Do not alter your spoken response. Always include a follow_up_chips block alongside any card.\n\n' +
'Block format (copy exactly, including the sentinel lines):\n' +
'[BLOCKS_START]\n' +
'[...JSON array of block objects...]\n' +
'[BLOCKS_END]\n\n' +
'Each block object has a "type" field identifying the card. Supported types below.\n\n' +

'## CARD TYPE: incident_card\n' +
'Emit when: the question is specifically about an ACTIVE supply chain disruption — a port closure, typhoon, strike, factory shutdown, logistics incident, or similar real-time event that directly affects the user\'s sourcing regions or named suppliers.\n\n' +
'Format:\n' +
'[{"type":"incident_card","data":{"severity":"P1","category":"logistics","title":"<event title, max 60 chars>","subtitle":"<one-line event summary, max 60 chars>","location":{"display":"<REGION · LOCATION, uppercase, max 25 chars, e.g. SOUTH CHINA · YANTIAN>","primary":"<primary marker name, uppercase, e.g. YANTIAN>","sub":"<sub label, uppercase, e.g. SHENZHEN>","region":"<south_china|red_sea|na_east_coast|northern_europe|mediterranean>"},"direct_exposure_usd":<number, use 0 if unknown>,"affected_pos_count":<number, use 0 if unknown>,"suppliers_hit":[{"name":"<supplier name relevant to user profile or disruption location>","exposure_usd":<number, use 0 if unknown>}],"delay_risk":"<e.g. 9-14 days to North America DCs>","recommended_action":{"text":"<one concrete sentence recommending an action>","impact_estimate":"<brief estimated benefit>","cta_label":"Run mitigation"},"recommendedActions":[{"text":"<action, plain text only, no HTML or asterisks, max 120 chars>","impact":"<primary impact tag>","impact2":"<optional, item 0 only>","cta":"<button label, uppercase, max 20 chars>"},{"text":"<second action>","impact":"<impact>","cta":"<label>"},{"text":"<third action>","impact":"<impact>","cta":"<label>"}]}},{"type":"follow_up_chips","options":["<3-6 word chip>","<3-6 word chip>","<3-6 word chip>"]}]\n\n' +
'Rules: location is required — display is REGION · LOCATION (max 25 chars), primary is port/city, sub is broader area. region values: south_china (mainland China, Hong Kong, Taiwan, Pearl River Delta); red_sea (Suez Canal, Egypt, Eastern Mediterranean, Gulf of Aden, Arabian Peninsula); na_east_coast (US East Coast ports: Newark, NY, Norfolk, Charleston, Savannah, Baltimore); northern_europe (North Sea ports: Rotterdam, Hamburg, Antwerp, Felixstowe, Bremerhaven); mediterranean (Mediterranean ports: Piraeus, Genoa, Valencia, Algeciras, Trieste). recommendedActions must have exactly 3 items, plain text only. Use 0 for all USD/count fields when unknown.\n' +
'CRITICAL — no fabricated user data: (1) direct_exposure_usd, affected_pos_count, and suppliers_hit[].exposure_usd MUST be 0 unless the user has explicitly provided these figures in their profile — you do not have their purchase order data or spend volumes. (2) suppliers_hit[].name MUST be exactly one of the supplier names listed in the user\'s Key Suppliers profile; if the user has no suppliers listed, return suppliers_hit as an empty array []. (3) delay_risk MUST reference publicly-known information about the disruption event, not invented lead-time impacts for the user\'s specific business. (4) If the user\'s profile lacks the data to fill these fields meaningfully, emit the card with placeholder zeros and include a note in subtitle like "Add your suppliers in Settings for specific exposure estimates."\n' +
'Emit YES: "Typhoon hitting Yantian port, what\'s my exposure?" / "Port strike in Shanghai — how does that affect me?" / "Red Sea shipping lanes are disrupted"\n' +
'Emit NO: geographic exposure overview questions, tariff questions, general risk questions, sourcing comparisons, strategy questions:\n' +
'  - "What are my biggest risks?"\n' +
'  - "Should I source from Vietnam or China?"\n' +
'  - "What\'s the vibe of supply chain?"\n' +
'  - "Who are you?"\n\n' +

'## CARD TYPE: geo_exposure_card\n' +
'Emit when: the user asks about their OVERALL geographic risk profile — which of their sourcing countries are riskiest, a risk overview of where they source from, which regions to be most concerned about. This is a structural risk question, not an active-event question.\n\n' +
'Format:\n' +
'[{"type":"geo_exposure_card","data":{"countries":[{"name":"<country name>","severity":"<critical|high|medium|low>","reason":"<1-2 qualitative sentences — geopolitical, trade policy, and industry-specific risk for this country>"},{"name":"<next country>","severity":"<severity>","reason":"<reason>"}],"insight":"<one synthesis observation across all countries, e.g. concentration risk or correlated risk>","cta_text":"<button label, e.g. Drill into China risk>","cta_action":"<full question string to send to chat when the button is clicked>"}},{"type":"follow_up_chips","options":["<3-6 word chip>","<3-6 word chip>","<3-6 word chip>"]}]\n\n' +
'Rules: List ALL of the user\'s sourcing countries from their profile. Rank by severity (critical first, then high, medium, low). reason must be 1-2 qualitative sentences grounded in geopolitical conditions, trade policy, and industry-specific factors — no percentages, no dollar amounts. insight is a synthesis across all countries. cta_action is the full question that drills deeper into the highest-risk country.\n' +
'CRITICAL — no fabricated data: In reason and insight, never state spend percentages, dollar amounts, volumes, or any quantified figure about the user\'s operations — you do not have that data. Reason only qualitatively. Never write "China represents X% of your spend" or "your exposure is $Y" — these figures are unknown.\n' +
'Emit YES: "What are my riskiest sourcing countries?" / "Map my geographic exposure" / "Which regions worry you most for my supply chain?" / "Give me a risk overview of where I source from"\n' +
'Emit NO: active disruption events (use incident_card instead), tariff or duty questions (use tariff_exposure_card instead), supplier-specific questions, general strategy or cost questions.\n\n' +

'## CARD TYPE: tariff_exposure_card\n' +
'Emit when: the user asks about tariff or duty risk on their sourcing — how tariffs affect their imports, which of their sourcing countries face duty exposure, trade policy risk to their supply chain, the impact of tariff regimes (Section 301, USMCA, EU duties, GSP, antidumping, etc.) on their sourcing.\n\n' +
'IMPORTANT — homeCountry required: Tariff analysis depends entirely on the import destination (homeCountry determines which tariff regime applies). If homeCountry is not in the user\'s profile, do NOT emit this card. Instead, respond in plain text and suggest the user complete their profile with their home country.\n\n' +
'Format:\n' +
'[{"type":"tariff_exposure_card","data":{"regime":"<name of applicable tariff regime derived from homeCountry, e.g. US Section 301 / USTR Schedule, EU Common External Tariff, UK Global Tariff>","items":[{"name":"<sourcing country>","severity":"<critical|high|medium|low>","policy":"<specific tariff measure applying to this country, e.g. Section 301, USMCA, GSP, EU Antidumping Duty>","reason":"<1-2 qualitative sentences — nature of the tariff risk, product categories affected, direction of policy (escalating, stable, uncertain)>"},{"name":"<next country>","severity":"<severity>","policy":"<measure>","reason":"<reason>"}],"insight":"<synthesis: overall tariff posture, most exposed country-category combination, key policy trend>","cta_text":"<button label, e.g. How do I reduce China tariff exposure?>","cta_action":"<full question string to send to chat when clicked>"}},{"type":"follow_up_chips","options":["<3-6 word chip>","<3-6 word chip>","<3-6 word chip>"]}]\n\n' +
'Rules: List ALL of the user\'s sourcing countries. Rank by severity (critical first, then high, medium, low). regime is derived from homeCountry — state it once at card level. policy names the specific tariff measure per country. reason explains the risk qualitatively: the nature of the measure, product categories affected for the user\'s industry, policy direction. Do not inflate severity to make the card look more dramatic — if a profile genuinely has low tariff exposure, show low severity honestly.\n\n' +
'CRITICAL — the line between public policy facts and fabricated user exposure:\n' +
'PERMITTED: General tariff policy facts that are public knowledge — rate ranges, named measures, affected product categories. Example: "Section 301 tariffs on Chinese electronics span 7.5–25% across most categories, with higher rates on semiconductors and advanced manufacturing inputs." These are real, verifiable facts.\n' +
'NOT PERMITTED: Any statement about the user\'s specific tariff cost, dollar exposure, or effective rate — "your tariff exposure is $X" or "you pay an effective rate of Y% on your China imports." You do not have the user\'s import volumes, customs values, or spend. Never compute, estimate, or infer the user\'s individual tariff liability.\n\n' +
'Emit YES: "How do tariffs affect my sourcing?" / "What\'s my tariff exposure?" / "Which of my countries face duty risk?" / "How does Section 301 affect me?" / "What are the tariff implications of sourcing from China?"\n' +
'Emit NO: active disruption events (use incident_card instead), geographic or geopolitical country risk overview (use geo_exposure_card instead), supplier-specific questions, general cost or strategy questions unrelated to tariffs.\n\n' +

'## GLOBAL CARD RULES\n' +
'If uncertain which card fits the question, emit plain text only. Never emit more than one analysis card (incident_card, geo_exposure_card, tariff_exposure_card) in a single response. Always default to plain text if a question does not clearly match a card\'s emit criteria.';

    if (profile && (profile.companyType || profile.homeCountry || profile.industry)) {
        prompt += '\n\n## User Company Profile\n';
        if (profile.companyName) prompt += `- **Company Name**: ${profile.companyName}\n`;
        if (profile.companyType) prompt += `- **Company Type**: ${profile.companyType}\n`;
        if (profile.homeCountry) prompt += `- **Home Country / HQ**: ${profile.homeCountry}\n`;
        if (profile.industry) prompt += `- **Industry**: ${profile.industry}\n`;
        if (profile.sourcingCountries && profile.sourcingCountries.length > 0) {
            prompt += `- **Primary Sourcing Countries**: ${profile.sourcingCountries.join(', ')}\n`;
        }
        if (profile.revenue) prompt += `- **Annual Revenue Range**: ${profile.revenue}\n`;
        if (profile.employees) prompt += `- **Company Size**: ${profile.employees} employees\n`;
        if (profile.products) prompt += `- **Main Products/Services**: ${profile.products}\n`;
        if (profile.suppliers) prompt += `- **Key Suppliers**: ${profile.suppliers}\n`;
        if (profile.concern) {
            const concernLabels = {
                geopolitical: 'Geopolitical Risk',
                disruption: 'Supply Disruption',
                tariffs: 'Tariffs & Trade Policy',
                labor: 'Labor & ESG',
                climate: 'Climate Risk',
                quality: 'Quality Control',
                cost: 'Cost Optimization'
            };
            prompt += `- **Primary Concern**: ${concernLabels[profile.concern] || profile.concern}\n`;
        }
        if (profile.businessDescription) prompt += `- **Additional Context**: ${profile.businessDescription}\n`;
        prompt += '\nYou know this company well. Always tailor your analysis to their specific situation. ' +
            'Reference their products, suppliers, sourcing countries, and primary concerns in your answers. ' +
            'When they ask about risks, focus on risks to THEIR specific supply chain. ' +
            'When they ask about costs, reference THEIR sourcing regions and industry. ' +
            'When they ask about suppliers, consider THEIR listed key suppliers. ' +
            'Make every response feel like it was written specifically for this company, not generic advice.';
    }

    // Enterprise intelligence profile — server-gated on plan === 'enterprise'
    if (profile && profile.plan === 'enterprise' && profile.enterprise) {
        const ep = profile.enterprise;
        const hasMeaningfulData = (Array.isArray(ep.productCategories) && ep.productCategories.length > 0) ||
                                   (Array.isArray(ep.suppliers) && ep.suppliers.length > 0) ||
                                   ep.spendBand || ep.leadTimeBand;
        if (hasMeaningfulData) {
            prompt += '\n\n## Enterprise Intelligence Profile\n' +
                'This user has provided detailed supply chain context. Use it to make analysis operationally specific — ' +
                'reference suppliers by name, flag concentration risk, and apply their operational parameters when assessing resilience.\n\n';

            if (Array.isArray(ep.productCategories) && ep.productCategories.length > 0) {
                const cats = ep.productCategories.map(c =>
                    [sanitizeForPrompt(c.broadCategory), sanitizeForPrompt(c.subCategory)].filter(Boolean).join(' › ')
                ).filter(Boolean).join('; ');
                if (cats) prompt += `Product focus: ${cats}\n`;
            }
            if (ep.spendBand) prompt += `Annual sourced spend: ${sanitizeForPrompt(ep.spendBand)}\n`;
            if (ep.leadTimeBand) prompt += `Typical supplier lead time: ${sanitizeForPrompt(ep.leadTimeBand)}\n`;
            if (Array.isArray(ep.freightMethods) && ep.freightMethods.length) {
                prompt += `Primary freight: ${ep.freightMethods.map(sanitizeForPrompt).join(', ')}\n`;
            }
            if (Array.isArray(ep.portsOfEntry) && ep.portsOfEntry.length) {
                prompt += `Ports of entry: ${ep.portsOfEntry.map(sanitizeForPrompt).join(', ')}\n`;
            }
            if (Array.isArray(ep.incoterms) && ep.incoterms.length) {
                prompt += `Incoterms: ${ep.incoterms.map(sanitizeForPrompt).join(', ')}\n`;
            }

            if (Array.isArray(ep.suppliers) && ep.suppliers.length > 0) {
                prompt += '\nKey suppliers:\n';
                const singleSourcedCritical = [];
                ep.suppliers.forEach(s => {
                    const name = sanitizeForPrompt(s.name || '');
                    if (!name) return;
                    const country = sanitizeForPrompt(s.country || '');
                    const crit = sanitizeForPrompt(s.criticality || 'important').toUpperCase();
                    const ss = s.singleSource ? ' · SINGLE-SOURCED' : '';
                    const sw = s.switchability ? ` · switchability ${s.switchability}/5` : '';
                    prompt += `  - ${name}${country ? ' (' + country + ')' : ''}: ${crit}${ss}${sw}\n`;
                    if (s.singleSource && s.criticality === 'critical') singleSourcedCritical.push(name);
                });
                if (singleSourcedCritical.length > 0) {
                    const names = singleSourcedCritical.join(', ');
                    prompt += `CONCENTRATION RISK: ${names} ${singleSourcedCritical.length === 1 ? 'is a' : 'are'} single-sourced critical supplier${singleSourcedCritical.length > 1 ? 's' : ''} — proactively flag this when discussing disruption or resilience.\n`;
                }
            }

            if (Array.isArray(ep.spendByCountry) && ep.spendByCountry.length > 0) {
                const sbc = ep.spendByCountry
                    .filter(s => s.country && s.pctOfTotal > 0)
                    .map(s => `${sanitizeForPrompt(s.country)} ${s.pctOfTotal}%`)
                    .join(', ');
                if (sbc) prompt += `\nSpend by country: ${sbc}\n`;
            }

            const resLines = [];
            if (ep.hasBackupSuppliers) resLines.push(`backup suppliers: ${sanitizeForPrompt(ep.hasBackupSuppliers)} categories covered`);
            if (ep.supplierSwitchTime) resLines.push(`switch time: ${sanitizeForPrompt(ep.supplierSwitchTime)}`);
            if (ep.leadTimeTolerance) resLines.push(`delay tolerance: ${sanitizeForPrompt(ep.leadTimeTolerance)}`);
            if (ep.inventoryBufferDays) resLines.push(`inventory buffer: ${sanitizeForPrompt(ep.inventoryBufferDays)}`);
            if (resLines.length) prompt += `\nResilience parameters: ${resLines.join('; ')}\n`;

            prompt += '\nWhen asked about risk: reference named suppliers and their criticality. ' +
                'When asked about tariffs: reference spend-by-country if provided. ' +
                'When asked about resilience or disruption: apply buffer, switch time, and delay tolerance as operative constraints. ' +
                'Make every response reflect these specific operational parameters.';
        }
    }

    return prompt;
}

app.post('/api/chat', async (req, res) => {
    try {
        let { message, messages, profile } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0)
            return res.status(400).json({ error: 'Message required' });
        if (message.length > MAX_INPUT)
            return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
        message = stripHtml(message);

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const history = Array.isArray(messages) ? messages.slice(-20) : [];
        const allMessages = [...history, { role: 'user', content: message }];

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: buildSystemPrompt(profile),
            messages: allMessages
        });

        const rawText = response.content[0]?.text || 'No response';
        let reply = rawText;
        let blocks = [];
        const blockStart = rawText.indexOf('[BLOCKS_START]');
        if (blockStart !== -1) {
            reply = rawText.slice(0, blockStart).trim();
            const blockEnd = rawText.indexOf('[BLOCKS_END]', blockStart);
            if (blockEnd !== -1) {
                try {
                    blocks = JSON.parse(rawText.slice(blockStart + 14, blockEnd).trim());
                } catch (e) {
                    console.error('blocks parse error:', e.message);
                    blocks = [];
                }
            }
        }
        res.json({ reply, blocks });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/audit-custom', async (req, res) => {
    try {
        let { supplierName, context, profile } = req.body;

        if (!supplierName || typeof supplierName !== 'string' || supplierName.trim().length === 0)
            return res.status(400).json({ error: 'Supplier name is required' });
        if (supplierName.length > MAX_INPUT)
            return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
        supplierName = stripHtml(supplierName);
        if (context) {
            if (context.length > MAX_INPUT)
                return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
            context = stripHtml(context);
        }

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const systemPrompt = `You are a supply chain risk intelligence analyst for RiskSim AI. You generate detailed supplier risk audits based on available information. You must ALWAYS respond with valid JSON only — no markdown, no backticks, no explanation text outside the JSON.

Your analysis should be thorough, professional, and data-driven. When you have limited information about a supplier, use reasonable estimates based on the country, industry, company size, and general risk factors for that region. Be honest about confidence levels.

Always respond in this exact JSON format:
{
  "supplierName": "Full Company Name",
  "country": "Country of origin",
  "industry": "Industry/sector",
  "founded": "Year or estimate",
  "employees": "Estimate range",
  "riskScore": 45,
  "confidence": "high/medium/low",
  "metrics": {
    "fraudRisk": { "score": 35, "change": -5, "summary": "Brief 1-sentence assessment" },
    "financialStability": { "score": 62, "change": 3, "summary": "Brief 1-sentence assessment" },
    "supplyReliability": { "score": 58, "change": -2, "summary": "Brief 1-sentence assessment" },
    "compliance": { "score": 71, "change": 1, "summary": "Brief 1-sentence assessment" }
  },
  "summary": "A detailed 150-200 word executive summary analyzing the supplier's overall risk profile, key strengths, vulnerabilities, and contextual factors affecting their risk rating. Reference specific geopolitical, economic, or industry factors.",
  "recommendations": [
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" },
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" },
    { "title": "Title", "description": "2-3 sentence actionable recommendation", "priority": "high/medium/low", "timeline": "immediate/30-days/90-days" }
  ],
  "alternativeSuppliers": [
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" },
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" },
    { "name": "Name", "country": "Country", "reason": "Why this is a good alternative" }
  ],
  "riskFactors": ["Specific risk factor 1", "Specific risk factor 2", "Specific risk factor 3"],
  "strengths": ["Specific strength 1", "Specific strength 2"]
}

Risk score ranges: 0-14 Low risk, 15-29 Low-Medium, 30-44 Medium, 45-59 Medium-High, 60-84 High, 85-100 Critical. Only assign Critical for active conflict zones, complete port shutdowns, or government-imposed trade bans directly affecting the supplier.
Score realistically based on country risk, industry, company size, and known information.`;

        const userMessage = `Generate a comprehensive supply chain risk audit for this supplier:

Supplier Name: ${supplierName.trim()}
${context ? 'Additional Context: ' + context : ''}
${profile && profile.industry ? 'Requesting Company Industry: ' + profile.industry : ''}
${profile && profile.sourcingCountries ? 'Requesting Company Sourcing Countries: ' + profile.sourcingCountries.join(', ') : ''}

Analyze this supplier thoroughly. If you have knowledge about this company, use it. If this is a smaller or unknown company, make reasonable assessments based on the country, industry, and any context provided.`;

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        });

        const rawText = response.content[0].text;

        let auditData;
        try {
            const cleanText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            auditData = JSON.parse(cleanText);
        } catch (parseError) {
            console.error('Failed to parse audit JSON:', parseError);
            return res.status(500).json({ error: 'Failed to parse audit data' });
        }

        res.json({ audit: auditData });

    } catch (error) {
        console.error('Custom audit error:', error);
        res.status(500).json({ error: 'Failed to generate audit. Please try again.' });
    }
});

app.post('/api/terminal/news', async (req, res) => {
    try {
        const { sourcingCountries, homeCountry, industry } = req.body;

        const hasSourcing = Array.isArray(sourcingCountries) && sourcingCountries.length > 0;
        const hasHome = typeof homeCountry === 'string' && homeCountry.trim().length > 0;
        const hasIndustry = typeof industry === 'string' && industry.trim().length > 0;

        if (!hasSourcing && !hasHome && !hasIndustry) {
            return res.status(400).json({ error: 'insufficient_profile', items: [] });
        }

        const key = terminalCacheKey(sourcingCountries, homeCountry, industry);
        const cached = terminalNewsCache[key];
        if (cached && (Date.now() - cached.fetchedAt) < TERMINAL_NEWS_TTL) {
            return res.json({ items: cached.items, fetchedAt: new Date(cached.fetchedAt).toISOString(), fromCache: true });
        }

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const now = new Date();
        const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

        const sourcingStr = hasSourcing ? sourcingCountries.map(c => String(c).trim()).filter(Boolean).join(', ') : '';
        const laneDesc = [
            sourcingStr && `sourcing from ${sourcingStr}`,
            hasHome && `shipping to ${homeCountry.trim()}`,
            hasIndustry && `industry: ${industry.trim()}`
        ].filter(Boolean).join(', ');

        const searchQuery = [
            `supply chain risk news ${monthYear}`,
            sourcingStr,
            hasHome ? homeCountry.trim() : '',
            hasIndustry ? industry.trim() : '',
            'tariffs disruptions port delays strikes'
        ].filter(Boolean).join(' ');

        const userMessage = `Search for the latest supply chain risk news relevant to this trade profile and return ONLY a JSON array — no prose, no markdown, no backticks — with 5-8 items.

Trade profile: ${laneDesc}
Date: ${monthYear}

Return this exact JSON array format with no other text before or after it:
[{"headline":"...","summary":"one concise sentence max 120 chars","source":"publication name","date":"${monthYear}","severity":"critical|high|medium|low"}]

Severity guide — be conservative, match real-world impact:
- critical: only for supply-chain-halting events (port fully closed, major sanctions embargo, war-zone factory seizure)
- high: significant disruption — major strike, 20%+ tariff hike, severe congestion adding weeks of delay
- medium: notable but manageable — policy change, moderate congestion, cost pressure, investigation launched
- low: advisory, minor update, early-stage review with no confirmed impact yet
Most items should be medium or high. Reserve critical for genuinely rare, severe events. Do not inflate severity.

Focus on: tariffs, port disruptions, strikes, geopolitical risk, freight rate changes, factory shutdowns — specific to the trade lane above. Omit general economic news not tied to supply chain.

Search query: ${searchQuery}`;

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: userMessage }]
        });

        const rawText = response.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');

        const jsonStr = extractJsonArray(rawText);
        let items = [];
        if (jsonStr) {
            try {
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed)) items = parsed.slice(0, 8);
            } catch (e) {
                console.error('[terminal/news] JSON parse failed:', e.message, '— raw:', rawText.slice(0, 200));
            }
        }

        const fetchedAt = Date.now();
        if (items.length > 0) {
            terminalNewsCache[key] = { items, fetchedAt };
        }
        console.log(`[terminal/news] fetched ${items.length} items for key: ${key}`);

        res.json({ items, fetchedAt: new Date(fetchedAt).toISOString(), fromCache: false });
    } catch (error) {
        console.error('[terminal/news] error:', error.message);
        res.status(500).json({ error: 'fetch_failed', items: [] });
    }
});

app.post('/api/analyze-shipment', async (req, res) => {
    try {
        let { shipmentText, profile } = req.body;

        if (!shipmentText || typeof shipmentText !== 'string' || shipmentText.trim().length === 0)
            return res.status(400).json({ error: 'Shipment text is required' });
        if (shipmentText.length > MAX_INPUT)
            return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
        shipmentText = stripHtml(shipmentText);

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const tariffCtx = JSON.stringify((dataStore.tariffs || []).slice(0, 15));
        const portCtx = JSON.stringify((dataStore.ports || []).slice(0, 15));
        const alertCtx = JSON.stringify((dataStore.alerts || []).slice(0, 10));

        let profileLines = '';
        if (profile) {
            if (profile.companyName) profileLines += `Company: ${profile.companyName}\n`;
            if (profile.industry) profileLines += `Industry: ${profile.industry}\n`;
            if (profile.homeCountry) profileLines += `Home country: ${profile.homeCountry}\n`;
            if (profile.sourcingCountries && profile.sourcingCountries.length)
                profileLines += `Sourcing countries: ${profile.sourcingCountries.join(', ')}\n`;
            if (profile.products) profileLines += `Products: ${profile.products}\n`;
            if (profile.suppliers) profileLines += `Suppliers: ${profile.suppliers}\n`;
            if (profile.businessDescription) profileLines += `Business context: ${profile.businessDescription.slice(0, 600)}\n`;
            if (profile.enterprise) profileLines += `Enterprise profile summary: ${JSON.stringify(profile.enterprise).slice(0, 600)}\n`;
        }

        const systemPrompt = `You are a supply chain intelligence analyst at RiskSim AI. Analyze the shipment information the user provides and return structured risk analysis as ONLY valid JSON — no markdown fences, no backticks, no explanatory text outside the JSON.

USER PROFILE:
${profileLines || 'No profile provided.'}

LIVE TARIFF DATA (from RiskSim pipelines):
${tariffCtx}

LIVE PORT CONDITIONS (from RiskSim pipelines):
${portCtx}

LIVE SUPPLY CHAIN ALERTS (from RiskSim pipelines):
${alertCtx}

INSTRUCTIONS:
1. Extract from the user's text: container/booking ID, origin port, destination port, carrier, transit time, and ETA. Make reasonable estimates from context if not explicit.
2. Assess overall route risk as LOW, MODERATE, HIGH, or CRITICAL — base this on current port conditions, active tariff exposure, carrier performance signals, and any relevant alerts from the pipeline data above.
3. List up to 5 route factors — objective, data-grounded risks specific to this route right now.
4. List up to 4 "your factors" — company-specific risks derived from the user profile (single-source exposure, inventory buffers, tariff sensitivity for their products, etc.). Skip if no profile.
5. Generate 3–5 specific, actionable recommended steps for this shipment. Each should be concrete and immediately useful — not generic supply chain advice.
6. If a field cannot be extracted, use a reasonable placeholder (e.g. "Unknown" for ID, "Estimated" for transit).

Return ONLY this JSON structure:
{
  "id": "container or booking ID, or UNKNOWN",
  "origin": "origin port with city",
  "destination": "destination port with city",
  "carrier": "carrier name",
  "transit": "~X days or range",
  "eta": "Month Day, Year",
  "severity": "LOW|MODERATE|HIGH|CRITICAL",
  "routeFactors": ["factor 1", "factor 2"],
  "yourFactors": ["company-specific factor 1"],
  "actions": ["action 1", "action 2"]
}`;

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            system: systemPrompt,
            messages: [{ role: 'user', content: `Analyze this shipment:\n\n${shipmentText}` }]
        });

        const rawText = response.content[0]?.text || '';
        let result;
        try {
            const cleaned = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
            result = JSON.parse(cleaned);
        } catch (e) {
            console.error('[analyze-shipment] JSON parse error:', e.message, rawText.slice(0, 300));
            return res.status(500).json({ error: 'Failed to parse analysis result. Please try again.' });
        }

        res.json(result);
    } catch (error) {
        console.error('[analyze-shipment] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/price-extract', async (req, res) => {
    try {
        let { fileType, fileName, fileData, fileContent, mimeType } = req.body;

        if (!fileType || typeof fileType !== 'string' || fileType.trim().length === 0)
            return res.status(400).json({ error: 'fileType required' });
        fileType = stripHtml(fileType);
        if (fileName) fileName = stripHtml(fileName);
        if (fileContent) {
            if (fileContent.length > MAX_INPUT)
                return res.status(400).json({ error: 'Input exceeds maximum allowed length.' });
            fileContent = stripHtml(fileContent);
        }

        const apiKey = process.env.CLAUDE_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const client = new Anthropic({ apiKey });

        const systemPrompt = `You are a pricing data extraction specialist. Extract all pricing information from the provided document and return ONLY valid JSON — no markdown, no backticks, no text outside the JSON.

Return this exact format:
{
  "manufacturer": "Company or brand name if identifiable, else null",
  "effectiveDate": "Date string if found, else null",
  "currency": "USD or detected currency",
  "items": [
    {
      "partNumber": "Part or SKU number",
      "description": "Item description",
      "oldPrice": 0.00,
      "newPrice": 0.00,
      "unit": "each/kg/box/etc"
    }
  ],
  "summary": {
    "totalItems": 0,
    "avgChangePercent": 0.0,
    "largestIncrease": 0.0,
    "smallestChange": 0.0,
    "increasedCount": 0,
    "decreasedCount": 0,
    "unchangedCount": 0
  }
}

If oldPrice is not present in the document, set oldPrice to null. Extract every line item you can find. Be thorough.`;

        let messageContent;

        if (fileType === 'pdf') {
            messageContent = [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: fileData
                    }
                },
                {
                    type: 'text',
                    text: `Extract all pricing data from this document: ${fileName}`
                }
            ];
        } else if (fileType === 'csv' || fileType === 'text') {
            messageContent = `Extract all pricing data from this file (${fileName}):\n\n${fileContent}`;
        } else {
            // Excel or other binary — send as base64 with description
            messageContent = [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: mimeType || 'application/octet-stream',
                        data: fileData
                    }
                },
                {
                    type: 'text',
                    text: `Extract all pricing data from this spreadsheet: ${fileName}`
                }
            ];
        }

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: 'user', content: messageContent }]
        });

        const rawText = response.content[0].text;

        let extracted;
        try {
            const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            extracted = JSON.parse(clean);
        } catch (e) {
            console.error('Price extract parse error:', e);
            return res.status(500).json({ error: 'Failed to parse extracted data' });
        }

        // Compute change percents server-side
        if (extracted.items) {
            extracted.items = extracted.items.map(item => {
                const change = (item.oldPrice != null && item.oldPrice !== 0)
                    ? ((item.newPrice - item.oldPrice) / item.oldPrice * 100)
                    : null;
                return { ...item, changePercent: change !== null ? parseFloat(change.toFixed(2)) : null };
            });
        }

        res.json({ data: extracted });
    } catch (error) {
        console.error('Price extract error:', error);
        res.status(500).json({ error: 'Failed to extract pricing data. Please try again.' });
    }
});

// ============================================================
// SYS_06 COST ENGINE — Exchange Rates + Landed Cost Calculator
// ============================================================

const FX_FALLBACK = {
    USD:1, EUR:0.92, GBP:0.79, CNY:7.24, JPY:149.5, KRW:1380, INR:84.5,
    VND:25400, THB:34.8, MXN:17.2, BRL:5.15, TWD:32.5, BDT:121, TRY:36.5,
    CAD:1.37, AUD:1.55, CHF:0.88, SGD:1.35, MYR:4.72, IDR:15800,
    PHP:56.5, PKR:278, CZK:23.5, ZAR:18.2, CLP:950, ILS:3.65,
    PLN:4.05, SEK:10.5, NOK:10.8, DKK:6.88, HKD:7.82, NZD:1.68
};

app.get('/api/exchange-rates', async (req, res) => {
    try {
        const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 4000 });
        res.json({ rates: response.data.rates, base: 'USD', updated: response.data.date });
    } catch (error) {
        res.json({ rates: FX_FALLBACK, base: 'USD', updated: new Date().toISOString().split('T')[0], fallback: true });
    }
});

app.post('/api/landed-cost', async (req, res) => {
    try {
        const {
            productName, unitPrice, unitCurrency, quantity,
            weightPerUnit, weightUnit, hsCode, productCategory,
            containerType, shippingMode, incoterms,
            destinationCountry, originCountries,
            insuranceRate, brokerFee, hmfRate, mpfRate,
            inlandTransport, resultCurrency
        } = req.body;

        if (!unitPrice || !originCountries || originCountries.length === 0) {
            return res.status(400).json({ error: 'Unit price and at least one origin country required' });
        }

        let rates = FX_FALLBACK;
        try {
            const fxRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 3000 });
            rates = fxRes.data.rates;
        } catch (e) { /* use fallback */ }

        const SHIPPING_RATES = {
            sea:  { Asia:0.15, Europe:0.18, Americas:0.12, Africa:0.22, default:0.17 },
            air:  { Asia:3.50, Europe:3.80, Americas:2.80, Africa:4.50, default:3.50 },
            rail: { Asia:0.45, Europe:0.55, Americas:0.40, Africa:null,  default:0.50 },
            road: { Asia:0.35, Europe:0.30, Americas:0.25, Africa:0.45, default:0.35 }
        };
        const TRANSIT = {
            sea:  { Asia:28, Europe:18, Americas:8,  Africa:32, default:25 },
            air:  { Asia:4,  Europe:3,  Americas:2,  Africa:5,  default:4  },
            rail: { Asia:18, Europe:14, Americas:5,  Africa:null,default:15},
            road: { Asia:null,Europe:8, Americas:4,  Africa:null,default:6 }
        };
        const REGIONS = {
            China:'Asia',Taiwan:'Asia',Vietnam:'Asia',India:'Asia','South Korea':'Asia',
            Japan:'Asia',Thailand:'Asia',Malaysia:'Asia',Indonesia:'Asia',Bangladesh:'Asia',
            Cambodia:'Asia',Philippines:'Asia',Myanmar:'Asia',Pakistan:'Asia','Sri Lanka':'Asia',
            Germany:'Europe',France:'Europe',Italy:'Europe',Spain:'Europe',Netherlands:'Europe',
            Belgium:'Europe',Poland:'Europe','Czech Republic':'Europe',Slovakia:'Europe',
            Turkey:'Europe',Ireland:'Europe',Switzerland:'Europe','United Kingdom':'Europe',
            Sweden:'Europe',Norway:'Europe',Israel:'Europe',
            Mexico:'Americas',Brazil:'Americas',Canada:'Americas',Chile:'Americas',
            Colombia:'Americas',Argentina:'Americas',
            'South Africa':'Africa',Ethiopia:'Africa',Nigeria:'Africa',
            Australia:'Asia'
        };
        const TARIFFS = {
            technology:{ China:{mfn:3.4,add:25,ad:0},Taiwan:{mfn:2.8,add:0,ad:0},'South Korea':{mfn:0,add:0,ad:0},Vietnam:{mfn:3.2,add:5,ad:0},Japan:{mfn:0,add:0,ad:0},Malaysia:{mfn:2.5,add:0,ad:0},India:{mfn:3.8,add:10,ad:0},Germany:{mfn:1.5,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},Thailand:{mfn:3.0,add:3,ad:0},Bangladesh:{mfn:4,add:0,ad:0},Indonesia:{mfn:3.5,add:0,ad:0} },
            textiles:{ China:{mfn:12,add:25,ad:0},Bangladesh:{mfn:16,add:0,ad:0},Vietnam:{mfn:12,add:0,ad:0},India:{mfn:14,add:5,ad:0},Turkey:{mfn:10,add:0,ad:0},Cambodia:{mfn:14,add:0,ad:0},Indonesia:{mfn:13,add:0,ad:0},Pakistan:{mfn:11,add:0,ad:0} },
            automotive:{ China:{mfn:2.5,add:25,ad:0},Germany:{mfn:2.5,add:0,ad:0},Japan:{mfn:2.5,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},'South Korea':{mfn:0,add:0,ad:0},'Czech Republic':{mfn:2.5,add:0,ad:0},Thailand:{mfn:2.5,add:2.5,ad:0} },
            food:{ China:{mfn:8,add:25,ad:0},Brazil:{mfn:5,add:0,ad:0},India:{mfn:8,add:5,ad:0},Thailand:{mfn:4,add:0,ad:0},Mexico:{mfn:0,add:0,ad:0},Vietnam:{mfn:6,add:0,ad:0} },
            pharma:{ China:{mfn:3,add:25,ad:0},India:{mfn:0,add:0,ad:0},Ireland:{mfn:0,add:0,ad:0},Switzerland:{mfn:0,add:0,ad:0},Germany:{mfn:0,add:0,ad:0},Israel:{mfn:0,add:0,ad:0} },
            rawMaterials:{ China:{mfn:2,add:25,ad:5},Australia:{mfn:0,add:0,ad:0},Brazil:{mfn:2,add:0,ad:0},'South Africa':{mfn:0,add:0,ad:0},Chile:{mfn:0,add:0,ad:0},Indonesia:{mfn:3,add:2,ad:0} },
            consumerGoods:{ China:{mfn:5,add:25,ad:0},Vietnam:{mfn:8,add:2,ad:0},India:{mfn:7,add:5,ad:0},Thailand:{mfn:4,add:1,ad:0},Indonesia:{mfn:5,add:2,ad:0},Mexico:{mfn:0,add:0,ad:0} }
        };
        const RISK = {
            China:{risk:42,sourcing:95,reliability:'High'},Taiwan:{risk:35,sourcing:95,reliability:'High'},
            Vietnam:{risk:38,sourcing:55,reliability:'Medium'},India:{risk:45,sourcing:72,reliability:'Medium'},
            Bangladesh:{risk:58,sourcing:88,reliability:'Medium'},'South Korea':{risk:18,sourcing:88,reliability:'High'},
            Japan:{risk:12,sourcing:88,reliability:'High'},Germany:{risk:8,sourcing:78,reliability:'High'},
            Mexico:{risk:48,sourcing:78,reliability:'Medium'},Thailand:{risk:32,sourcing:55,reliability:'Medium'},
            Turkey:{risk:52,sourcing:70,reliability:'Medium'},Cambodia:{risk:55,sourcing:65,reliability:'Low'},
            Malaysia:{risk:25,sourcing:60,reliability:'Medium'},Indonesia:{risk:40,sourcing:45,reliability:'Medium'},
            Brazil:{risk:42,sourcing:55,reliability:'Medium'},Ireland:{risk:6,sourcing:88,reliability:'High'},
            Switzerland:{risk:4,sourcing:85,reliability:'High'},'Czech Republic':{risk:12,sourcing:72,reliability:'High'},
            'South Africa':{risk:48,sourcing:40,reliability:'Low'},Chile:{risk:22,sourcing:45,reliability:'Medium'},
            Australia:{risk:8,sourcing:50,reliability:'High'},Israel:{risk:55,sourcing:65,reliability:'Medium'},
            Canada:{risk:6,sourcing:65,reliability:'High'},'United Kingdom':{risk:8,sourcing:70,reliability:'High'},
            Philippines:{risk:42,sourcing:50,reliability:'Medium'},Pakistan:{risk:62,sourcing:45,reliability:'Low'}
        };

        const DISTANCES = {
            China:{sea:19000,air:12000,rail:null,road:null},Vietnam:{sea:17500,air:14000,rail:null,road:null},
            India:{sea:15000,air:13000,rail:null,road:null},Mexico:{sea:3200,air:3000,rail:3200,road:3500},
            Germany:{sea:8500,air:7500,rail:null,road:null},Japan:{sea:16500,air:10500,rail:null,road:null},
            'South Korea':{sea:17000,air:11000,rail:null,road:null},Taiwan:{sea:17500,air:12500,rail:null,road:null},
            Bangladesh:{sea:16000,air:13500,rail:null,road:null},Thailand:{sea:16000,air:14000,rail:null,road:null},
            Turkey:{sea:10500,air:9000,rail:null,road:null},Brazil:{sea:8500,air:8000,rail:null,road:null},
            Canada:{sea:2000,air:1500,rail:2500,road:2500},'United Kingdom':{sea:6500,air:6000,rail:null,road:null},
            Indonesia:{sea:17000,air:15000,rail:null,road:null},Malaysia:{sea:17500,air:14500,rail:null,road:null},
            Pakistan:{sea:14000,air:12000,rail:null,road:null},Spain:{sea:7500,air:7000,rail:null,road:null},
            Italy:{sea:8000,air:7200,rail:null,road:null},France:{sea:7800,air:7000,rail:null,road:null},
            Poland:{sea:8200,air:7500,rail:null,road:null},Netherlands:{sea:7800,air:7000,rail:null,road:null},
        };
        const CO2_FACTORS = { sea:0.015, air:0.500, rail:0.025, road:0.065 };

        const catMap = { electronics:'technology',textiles:'textiles',automotive:'automotive',food:'food',pharma:'pharma',rawMaterials:'rawMaterials',consumerGoods:'consumerGoods',industrial:'technology',chemicals:'rawMaterials',other:'consumerGoods' };
        const cat = catMap[productCategory] || catMap[(productCategory||'').toLowerCase()] || 'technology';
        const unitCurrCode = unitCurrency || 'USD';
        const priceUSD = unitCurrCode === 'USD' ? parseFloat(unitPrice) : parseFloat(unitPrice) / (rates[unitCurrCode] || 1);
        const qty = parseInt(quantity) || 1000;
        const wtKg = (weightUnit === 'lbs' ? parseFloat(weightPerUnit||0.5) * 0.453592 : parseFloat(weightPerUnit||0.5));
        const resCurr = resultCurrency || 'USD';
        const resRate = rates[resCurr] || 1;
        const toRes = v => Math.round(v * resRate * 100) / 100;
        const r2 = v => Math.round(v * 100) / 100;

        const modesToCalc = ['sea','air','rail','road']; // always calculate all modes
        const results = {};
        let lowestCost = Infinity, optimalCountry = '', optimalMode = '';

        for (const country of originCountries) {
            const region = REGIONS[country] || 'default';
            const countryTariff = (TARIFFS[cat] || {})[country] || { mfn:5, add:0, ad:0 };
            const riskData = RISK[country] || { risk:50, sourcing:50, reliability:'Medium' };
            const countryResults = {};

            for (const mode of modesToCalc) {
                const modeRates = SHIPPING_RATES[mode] || {};
                const modeTimes = TRANSIT[mode] || {};
                const freightPerKg = modeRates[region] != null ? modeRates[region] : modeRates.default;
                const transit = modeTimes[region] != null ? modeTimes[region] : modeTimes.default;
                if (freightPerKg == null || transit == null) continue;

                const shipCostPerUnit = freightPerKg * wtKg;
                const effTariffRate = (countryTariff.mfn + countryTariff.add + countryTariff.ad) / 100;
                const tariffPerUnit = priceUSD * effTariffRate;

                const cargoVal = priceUSD * qty;
                const ins = cargoVal * ((insuranceRate || 0.5) / 100);
                const broker = parseFloat(brokerFee || 150);
                const hmf = cargoVal * ((hmfRate || 0.125) / 100);
                const mpfRaw = cargoVal * ((mpfRate || 0.3464) / 100);
                const mpf = Math.min(Math.max(mpfRaw, 31.67), 614.35);
                const inland = parseFloat(inlandTransport || 0);
                const totalFees = ins + broker + hmf + mpf + inland;
                const feesPerUnit = totalFees / qty;

                let unitsPerCont = null, contNeeded = null;
                const contCap = { '20ft':{ kg:28200 }, '40ft':{ kg:28800 }, '40hc':{ kg:28600 } };
                if (containerType && contCap[containerType]) {
                    unitsPerCont = wtKg > 0 ? Math.floor(contCap[containerType].kg / wtKg) : null;
                    if (unitsPerCont) contNeeded = Math.ceil(qty / unitsPerCont);
                }

                const totalPerUnit = priceUSD + shipCostPerUnit + tariffPerUnit + feesPerUnit;
                const costIncrease = r2(((totalPerUnit - priceUSD) / priceUSD) * 100);

                const distKm = (DISTANCES[country] || {})[mode] || null;
                const co2PerUnit = (distKm && wtKg > 0) ? r2((wtKg / 1000) * distKm * (CO2_FACTORS[mode] || 0)) : null;

                countryResults[mode] = {
                    mode, transit,
                    product: { unitPriceOriginal:parseFloat(unitPrice), unitCurrency:unitCurrCode, unitPriceUSD:r2(priceUSD), unitPriceResult:toRes(priceUSD), fxRate:r2((rates[unitCurrCode]||1)), quantity:qty, subtotal:toRes(priceUSD*qty) },
                    shipping: { freightPerKg:r2(freightPerKg), freightPerUnit:toRes(shipCostPerUnit), freightTotal:toRes(shipCostPerUnit*qty), mode, transitDays:transit, containerType:containerType||'N/A', unitsPerContainer:unitsPerCont, containersNeeded:contNeeded, distanceKm:distKm },
                    tariffs: { hsCode:hsCode||'N/A', mfnRate:countryTariff.mfn, additionalDuty:countryTariff.add, antidumping:countryTariff.ad, effectiveRate:r2(countryTariff.mfn+countryTariff.add+countryTariff.ad), costPerUnit:toRes(tariffPerUnit), costTotal:toRes(tariffPerUnit*qty) },
                    fees: { insurance:toRes(ins), brokerFee:toRes(broker), hmf:toRes(hmf), mpf:toRes(mpf), inland:toRes(inland), subtotal:toRes(totalFees), perUnit:toRes(feesPerUnit), insuranceRate:insuranceRate||0.5, hmfRate:hmfRate||0.125, mpfRate:mpfRate||0.3464 },
                    total: { perUnit:toRes(totalPerUnit), perShipment:toRes(totalPerUnit*qty), costIncrease, effectiveMarkup:costIncrease },
                    risk: { countryRiskScore:riskData.risk, sourcingScore:riskData.sourcing, reliability:riskData.reliability, leadTimeDays:transit },
                    co2PerUnit,
                    resultCurrency:resCurr
                };

                if (totalPerUnit < lowestCost) { lowestCost = totalPerUnit; optimalCountry = country; optimalMode = mode; }
            }
            if (Object.keys(countryResults).length) results[country] = countryResults;
        }

        // Collect tariff rates used (for frontend sensitivity slider)
        const tariffRates = {};
        for (const country of originCountries) {
            tariffRates[country] = (TARIFFS[cat] || {})[country] || { mfn:5, add:0, ad:0 };
        }

        res.json({
            results,
            optimal: { country:optimalCountry, mode:optimalMode, costPerUnit:toRes(lowestCost), currency:resCurr },
            meta: { productName, quantity:qty, calculatedAt:new Date().toISOString(), resultCurrency:resCurr },
            tariffRates,
            fxRates: rates,
            unitCurrency: unitCurrCode,
            priceUSD: r2(priceUSD)
        });

    } catch (error) {
        console.error('Landed cost error:', error);
        res.status(500).json({ error: 'Calculation failed. Please try again.' });
    }
});

// ============================================================
// SHOPIFY CHECKOUT
// ============================================================

app.post('/api/shopify-checkout', async (req, res) => {
  try {
    const { variantId, sellingPlanId } = req.body;

    console.log('[Checkout] variantId:', variantId, 'sellingPlanId:', sellingPlanId);

    const mutation = `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const lineItem = {
      merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: 1
    };
    if (sellingPlanId) {
      lineItem.sellingPlanId = `gid://shopify/SellingPlan/${sellingPlanId}`;
    }

    const variables = { input: { lines: [lineItem], discountCodes: ['FIRSTMONTHFREE'] } };

    const response = await fetch('https://risksim-ai.myshopify.com/api/2023-10/graphql.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const rawText = await response.text();
    console.log('[Checkout] Raw response:', rawText);
    const data = JSON.parse(rawText);

    if (data.errors) {
      return res.status(500).json({ error: 'GraphQL error', details: data.errors });
    }

    const cart = data?.data?.cartCreate?.cart;
    const userErrors = data?.data?.cartCreate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      return res.status(400).json({ error: userErrors[0].message });
    }

    if (!cart?.checkoutUrl) {
      return res.status(500).json({ error: 'No checkout URL returned' });
    }

    console.log('[Checkout] URL:', cart.checkoutUrl);
    res.json({ url: cart.checkoutUrl });

  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHOPIFY ADMIN TOKEN CACHE + RESTORE ACCESS
// ============================================================

let shopifyAdminToken = null;
let shopifyAdminTokenExpiry = 0;

async function getShopifyAdminToken() {
  if (shopifyAdminToken && Date.now() < shopifyAdminTokenExpiry - 60000) {
    return shopifyAdminToken;
  }
  const shopDomain = 'risksim-ai.myshopify.com';
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('[Shopify Token] Failed:', errText);
    throw new Error('Failed to get Shopify admin token');
  }
  const data = await response.json();
  shopifyAdminToken = data.access_token;
  shopifyAdminTokenExpiry = Date.now() + ((data.expires_in || 86400) * 1000);
  console.log('[Shopify Token] Refreshed successfully');
  return shopifyAdminToken;
}

app.post('/api/save-profile', async (req, res) => {
  try {
    const { email, profile } = req.body;
    if (!email || !email.includes('@') || !profile) {
      return res.status(400).json({ error: 'Email and profile required' });
    }

    // Assign a supply-chain region so the Risk Intelligence Map can be personalised
    // (see regionalMapData / assignRegionToUser). An explicit Settings override wins;
    // otherwise derive from the home country. Recomputed on every save.
    if (profile.regionOverride && Object.prototype.hasOwnProperty.call(regionalMapData, profile.regionOverride)) {
      profile.assignedRegion = profile.regionOverride;
    } else if (profile.homeCountry) {
      profile.assignedRegion = assignRegionToUser(profile.homeCountry);
    }

    console.log('[Save Profile] For:', email, '- assignedRegion:', profile.assignedRegion || '(none)');

    const token = await getShopifyAdminToken();
    const shopDomain = 'risksim-ai.myshopify.com';

    // Find customer by email
    const customerQuery = `
      query getCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const customerRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: customerQuery,
        variables: { query: `email:${email}` }
      })
    });

    const customerData = await customerRes.json();
    const customer = customerData?.data?.customers?.edges?.[0]?.node;

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Save profile as metafield
    const metafieldMutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: metafieldMutation,
        variables: {
          metafields: [{
            ownerId: customer.id,
            namespace: 'risksim',
            key: 'profile',
            type: 'json',
            value: JSON.stringify(profile)
          }]
        }
      })
    });

    const metafieldData = await metafieldRes.json();
    console.log('[Save Profile] Result:', JSON.stringify(metafieldData));

    if (metafieldData?.data?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({
        error: 'Failed to save profile',
        details: metafieldData.data.metafieldsSet.userErrors
      });
    }

    return res.json({ success: true });

  } catch (err) {
    console.error('[Save Profile] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/restore-access', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    console.log('[Restore Access] Lookup for:', email);

    const token = await getShopifyAdminToken();
    const shopDomain = 'risksim-ai.myshopify.com';

    // Find customer by email
    const customerQuery = `
      query getCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email
              numberOfOrders
            }
          }
        }
      }
    `;

    const customerRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: customerQuery,
        variables: { query: `email:${email}` }
      })
    });

    const customerData = await customerRes.json();
    console.log('[Restore Access] Customer lookup:', JSON.stringify(customerData));

    const customer = customerData?.data?.customers?.edges?.[0]?.node;
    if (!customer) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    // Get customer's orders with subscription line items
    const ordersQuery = `
      query getCustomerOrders($customerId: ID!) {
        customer(id: $customerId) {
          orders(first: 20, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                cancelledAt
                lineItems(first: 10) {
                  edges {
                    node {
                      title
                      sellingPlan {
                        sellingPlanId
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const ordersRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: ordersQuery,
        variables: { customerId: customer.id }
      })
    });

    const ordersData = await ordersRes.json();
    console.log('[Restore Access] Orders:', JSON.stringify(ordersData));

    const orders = ordersData?.data?.customer?.orders?.edges || [];

    // Plan ID mapping
    const PLAN_IDS = {
      'gid://shopify/SellingPlan/692427948370': 'pro',          // Pro monthly
      'gid://shopify/SellingPlan/692434501970': 'pro',          // Pro annual
      'gid://shopify/SellingPlan/692427981138': 'enterprise',   // Enterprise monthly
      'gid://shopify/SellingPlan/692442923346': 'enterprise'    // Enterprise annual
    };

    let plan = null;
    for (const orderEdge of orders) {
      const order = orderEdge.node;
      if (order.cancelledAt) continue;

      for (const lineEdge of (order.lineItems?.edges || [])) {
        const line = lineEdge.node;
        if (line.sellingPlan?.sellingPlanId) {
          const planId = line.sellingPlan.sellingPlanId;
          if (PLAN_IDS[planId]) {
            plan = PLAN_IDS[planId];
            break;
          }
        }
      }
      if (plan) break;
    }

    if (!plan) {
      return res.status(404).json({ error: 'No active subscription found for this email' });
    }

    // Fetch saved profile metafield
    let profile = null;
    try {
      const profileQuery = `
        query getCustomerProfile($customerId: ID!) {
          customer(id: $customerId) {
            metafield(namespace: "risksim", key: "profile") {
              value
            }
          }
        }
      `;

      const profileRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({
          query: profileQuery,
          variables: { customerId: customer.id }
        })
      });

      const profileData = await profileRes.json();
      const metafieldValue = profileData?.data?.customer?.metafield?.value;
      if (metafieldValue) {
        profile = JSON.parse(metafieldValue);
        console.log('[Restore Access] Profile loaded from metafield');
      }
      // Backfill assignedRegion for profiles saved before regional map data existed,
      // so the map personalises on next login even without a re-save.
      if (profile && !profile.assignedRegion && profile.homeCountry) {
        profile.assignedRegion = assignRegionToUser(profile.homeCountry);
      }
    } catch (e) {
      console.error('[Restore Access] Profile fetch error:', e);
    }

    return res.json({ success: true, plan, email, profile });

  } catch (err) {
    console.error('[Restore Access] Error:', err);
    return res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ============================================================
// OTP SIGN-IN — two-step email verification
// ============================================================

const OTP_KEY     = e => `otp:${e}`;
const OTP_SENDS   = e => `otp:sends:${e}`;
const OTP_LOCKOUT = ip => `otp:lockout:${ip}`;

// Shared Shopify plan-ID map (same set as /api/restore-access)
const SHOPIFY_PLAN_IDS = {
    'gid://shopify/SellingPlan/692427948370': 'pro',
    'gid://shopify/SellingPlan/692434501970': 'pro',
    'gid://shopify/SellingPlan/692427981138': 'enterprise',
    'gid://shopify/SellingPlan/692442923346': 'enterprise'
};

app.post('/api/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        const key = email.toLowerCase().trim();
        const ip = req.ip;

        // Fail closed — OTP requires Redis
        if (!redisAvailable) {
            return res.status(503).json({ error: 'Sign-in temporarily unavailable. Please try again later.' });
        }

        // IP lockout check
        const locked = await redisCmd(['EXISTS', OTP_LOCKOUT(ip)]);
        if (locked === 1) {
            return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
        }

        // Per-email send rate limit: INCR-first so check+increment are one atomic sequence (no race)
        const newSendCount = await redisCmd(['INCR', OTP_SENDS(key)]);
        if (newSendCount === 1) {
            await redisCmd(['EXPIRE', OTP_SENDS(key), '3600']);
        }
        if (newSendCount > 3) {
            return res.status(429).json({ error: "You've requested the maximum codes for this email. Try again in an hour, or email info@risksim.ai for help." });
        }

        // Shopify lookup — verify customer and active subscription before issuing code
        const token = await getShopifyAdminToken();
        const shopDomain = 'risksim-ai.myshopify.com';

        const customerRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({
                query: `query getCustomerByEmail($query: String!) {
                    customers(first: 1, query: $query) {
                        edges { node { id email } }
                    }
                }`,
                variables: { query: `email:${key}` }
            })
        });
        const customerData = await customerRes.json();
        const customer = customerData?.data?.customers?.edges?.[0]?.node;
        if (!customer) {
            return res.status(404).json({ error: 'No account found with this email' });
        }

        const ordersRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({
                query: `query getCustomerOrders($customerId: ID!) {
                    customer(id: $customerId) {
                        orders(first: 20, sortKey: CREATED_AT, reverse: true) {
                            edges {
                                node {
                                    cancelledAt
                                    lineItems(first: 10) {
                                        edges { node { sellingPlan { sellingPlanId } } }
                                    }
                                }
                            }
                        }
                    }
                }`,
                variables: { customerId: customer.id }
            })
        });
        const ordersData = await ordersRes.json();
        const orders = ordersData?.data?.customer?.orders?.edges || [];
        let plan = null;
        for (const { node: order } of orders) {
            if (order.cancelledAt) continue;
            for (const { node: line } of (order.lineItems?.edges || [])) {
                const pid = line.sellingPlan?.sellingPlanId;
                if (pid && SHOPIFY_PLAN_IDS[pid]) { plan = SHOPIFY_PLAN_IDS[pid]; break; }
            }
            if (plan) break;
        }
        if (!plan) {
            return res.status(404).json({ error: 'No active subscription found for this email' });
        }

        let profile = null;
        try {
            const profileRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
                body: JSON.stringify({
                    query: `query getCustomerProfile($customerId: ID!) {
                        customer(id: $customerId) {
                            metafield(namespace: "risksim", key: "profile") { value }
                        }
                    }`,
                    variables: { customerId: customer.id }
                })
            });
            const profileData = await profileRes.json();
            const mv = profileData?.data?.customer?.metafield?.value;
            if (mv) profile = JSON.parse(mv);
        } catch (e) {
            console.error('[send-otp] Profile fetch error:', e.message);
        }

        // Generate 6-digit code and store with plan/profile (avoids second Shopify round-trip at verify)
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await redisCmd(['SET', OTP_KEY(key), JSON.stringify({ code, attempts: 0, plan, profile }), 'EX', '600']);

        // Send OTP email
        const otpHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.28);margin-bottom:28px">RISKSIM AI</div>
  <p style="font-size:15px;color:rgba(255,255,255,0.85);margin:0 0 24px">Your sign-in code is:</p>
  <div style="font-size:36px;font-weight:700;letter-spacing:0.15em;font-family:monospace;color:#fff;margin-bottom:24px">${code}</div>
  <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:0">It expires in 10 minutes. If you didn't request this, ignore this email.</p>
</body></html>`;
        const otpText = `Your RiskSim sign-in code is: ${code}\n\nIt expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`;
        await sendEmail(key, 'Your RiskSim sign-in code', otpHtml, otpText);

        console.log('[send-otp] Code issued for:', key);
        res.json({ otpSent: true });

    } catch (err) {
        console.error('[send-otp] Error:', err);
        res.status(500).json({ error: 'Server error, please try again' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !email.includes('@') || !code) {
            return res.status(400).json({ error: 'Email and code required' });
        }
        const key = email.toLowerCase().trim();
        const ip = req.ip;

        if (!redisAvailable) {
            return res.status(503).json({ error: 'Sign-in temporarily unavailable. Please try again later.' });
        }

        // IP lockout check
        const locked = await redisCmd(['EXISTS', OTP_LOCKOUT(ip)]);
        if (locked === 1) {
            return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
        }

        // Fetch OTP record
        const raw = await redisCmd(['GET', OTP_KEY(key)]);
        if (!raw) {
            return res.status(400).json({ error: 'Code expired or not found. Please request a new one.' });
        }
        const record = JSON.parse(raw);

        // Safety net — should have been caught on previous attempts
        if (record.attempts >= 5) {
            await redisCmd(['SET', OTP_LOCKOUT(ip), '1', 'EX', '900']);
            await redisCmd(['DEL', OTP_KEY(key)]);
            return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
        }

        if (code !== record.code) {
            const newAttempts = record.attempts + 1;

            if (newAttempts >= 5) {
                await redisCmd(['SET', OTP_LOCKOUT(ip), '1', 'EX', '900']);
                await redisCmd(['DEL', OTP_KEY(key)]);
                return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
            }

            // Preserve remaining TTL when writing back incremented attempts (spec requirement B)
            const ttl = await redisCmd(['TTL', OTP_KEY(key)]);
            if (!ttl || ttl < 1) {
                return res.status(400).json({ error: 'Code expired. Please request a new one.' });
            }
            record.attempts = newAttempts;
            await redisCmd(['SETEX', OTP_KEY(key), String(ttl), JSON.stringify(record)]);

            return res.status(400).json({ error: 'Incorrect code.', attemptsLeft: 5 - newAttempts });
        }

        // Success
        await redisCmd(['DEL', OTP_KEY(key)]);
        console.log('[verify-otp] Success for:', key);
        // Backfill assignedRegion if an older cached profile lacks it.
        if (record.profile && !record.profile.assignedRegion && record.profile.homeCountry) {
            record.profile.assignedRegion = assignRegionToUser(record.profile.homeCountry);
        }
        return res.json({ success: true, plan: record.plan, email: key, profile: record.profile });

    } catch (err) {
        console.error('[verify-otp] Error:', err);
        res.status(500).json({ error: 'Server error, please try again' });
    }
});

app.post('/api/verify-reviewer', async (req, res) => {
    try {
        const { yc_token, password } = req.body;
        if (!yc_token || !password) {
            return res.status(400).json({ error: 'Token and password required' });
        }
        if (yc_token !== REVIEWER_TOKEN) {
            return res.status(400).json({ error: 'Invalid token' });
        }
        const valid = await bcrypt.compare(String(password), REVIEWER_PASSWORD_HASH);
        if (!valid) {
            return res.status(400).json({ success: false, error: 'Incorrect password' });
        }
        console.log('[verify-reviewer] Success from IP:', req.ip);
        return res.json({ success: true });
    } catch (err) {
        console.error('[verify-reviewer] Error:', err);
        res.status(500).json({ error: 'Server error, please try again' });
    }
});

// ============================================================
// EMAIL SENDING — Resend REST API via axios (no extra npm package)
// ============================================================

const EMAIL_FROM = 'RiskSim AI <alerts@risksim.ai>';

function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmail(to, subject, html, text) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.warn('[Email] RESEND_API_KEY not set — skipping send to', to);
        return false;
    }
    try {
        const r = await axios.post('https://api.resend.com/emails', { from: EMAIL_FROM, to: [to], subject, html, text }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 10000
        });
        console.log('[Email] Sent to', to, '— id:', r.data?.id);
        return true;
    } catch (err) {
        console.error('[Email] Resend error for', to, '—', err.response?.data?.message || err.message);
        return false;
    }
}

function buildCriticalAlertHtml(alert, subscriber) {
    const unsubUrl = `https://risksim.ai/api/email/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
    const linkHtml = alert.link
        ? `<p style="margin:16px 0"><a href="${escHtml(alert.link)}" style="color:#4a9eff;font-size:13px">Read full report →</a></p>`
        : '';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.28);margin-bottom:28px">RISKSIM AI &middot; CRITICAL SUPPLY CHAIN ALERT</div>
  <h1 style="font-size:20px;font-weight:700;margin:0 0 12px;line-height:1.35;color:#fff">${escHtml(alert.title)}</h1>
  <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:24px;letter-spacing:0.05em">${alert.industry ? escHtml(alert.industry.toUpperCase()) + ' &nbsp;&middot;&nbsp; ' : ''}${alert.pubDate ? new Date(alert.pubDate).toUTCString() : ''}</div>
  <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.75;margin:0 0 8px">This event was flagged by RiskSim's critical alert system. Review your supply chain exposure immediately.</p>
  ${linkHtml}
  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:32px 0">
  <p style="font-size:11px;color:rgba(255,255,255,0.22);line-height:1.6;margin:0">You're receiving this because you subscribed to critical alerts on RiskSim AI.<br><a href="${unsubUrl}" style="color:rgba(255,255,255,0.22)">Unsubscribe</a></p>
</body></html>`;
}

function buildCriticalAlertText(alert, subscriber) {
    const unsubUrl = `https://risksim.ai/api/email/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
    const lines = [
        'RISKSIM AI — CRITICAL SUPPLY CHAIN ALERT',
        '',
        alert.title,
        alert.industry ? alert.industry.toUpperCase() : '',
        alert.pubDate ? new Date(alert.pubDate).toUTCString() : '',
        '',
        "This event was flagged by RiskSim's critical alert system. Review your supply chain exposure immediately."
    ];
    if (alert.link) lines.push('', 'Read more: ' + alert.link);
    lines.push('', '---', 'Unsubscribe: ' + unsubUrl);
    return lines.join('\n');
}

const CRITICAL_RE = /\bwar\b|bombing|invasion|military.strike|armed.conflict|port.closure|factory.explosion/i;

async function processCriticalAlertsNow() {
    const criticalAlerts = [];
    for (const [industry, alerts] of Object.entries(dataStore.alertsByIndustry)) {
        for (const alert of alerts) {
            const title = alert.title || '';
            if (!CRITICAL_RE.test(title)) continue;
            const pubDate = new Date(alert.pubDate || alert.isoDate || 0);
            if ((Date.now() - pubDate.getTime()) / 3600000 > 6) continue;
            criticalAlerts.push({ title, industry, pubDate: alert.pubDate || alert.isoDate, link: alert.link });
        }
    }

    if (criticalAlerts.length === 0) {
        console.log('[Email] processCriticalAlertsNow: no critical alerts in window');
        return { sent: 0, skipped: 0, alerts: 0 };
    }

    const subscribers = await listSubscribers('criticalAlerts');
    if (subscribers.length === 0) {
        console.log('[Email] processCriticalAlertsNow: no criticalAlerts subscribers');
        return { sent: 0, skipped: 0, alerts: criticalAlerts.length };
    }

    let sent = 0, skipped = 0;

    for (const alert of criticalAlerts) {
        const alertId = Buffer.from((alert.title + alert.industry).slice(0, 60)).toString('base64').replace(/[+/=]/g, '').slice(0, 24);

        for (const sub of subscribers) {
            // Industry filter: skip if alert and subscriber have known, mismatched industries
            const alertInd = (alert.industry || '').toLowerCase();
            const subInd = (sub.industry || '').toLowerCase();
            if (alertInd && alertInd !== 'general' && subInd && alertInd !== subInd) {
                skipped++;
                continue;
            }

            // Dedup: skip if this (alert, subscriber) pair was already sent (7-day TTL)
            const sentKey = `email:sent:${alertId}:${sub.email}`;
            if (redisAvailable) {
                try {
                    const already = await redisCmd(['EXISTS', sentKey]);
                    if (already === 1) { skipped++; continue; }
                } catch (e) { /* dedup check failed — allow send rather than skip silently */ }
            }

            const subject = `Critical Alert: ${alert.title.slice(0, 80)}`;
            const ok = await sendEmail(
                sub.email,
                subject,
                buildCriticalAlertHtml(alert, sub),
                buildCriticalAlertText(alert, sub)
            );
            if (ok) {
                sent++;
                if (redisAvailable) {
                    try { await redisCmd(['SET', sentKey, '1', 'EX', String(7 * 24 * 3600)]); } catch (e) {}
                }
            }
        }
    }

    console.log(`[Email] processCriticalAlertsNow — sent: ${sent}, skipped: ${skipped}, alerts found: ${criticalAlerts.length}`);
    return { sent, skipped, alerts: criticalAlerts.length };
}

// ============================================================
// EMAIL SUBSCRIBER ENDPOINTS
// ============================================================

// Subscribe / update preferences
app.post('/api/email/subscribe', async (req, res) => {
    const { email, industry, sourcingCountries, companyName, preferences } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
    }
    const key = email.toLowerCase();
    const existing = await getSubscriber(key);
    const record = {
        email: key,
        industry: industry || 'technology',
        sourcingCountries: sourcingCountries || [],
        companyName: companyName || '',
        preferences: {
            weeklyDigest: preferences?.weeklyDigest !== false,
            criticalAlerts: preferences?.criticalAlerts !== false
        },
        subscribedAt: existing?.subscribedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    await setSubscriber(key, record);
    console.log('[Email] Subscriber updated:', key);
    res.json({ success: true, subscriber: record });
});

// Unsubscribe
app.post('/api/email/unsubscribe', async (req, res) => {
    const email = (req.body.email || req.query.email || '').toLowerCase();
    if (email) {
        await deleteSubscriber(email);
        console.log('[Email] Unsubscribed:', email);
    }
    res.json({ success: true });
});

// GET unsubscribe (for email link clicks)
app.get('/api/email/unsubscribe', async (req, res) => {
    const email = (req.query.email || '').toLowerCase();
    if (email) {
        await deleteSubscriber(email);
        console.log('[Email] Unsubscribed via link:', email);
    }
    res.send('<html><body style="background:#111;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><div style="font-size:14px;letter-spacing:3px;margin-bottom:16px;">RISKSIM</div><div style="color:rgba(255,255,255,0.5);font-size:13px;">You have been unsubscribed.</div></div></body></html>');
});

// Get all subscribers — n8n uses this (protected)
app.get('/api/email/subscribers', requireDataKey, async (req, res) => {
    const type = req.query.type || null;
    const subs = await listSubscribers(type);
    res.json(subs);
});

// Get preferences for one email — frontend uses this
app.get('/api/email/preferences/:email', async (req, res) => {
    const sub = await getSubscriber(req.params.email);
    if (!sub) return res.json({ subscribed: false, preferences: { weeklyDigest: false, criticalAlerts: false } });
    res.json({ subscribed: true, preferences: sub.preferences });
});

// Critical alert check — n8n uses this (protected)
app.get('/api/email/critical-check', requireDataKey, (req, res) => {
    const criticalKeywords = /\bwar\b|bombing|invasion|military.strike|armed.conflict|port.closure|factory.explosion/i;
    const criticalAlerts = [];
    for (const [industry, alerts] of Object.entries(dataStore.alertsByIndustry)) {
        for (const alert of alerts) {
            const title = alert.title || '';
            if (criticalKeywords.test(title)) {
                const pubDate = new Date(alert.pubDate || alert.isoDate || 0);
                const hoursSince = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60);
                if (hoursSince <= 6) {
                    criticalAlerts.push({
                        title,
                        industry,
                        pubDate: alert.pubDate || alert.isoDate,
                        link: alert.link,
                        source: (title.split(' - ').pop() || '').trim()
                    });
                }
            }
        }
    }
    res.json({ hasCritical: criticalAlerts.length > 0, alerts: criticalAlerts });
});

// Weekly digest data — n8n uses this (protected)
app.get('/api/email/digest-data', requireDataKey, (req, res) => {
    const industry = req.query.industry || 'general';
    const industryAlerts = dataStore.alertsByIndustry[industry] || [];
    const generalAlerts = dataStore.alertsByIndustry.general || [];
    const combined = [...industryAlerts, ...generalAlerts];
    const topStories = combined.slice(0, 10).map(a => ({
        title: (a.title || '').split(' - ').slice(0, -1).join(' - ').trim() || a.title,
        source: (a.title || '').split(' - ').pop().trim(),
        link: a.link,
        pubDate: a.pubDate || a.isoDate
    }));
    const criticalRe = /\bwar\b|bombing|invasion|military.strike|armed.conflict|port.closure|factory.explosion/i;
  const highRe = /labor.strike|supply.shortage|port.congestion|major.disruption|operations.halted|trade.suspension|financial.crisis/i;
    let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;
    combined.forEach(a => {
        const t = (a.title || '').toLowerCase();
      if (criticalRe.test(t) && t.length > 30) criticalCount++;
else if (criticalRe.test(t)) highCount++;
        else if (highRe.test(t)) highCount++;
        else if (/tariff|regulation|compliance|cost.*rise|review|probe/i.test(t)) mediumCount++;
        else lowCount++;
    });
    res.json({
        industry,
        totalAlerts: combined.length,
        severity: { critical: criticalCount, high: highCount, medium: mediumCount, low: lowCount },
        topStories,
        generatedAt: new Date().toISOString()
    });
});

// Manual trigger + n8n callback — protected by DATA_API_KEY
app.post('/api/email/process-critical-now', requireDataKey, async (req, res) => {
    try {
        const result = await processCriticalAlertsNow();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[Email] process-critical-now error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Internal poller — only active when ALERT_POLLER_ENABLED=true
if (process.env.ALERT_POLLER_ENABLED === 'true') {
    setInterval(async () => {
        try { await processCriticalAlertsNow(); }
        catch (err) { console.error('[Email] Poller error:', err.message); }
    }, 10 * 60 * 1000); // 10 minutes
    console.log('[Email] Critical alert poller enabled — running every 10 minutes');
}

app.post('/api/subscription/cancel-request', async (req, res) => {
  const { email, plan, timestamp, customerId } = req.body;
  const webhookUrl = process.env.DISCORD_CANCEL_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ success: false, error: 'internal' });
  }

  let resolvedEmail = email;
  if ((!resolvedEmail || resolvedEmail === 'not provided') && customerId) {
      try {
          const token = await getShopifyAdminToken();
          const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
          const customerRes = await fetch(
              `https://${shopDomain}/admin/api/2024-10/customers/${customerId}.json`,
              {
                  headers: {
                      'X-Shopify-Access-Token': token,
                      'Content-Type': 'application/json'
                  }
              }
          );
          const customerData = await customerRes.json();
          resolvedEmail = customerData?.customer?.email || 'not found';
      } catch (e) {
          resolvedEmail = 'lookup failed';
      }
  }

  try {
    const content = `🚨 **CANCELLATION REQUEST**\n**Plan:** ${plan || 'unknown'}\n**Email:** ${resolvedEmail || 'not provided'}\n**Timestamp:** ${timestamp}\n**Action needed:** Cancel in Shopify admin → Subscriptions → Contracts`;
    const resp = await axios.post(webhookUrl, { content }, { headers: { 'Content-Type': 'application/json' } });
    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ success: true });
    }
    return res.status(500).json({ success: false, error: 'internal' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal' });
  }
});

app.post('/api/demo-request', async (req, res) => {
  const { name, email, meetingPlatform, preferredTime, website } = req.body;
  // honeypot — bots fill this, real users never see it
  if (website) return res.json({ success: true });
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'invalid' });
  }
  const webhookUrl = process.env.DISCORD_CANCEL_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ success: false, error: 'internal' });
  }
  try {
    const content = `📅 **DEMO REQUEST**\n**Name:** ${sanitizeForDiscord(name)}\n**Email:** ${sanitizeForDiscord(email)}\n**Preferred platform:** ${sanitizeForDiscord(meetingPlatform) || 'not specified'}\n**Preferred time:** ${sanitizeForDiscord(preferredTime) || 'not specified'}`;
    const resp = await axios.post(webhookUrl, { content }, { headers: { 'Content-Type': 'application/json' } });
    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ success: true });
    }
    return res.status(500).json({ success: false, error: 'internal' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal' });
  }
});

// ============================================================
// SHIPMENTS WORKSPACE — PHASE 3
// Server-side shipment sync, daily re-analysis job, alert store,
// and email digest. Reuses redisCmd/sendEmail/requireDataKey and the
// existing /api/analyze-shipment endpoint (called via internal HTTP so
// that endpoint stays unmodified). All gated on opted-in enterprise users.
// ============================================================

const { randomUUID } = require('crypto');

const SHIP_KEY    = e => `shipments:${e.toLowerCase()}`;
const SHIP_INDEX  = 'shipments:index';
const ALERTS_KEY  = e => `alerts:${e.toLowerCase()}`;
const SHIP_TTL    = 30 * 24 * 3600;          // 30 days
const MAX_ALERTS  = 20;
const SEVERITY_RANK   = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
const ALERT_SEV_RANK  = { INFO: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 };
const ALERT_SEV_COLOR = { INFO: '#4a9eff', WATCH: '#f5c518', WARNING: '#ff8c00', CRITICAL: '#ff1a4a' };

const shipmentsFallback = {};
const alertsFallback = {};

// ---- Redis store helpers (mirror the subscriber store: guarded, in-memory fallback) ----
async function getUserShipments(email) {
    const key = email.toLowerCase();
    if (!redisAvailable) return shipmentsFallback[key] || null;
    try {
        const val = await redisCmd(['GET', SHIP_KEY(key)]);
        return val ? JSON.parse(val) : null;
    } catch (e) { console.error('[Shipments] get error:', e.message); return shipmentsFallback[key] || null; }
}
async function setUserShipments(email, data) {
    const key = email.toLowerCase();
    shipmentsFallback[key] = data;
    if (!redisAvailable) return;
    try {
        await redisPipeline([
            ['SET', SHIP_KEY(key), JSON.stringify(data), 'EX', String(SHIP_TTL)],
            ['SADD', SHIP_INDEX, key]
        ]);
    } catch (e) { console.error('[Shipments] set error:', e.message); }
}
async function listShipmentEmails() {
    if (!redisAvailable) return Object.keys(shipmentsFallback);
    try { return (await redisCmd(['SMEMBERS', SHIP_INDEX])) || []; }
    catch (e) { console.error('[Shipments] list error:', e.message); return Object.keys(shipmentsFallback); }
}
async function getUserAlerts(email) {
    const key = email.toLowerCase();
    if (!redisAvailable) return alertsFallback[key] || [];
    try {
        const val = await redisCmd(['GET', ALERTS_KEY(key)]);
        return val ? JSON.parse(val) : [];
    } catch (e) { console.error('[Alerts] get error:', e.message); return alertsFallback[key] || []; }
}
async function setUserAlerts(email, alerts) {
    const key = email.toLowerCase();
    alertsFallback[key] = alerts;
    if (!redisAvailable) return;
    try { await redisCmd(['SET', ALERTS_KEY(key), JSON.stringify(alerts), 'EX', String(SHIP_TTL)]); }
    catch (e) { console.error('[Alerts] set error:', e.message); }
}

// ---- Phase 3 hardening: verify the enterprise plan against Shopify (cached) ----
// /api/shipments/sync is unauthenticated (email in body); never trust a client-asserted
// plan. Verify against real Shopify subscription state, cached 1h since sync runs often.
const PLAN_CACHE_KEY = e => `plan:verified:${e.toLowerCase()}`;
const PLAN_CACHE_TTL = 3600;   // 1 hour
const planFallback = {};

async function getCachedPlan(email) {
    const key = email.toLowerCase();
    if (!redisAvailable) return planFallback[key];   // undefined on miss
    try {
        const v = await redisCmd(['GET', PLAN_CACHE_KEY(key)]);
        return v ? JSON.parse(v) : undefined;
    } catch (e) { return planFallback[key]; }
}
async function setCachedPlan(email, plan) {
    const key = email.toLowerCase();
    const rec = { plan, ts: Date.now() };
    planFallback[key] = rec;
    if (!redisAvailable) return;
    try { await redisCmd(['SET', PLAN_CACHE_KEY(key), JSON.stringify(rec), 'EX', String(PLAN_CACHE_TTL)]); }
    catch (e) { /* cache write best-effort */ }
}
// Raw Shopify lookup — mirrors send-otp / restore-access. Returns 'enterprise'|'pro'|null.
async function shopifyPlanLookup(email) {
    const shopDomain = 'risksim-ai.myshopify.com';
    const token = await getShopifyAdminToken();
    const custRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: `query getCustomerByEmail($query: String!){ customers(first:1, query:$query){ edges{ node{ id } } } }`, variables: { query: `email:${email}` } })
    });
    const custData = await custRes.json();
    const customer = custData?.data?.customers?.edges?.[0]?.node;
    if (!customer) return null;
    const ordRes = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: `query getCustomerOrders($customerId: ID!){ customer(id:$customerId){ orders(first:20, sortKey:CREATED_AT, reverse:true){ edges{ node{ cancelledAt lineItems(first:10){ edges{ node{ sellingPlan{ sellingPlanId } } } } } } } } }`, variables: { customerId: customer.id } })
    });
    const ordData = await ordRes.json();
    const orders = ordData?.data?.customer?.orders?.edges || [];
    for (const { node: order } of orders) {
        if (order.cancelledAt) continue;
        for (const { node: line } of (order.lineItems?.edges || [])) {
            const pid = line.sellingPlan?.sellingPlanId;
            if (pid && SHOPIFY_PLAN_IDS[pid]) return SHOPIFY_PLAN_IDS[pid];
        }
    }
    return null;
}
// Cached, fail-closed verification used by the sync path.
async function verifyShopifyPlan(email) {
    const cached = await getCachedPlan(email);
    if (cached && typeof cached.plan !== 'undefined') return cached.plan;
    try {
        const plan = await shopifyPlanLookup(email);
        await setCachedPlan(email, plan);
        return plan;
    } catch (e) {
        console.error('[Shipments] Shopify plan verify failed for', email, '—', e.message);
        // Fail closed: reuse stale cache if any, otherwise treat as not-enterprise.
        return (cached && typeof cached.plan !== 'undefined') ? cached.plan : null;
    }
}

// ---- Part B: severity diff + alert generation ----
function severityRank(s) {
    const r = SEVERITY_RANK[String(s || '').toUpperCase()];
    return r === undefined ? 0 : r;
}
function makeAlert(shipmentId, severity, title, description, actionRecommended) {
    return {
        id: randomUUID(),
        shipment_id: shipmentId,
        severity,                       // INFO | WATCH | WARNING | CRITICAL
        title, description,
        timestamp: Date.now(),
        resolved: false,
        action_recommended: actionRecommended || null
    };
}
// Returns an alert object when severity changed materially, else null.
function alertForSeverityChange(shipmentId, prevSeverity, result) {
    const delta = severityRank(result.severity) - severityRank(prevSeverity);
    if (delta === 0) return null;
    const route = `${result.origin || 'origin'} -> ${result.destination || 'destination'}`;
    const firstAction = (Array.isArray(result.actions) && result.actions.length) ? result.actions[0] : null;
    if (delta >= 1) {
        const sevMap = { CRITICAL: 'CRITICAL', HIGH: 'WARNING', MODERATE: 'WATCH', LOW: 'INFO' };
        const alertSev = sevMap[String(result.severity).toUpperCase()] || 'WATCH';
        const factor = (Array.isArray(result.routeFactors) && result.routeFactors.length) ? ` Key factor: ${result.routeFactors[0]}` : '';
        return makeAlert(shipmentId, alertSev,
            `Risk increased to ${result.severity} — ${route}`,
            `Re-analysis raised this shipment's risk from ${prevSeverity || 'UNKNOWN'} to ${result.severity}.${factor}`,
            firstAction);
    }
    return makeAlert(shipmentId, 'INFO',
        `Risk decreased to ${result.severity} — ${route}`,
        `Re-analysis lowered this shipment's risk from ${prevSeverity || 'UNKNOWN'} to ${result.severity}.`,
        firstAction);
}
// Keep <= MAX_ALERTS, dropping oldest resolved first, then oldest overall.
function pruneAlerts(alerts) {
    if (alerts.length <= MAX_ALERTS) return alerts;
    const dropCount = alerts.length - MAX_ALERTS;
    const order = [...alerts].sort((a, b) => {
        if (!!a.resolved !== !!b.resolved) return a.resolved ? -1 : 1; // resolved first (to drop)
        return a.timestamp - b.timestamp;                              // then oldest first
    });
    const dropIds = new Set(order.slice(0, dropCount).map(a => a.id));
    return alerts.filter(a => !dropIds.has(a.id));
}

// ---- Part A: re-analysis helpers ----
function reconstructShipmentText(data) {
    if (!data) return '';
    const parts = [];
    if (data.id && data.id !== 'UNKNOWN') parts.push(`Booking/Container ID: ${data.id}`);
    if (data.origin) parts.push(`Origin: ${data.origin}`);
    if (data.destination) parts.push(`Destination: ${data.destination}`);
    if (data.carrier) parts.push(`Carrier: ${data.carrier}`);
    if (data.transit) parts.push(`Transit: ${data.transit}`);
    if (data.eta) parts.push(`ETA: ${data.eta}`);
    return parts.join('\n');
}
function isActiveShipment(entry) {
    const THIRTY_D = 30 * 24 * 3600 * 1000;
    const createdRecently = entry.ts && (Date.now() - entry.ts) <= THIRTY_D;
    let etaFuture = false;
    const etaStr = entry.data && entry.data.eta;
    if (etaStr) { const t = Date.parse(etaStr); if (!isNaN(t)) etaFuture = t >= Date.now(); }
    return !!(createdRecently || etaFuture);
}
// Re-run analysis by calling the existing endpoint internally (keeps it unmodified).
async function reanalyzeShipment(entry, profile) {
    const text = (entry.shipmentText && entry.shipmentText.trim())
        ? entry.shipmentText
        : reconstructShipmentText(entry.data);
    if (!text) throw new Error('no shipment text available');
    const r = await axios.post(`http://127.0.0.1:${PORT}/api/analyze-shipment`,
        { shipmentText: text, profile: profile || {} },
        { timeout: 30000, headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.DATA_API_KEY || '' } });
    return r.data;
}

// ---- Part A + B: the daily re-analysis job ----
async function runReanalysisJob() {
    const summary = { users: 0, processed: 0, reanalyzed: 0, alerts: 0, skipped: 0, errors: 0 };
    let emails;
    try { emails = await listShipmentEmails(); }
    catch (e) { console.error('[Job] listShipmentEmails failed:', e.message); return summary; }

    for (const email of emails) {
        let record;
        try { record = await getUserShipments(email); }
        catch (e) { summary.errors++; continue; }
        if (!record || !Array.isArray(record.shipments)) continue;
        // Gate: opted-in enterprise only. MVP trusts the client-asserted plan captured
        // at sync time; hardening TODO: verify via getShopifyAdminToken() before spend.
        if (!record.opted_in || record.plan !== 'enterprise') { summary.skipped++; continue; }
        summary.users++;

        let alerts = await getUserAlerts(email);
        let changed = false;
        for (const entry of record.shipments) {
            if (!isActiveShipment(entry)) continue;
            summary.processed++;
            try {
                const result = await reanalyzeShipment(entry, record.profile);
                summary.reanalyzed++;
                const prevSeverity = entry.prevSeverity || (entry.data && entry.data.severity) || null;
                const alert = alertForSeverityChange(entry.id, prevSeverity, result);
                entry.prevSeverity = result.severity;
                entry.lastAnalyzedAt = Date.now();
                if (result && result.severity) {
                    entry.data = Object.assign({}, entry.data, {
                        severity: result.severity, routeFactors: result.routeFactors,
                        yourFactors: result.yourFactors, actions: result.actions
                    });
                }
                if (alert) { alerts.unshift(alert); summary.alerts++; changed = true; }
            } catch (e) {
                console.error(`[Job] re-analysis failed (${email} / ${entry.id}):`, e.message);
                summary.errors++;   // log and continue — never crash the job
            }
        }
        if (changed) { alerts = pruneAlerts(alerts); await setUserAlerts(email, alerts); }
        record.updatedAt = Date.now();
        try { await setUserShipments(email, record); } catch (e) { summary.errors++; }
    }
    console.log('[Job] runReanalysisJob summary:', JSON.stringify(summary));
    return summary;
}

// ---- Part D: email digest ----
function buildShipmentDigestHtml(email, activeCount, alerts) {
    const unsubUrl = `https://risksim.ai/api/email/unsubscribe?email=${encodeURIComponent(email)}`;
    const rows = alerts.length ? alerts.map(a => {
        const c = ALERT_SEV_COLOR[a.severity] || '#4a9eff';
        return `<div style="border-left:3px solid ${c};padding:10px 14px;margin:10px 0;background:rgba(255,255,255,0.03)">`
            + `<div style="font-size:10px;letter-spacing:0.1em;color:${c};text-transform:uppercase;margin-bottom:4px">${escHtml(a.severity)}</div>`
            + `<div style="font-size:14px;color:#fff;font-weight:600;margin-bottom:4px">${escHtml(a.title)}</div>`
            + `<div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.6">${escHtml(a.description)}</div>`
            + (a.action_recommended ? `<div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:6px">&rarr; ${escHtml(a.action_recommended)}</div>` : '')
            + `</div>`;
    }).join('') : `<p style="color:rgba(255,255,255,0.5);font-size:13px">No new alerts today. All monitored shipments are steady.</p>`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.28);margin-bottom:24px">RISKSIM AI &middot; SHIPMENT DIGEST</div>
  <h1 style="font-size:20px;font-weight:700;margin:0 0 8px;color:#fff">Your shipment update</h1>
  <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0 0 20px">${activeCount} active shipment${activeCount === 1 ? '' : 's'} monitored &middot; ${alerts.length} new alert${alerts.length === 1 ? '' : 's'}</p>
  ${rows}
  <p style="margin:24px 0 0"><a href="https://risksim.ai" style="color:#4a9eff;font-size:13px">Open Shipments workspace &rarr;</a></p>
  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:28px 0">
  <p style="font-size:11px;color:rgba(255,255,255,0.22);line-height:1.6;margin:0">You're receiving this because shipment digests are enabled for ${escHtml(email)}.<br><a href="${unsubUrl}" style="color:rgba(255,255,255,0.22)">Unsubscribe</a></p>
</body></html>`;
}
function buildShipmentDigestText(email, activeCount, alerts) {
    const lines = ['RISKSIM AI — SHIPMENT DIGEST', '', 'Your shipment update',
        `${activeCount} active shipments · ${alerts.length} new alerts`, ''];
    if (alerts.length) alerts.forEach(a => {
        lines.push(`[${a.severity}] ${a.title}`, a.description);
        if (a.action_recommended) lines.push('-> ' + a.action_recommended);
        lines.push('');
    }); else lines.push('No new alerts today.', '');
    lines.push('Open workspace: https://risksim.ai', '', '---',
        `Unsubscribe: https://risksim.ai/api/email/unsubscribe?email=${encodeURIComponent(email)}`);
    return lines.join('\n');
}
async function sendShipmentDigest(email) {
    const key = email.toLowerCase();
    const record = await getUserShipments(key);
    const alerts = await getUserAlerts(key);
    const active = (record && Array.isArray(record.shipments)) ? record.shipments.filter(isActiveShipment) : [];
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const newAlerts = alerts
        .filter(a => !a.resolved && a.timestamp >= dayAgo)
        .sort((a, b) => (ALERT_SEV_RANK[b.severity] || 0) - (ALERT_SEV_RANK[a.severity] || 0))
        .slice(0, 5);
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return await sendEmail(key, `Your shipment update — ${dateStr}`,
        buildShipmentDigestHtml(key, active.length, newAlerts),
        buildShipmentDigestText(key, active.length, newAlerts));
}
// Daily digest sweep — respects per-user pref + frequency, idempotent per day.
async function runDigestJob() {
    const summary = { candidates: 0, sent: 0, skipped: 0, errors: 0 };
    const emails = await listShipmentEmails();
    const today = new Date().toISOString().slice(0, 10);
    for (const email of emails) {
        try {
            const record = await getUserShipments(email);
            if (!record) continue;
            if (record.plan !== 'enterprise' || !record.opted_in) { summary.skipped++; continue; }
            const digest = record.digest || { enabled: true, frequency: 'daily' };
            if (!digest.enabled || digest.frequency === 'off') { summary.skipped++; continue; }
            if (digest.frequency === 'weekly' && new Date().getUTCDay() !== 1) { summary.skipped++; continue; }
            const active = (record.shipments || []).filter(isActiveShipment);
            if (!active.length) { summary.skipped++; continue; }
            summary.candidates++;
            if (redisAvailable) {
                try {
                    const set = await redisCmd(['SET', `digest:sent:${email}:${today}`, '1', 'NX', 'EX', '82800']);
                    if (set === null) { summary.skipped++; continue; }   // already sent today
                } catch (e) { /* idempotency check failed — send rather than silently skip */ }
            }
            const ok = await sendShipmentDigest(email);
            if (ok) summary.sent++; else { summary.errors++; }   // email failed — log via sendEmail, no retry
        } catch (e) { console.error('[Digest] job error for', email, '—', e.message); summary.errors++; }
    }
    console.log('[Digest] runDigestJob summary:', JSON.stringify(summary));
    return summary;
}

// ---- Part C: client-facing endpoints ----
const shipmentSyncLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 120,
    message: { error: 'Too many sync requests, please slow down.' }
});

// POST /api/shipments/sync — upsert a user's shipments, assign UUIDs, return id map for write-back.
app.post('/api/shipments/sync', shipmentSyncLimiter, async (req, res) => {
    try {
        const { email, plan, optedIn, profile, digest, shipments } = req.body;
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
        if (!Array.isArray(shipments)) return res.status(400).json({ error: 'shipments array required' });
        const key = email.toLowerCase();
        const existing = (await getUserShipments(key)) || { shipments: [] };
        const prevByTs = {};
        for (const s of (existing.shipments || [])) if (s.ts != null) prevByTs[s.ts] = s;

        const idMap = [];
        const merged = shipments.slice(0, 100).map(s => {
            const prev = prevByTs[s.ts] || {};
            const id = s.id || prev.id || randomUUID();
            idMap.push({ ts: s.ts, id });
            return {
                id, ts: s.ts || Date.now(),
                shipmentText: s.shipmentText || prev.shipmentText || '',
                data: s.data || prev.data || {},
                prevSeverity: prev.prevSeverity || (s.data && s.data.severity) || null,
                lastAnalyzedAt: prev.lastAnalyzedAt || null,
                notes: s.notes || [], timeline: s.timeline || [], alerts: s.alerts || []
            };
        });
        // Phase 3 hardening: authoritative plan from Shopify — the client-asserted `plan` is ignored.
        const verifiedPlan = await verifyShopifyPlan(key);
        const record = {
            email: key, updatedAt: Date.now(),
            plan: verifiedPlan,
            opted_in: optedIn != null ? !!optedIn : !!existing.opted_in,
            profile: profile || existing.profile || null,
            digest: digest || existing.digest || { enabled: true, frequency: 'daily' },
            shipments: merged
        };
        await setUserShipments(key, record);
        res.json({ success: true, count: merged.length, shipments: idMap });
    } catch (e) {
        console.error('[Shipments] sync error:', e.message);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// GET /api/alerts?email= — all alerts for a user (degrades to [] if Redis down).
app.get('/api/alerts', async (req, res) => {
    const email = (req.query.email || '').toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'email required' });
    const alerts = await getUserAlerts(email);
    res.json({ alerts });
});

// POST /api/alerts/resolve — mark an alert resolved.
app.post('/api/alerts/resolve', async (req, res) => {
    const email = (req.body.email || '').toLowerCase();
    const alertId = req.body.alert_id;
    if (!email || !email.includes('@') || !alertId) return res.status(400).json({ error: 'email and alert_id required' });
    const alerts = await getUserAlerts(email);
    let found = false;
    for (const a of alerts) if (a.id === alertId) { a.resolved = true; a.resolvedAt = Date.now(); found = true; }
    if (found) await setUserAlerts(email, alerts);
    res.json({ success: true, resolved: found });
});

// ---- Admin manual triggers (DATA_API_KEY) ----
app.post('/api/admin/run-analysis-job', requireDataKey, async (req, res) => {
    try { const summary = await runReanalysisJob(); res.json({ success: true, ...summary }); }
    catch (e) { console.error('[Job] run-analysis-job error:', e.message); res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/admin/send-test-digest', requireDataKey, async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase();
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'email required' });
        const ok = await sendShipmentDigest(email);
        res.json({ success: ok });
    } catch (e) { console.error('[Digest] send-test-digest error:', e.message); res.status(500).json({ success: false, error: e.message }); }
});
// Daily digest SWEEP for all eligible users — the cron-triggerable counterpart to the
// in-process poller (unreliable on Render free tier). Respects per-user pref/gating and
// the digest:sent:{email}:{date} idempotency lock. Returns summary counts only.
app.post('/api/admin/run-digest-job', requireDataKey, async (req, res) => {
    try { const summary = await runDigestJob(); res.json({ success: true, ...summary }); }
    catch (e) { console.error('[Digest] run-digest-job error:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ---- Scheduled poller (mirrors ALERT_POLLER_ENABLED). Env-gated + Redis day-lock so it
// runs at most once/day even across cold starts. For free-tier reliability, also point an
// external cron at the two /api/admin/* endpoints. ----
if (process.env.SHIPMENT_JOB_POLLER_ENABLED === 'true') {
    const REANALYSIS_HOUR = 4, DIGEST_HOUR = 10;   // UTC
    setInterval(async () => {
        try {
            if (!redisAvailable) return;
            const now = new Date(), hour = now.getUTCHours(), day = now.toISOString().slice(0, 10);
            if (hour === REANALYSIS_HOUR) {
                const lock = await redisCmd(['SET', `job:reanalysis:${day}`, '1', 'NX', 'EX', '82800']);
                if (lock !== null) { console.log('[Job] poller: running daily re-analysis'); await runReanalysisJob(); }
            }
            if (hour === DIGEST_HOUR) {
                const lock = await redisCmd(['SET', `job:digest:${day}`, '1', 'NX', 'EX', '82800']);
                if (lock !== null) { console.log('[Digest] poller: running daily digest'); await runDigestJob(); }
            }
        } catch (e) { console.error('[Job] poller error:', e.message); }
    }, 15 * 60 * 1000);   // every 15 minutes
    console.log('[Job] Shipment job poller enabled — re-analysis 04:00 UTC, digest 10:00 UTC');
}

app.listen(PORT, () => console.log(`RiskSim running on ${PORT}`));

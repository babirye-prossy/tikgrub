import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';
const cache = {};
const CACHE_TIMEOUT = 5 * 60 * 1000;

const log = (emoji, label, data) => {
    const time = new Date().toISOString();
    console.log(`[${time}] ${emoji} ${label}`, data !== undefined ? JSON.stringify(data) : '');
};

// ✅ HTTP server + WebSocket server sharing the same port
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ✅ Track connected clients per tiktokUrl
const clients = {};

wss.on('connection', (ws, req) => {
    const urlParam = new URL(req.url, `http://localhost`).searchParams.get('url');
    log('🔌', 'WebSocket connected', { url: urlParam });

    if (!urlParam) {
        ws.close(1008, 'Missing url param');
        return;
    }

    if (!clients[urlParam]) clients[urlParam] = new Set();
    clients[urlParam].add(ws);

    ws.on('close', () => {
        log('🔌', 'WebSocket disconnected', { url: urlParam });
        clients[urlParam]?.delete(ws);
        if (clients[urlParam]?.size === 0) delete clients[urlParam];
    });

    ws.on('error', (err) => {
        log('❌', 'WebSocket error', { error: err.message });
    });
});

// ✅ Broadcast to all clients watching a url
function broadcast(tiktokUrl, payload) {
    const connected = clients[tiktokUrl];
    if (!connected || connected.size === 0) return;
    const message = JSON.stringify(payload);
    connected.forEach(ws => {
        if (ws.readyState === 1) ws.send(message);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveRedirect(url) {
    try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        const clean = new URL(res.url);
        clean.search = '';
        log('🔗', 'Resolved URL', { from: url, to: clean.toString() });
        return clean.toString();
    } catch (err) {
        log('⚠️', 'Could not resolve redirect, using original URL', { url });
        return url;
    }
}

// ✅ Background poller — watches Apify and broadcasts over WebSocket
async function pollAndBroadcast(tiktokUrl, runId) {
    let status = 'RUNNING';

    while (status === 'RUNNING' || status === 'READY') {
        await sleep(4000);
        try {
            const statusRes = await fetch(
                `${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`
            );
            const statusJson = await statusRes.json();
            status = statusJson.data.status;

            log('📊', 'pollAndBroadcast status', { runId, status });

            if (status === 'FAILED' || status === 'TIMED-OUT' || status === 'ABORTED') {
                broadcast(tiktokUrl, { type: 'ERROR', message: `Apify run ${status}` });
                return;
            }

            if (status === 'SUCCEEDED') {
                const datasetRes = await fetch(
                    `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
                );
                const items = await datasetRes.json();

                if (items.length > 0) log('🔬', 'Sample raw item', items[0]);

                const allComments = items
                    .map(i => ({
                        text: i.text,
                        user: i.uniqueId || i.authorMeta?.name || i.author || 'anon'
                    }))
                    .filter(c => c.text);

                log('💬', 'Broadcasting comments', { count: allComments.length });

                // ✅ Broadcast all comments in one shot
                broadcast(tiktokUrl, {
                    type: 'COMMENTS',
                    comments: allComments,
                    progress: 100,
                    total: allComments.length
                });

                broadcast(tiktokUrl, { type: 'DONE', total: allComments.length });
                return;
            }
        } catch (err) {
            log('❌', 'Error in pollAndBroadcast', { error: err.message });
            broadcast(tiktokUrl, { type: 'ERROR', message: err.message });
            return;
        }
    }
}

app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// STEP 1: Trigger scraping
app.post('/collect', async (req, res) => {
    const { tiktokUrl } = req.body;
    if (!tiktokUrl) return res.status(400).json({ error: 'URL required' });

    const resolvedUrl = await resolveRedirect(tiktokUrl);
    log('📥', 'POST /collect received', { original: tiktokUrl, resolved: resolvedUrl });

    try {
        log('🚀', 'Triggering Apify scrape for', resolvedUrl);
        const runRes = await fetch(
            `${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postURLs: [resolvedUrl], commentsPerPost: 100 }),
            }
        );
        const runJson = await runRes.json();
        const runId = runJson.data?.id;

        if (!runId) {
            log('❌', 'Apify did not return a runId', runJson);
            return res.status(500).json({ error: 'Apify did not return a runId' });
        }

        log('✅', 'Apify run started', { runId });
        cache[tiktokUrl] = { runId, resolvedUrl, createdAt: Date.now() };

        // ✅ Start background WebSocket broadcaster
        broadcast(tiktokUrl, { type: 'SCRAPE_STARTED', runId });
        pollAndBroadcast(tiktokUrl, runId);

        setTimeout(() => {
            log('🗑️', 'Cache expired for', tiktokUrl);
            delete cache[tiktokUrl];
        }, CACHE_TIMEOUT);

        res.json({ runId, stage: 'collecting', progress: 0, eta: 10 });
    } catch (err) {
        log('❌', 'Error in /collect', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// STEP 2: REST fallback — unchanged, still works for polling
app.get('/comments', async (req, res) => {
    const { tiktokUrl } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    log('📥', 'GET /comments received', { tiktokUrl, page, limit });

    if (!tiktokUrl || !cache[tiktokUrl]) {
        log('⏳', 'No cache entry found for', tiktokUrl);
        return res.json({ comments: [], stage: 'waiting', progress: 0, eta: 0 });
    }

    const { runId, resolvedUrl } = cache[tiktokUrl];
    log('🔗', 'Using resolved URL for run', { resolvedUrl });

    try {
        const statusRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`
        );
        const statusJson = await statusRes.json();
        const status = statusJson.data.status;

        log('📊', 'Apify run status', { runId, status });

        if (status === 'READY' || status === 'RUNNING') {
            return res.json({ comments: [], stage: 'collecting', progress: 0, eta: 30 });
        }

        if (status === 'FAILED' || status === 'TIMED-OUT' || status === 'ABORTED') {
            return res.status(500).json({ error: `Apify run ${status}` });
        }

        const datasetRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
        );
        const items = await datasetRes.json();

        log('📦', 'Dataset fetched', { totalItems: items.length });
        if (items.length > 0) log('🔬', 'Sample raw item', items[0]);

        const allComments = items
            .map(i => ({
                text: i.text,
                user: i.uniqueId || i.authorMeta?.name || i.author || 'anon'
            }))
            .filter(c => c.text);

        const start = (page - 1) * limit;
        const end = start + limit;
        const pagedComments = allComments.slice(start, end);
        const progress = Math.min(100, Math.floor((end / allComments.length) * 100));
        const remaining = allComments.length - end;
        const eta = Math.ceil((remaining / limit) * 5);

        log('📤', 'Sending response', { page, returning: pagedComments.length, progress, total: allComments.length });

        res.json({ comments: pagedComments, stage: 'done', progress, eta: eta > 0 ? eta : 0 });

    } catch (err) {
        log('❌', 'Error in /comments', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ✅ server.listen instead of app.listen so WebSocket shares the same port
server.listen(PORT, () => log('🟢', `Server running on port ${PORT}`));

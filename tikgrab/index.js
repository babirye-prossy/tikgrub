import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';
const cache = {};
const CACHE_TIMEOUT = 5 * 60 * 1000;

// ✅ Simple logger helper
const log = (emoji, label, data) => {
    const time = new Date().toISOString();
    console.log(`[${time}] ${emoji} ${label}`, data !== undefined ? JSON.stringify(data) : '');
};

app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// STEP 1: Trigger scraping
app.post('/collect', async (req, res) => {
    const { tiktokUrl } = req.body;
    if (!tiktokUrl) return res.status(400).json({ error: 'URL required' });

    log('📥', 'POST /collect received', { tiktokUrl });

    try {
        log('🚀', 'Triggering Apify scrape for', tiktokUrl);
        const runRes = await fetch(
            `${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postURLs: [tiktokUrl], commentsPerPost: 100 }),
            }
        );
        const runJson = await runRes.json();
        const runId = runJson.data?.id;

        if (!runId) {
            log('❌', 'Apify did not return a runId', runJson);
            return res.status(500).json({ error: 'Apify did not return a runId' });
        }

        log('✅', 'Apify run started', { runId });
        cache[tiktokUrl] = { runId, createdAt: Date.now() };
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

// STEP 2: Fetch paginated comments
app.get('/comments', async (req, res) => {
    const { tiktokUrl } = req.query;

    // ✅ Parse page and limit as integers immediately — avoids string math bugs
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    log('📥', 'GET /comments received', { tiktokUrl, page, limit });

    if (!tiktokUrl || !cache[tiktokUrl]) {
        log('⏳', 'No cache entry found for', tiktokUrl);
        return res.json({ comments: [], stage: 'waiting', progress: 0, eta: 0 });
    }

    const { runId } = cache[tiktokUrl];

    try {
        log('🔍', 'Checking Apify run status', { runId });
        const statusRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`
        );
        const statusJson = await statusRes.json();
        const status = statusJson.data.status;

        log('📊', 'Apify run status', { runId, status });

        if (status === 'READY' || status === 'RUNNING') {
            log('⏳', 'Run still in progress, telling client to retry');
            return res.json({ comments: [], stage: 'collecting', progress: 0, eta: 30 });
        }

        if (status === 'FAILED' || status === 'TIMED-OUT' || status === 'ABORTED') {
            log('❌', 'Apify run failed', { status });
            return res.status(500).json({ error: `Apify run ${status}` });
        }

        log('✅', 'Apify run SUCCEEDED, fetching dataset', { runId });
        const datasetRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
        );
        const items = await datasetRes.json();

        log('📦', 'Dataset fetched', { totalItems: items.length });

        // ✅ Log the raw shape of the first item to find the real username field
        if (items.length > 0) {
            log('🔬', 'Sample raw item', items[0]);
        }

        const allComments = items
            .map(i => ({ text: i.text, user: i.user?.uniqueId || 'anon' }))
            .filter(c => c.text);

        log('💬', 'Comments after filtering', { count: allComments.length });

        const start = (page - 1) * limit;
        const end = start + limit;
        const pagedComments = allComments.slice(start, end);
        const progress = Math.min(100, Math.floor((end / allComments.length) * 100));
        const remaining = allComments.length - end;
        const eta = Math.ceil((remaining / limit) * 5);

        log('📤', 'Sending response', { page, returning: pagedComments.length, progress });

        res.json({
            comments: pagedComments,
            stage: 'done',
            progress,
            eta: eta > 0 ? eta : 0,
        });

    } catch (err) {
        log('❌', 'Error in /comments', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => log('🟢', `Server running on port ${PORT}`));

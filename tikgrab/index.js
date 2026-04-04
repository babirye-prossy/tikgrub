import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// In-memory cache for last run
const cache = {};

// Root
app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// Trigger scraping
app.post('/collect', async (req, res) => {
    const { tiktokUrl } = req.body;
    if (!tiktokUrl) return res.status(400).json({ error: 'URL required' });

    try {
        const runRes = await fetch(
            `${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postURLs: [tiktokUrl], commentsPerPost: 100 }),
            }
        );

        const runJson = await runRes.json();
        const runId = runJson.data.id;

        cache[tiktokUrl] = { runId };
        res.json({ runId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Paginated streaming comments
app.get('/comments', async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    const keys = Object.keys(cache);
    if (keys.length === 0) return res.json({ stage: "waiting", progress: 0, eta: 5, comments: [] });

    const last = cache[keys[keys.length - 1]];
    const runId = last.runId;

    try {
        const statusRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
        const statusJson = await statusRes.json();
        const runData = statusJson.data;
        const status = runData.status;

        let stage = "streaming";
        let progress = 50;
        let eta = 10;

        if (status === "SUCCEEDED") { stage = "done"; progress = 100; eta = 0; }
        else if (status === "RUNNING") { stage = "collecting"; progress = 30; eta = 10; }

        const datasetRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`);
        const items = await datasetRes.json();

        const allComments = items.map(i => ({
            text: i.text,
            user: i.user?.nickname || i.user?.uniqueId || 'anon'
        })).filter(c => c.text);

        const start = (page - 1) * limit;
        const end = start + limit;
        const pageData = allComments.slice(start, end);

        res.json({ stage, progress, eta, comments: pageData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// 🔥 In-memory cache
const cache = {};

// Root
app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// 🔥 STEP 1: Trigger scraping
app.post('/collect', async (req, res) => {
    const { tiktokUrl } = req.body;

    if (!tiktokUrl) {
        return res.status(400).json({ error: 'URL required' });
    }

    try {
        const runRes = await fetch(
            `${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    postURLs: [tiktokUrl],
                    commentsPerPost: 100
                }),
            }
        );

        const runJson = await runRes.json();
        const runId = runJson.data.id;

        // store mapping
        cache[tiktokUrl] = { runId };

        res.json({ runId });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔥 STEP 2: PAGINATED COMMENTS
app.get('/comments', async (req, res) => {

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    // For demo: use latest cached run
    const keys = Object.keys(cache);
    if (keys.length === 0) {
        return res.json({ comments: [] });
    }

    const last = cache[keys[keys.length - 1]];
    const runId = last.runId;

    try {
        const datasetRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
        );

        const items = await datasetRes.json();

        const allComments = items.map(i => ({
            text: i.text,
            user: i.user?.uniqueId || 'anon'
        })).filter(c => c.text);

        // 🔥 PAGINATION LOGIC
        const start = (page - 1) * limit;
        const end = start + limit;

        res.json({
            comments: allComments.slice(start, end)
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});

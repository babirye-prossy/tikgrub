import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// In-memory cache per URL
const cache = {};
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Root
app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// STEP 1: Trigger scraping
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

        // Cache run with timestamp
        cache[tiktokUrl] = { runId, createdAt: Date.now() };

        // Auto-clear cache after timeout
        setTimeout(() => delete cache[tiktokUrl], CACHE_TIMEOUT);

        res.json({ runId, stage: 'collecting', progress: 0, eta: 10 });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// STEP 2: Fetch paginated comments with progress
app.get('/comments', async (req, res) => {
    const { tiktokUrl, page = 1, limit = 10 } = req.query;

    if (!tiktokUrl || !cache[tiktokUrl]) {
        return res.json({ comments: [], stage: 'waiting', progress: 0, eta: 0 });
    }

    const { runId } = cache[tiktokUrl];

    try {
        const datasetRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
        );
        const items = await datasetRes.json();

        const allComments = items
            .map(i => ({ text: i.text, user: i.user?.uniqueId || 'anon' }))
            .filter(c => c.text);

        // Pagination
        const start = (page - 1) * limit;
        const end = start + parseInt(limit);
        const pagedComments = allComments.slice(start, end);

        // Progress estimation
        const progress = Math.min(100, Math.floor((end / allComments.length) * 100));
        const remaining = allComments.length - end;
        const eta = Math.ceil((remaining / limit) * 5); // 5 sec per page estimate

        res.json({
            comments: pagedComments,
            stage: progress >= 100 ? 'done' : 'collecting',
            progress,
            eta: eta > 0 ? eta : 0,
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Environment Variables - Removed OPENROUTER_KEY
const VERIFICATION_KEY = process.env.VERIFICATION_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

const APIFY_BASE = 'https://api.apify.com/v2';

app.get('/', (req, res) => {
    res.send('TikGrab Scraper is online. Use POST /collect');
});

app.post('/collect', async (req, res) => {
    console.log('--- New Scrape Request ---');
    const { tiktokUrl, verificationKey, maxComments = 5 } = req.body;

    if (verificationKey !== VERIFICATION_KEY) {
        console.error('Auth Failed');
        return res.status(401).json({ error: 'Invalid verification key' });
    }

    if (!tiktokUrl) {
        return res.status(400).json({ error: 'tiktokUrl is required' });
    }

    try {
        const limit = Math.min(Number(maxComments) || 5, 10);
        console.log(`Fetching ${limit} comments for: ${tiktokUrl}`);

        // STEP 1: Start Apify Actor
        const runRes = await fetch(`${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                postURLs: [tiktokUrl],
                commentsPerPost: limit,
                maxRepliesPerComment: 0
            }),
        });

        const runJson = await runRes.json();
        if (!runRes.ok) throw new Error(`Apify Error: ${runJson.error?.message || 'Start failed'}`);
        
        const runId = runJson.data.id;

        // STEP 2: Poll for completion
        let status = runJson.data.status;
        while (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'ABORTED') {
            await new Promise(r => setTimeout(r, 3000));
            const pollRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const pollData = await pollRes.json();
            status = pollData.data.status;
            console.log(`Scraper Status: ${status}`);
        }

        if (status !== 'SUCCEEDED') throw new Error(`Scraper status: ${status}`);

        // STEP 3: Get Items and Return Raw List
        const datasetRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=${limit}`);
        const items = await datasetRes.json();
        
        // Extract just the text and user info if needed
        const comments = items.map(i => ({
            text: i.text,
            user: i.user?.uniqueId || 'anonymous'
        })).filter(c => c.text);

        console.log(`Success! Returning ${comments.length} comments.`);
        
        // Returning a simple JSON object with a 'comments' array
        res.json({ comments });

    } catch (error) {
        console.error('Scrape Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server live on port ${PORT}`);
});

import express from 'express';
import fetch from 'node-fetch'; // Add this if you are on an older Node version

const app = express();
app.use(express.json());

// 1. Setup Port for Render
const PORT = process.env.PORT || 3000;

const VERIFICATION_KEY = process.env.VERIFICATION_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

const APIFY_BASE = 'https://api.apify.com/v2';

app.post('/collect', async (req, res) => {
    const { tiktokUrl, verificationKey, maxComments = 10 } = req.body;

    // Security Check
    if (verificationKey !== VERIFICATION_KEY) {
        return res.status(401).json({ error: 'Invalid verification key' });
    }

    try {
        const limit = Math.min(Number(maxComments) || 10, 10);

        // Start Apify Scraper
        const runRes = await fetch(`${APIFY_BASE}/acts/clockworks~tiktok-comments-scraper/runs?token=${APIFY_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postURLs: [tiktokUrl], commentsPerPost: limit })
        });
        
        const runJson = await runRes.json();
        const runId = runJson.data.id;

        // Poll for completion (Wait up to 2 mins)
        let status = runJson.data.status;
        while (status !== 'SUCCEEDED' && status !== 'FAILED') {
            await new Promise(r => setTimeout(r, 4000));
            const poll = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const pollData = await poll.json();
            status = pollData.data.status;
        }

        // Fetch Data & Run AI Analysis (Your existing logic here...)
        // ... (Keep your OpenRouter fetch logic) ...

        res.json({ analysis });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// CRITICAL: Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

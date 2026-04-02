import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Environment Variables
const VERIFICATION_KEY = process.env.VERIFICATION_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

const APIFY_BASE = 'https://api.apify.com/v2';

// 1. Home Route (To verify the server is up)
app.get('/', (req, res) => {
    res.send('TikGrab API is online. Send POST to /collect');
});

// 2. The Main Collector Route
app.post('/collect', async (req, res) => {
    console.log('--- New Request Received ---');
    const { tiktokUrl, verificationKey, maxComments = 5 } = req.body;

    // Security check
    if (verificationKey !== VERIFICATION_KEY) {
        console.error('Auth Failed: Invalid Key');
        return res.status(401).json({ error: 'Invalid verification key' });
    }

    if (!tiktokUrl) {
        return res.status(400).json({ error: 'tiktokUrl is required' });
    }

    try {
        const limit = Math.min(Number(maxComments) || 5, 10);
        console.log(`Scraping ${limit} comments from: ${tiktokUrl}`);

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
        if (!runRes.ok) throw new Error(`Apify Start Error: ${JSON.stringify(runJson)}`);
        
        const runId = runJson.data.id;
        console.log(`Apify Run Started: ${runId}`);

        // STEP 2: Poll for completion
        let status = runJson.data.status;
        while (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'ABORTED') {
            await new Promise(r => setTimeout(r, 3000));
            const pollRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            const pollData = await pollRes.json();
            status = pollData.data.status;
            console.log(`Current Status: ${status}`);
        }

        if (status !== 'SUCCEEDED') throw new Error(`Scraper finished with status: ${status}`);

        // STEP 3: Get the comments from Dataset
        const datasetRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=${limit}`);
        const items = await datasetRes.json();
        const comments = items.map(i => i.text).filter(Boolean);

        if (comments.length === 0) {
            return res.json({ analysis: [], message: 'No comments found' });
        }

        // STEP 4: AI Analysis via OpenRouter
        console.log(`Analyzing ${comments.length} comments...`);
        const prompt = `Analyze the sentiment of these TikTok comments. Return a JSON array of objects with "comment" and "analysis" (positive/negative/neutral). Return ONLY the JSON.
        Comments: ${JSON.stringify(comments)}`;

        const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'amazon/nova-lite-v1',
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        const orData = await orRes.json();
        const aiContent = orData.choices?.[0]?.message?.content || '[]';
        
        // Clean up AI response if it includes markdown
        const cleanJson = aiContent.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(cleanJson);

        console.log('Success!');
        res.json({ analysis });

    } catch (error) {
        console.error('Global Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server live on port ${PORT}`);
});

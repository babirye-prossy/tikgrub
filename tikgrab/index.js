import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(cors());
const server = createServer(app);

app.use(express.json());

const PORT = process.env.PORT || 10000;
const CACHE_TIMEOUT = 10 * 60 * 1000; // 10 min

// In-memory storage
const cache = {};
const clients = {};


const log = (emoji, label, data) => {
    const time = new Date().toISOString();
    console.log(`[${time}] ${emoji} ${label}`, data !== undefined ? JSON.stringify(data) : '');
};

// ✅ WebSocket server
const wss = new WebSocketServer({ server });

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
function broadcast(postUrl, payload) {
    const connected = clients[postUrl];
    if (!connected || connected.size === 0) return;
    const message = JSON.stringify(payload);
    connected.forEach(ws => {
        if (ws.readyState === 1) ws.send(message);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 🔥 Reddit scraper
async function fetchRedditComments(url) {
    const cleanUrl = url.split('?')[0];
    const jsonUrl = cleanUrl.endsWith('/')
        ? cleanUrl + '.json'
        : cleanUrl + '/.json';

    log('🌐', 'Fetching Reddit JSON', { jsonUrl });

const response = await fetch(jsonUrl, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }
});

    const data = await response.json();
    const commentsTree = data[1]?.data?.children || [];

    let extractedComments = [];

    function extract(list) {
        for (let item of list) {
            if (item.kind === "t1") {
                const c = item.data;

                if (c.body) {
                    extractedComments.push({
                        text: c.body,
                        user: c.author || 'anon',
                        score: c.score || 0
                    });
                }

                if (c.replies && c.replies.data) {
                    extract(c.replies.data.children);
                }
            }
        }
    }

    extract(commentsTree);

    return extractedComments;
}

app.get('/', (req, res) => {
    res.send('TrendPulse API is running');
});

// STEP 1: Trigger scraping
// 🚀 START SCRAPING
app.post('/collect', async (req, res) => {
    const { postUrl } = req.body;

    if (!postUrl) return res.status(400).json({ error: 'postUrl required' });
    

    log('📥', 'POST /collect', { postUrl });

    try {
        broadcast(postUrl, { type: 'SCRAPE_STARTED' });

        const comments = await fetchRedditComments(postUrl);

        cache[postUrl] = {
            comments,
            createdAt: Date.now()
        };

        broadcast(postUrl, {
            type: 'COMMENTS',
            comments,
            progress: 100,
            total: comments.length
        });

        broadcast(postUrl, {
            type: 'DONE',
            total: comments.length
        });

        setTimeout(() => {
            delete cache[postUrl];
            log('🗑️', 'Cache expired', { postUrl });
        }, CACHE_TIMEOUT);

        res.json({
            stage: 'done',
            total: comments.length,
            progress: 100
        });

    } catch (err) {
        log('❌', 'Scrape error', { error: err.message });

        broadcast(postUrl, {
            type: 'ERROR',
            message: err.message
        });

        res.status(500).json({ error: err.message });
    }
});

// STEP 2: REST fallback — unchanged, still works for polling
app.get('/comments', (req, res) => {
    const { postUrl } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    if (!postUrl || !cache[postUrl]) {
        return res.json({
            comments: [],
            stage: 'waiting',
            progress: 0
        });
    }

    const all = cache[postUrl].comments;

    const start = (page - 1) * limit;
    const end = start + limit;

    res.json({
        comments: all.slice(start, end),
        stage: 'done',
        progress: 100,
        total: all.length
    });
});

// ✅ server.listen instead of app.listen so WebSocket shares the same port
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 Server running on port ${PORT}`);
});

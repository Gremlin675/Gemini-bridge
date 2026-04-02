import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import cors from 'cors';

const PORT = 8765;
const HTTP_PORT = 8080;
const USAGE_FILE = 'usage_data.json';

// Add your Gemini API keys here. Multiple keys are load-balanced automatically.
const API_KEYS = [
    // "AIza...",
];

const MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-flash-lite-latest",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-image",
];

// Models that can only run in a browser client (no API key path).
const BROWSER_ONLY_MODELS = new Set(["gemini-3-pro-preview"]);

const pendingRequests = new Map();

// ---------------------------------------------------------------------------
// Usage Tracker — persists daily call counts and rate-limit state per key/model
// ---------------------------------------------------------------------------
class UsageTracker {
    constructor() {
        this.currentDate = new Date().toISOString().split('T')[0];
        this.data = this.loadUsageData();
    }

    loadUsageData() {
        try {
            if (fs.existsSync(USAGE_FILE)) {
                const loaded = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
                if (loaded.date === this.currentDate) return this.ensureStructure(loaded);
            }
        } catch (e) {
            console.error('Usage load error:', e);
        }
        return this.createEmptyStructure();
    }

    createEmptyStructure() {
        const structure = { date: this.currentDate, api_keys: {}, browser_clients: {} };
        API_KEYS.forEach(key => {
            structure.api_keys[key] = {};
            MODELS.forEach(m => {
                structure.api_keys[key][m] = { count: 0, exhausted: false, rate_limited_until: null };
            });
        });
        return structure;
    }

    ensureStructure(data) {
        API_KEYS.forEach(key => {
            if (!data.api_keys[key]) data.api_keys[key] = {};
            MODELS.forEach(m => {
                if (!data.api_keys[key][m])
                    data.api_keys[key][m] = { count: 0, exhausted: false, rate_limited_until: null };
            });
        });
        if (!data.browser_clients) data.browser_clients = {};
        return data;
    }

    saveUsageData() {
        fs.writeFileSync(USAGE_FILE, JSON.stringify(this.data, null, 2));
    }

    registerBrowserClient(clientId) {
        if (!this.data.browser_clients[clientId]) {
            this.data.browser_clients[clientId] = {};
            MODELS.forEach(m => {
                this.data.browser_clients[clientId][m] = { count: 0, exhausted: false, rate_limited_until: null };
            });
            this.saveUsageData();
        }
    }

    getBestResource(model) {
        let best = { type: null, id: null, count: Infinity };

        for (const clientId of browserConnections.keys()) {
            const mData = this.data.browser_clients[clientId]?.[model];
            if (mData && !mData.exhausted && (!mData.rate_limited_until || Date.now() > mData.rate_limited_until)) {
                if (mData.count < best.count) {
                    best = { type: 'browser', id: clientId, count: mData.count };
                }
            }
        }

        if (!BROWSER_ONLY_MODELS.has(model)) {
            for (const key of API_KEYS) {
                const mData = this.data.api_keys[key]?.[model];
                if (mData && !mData.exhausted && (!mData.rate_limited_until || Date.now() > mData.rate_limited_until)) {
                    if (mData.count < best.count) {
                        best = { type: 'api_key', id: key, count: mData.count };
                    }
                }
            }
        }

        return best.type ? best : null;
    }

    incrementUsage(type, id, model) {
        const target = type === 'browser' ? this.data.browser_clients[id] : this.data.api_keys[id];
        if (target?.[model]) {
            target[model].count++;
            this.saveUsageData();
        }
    }

    markRateLimited(type, id, model) {
        const target = type === 'browser' ? this.data.browser_clients[id] : this.data.api_keys[id];
        if (target?.[model]) {
            target[model].rate_limited_until = Date.now() + 60_000;
            this.saveUsageData();
        }
    }

    markExhausted(type, id, model) {
        const target = type === 'browser' ? this.data.browser_clients[id] : this.data.api_keys[id];
        if (target?.[model]) {
            target[model].exhausted = true;
            this.saveUsageData();
        }
    }
}

const tracker = new UsageTracker();
const browserConnections = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the model response contains a service error string. */
function responseHasError(text) {
    return text.includes('[503 Service Unavailable]');
}

// ---------------------------------------------------------------------------
// Core executor — routes a job to the best browser or API key, with failover.
// ---------------------------------------------------------------------------
async function executePrompt(params) {
    const { prompt, images, model, retryCount = 0 } = params;
    const MAX_RETRIES = 3;

    if (retryCount > MAX_RETRIES) {
        throw new Error(`Max retries (${MAX_RETRIES}) exceeded. All providers failed.`);
    }

    const resource = tracker.getBestResource(model);
    if (!resource) throw new Error('All resources for this model are exhausted or rate-limited.');

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // --- BROWSER PATH ---
    if (resource.type === 'browser') {
        const ws = browserConnections.get(resource.id);

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            tracker.markRateLimited('browser', resource.id, model);
            return executePrompt(params);
        }

        console.log(`[${jobId}] → Browser ${resource.id} (attempt ${retryCount + 1})`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.warn(`[${jobId}] Browser ${resource.id} timed out. Failing over...`);
                pendingRequests.delete(jobId);
                tracker.markRateLimited('browser', resource.id, model);
                executePrompt({ ...params, retryCount: retryCount + 1 }).then(resolve).catch(reject);
            }, 600_000); // 10 min — lower for faster failover

            pendingRequests.set(jobId, { resolve, reject, timeout, model, resource, params });

            const requestType = model === 'gemini-2.5-flash-image' ? 'image_request' : 'txt_request';
            ws.send(JSON.stringify({ type: requestType, job_id: jobId, prompt, images: images || [], model, client_id: resource.id }));
            tracker.incrementUsage('browser', resource.id, model);
        });
    }

    // --- API KEY PATH ---
    console.log(`[${jobId}] → API key ...${resource.id.slice(-4)} (attempt ${retryCount + 1})`);
    try {
        const genAI = new GoogleGenerativeAI(resource.id);
        const genModel = genAI.getGenerativeModel({ model });

        const contents = [];
        if (images) {
            images.forEach(img => contents.push({ inlineData: { mimeType: img.mime_type || 'image/jpeg', data: img.data } }));
        }
        contents.push({ text: prompt });

        const result = await genModel.generateContent(contents);
        tracker.incrementUsage('api_key', resource.id, model);

        const text = result.response.text();
        if (responseHasError(text)) throw new Error('Response contained a service error.');
        return text;

    } catch (error) {
        const msg = error.message || '';
        if (msg.includes('429') || msg.includes('quota') || msg.includes('exhausted')) {
            console.warn(`[${jobId}] API key rate-limited. Switching provider...`);
            tracker.markRateLimited('api_key', resource.id, model);
            return executePrompt({ ...params, retryCount: retryCount + 1 });
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// HTTP Server — OpenAI-compatible /v1/chat/completions endpoint
// ---------------------------------------------------------------------------
const app = express();
app.use(cors(), express.json({ limit: '50mb' }));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model: reqModel } = req.body;

        const fullPrompt = messages.map(m => {
            const role = m.role.toUpperCase();
            let text = '';
            if (typeof m.content === 'string') {
                text = m.content;
            } else if (Array.isArray(m.content)) {
                text = m.content.map(p => p.type === 'text' ? p.text : p.type === 'image_url' ? '[IMAGE]' : '').join('\n');
            }
            return `[${role}]:\n${text}`;
        }).join('\n\n---\n\n');

        const images = [];
        const lastMsg = messages[messages.length - 1];
        if (Array.isArray(lastMsg.content)) {
            lastMsg.content.forEach(p => {
                if (p.type === 'image_url') {
                    const [header, data] = p.image_url.url.split(',');
                    images.push({ data, mime_type: header.match(/:(.*?);/)[1] });
                }
            });
        }

        const model = reqModel || MODELS[0];
        const result = await executePrompt({ prompt: fullPrompt, images, model });

        res.status(200).json({
            id: `chatcmpl-${Math.random().toString(36).substring(7)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: reqModel,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: typeof result === 'string' ? result : JSON.stringify(result) },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });

    } catch (e) {
        res.status(503).json({ error: e.message });
    }
});

app.listen(HTTP_PORT,'127.0.0.1', () => console.log(`HTTP server on port ${HTTP_PORT}`));

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1',   maxPayload: 50 * 1024 * 1024 });

wss.on('connection', ws => {
    ws.on('message', async raw => {
        try {
            const data = JSON.parse(raw.toString());

            // Browser client registration
            if (data.type === 'browser') {
                ws.clientId = data.client_id || `br_${Date.now()}`;
                browserConnections.set(ws.clientId, ws);
                tracker.registerBrowserClient(ws.clientId);
                console.log(`Browser registered: ${ws.clientId}`);
                return;
            }

            // Browser reporting an error back to server
            if (data.type === 'error') {
                const pending = pendingRequests.get(data.job_id);
                if (!pending) return;

                clearTimeout(pending.timeout);
                pendingRequests.delete(data.job_id);

                const { resolve, reject, params, resource } = pending;
                console.warn(`[${data.job_id}] Error from browser ${resource.id}: [${data.error_type}] ${data.message}`);

                if (data.error_type === 'usage_limit') {
                    tracker.markExhausted('browser', resource.id, data.model || params.model);
                }

                if (data.error_type === 'internal' || data.error_type === 'other') {
                    const nextRetry = (params.retryCount || 0) + 1;
                    if (nextRetry <= 3) {
                        executePrompt({ ...params, retryCount: nextRetry }).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Browser error: ${data.message}`));
                    }
                } else {
                    reject(new Error(`Unhandled error type: ${data.error_type}`));
                }
                return;
            }

            // Browser returning a successful result
            if (data.type === 'txt_result' || data.type === 'image_result') {
                const pending = pendingRequests.get(data.job_id);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pending.resolve(data.text ?? data.image_data);
                    pendingRequests.delete(data.job_id);
                }
                return;
            }

            // Browser reporting quota exhaustion
            if (data.type === 'resource_exhausted') {
                tracker.markExhausted('browser', data.client_id, data.model);
                const pending = pendingRequests.get(data.job_id);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(data.job_id);
                    executePrompt({ ...pending.params, retryCount: (pending.params.retryCount || 0) + 1 })
                        .then(pending.resolve)
                        .catch(pending.reject);
                }
                return;
            }

            // Incoming request from a Python / external WS client
            if (data.type === 'txt_request' || data.type === 'image_request') {
                try {
                    const out = await executePrompt({
                        prompt: data.prompt,
                        images: data.images_base64 || [],
                        model: data.model || MODELS[0],
                    });
                    if (data.type === 'image_request') {
                        ws.send(JSON.stringify({ type: 'image_result', job_id: data.job_id, image_data: out }));
                    } else {
                        ws.send(JSON.stringify({ type: 'txt_result', job_id: data.job_id, text: out }));
                    }
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'error', job_id: data.job_id, message: e.message }));
                }
                return;
            }

        } catch (e) {
            console.error('WS message error:', e);
        }
    });

    ws.on('close', () => {
        if (ws.clientId) browserConnections.delete(ws.clientId);
    });
});

console.log(`WebSocket server on port ${PORT}`);
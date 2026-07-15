// WebRTC bring-up server for casting the WebGPU show to a display-only client (e.g. an Android TV
// whose WebView is too old for WebGPU). Renders NOTHING itself — it only:
//   1. Serves the built app (dist/) so a capable browser ON THIS MACHINE can run the real show as
//      the WebRTC *publisher* (`/?autostart=1&stream=1`).
//   2. Serves the thin receiver page (`/tv`) that the TV loads to play the remote track.
//   3. Relays WebRTC signaling (SDP + ICE) between the two over SSE + POST — no WebSocket dep,
//      nothing but Node's stdlib.
//
// Media itself never touches this server: once signaled, the publisher (Mac LAN IP) and the TV
// connect peer-to-peer over the LAN via host ICE candidates. Bind is 0.0.0.0 so the TV can reach
// it directly at http://<mac-lan-ip>:<port> (no adb tunnel; LAN has no client isolation).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8765);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// One SSE client per role, plus a buffer so a message sent before the peer connects is not lost.
const roles = { pub: null, tv: null };
const buffers = { pub: [], tv: [] };

function sseSend(role, obj) {
  const res = roles[role];
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  if (res) res.write(line);
  else buffers[role].push(line);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function serveStatic(req, res, urlPath) {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204).end(); return; }

  // ---- signaling: SSE subscribe ----
  if (path.startsWith('/sig/sub/')) {
    const role = path.slice('/sig/sub/'.length);
    if (role !== 'pub' && role !== 'tv') { res.writeHead(400).end(); return; }
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    roles[role] = res;
    for (const line of buffers[role].splice(0)) res.write(line);
    // A viewer appearing is the publisher's cue to (re)offer.
    if (role === 'tv') sseSend('pub', { type: 'viewer-ready' });
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); if (roles[role] === res) roles[role] = null; });
    return;
  }

  // ---- signaling: POST a message to the other peer ----
  if (path.startsWith('/sig/send/') && req.method === 'POST') {
    const target = path.slice('/sig/send/'.length); // 'pub' or 'tv' = recipient
    if (target !== 'pub' && target !== 'tv') { res.writeHead(400).end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { sseSend(target, JSON.parse(body)); } catch {} cors(res); res.writeHead(204).end(); });
    return;
  }

  // ---- receiver page ----
  if (path === '/tv' || path === '/tv.html') {
    try {
      const html = await readFile(join(ROOT, 'server', 'tv.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch { res.writeHead(404).end('tv.html missing'); }
    return;
  }

  // ---- static app (publisher) ----
  await serveStatic(req, res, path);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`stream server on http://0.0.0.0:${PORT}`);
  console.log(`  publisher: http://localhost:${PORT}/?autostart=1&stream=1`);
  console.log(`  tv:        http://<host-lan-ip>:${PORT}/tv`);
  advertiseMdns(PORT);
});

// mDNS / DNS-SD advertisement so receivers (e.g. the Android app) can auto-discover the host
// instead of the user typing its ip:port. Node has no built-in mDNS; rather than add a dependency
// we drive the OS responder that's already present: `dns-sd` (macOS/Bonjour) or
// `avahi-publish-service` (Linux). Service type `_firewrks._tcp`, TXT `path=/tv`. If neither tool
// exists, discovery is simply unavailable and the receiver falls back to manual entry.
function advertiseMdns(port) {
  const attempts = [
    { cmd: 'dns-sd', args: ['-R', 'firewrks', '_firewrks._tcp', 'local', String(port), 'path=/tv'] },
    { cmd: 'avahi-publish-service', args: ['firewrks', '_firewrks._tcp', String(port), 'path=/tv'] },
  ];
  for (const { cmd, args } of attempts) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => {}); // ENOENT -> tool absent; try the next / give up silently
      child.on('spawn', () => console.log(`  mDNS:      advertising _firewrks._tcp via ${cmd}`));
      const stop = () => { try { child.kill(); } catch {} };
      process.on('exit', stop);
      process.on('SIGINT', () => { stop(); process.exit(0); });
      process.on('SIGTERM', () => { stop(); process.exit(0); });
      return; // first tool that spawns wins
    } catch { /* try next */ }
  }
}

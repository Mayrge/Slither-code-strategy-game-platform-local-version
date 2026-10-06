import http from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createAgentKit } from './agent-sandbox/package-kit.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const exportRoot = resolve(root, 'exports');
const port = Number(process.env.PORT || 3080);
const instance = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT需要是0～65535之间的整数。');
  process.exit(1);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.zip': 'application/zip' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ app: 'snake-arena', version: 1, instance })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent-kit') {
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { res.writeHead(403); res.end('Origin not allowed'); return; }
      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-snake-arena-agent-kit.zip`;
      await mkdir(exportRoot, { recursive: true });
      await writeFile(resolve(exportRoot, filename), await createAgentKit(root), { flag: 'wx' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ filename, url: '/exports/' + encodeURIComponent(filename) })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/exports') {
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { res.writeHead(403); res.end('Origin not allowed'); return; }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) { res.writeHead(413); res.end('Export too large'); return; }
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
      if (typeof data.content !== 'string' || Buffer.byteLength(data.content, 'utf8') > 20 * 1024 * 1024) { res.writeHead(400); res.end('Invalid export'); return; }
      let name = String(data.name || 'snake-arena.json').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120);
      if (!['.json', '.js', '.mjs', '.txt'].includes(extname(name).toLowerCase())) name += '.txt';
      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`;
      const exportPath = resolve(exportRoot, filename);
      if (!exportPath.startsWith(exportRoot + sep)) { res.writeHead(400); res.end('Invalid filename'); return; }
      await mkdir(exportRoot, { recursive: true });
      await writeFile(exportPath, data.content, { encoding: 'utf8', flag: 'wx' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ filename, url: '/exports/' + encodeURIComponent(filename) })); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method not allowed'); return; }
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.slice(root.length + 1).replaceAll('\\', '/');
    const isExport = /^exports\/[^/]+\.(json|js|mjs|txt|zip)$/i.test(relative);
    const allowed = relative === 'index.html' || relative === 'README.md' || relative === 'RULES.md' || /^(src|strategies)\//.test(relative) || isExport;
    if (!path.startsWith(root + sep) || !allowed || !(await stat(path)).isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(isExport ? { 'Content-Disposition': `attachment; filename="snake-arena${extname(path)}"; filename*=UTF-8''${encodeURIComponent(relative.split('/').pop())}` } : {}),
      'Content-Security-Policy': `default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${relative === 'index.html' ? "'self'" : "'none'"}; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});
function openBrowser(address) {
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${address}'`], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.error(`请在浏览器打开：${address}`));
  }
}

async function isThisArena(candidate) {
  try {
    const response = await fetch(`http://127.0.0.1:${candidate}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const health = await response.json();
    return health.app === 'snake-arena' && health.instance === instance;
  } catch { return false; }
}

function listen(candidate) {
  return new Promise((resolveListen, reject) => {
    const cleanUp = () => { server.off('error', onError); server.off('listening', onListening); };
    const onError = error => { cleanUp(); reject(error); };
    const onListening = () => { cleanUp(); resolveListen(server.address().port); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(candidate, '127.0.0.1');
  });
}

async function start() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = port === 0 ? 0 : port + attempt;
    if (candidate > 65535) break;
    try {
      const actualPort = await listen(candidate);
      const address = `http://127.0.0.1:${actualPort}`;
      console.log(`Snake Arena: ${address}`);
      console.log('竞技台已启动。关闭此窗口会停止本次启动的服务。');
      server.on('error', error => console.error(error.message));
      openBrowser(address); return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (await isThisArena(candidate)) {
        const address = `http://127.0.0.1:${candidate}`;
        console.log(`Snake Arena already running: ${address}`);
        console.log('竞技台已经在运行，直接打开已有页面。');
        openBrowser(address); return;
      }
      console.log(`端口${candidate}被其他程序占用，正在尝试下一个端口。`);
    }
  }
  throw new Error('未找到可用端口，请稍后重试或设置其他PORT。');
}

start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

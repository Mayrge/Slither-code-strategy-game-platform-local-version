import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import http from 'node:http';

function launch(port = '0') {
  return spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function addressOf(process) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error('Server did not start')); }, 10000);
    const onData = chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { cleanUp(); resolve(match[0]); }
    };
    const onExit = code => { cleanUp(); reject(new Error(`Server exited before starting: ${code}`)); };
    const onError = error => { cleanUp(); reject(error); };
    const cleanUp = () => { clearTimeout(timer); process.stdout.off('data', onData); process.off('exit', onExit); process.off('error', onError); };
    process.stdout.on('data', onData); process.once('exit', onExit); process.once('error', onError);
  });
}

test('local server protects unrelated files and saves downloadable UTF-8 exports', async () => {
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
      server.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      server.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const page = await fetch(address);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Snake Arena/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(address + '/package.json')).status, 404);
    assert.equal((await fetch(address + '/.video-review/read-subtitles.ps1')).status, 404);
    const script = await fetch(address + '/src/strategy-worker.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-security-policy'), /connect-src 'none'/);
    const content = JSON.stringify({ name: '测试策略', body: [[1, 2]], text: '<script>&+% 中文' });
    const saved = await fetch(address + '/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '比赛回放.json', content }) });
    assert.equal(saved.status, 200);
    const { url, filename } = await saved.json();
    const exportFile = new URL('../exports/' + encodeURIComponent(filename), import.meta.url);
    const attachment = await fetch(address + url);
    assert.equal(attachment.status, 200);
    assert.match(attachment.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await attachment.text(), content);
    assert.match(attachment.headers.get('content-type'), /application\/json/);
    assert.equal(await readFile(exportFile, 'utf8'), content);
    await unlink(exportFile);
    const blocked = await fetch(address + '/api/exports', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'blocked.txt', content: '' }) });
    assert.equal(blocked.status, 403);
    const kitResponse = await fetch(address + '/api/agent-kit', { method: 'POST' });
    assert.equal(kitResponse.status, 200);
    const kit = await kitResponse.json();
    const zip = await fetch(address + kit.url);
    assert.equal(zip.status, 200); assert.match(zip.headers.get('content-type'), /application\/zip/);
    assert.match(zip.headers.get('content-disposition'), /^attachment;/);
    assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    await unlink(new URL('../exports/' + encodeURIComponent(kit.filename), import.meta.url));
    assert.equal((await fetch(address + '/api/agent-kit', { method: 'POST', headers: { Origin: 'https://unrelated.example' } })).status, 403);
  } finally { server.kill(); }
});

test('starting twice reuses the same arena without stopping the first service', async () => {
  const first = launch();
  let second;
  try {
    const address = await addressOf(first);
    const health = await (await fetch(address + '/api/health')).json();
    assert.equal(health.app, 'snake-arena');
    second = launch(new URL(address).port);
    let output = '';
    second.stdout.on('data', chunk => { output += chunk.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { second.kill(); reject(new Error('Repeated launch did not exit')); }, 5000);
      second.once('exit', code => { clearTimeout(timer); resolve(code); });
      second.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(exitCode, 0);
    assert.match(output, /Snake Arena already running:/);
    assert.ok(output.includes(address));
    assert.equal((await fetch(address)).status, 200);
  } finally { first.kill(); second?.kill(); }
});

test('an unrelated occupied port is preserved and the arena selects another port', async () => {
  const unrelated = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ app: 'snake-arena', instance: 'another-project' })); });
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  const occupiedPort = unrelated.address().port;
  const arena = launch(occupiedPort);
  try {
    const address = await addressOf(arena);
    assert.notEqual(Number(new URL(address).port), occupiedPort);
    assert.equal((await fetch(address)).status, 200);
    const original = await (await fetch(`http://127.0.0.1:${occupiedPort}/api/health`)).json();
    assert.equal(original.instance, 'another-project');
  } finally { arena.kill(); unrelated.closeAllConnections(); await new Promise(resolve => unrelated.close(resolve)); }
});

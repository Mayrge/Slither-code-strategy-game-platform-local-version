import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { AgentArena, coordinateFrame, BLANK_MAP, validateMap } from '../agent-sandbox/environment.mjs';
import { createAgentKit } from '../agent-sandbox/package-kit.mjs';
import { SnakeGame, makeRandom } from '../src/engine.js';
import { validateReplay } from '../src/replay.js';

const straight = 'export default s => s.snakes.find(p => p.id === s.you).direction;';
const players = [{ id: 1, name: 'Agent', source: straight }, { id: 2, name: '对手', source: straight }];
const cli = new URL('../agent-sandbox/arena.mjs', import.meta.url);
function command(args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(cli), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI未能及时结束')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
    child.stdin.end(input || '');
  });
}
async function cleanup(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir(), 'snake-agent-')));
  await rm(directory, { recursive: true, force: true });
}
test('blank map starts without a saved roster and manual turns match the official referee', async () => {
  assert.deepEqual([BLANK_MAP.walls, BLANK_MAP.snakes, BLANK_MAP.food], [[], [], []]);
  assert.throws(() => validateMap({ ...BLANK_MAP, maxTurns: 100 }), /规则/);
  const arena = new AgentArena(players, { seed: 'PARITY', recordReplay: true });
  const reference = new SnakeGame(players, { seed: 'PARITY', foodTarget: 60 });
  try {
    assert.deepEqual(arena.state(), coordinateFrame(reference.snapshot()));
    while (!reference.done) {
      const actions = Object.fromEntries(reference.snakes.filter(p => p.alive).map(p => [p.id, p.direction]));
      reference.step(actions); const actual = await arena.step(actions);
      assert.deepEqual(actual.state, coordinateFrame(reference.snapshot()));
    }
    assert.equal(validateReplay(arena.replay()).frames.length, reference.turn + 1);
  } finally { await arena.close(); }
});
test('strategy workers have per-player module memory and the official seeded random stream', async () => {
  const source = 'let count=0; export default s => { count++; const me=s.snakes.find(p=>p.id===s.you); return Math.random()<0.5?"left":"right"; };';
  const arena = new AgentArena(players.map(p => ({ ...p, source })), { seed: 'SEEDED' });
  try {
    const first = await arena.step();
    for (const player of players) assert.equal(first.actions[player.id].direction, makeRandom('SEEDED:' + player.id)() < .5 ? 'left' : 'right');
    const memory = 'let n=0; export default s=>{ n++;return n===1?s.snakes.find(p=>p.id===s.you).direction:"left"; };';
    for (let game = 0; game < 2; game++) {
      const reset = new AgentArena(players.map(p => ({ ...p, source: memory })), { seed: 'MEMORY' });
      try { const initial = reset.state(); const turn = await reset.step(); for (const p of initial.snakes) assert.equal(turn.actions[p.id].direction, p.direction); }
      finally { await reset.close(); }
    }
  } finally { await arena.close(); }
});
test('bad exports, strategy errors, invalid outputs and infinite decisions are diagnosed without hanging', async () => {
  for (const [source, reason] of [
    ['export const unrelated=1;', '代码加载失败'],
    ['export default () => { throw new Error("具体错误"); };', '策略异常'],
    ['export default () => "not-a-direction";', '输出无效'],
    ['export default () => { while(true){} };', '决策超时']
  ]) {
    const arena = new AgentArena([{ ...players[0], source }, players[1]]);
    try { const turn = await arena.step(); assert.equal(turn.state.snakes.find(p => p.id === 1).deathReason, reason); if (reason === '策略异常') assert.match(turn.diagnostics[1].detail, /具体错误/); }
    finally { await arena.close(); }
  }
});
test('batch CLI records every turn, balances positions, inspects coordinates and exports valid replays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snake-agent-cli-'));
  try {
    const source = join(directory, 'strategy with spaces.js'); await writeFile(source, 'console.log("strategy log noise");\n' + straight);
    const out = join(directory, 'results');
    const run = await command(['run', '--strategy', source, '--opponents', source + ',' + source, '--games', '4', '--seed', 'CLI-TEST', '--out', out, '--replays']);
    assert.equal(run.code, 0, run.stderr); const summary = JSON.parse(run.stdout);
    assert.equal(summary.completedGames, 6); assert.equal(summary.ranked, false);
    const lines = (await readFile(join(out, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, summary.matches.reduce((total, g) => total + g.turns + 1, 0));
    const positions = [[], [], []];
    for (const g of summary.matches) g.order.forEach((id, i) => { positions[id - 1].push((i + g.rotation) % 3); });
    for (const list of positions) for (const pos of [0, 1, 2]) assert.equal(list.filter(p => p === pos).length, 2);
    const inspected = await command(['inspect', '--trace', join(out, 'trace.jsonl'), '--game', '1', '--turn', '1', '--player', '1']);
    assert.equal(inspected.code, 0, inspected.stderr); const turn = JSON.parse(inspected.stdout);
    assert.equal(turn.inputTurn, 0); assert.equal(turn.observation.you, 1); assert.equal(turn.state.food[0].length, 2);
    assert.equal(validateReplay(JSON.parse(await readFile(join(out, 'replays/game-1.json'), 'utf8'))).frames.at(-1).done, true);
    const overwrite = await command(['run', '--strategy', source, '--games', '2', '--out', out]); assert.notEqual(overwrite.code, 0);
  } finally { await cleanup(directory); }
});
test('JSONL interactive API observes, steps, streams turns, resets and recovers from invalid commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snake-agent-serve-'));
  try {
    const source = join(directory, 'strategy.js'); await writeFile(source, straight);
    const requests = [{ id: 1, cmd: 'observe', player: 1 }, { id: 2, cmd: 'step' }, { id: 3, cmd: 'run', turns: 2 }, { id: 4, cmd: 'invalid' }, { id: 5, cmd: 'reset', seed: 'OTHER' }, { id: 6, cmd: 'close' }];
    const result = await command(['serve', '--strategy', source, '--opponents', source], requests.map(r => JSON.stringify(r)).join('\n'));
    assert.equal(result.code, 0, result.stderr); const responses = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(responses[0].type, 'ready'); assert.equal(responses.find(r => r.requestId === 1).result.you, 1);
    assert.equal(responses.find(r => r.requestId === 2).result.turn, 1);
    assert.equal(responses.filter(r => r.requestId === 3 && r.type === 'turn').length, 2);
    assert.equal(responses.find(r => r.requestId === 4).ok, false);
    assert.equal(responses.find(r => r.requestId === 5).result.turn, 0); assert.equal(responses.at(-1).type, 'closed');
  } finally { await cleanup(directory); }
});
test('download ZIP contains a self-contained environment, blank map, prompts and all ten examples', async () => {
  const zip = await createAgentKit(), entries = new Map();
  let position = 0;
  while (zip.readUInt32LE(position) === 0x04034b50) {
    const size = zip.readUInt32LE(position + 18), length = zip.readUInt16LE(position + 26), extra = zip.readUInt16LE(position + 28);
    const name = zip.subarray(position + 30, position + 30 + length).toString();
    const offset = position + 30 + length + extra;
    entries.set(name, inflateRawSync(zip.subarray(offset, offset + size)).toString()); position = offset + size;
  }
  for (const path of ['PROMPT.md', 'CONTESTANT-PROMPT.md', 'README.md', 'blank-map.json', 'strategy.js', 'package.json', 'agent-sandbox/arena.mjs', 'agent-sandbox/worker.mjs', 'src/engine.js', 'src/replay.js', 'src/tournament.js']) assert.ok(entries.has('snake-agent-kit/' + path), path);
  assert.equal([...entries.keys()].filter(p => /strategies\/examples\/.*\.js$/.test(p)).length, 10);
  assert.equal(JSON.parse(entries.get('snake-agent-kit/package.json')).type, 'module');
  assert.equal(validateMap(JSON.parse(entries.get('snake-agent-kit/blank-map.json'))).foodTarget, 60);
  assert.equal(entries.get('snake-agent-kit/src/engine.js'), await readFile(new URL('../src/engine.js', import.meta.url), 'utf8'));
  assert.match(entries.get('snake-agent-kit/PROMPT.md'), /summary.json/);
  assert.equal([...entries.keys()].some(path => /src\/(app|players|ranking)|exports\//.test(path)), false);
});

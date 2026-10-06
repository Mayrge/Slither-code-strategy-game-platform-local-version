import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentArena, BLANK_MAP, validateMap } from './environment.mjs';
import { makeSchedule } from '../src/tournament.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function argumentsOf(args) {
  const result = { command: args[0] || 'help' };
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('未知参数：' + args[i]);
    const key = args[i].slice(2);
    if (key === 'replays') result[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数缺少值：' + args[i]); result[key] = args[++i]; }
  }
  const allowed = { run: ['strategy', 'opponents', 'name', 'games', 'seed', 'out', 'map', 'replays'], serve: ['strategy', 'opponents', 'name', 'seed', 'map'], inspect: ['trace', 'game', 'turn', 'player'], help: [] }[result.command];
  if (!allowed) throw new Error('命令只支持run、serve、inspect和help');
  for (const key of Object.keys(result).filter(k => k !== 'command')) if (!allowed.includes(key)) throw new Error('该命令不支持参数：--' + key);
  return result;
}
function integer(value, fallback, min, max, label) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + '需要是' + min + '～' + max + '的整数');
  return n;
}
async function inputs(args) {
  if (!args.strategy) throw new Error('请提供--strategy strategy.js');
  const paths = [args.strategy, ...(args.opponents ? args.opponents.split(',').filter(Boolean) : [resolve(root, 'strategies/examples/02-glacier.js')])];
  if (paths.length < 2 || paths.length > 10) throw new Error('测试需要自己的策略加1～9个对手');
  const players = await Promise.all(paths.map(async (path, index) => ({ id: index + 1, name: (index === 0 ? args.name || '待测试策略' : basename(path)).slice(0, 24), source: await readFile(resolve(path), 'utf8') })));
  const map = args.map ? JSON.parse(await readFile(resolve(args.map), 'utf8')) : BLANK_MAP;
  validateMap(map); return { players, map };
}
async function run(args) {
  const { players, map } = await inputs(args);
  const requested = integer(args.games, 10, 1, 1000, '局数');
  const count = Math.ceil(requested / players.length) * players.length;
  if (count > 1000) throw new Error('补齐完整位置轮换后超过1000局，请减少请求局数');
  const seed = args.seed || 'AGENT-' + randomUUID();
  const directory = resolve(args.out || 'runs/run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6));
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Existing reports are never silently overwritten.
  const trace = await open(resolve(directory, 'trace.jsonl'), 'wx');
  const schedule = makeSchedule(players, count, seed), byId = new Map(players.map(p => [p.id, p]));
  const stats = players.map(p => ({ id: p.id, name: p.name, games: 0, points: 0, score: 0, wins: 0, alive: 0, deaths: {}, maxExecutionMs: 0 }));
  const matches = [];
  if (args.replays) await mkdir(resolve(directory, 'replays'));
  try {
    for (const entry of schedule) {
      const arena = new AgentArena(entry.order.map(id => byId.get(id)), { map, seed: entry.seed, rotation: entry.rotation, recordReplay: Boolean(args.replays) });
      try {
        await trace.write(JSON.stringify({ game: entry.round, ...arena.record(), kind: 'initial' }) + '\n');
        await arena.initialize();
        while (!arena.game.done) {
          const record = await arena.step();
          await trace.write(JSON.stringify({ game: entry.round, ...record, kind: 'step' }) + '\n');
          for (const stat of stats) stat.maxExecutionMs = Math.max(stat.maxExecutionMs, record.diagnostics[stat.id]?.elapsedMs || 0);
        }
        const result = arena.record().results;
        for (const s of result) {
          const stat = stats.find(p => p.id === s.id);
          stat.games++; stat.points += s.points; stat.score += s.score; stat.wins += s.rank === 1 ? 1 : 0; stat.alive += s.alive ? 1 : 0;
          if (!s.alive) stat.deaths[s.deathReason] = (stat.deaths[s.deathReason] || 0) + 1;
        }
        matches.push({ ...entry, turns: arena.game.turn, results: result });
        if (args.replays) await writeFile(resolve(directory, 'replays/game-' + entry.round + '.json'), JSON.stringify(arena.replay()), { flag: 'wx' });
      } finally { await arena.close(); }
    }
  } finally { await trace.close(); }
  const summary = { format: 'snake-agent-report', version: 1, seed, requestedGames: requested, completedGames: count, config: validateMap(map), players: stats.map(s => ({ ...s, averagePoints: s.points / s.games, averageScore: s.score / s.games, winRate: s.wins / s.games, survivalRate: s.alive / s.games })), matches, trace: resolve(directory, 'trace.jsonl'), directory, ranked: false };
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  return summary;
}
async function inspect(args) {
  if (!args.trace) throw new Error('请提供--trace runs/某次测试/trace.jsonl');
  const game = integer(args.game, 1, 1, 1000, '局号'), turn = integer(args.turn, 0, 0, 500, '回合');
  const player = args.player == null ? null : integer(args.player, 1, 1, 10, '选手ID');
  const stream = createReadStream(resolve(args.trace), { encoding: 'utf8' }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.game !== game || record.turn !== turn) continue;
      if (player != null) {
        if (!record.state.snakes.some(s => s.id === player)) throw new Error('该局没有此选手');
        record.observation = { turn, width: record.config.width, height: record.config.height, maxTurns: record.config.maxTurns, remainingTurns: record.config.maxTurns - turn, seed: record.seed, you: player, food: record.state.food,
          snakes: record.state.snakes.map(({ color, deathReason, ...s }) => s) };
      }
      return record;
    }
    throw new Error('未找到该回合；所有蛇提前死亡时，不会生成后续回合');
  } finally { lines.close(); stream.destroy(); }
}
async function serve(args) {
  const { players, map } = await inputs(args);
  let arena = new AgentArena(players, { map, seed: args.seed || 'AGENT-STEP' });
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  send({ ok: true, type: 'ready', ...arena.record() });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
        let result;
        if (request.cmd === 'observe') result = request.player == null ? arena.record() : arena.observation(integer(request.player, 1, 1, 10, '选手ID'));
        else if (request.cmd === 'step') result = await arena.step(request.actions);
        else if (request.cmd === 'run') {
          const count = integer(request.turns, 500, 1, 500, '推进回合数');
          for (let i = 0; i < count && !arena.game.done; i++) send({ ok: true, requestId: request.id ?? null, type: 'turn', ...await arena.step() });
          result = arena.record();
        } else if (request.cmd === 'reset') {
          const rotation = integer(request.rotation, 0, 0, players.length - 1, '出生位置轮换');
          await arena.close(); arena = new AgentArena(players, { map, seed: String(request.seed || args.seed || 'AGENT-STEP'), rotation }); result = arena.record();
        } else if (request.cmd === 'close') { send({ ok: true, requestId: request.id ?? null, type: 'closed' }); break; }
        else throw new Error('cmd支持observe、step、run、reset、close');
        send({ ok: true, requestId: request.id ?? null, type: 'result', result });
      } catch (error) { send({ ok: false, requestId: request?.id ?? null, error: error.message }); }
    }
  } finally { lines.close(); await arena.close(); }
}

const help = `Snake Arena · AI agent空白测试环境（Node.js 20+，无依赖）
批量测试：node agent-sandbox/arena.mjs run --strategy strategy.js --games 10 --seed CHECK-A --out runs/v1 --replays
指定对手：追加 --opponents strategies/examples/02-glacier.js,strategies/examples/03-coral.js
查看回合：node agent-sandbox/arena.mjs inspect --trace runs/v1/trace.jsonl --game 1 --turn 10 --player 1
逐步交互：node agent-sandbox/arena.mjs serve --strategy strategy.js --seed CHECK-A
空白地图：可追加 --map blank-map.json。仅为测试，不写入竞技台赛程或排行榜。
批量局数自动补齐完整出生位置轮换；stdout为JSON，回合记录为JSONL，选手1是你的策略。
serve每行接收一个JSON：{"cmd":"observe","player":1}、{"cmd":"step"}、{"cmd":"run","turns":10}、{"cmd":"reset","seed":"OTHER"}、{"cmd":"close"}。
`;
try {
  const args = argumentsOf(process.argv.slice(2));
  if (args.command === 'help') process.stdout.write(help);
  else if (args.command === 'serve') await serve(args);
  else process.stdout.write(JSON.stringify(await (args.command === 'run' ? run(args) : inspect(args))) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }

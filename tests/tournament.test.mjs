import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSchedule, filterGames, tournamentMetadata } from '../src/tournament.js';
import { packReplay, unpackReplay } from '../src/tournament-store.js';
import { SnakeGame } from '../src/engine.js';
import { makeReplay, validateReplay } from '../src/replay.js';

test('50, 100 and 500-game schedules balance every player across all spawn positions', () => {
  for (const n of [2, 3, 6, 10]) for (const count of [50, 100, 500, 1000]) {
    const players = Array.from({ length: n }, (_, i) => ({ id: i + 11 }));
    const schedule = makeSchedule(players, count, 'FAIR-CUP');
    assert.equal(schedule.length, count);
    const positions = new Map(players.map(p => [p.id, Array(n).fill(0)]));
    const seeds = new Set();
    for (let offset = 0; offset < count; offset += n) {
      const group = schedule.slice(offset, offset + n);
      assert.equal(new Set(group.map(g => g.seed)).size, 1);
      assert.equal(new Set(group.map(g => g.rotation)).size, group.length);
      assert.equal(new Set(group.map(g => g.order.join(','))).size, 1);
      assert.equal(group[0].seed.length <= 64, true);
      seeds.add(group[0].seed);
      for (const g of group) g.order.forEach((id, index) => positions.get(id)[(index + g.rotation) % n]++);
    }
    assert.equal(seeds.size, Math.ceil(count / n));
    for (const counts of positions.values()) {
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
      assert.equal(counts.reduce((a, b) => a + b), count);
    }
  }
});

test('random arrangements reproduce from the master seed and keep identical initial food within a cycle', () => {
  const players = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: String(i) }));
  const schedule = makeSchedule(players, 50, 'CUP-A');
  assert.deepEqual(schedule, makeSchedule(players, 50, 'CUP-A'));
  assert.notDeepEqual(schedule, makeSchedule(players, 50, 'CUP-B'));
  assert.ok(new Set(schedule.map(g => g.order.join(','))).size > 1);
  const byId = new Map(players.map(p => [p.id, p]));
  const foods = schedule.slice(0, 10).map(g => new SnakeGame(g.order.map(id => byId.get(id)), g).snapshot().food);
  for (const food of foods) assert.deepEqual(food, foods[0]);
  for (const count of [0, 1.5, 1001, NaN]) assert.throws(() => makeSchedule(players, count, 'X'));
});

test('round, seed and tied-winner filters select the requested matches', () => {
  const games = [
    { round: 1, seed: 'CUP-S1', results: [{ id: 11, name: '甲 AI', rank: 1 }, { id: 12, name: '乙 AI', rank: 1 }] },
    { round: 2, seed: 'CUP-S2', results: [{ id: 11, name: '甲 AI', rank: 2 }, { id: 12, name: '乙 AI', rank: 1 }] }
  ];
  assert.deepEqual(filterGames(games, '1').map(g => g.round), [1]);
  assert.deepEqual(filterGames(games, 'cup-s2').map(g => g.round), [2]);
  assert.deepEqual(filterGames(games, '甲').map(g => g.round), [1]);
  assert.equal(filterGames(games, '', '12').length, 2);
  assert.equal(filterGames(games, '2', '11').length, 0);
});

test('compressed recordings round-trip full game frames without source code', async () => {
  const game = new SnakeGame([{ id: 11, name: 'A' }, { id: 22, name: 'B' }]);
  const frames = [game.snapshot(), game.step({ 11: 'down', 22: 'up' })];
  const replay = makeReplay(game.config, game.seed, frames);
  const packed = await packReplay(replay);
  assert.equal(packed.codec, 'gzip');
  assert.ok(packed.blob.size < new Blob([JSON.stringify(replay)]).size);
  assert.deepEqual(validateReplay(await unpackReplay(packed)), validateReplay(replay));
  const fallback = { codec: 'json', blob: new Blob([JSON.stringify(replay)]) };
  assert.deepEqual(await unpackReplay(fallback), replay);
});

test('saved drafts keep their name and strategy snapshots while runtime handles stay out of storage', () => {
  const session = { id: 'draft-1', name: '第一届比赛', createdAt: '2026-10-05T00:00:00.000Z', masterSeed: 'CUP', total: 50,
    completed: 0, config: {}, stats: [], games: [], status: 'draft', contestants: [{ id: 11, color: '#112233', source: 'export default () => "up"' }], runner: {} };
  const saved = tournamentMetadata(session);
  assert.equal(saved.status, 'draft'); assert.equal(saved.name, session.name);
  assert.deepEqual(saved.contestants, session.contestants); assert.equal('runner' in saved, false);
  assert.equal(tournamentMetadata({ ...session, startedAt: session.createdAt }).status, 'stopped');
  assert.equal(tournamentMetadata({ ...session, startedAt: session.createdAt, running: true }).status, 'running');
  assert.equal(tournamentMetadata({ ...session, completed: 50 }).status, 'completed');
});

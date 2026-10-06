import test from 'node:test';
import assert from 'node:assert/strict';
import { SnakeGame } from '../src/engine.js';
import { makeReplay, validateReplay, scoreRound } from '../src/replay.js';

test('exported frames validate and round-trip without executing source', () => {
  const game = new SnakeGame([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  const frames = [game.snapshot(), game.step({ 1: 'down', 2: 'up' })];
  const replay = makeReplay(game.config, game.seed, frames);
  const loaded = validateReplay(JSON.parse(JSON.stringify(replay)));
  assert.equal(loaded.frames.length, 2);
  assert.deepEqual(loaded.frames[1].snakes, frames[1].snakes);
  assert.equal('source' in loaded.frames[0].snakes[0], false);
});

test('damaged, oversized or off-board replay values are rejected', () => {
  const game = new SnakeGame([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  const replay = makeReplay(game.config, game.seed, [game.snapshot()]);
  for (const mutate of [
    r => { r.config.width = 999; },
    r => { r.frames[0].snakes[0].body[0] = -1; },
    r => { r.frames[0].snakes[0].color = 'url(javascript:foo)'; },
    r => { r.frames[0].food.push(900); },
    r => { r.frames[0].snakes[0].body = []; },
    r => { r.frames[0].turn = 4; },
    r => { r.frames[0].snakes[0].id = 2; }
  ]) {
    const copy = structuredClone(replay); mutate(copy);
    assert.throws(() => validateReplay(copy));
  }
});

test('tied tournament ranks split occupied positions and preserve total points', () => {
  const scored = scoreRound([{ id: 1, score: 20 }, { id: 2, score: 20 }, { id: 3, score: 10 }, { id: 4, score: 5 }]);
  assert.ok(Math.abs(scored[0].points - 83.3333333333) < 1e-7);
  assert.equal(scored[0].points, scored[1].points);
  assert.ok(Math.abs(scored.reduce((sum, s) => sum + s.points, 0) - 200) < 1e-7);
  assert.deepEqual(scored.map(s => s.rank), [1, 1, 3, 4]);
});

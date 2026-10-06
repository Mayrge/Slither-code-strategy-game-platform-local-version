import test from 'node:test';
import assert from 'node:assert/strict';
import { SnakeGame, rankSnakes } from '../src/engine.js';

const players = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
const cell = (x, y) => y * 30 + x;
function fixture(options = {}) {
  const game = new SnakeGame(players, { foodTarget: 0, dropRatio: 0, ...options });
  Object.assign(game.snakes[0], { body: [cell(5, 5), cell(4, 5), cell(4, 6), cell(5, 6), cell(6, 6)], direction: 'right' });
  Object.assign(game.snakes[1], { body: [cell(20, 20), cell(21, 20), cell(22, 20), cell(23, 20), cell(24, 20)], direction: 'left' });
  return game;
}

test('self-body collision is legal and overlapping segments retain their length', () => {
  const game = fixture();
  game.step({ 1: 'down', 2: 'left' });
  assert.equal(game.snakes[0].alive, true);
  assert.equal(game.snakes[0].body[0], cell(5, 6));
  assert.equal(game.snakes[0].score, 5);
  assert.equal(game.snakes[0].body.filter(c => c === cell(5, 6)).length, 2);
});

test('food grows exactly one segment and refills only below the target', () => {
  const game = fixture({ foodTarget: 3 });
  game.food = new Set([cell(6, 5), cell(15, 15), cell(16, 15), cell(17, 15)]);
  game.step({ 1: 'right', 2: 'left' });
  assert.equal(game.snakes[0].score, 6);
  assert.equal(game.snakes[0].body.length, 6);
  assert.equal(game.food.size, 3);
  assert.equal(game.food.has(cell(6, 5)), false);
});

test('same-cell head collision kills both and does not consume food', () => {
  const game = fixture();
  Object.assign(game.snakes[1], { body: [cell(7, 5), cell(8, 5), cell(9, 5), cell(10, 5), cell(11, 5)], direction: 'left' });
  game.food.add(cell(6, 5));
  game.step({ 1: 'right', 2: 'left' });
  assert.ok(game.snakes.every(s => !s.alive));
  assert.ok(game.snakes.every(s => s.score === 5));
  assert.equal(game.food.has(cell(6, 5)), true);
  assert.equal(game.done, true);
});

test('head swaps kill both', () => {
  const game = fixture();
  Object.assign(game.snakes[1], { body: [cell(6, 5), cell(7, 5), cell(8, 5), cell(9, 5), cell(10, 5)], direction: 'left' });
  game.step({ 1: 'right', 2: 'left' });
  assert.ok(game.snakes.every(s => !s.alive));
});

test('an opponent tail vacates only on a non-growing legal move', () => {
  for (const growing of [false, true]) {
    const game = fixture();
    Object.assign(game.snakes[1], { body: [cell(10, 5), cell(9, 5), cell(8, 5), cell(7, 5), cell(6, 5)], direction: 'right' });
    if (growing) game.food.add(cell(11, 5));
    game.step({ 1: 'right', 2: 'right' });
    assert.equal(game.snakes[0].alive, !growing);
  }
});

test('tail remains occupied if another overlapping segment occupies the same cell', () => {
  const game = fixture();
  Object.assign(game.snakes[1], { body: [cell(10, 5), cell(6, 5), cell(8, 5), cell(7, 5), cell(6, 5)], direction: 'right' });
  game.step({ 1: 'right', 2: 'right' });
  assert.equal(game.snakes[0].alive, false);
});

test('a dying snake still blocks other heads in the current turn', () => {
  const game = fixture();
  Object.assign(game.snakes[1], { body: [cell(10, 5), cell(6, 5), cell(8, 5), cell(7, 5), cell(9, 5)], direction: 'right' });
  game.step({ 1: 'right', 2: { error: '决策超时' } });
  assert.ok(game.snakes.every(s => !s.alive));
});

test('dead scores freeze and a dead high scorer outranks a survivor', () => {
  const game = fixture({ maxTurns: 4 });
  game.snakes[0].score = 80;
  game.step({ 1: { error: '策略异常' }, 2: 'left' });
  assert.equal(game.done, false, 'one survivor must continue');
  for (let i = 0; i < 3; i++) game.step({ 2: 'left' });
  assert.equal(game.turn, 4);
  assert.equal(game.done, true);
  assert.equal(game.snakes[0].score, 80);
  assert.equal(rankSnakes(game.snakes)[0].id, 1);
});

test('overlapping corpse drops based on length, spilling to nearby free cells', () => {
  const game = fixture({ dropRatio: 0.3 });
  game.snakes[0].body = Array(20).fill(cell(5, 5));
  game.snakes[0].score = 20;
  game.step({ 1: 'left', 2: 'left' });
  assert.equal(game.snakes[0].alive, false);
  assert.equal(game.food.size, 6);
  assert.ok([...game.food].every(c => !game.occupied().has(c)));
  assert.deepEqual(game.snakes[0].body, []);
});

test('reverse, invalid output and wall collisions are eliminated', () => {
  for (const action of ['left', 'sideways', { error: '决策超时' }]) {
    const game = fixture();
    game.step({ 1: action, 2: 'left' });
    assert.equal(game.snakes[0].alive, false);
  }
  const game = fixture();
  game.snakes[0].body[0] = cell(29, 5);
  game.step({ 1: 'right', 2: 'left' });
  assert.equal(game.snakes[0].deathReason, '撞到边界');
});

test('seed and actions reproduce exactly; exported snapshots do not alias engine state', () => {
  const first = new SnakeGame(players, { seed: 'reproducible' });
  const second = new SnakeGame(players, { seed: 'reproducible' });
  for (let i = 0; i < 8; i++) {
    first.step({ 1: 'down', 2: 'up' }); second.step({ 1: 'down', 2: 'up' });
    assert.deepEqual(first.snapshot(), second.snapshot());
  }
  const snapshot = first.snapshot();
  snapshot.snakes[0].body[0] = -1;
  const observation = first.observation(1);
  observation.snakes[0].body[0][0] = -1;
  assert.notEqual(first.snakes[0].body[0], -1);
});

test('equal scores share rank regardless of survival or player id', () => {
  const ranked = rankSnakes([{ id: 1, score: 20, alive: false }, { id: 2, score: 20, alive: true }, { id: 3, score: 10, alive: true }]);
  assert.deepEqual(ranked.map(s => s.rank), [1, 1, 3]);
});

test('ten rotating spawn positions are in bounds, distinct and equally long', () => {
  const contestants = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: String(i) }));
  for (let rotation = 0; rotation < 10; rotation++) {
    const game = new SnakeGame(contestants, { rotation });
    const cells = game.snakes.flatMap(s => s.body);
    assert.equal(new Set(cells).size, 50);
    assert.ok(cells.every(c => c >= 0 && c < 900));
    assert.ok(game.snakes.every(s => s.score === 5));
    assert.ok([...game.food].every(c => !game.occupied().has(c)));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlayers } from '../src/bots.js';
import { createPlayer, restorePlayers } from '../src/players.js';
import { SnakeGame } from '../src/engine.js';
import { makeReplay, validateReplay } from '../src/replay.js';

test('new contestants remain on the bench when a match already has ten players', () => {
  const players = defaultPlayers();
  const player = createPlayer(players);
  assert.equal(player.id, 11);
  assert.equal(player.enabled, false);
  players.push(player);
  players[0].enabled = false;
  const next = createPlayer(players);
  assert.equal(next.id, 12);
  assert.equal(next.enabled, true);
});

test('stored custom names, colors, code and non-contiguous IDs survive reload', () => {
  const templates = defaultPlayers();
  const players = [templates[1], { ...createPlayer(templates), id: 42, name: '我的 AI', color: '#123abc', enabled: true,
    source: 'export default state => ({ direction: state.snakes.find(s => s.id === state.you).direction });' }];
  assert.deepEqual(restorePlayers(JSON.parse(JSON.stringify(players)), templates), players);
  const legacy = templates.map(({ color, ...p }) => p);
  assert.deepEqual(restorePlayers(legacy, templates), templates);
});

test('invalid saved identities, colors and match sizes are rejected', () => {
  const templates = defaultPlayers();
  for (const mutate of [
    p => { p[1].id = p[0].id; },
    p => { p[0].color = 'red;position:fixed'; },
    p => { p.push({ ...createPlayer(p), enabled: true }); },
    p => { p.forEach(s => { s.enabled = false; }); }
  ]) {
    const saved = structuredClone(templates); mutate(saved);
    assert.equal(restorePlayers(saved, templates), null);
  }
});

test('custom contestants execute starter code and retain their identities in replay', async () => {
  const templates = defaultPlayers();
  const custom = { ...createPlayer(templates), enabled: true, name: '新参赛者', color: '#112233' };
  const decide = (await import('data:text/javascript,' + encodeURIComponent(custom.source))).default;
  const game = new SnakeGame([templates[0], custom]);
  const frames = [game.snapshot(), game.step({ 1: 'down', [custom.id]: decide(game.observation(custom.id)) })];
  assert.equal(frames[1].snakes[1].alive, true);
  const replay = validateReplay(makeReplay(game.config, game.seed, frames));
  assert.equal(replay.frames[1].snakes[1].id, 11);
  assert.equal(replay.frames[1].snakes[1].name, custom.name);
  assert.equal(replay.frames[1].snakes[1].color, custom.color);
});

import { SnakeGame, DEFAULTS } from '../src/engine.js';
import { makeReplay, scoreRound } from '../src/replay.js';
import { AgentRunner } from './runner.mjs';

export const BLANK_MAP = Object.freeze({ format: 'snake-arena-blank-map', version: 1, width: 30, height: 30, maxTurns: 500, initialLength: 5, dropRatio: 0.3, decisionMs: 50, foodTarget: 60, walls: [], snakes: [], food: [] });
export function validateMap(map) {
  for (const key of ['format', 'version', 'width', 'height', 'maxTurns', 'initialLength', 'dropRatio', 'decisionMs']) if (map[key] !== BLANK_MAP[key]) throw new Error('空白地图的固定规则不匹配：' + key);
  if (!Number.isInteger(map.foodTarget) || map.foodTarget < 1 || map.foodTarget > 180) throw new Error('foodTarget需要是1～180的整数；排位请使用60');
  for (const key of ['walls', 'snakes', 'food']) if (!Array.isArray(map[key]) || map[key].length) throw new Error('空白地图的' + key + '必须为空，选手和食物在开局时生成');
  return { ...DEFAULTS, foodTarget: map.foodTarget };
}
export function coordinateFrame(frame, width = 30) {
  const xy = cell => [cell % width, Math.floor(cell / width)];
  return { ...frame, food: frame.food.map(xy), events: frame.events.map(event => event.cell == null ? { ...event } : { ...event, cell: xy(event.cell) }), snakes: frame.snakes.map(s => ({ ...s, length: s.score, body: s.body.map(xy) })) };
}
export class AgentArena {
  constructor(players, { map = BLANK_MAP, seed = 'AGENT-TEST', rotation = 0, recordReplay = false } = {}) {
    if (players.some(p => !Number.isSafeInteger(p.id) || p.id < 1 || typeof p.source !== 'string' || p.source.length > 200000 || typeof p.name !== 'string' || p.name.length > 24)) throw new Error('选手需要唯一正整数id、名称和独立JavaScript源代码');
    this.game = new SnakeGame(players, { ...validateMap(map), seed, rotation });
    this.runner = new AgentRunner(players, seed, 50);
    this.recordReplay = recordReplay; this.frames = recordReplay ? [this.game.snapshot()] : null;
    this.initialized = false; this.busy = false; this.closed = false;
  }
  async initialize() { if (this.closed) throw new Error('测试环境已关闭'); if (this.initialized) return; await this.runner.initialize(); this.initialized = true; }
  observation(id) { if (!this.game.snakes.some(s => s.id === id)) throw new Error('未知选手id'); return this.game.observation(id); }
  state() { return coordinateFrame(this.game.snapshot(), this.game.config.width); }
  record() { return { turn: this.game.turn, seed: this.game.seed, config: this.game.config, state: this.state(), actions: {}, diagnostics: {}, results: scoreRound(this.game.snakes).map(({ body, ...s }) => s) }; }
  async step(manualActions) {
    if (this.closed) throw new Error('测试环境已关闭');
    if (this.busy) throw new Error('上一个回合尚未完成');
    if (this.game.done) return this.record();
    this.busy = true;
    try {
      const actions = manualActions == null ? (await this.initialize(), await this.runner.decide(this.game)) : manualActions;
      const diagnostics = manualActions == null ? this.runner.diagnostics() : {};
      const frame = this.game.step(actions); if (this.frames) this.frames.push(frame);
      this.runner.retire(this.game);
      return { ...this.record(), actions: actions instanceof Map ? Object.fromEntries(actions) : structuredClone(actions), diagnostics, inputTurn: this.game.turn - 1 };
    } finally { this.busy = false; }
  }
  replay() { if (!this.frames) throw new Error('请在创建环境时设置recordReplay:true'); return makeReplay(this.game.config, this.game.seed, this.frames); }
  async close() { this.closed = true; await this.runner.dispose(); }
}

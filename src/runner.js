import { hashSeed } from './engine.js';

export class StrategyRunner {
  constructor(players, seed, budget = 50) {
    this.players = players;
    this.seed = seed;
    this.budget = budget;
    this.slots = new Map();
    this.disposed = false;
    this.request = 0;
  }

  async initialize() {
    await Promise.all(this.players.map(player => new Promise(resolve => {
      const worker = new Worker(new URL('./strategy-worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, error: null, pending: null, elapsed: 0, detail: '' };
      this.slots.set(player.id, slot);
      const finish = error => {
        clearTimeout(timer); slot.error = error; slot.pending = null;
        if (error) worker.terminate();
        resolve();
      };
      const timer = setTimeout(() => finish('初始化超时'), 4000);
      slot.pending = () => finish('比赛已停止');
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') finish(null);
        else if (message.type === 'init-error') { slot.detail = message.error; finish('代码加载失败'); }
      };
      worker.onerror = event => { event.preventDefault(); slot.detail = event.message; finish('代码加载失败'); };
      worker.postMessage({ type: 'init', id: player.id, source: player.source, seed: hashSeed(this.seed + ':' + player.id), budget: this.budget });
    })));
  }

  async decide(game) {
    const request = ++this.request;
    const decisions = await Promise.all(game.snakes.filter(s => s.alive).map(snake => {
      const slot = this.slots.get(snake.id);
      if (this.disposed || !slot || slot.error) return Promise.resolve([snake.id, { error: slot?.error || '比赛已停止' }]);
      return new Promise(resolve => {
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true; clearTimeout(timer); slot.pending = null;
          resolve([snake.id, result]);
        };
        // Execution is measured inside the worker. This larger watchdog allows
        // browser scheduling/serialization while still stopping infinite loops.
        const timer = setTimeout(() => {
          slot.error = '决策超时'; slot.worker.terminate(); finish({ error: slot.error });
        }, 250);
        slot.pending = () => finish({ error: '比赛已停止' });
        slot.worker.onmessage = event => {
          const message = event.data;
          if (message.type !== 'decision' || message.request !== request) return;
          slot.elapsed = message.elapsed || 0;
          slot.detail = message.detail || '';
          const result = message.result;
          const direction = typeof result === 'string' ? result : result?.direction;
          if (result?.error) finish({ error: result.error });
          else if (['up', 'right', 'down', 'left'].includes(direction)) finish({ direction });
          else finish({ error: '输出无效' });
        };
        slot.worker.onerror = event => { event.preventDefault(); slot.detail = event.message; finish({ error: '策略异常' }); };
        slot.worker.postMessage({ type: 'decide', request, state: game.observation(snake.id) });
      });
    }));
    return new Map(decisions);
  }

  retire(game) {
    for (const snake of game.snakes.filter(s => !s.alive)) {
      const slot = this.slots.get(snake.id);
      if (slot && !slot.error) { slot.worker.terminate(); slot.error = '已淘汰'; }
    }
  }

  dispose() {
    this.disposed = true;
    for (const slot of this.slots.values()) { slot.pending?.(); slot.worker.terminate(); }
    this.slots.clear();
  }
}

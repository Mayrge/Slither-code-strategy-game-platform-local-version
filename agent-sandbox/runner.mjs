import { Worker } from 'node:worker_threads';

export class AgentRunner {
  constructor(players, seed, budget = 50) {
    this.players = players; this.seed = seed; this.budget = budget;
    this.slots = new Map(); this.request = 0; this.disposed = false;
  }
  async initialize() {
    await Promise.all(this.players.map(player => new Promise(resolve => {
      // Isolate module memory per player and game; strategy logs cannot pollute JSON output.
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { stdout: true, stderr: true, execArgv: [] });
      worker.stdout.resume(); worker.stderr.resume();
      const slot = { worker, error: null, detail: '', elapsed: 0, pending: null };
      this.slots.set(player.id, slot);
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer); slot.pending = null;
        slot.error = error; if (error) void worker.terminate(); resolve();
      };
      const timer = setTimeout(() => finish('初始化超时'), 4000);
      slot.pending = () => finish('比赛已停止');
      worker.on('error', error => { slot.detail = error.message; if (slot.pending) slot.pending('代码加载失败'); else slot.error = '策略异常'; });
      worker.on('exit', code => { if (slot.pending) slot.pending(code === 0 ? '策略提前退出' : '策略异常'); });
      worker.on('message', message => {
        if (message.type === 'ready') finish(null);
        else if (message.type === 'init-error') { slot.detail = message.detail; finish('代码加载失败'); }
      });
      slot.pending = reason => finish(reason || '比赛已停止');
      worker.postMessage({ type: 'init', source: player.source, seedText: this.seed + ':' + player.id, budget: this.budget });
    })));
  }
  async decide(game) {
    const request = ++this.request;
    return new Map(await Promise.all(game.snakes.filter(s => s.alive).map(snake => {
      const slot = this.slots.get(snake.id);
      if (this.disposed || !slot || slot.error) return [snake.id, { error: slot?.error || '比赛已停止' }];
      return new Promise(resolve => {
        let settled = false;
        const finish = result => {
          if (settled) return; settled = true; clearTimeout(timer); slot.pending = null;
          slot.worker.off('message', onMessage); resolve([snake.id, result]);
        };
        const onMessage = message => {
          if (message.type !== 'decision' || message.request !== request) return;
          slot.elapsed = message.elapsed || 0; slot.detail = message.detail || '';
          const direction = typeof message.result === 'string' ? message.result : message.result?.direction;
          finish(message.result?.error ? { error: message.result.error } : ['up', 'right', 'down', 'left'].includes(direction) ? { direction } : { error: '输出无效' });
        };
        const timer = setTimeout(() => { slot.error = '决策超时'; void slot.worker.terminate(); finish({ error: slot.error }); }, 250);
        slot.pending = reason => finish({ error: reason || '比赛已停止' });
        slot.worker.on('message', onMessage);
        workerPost(slot, { type: 'decide', request, state: game.observation(snake.id) }, finish);
      });
    })));
  }
  diagnostics() { return Object.fromEntries([...this.slots].map(([id, slot]) => [id, { elapsedMs: slot.elapsed, detail: slot.detail, error: slot.error }])); }
  retire(game) {
    for (const snake of game.snakes.filter(s => !s.alive)) {
      const slot = this.slots.get(snake.id);
      if (slot && !slot.error) { slot.error = snake.deathReason; void slot.worker.terminate(); }
    }
  }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.slots.values()].map(slot => { slot.pending?.(); return slot.worker.terminate(); }));
    this.slots.clear();
  }
}
function workerPost(slot, message, finish) {
  try { slot.worker.postMessage(message); } catch (error) { slot.detail = error.message; finish({ error: '策略异常' }); }
}

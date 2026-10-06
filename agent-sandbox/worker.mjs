import { parentPort } from 'node:worker_threads';
import { makeRandom } from '../src/engine.js';

let decide, budget;
parentPort.on('message', async message => {
  if (message.type === 'init') {
    try {
      budget = message.budget;
      Math.random = makeRandom(message.seedText);
      const module = await import('data:text/javascript;base64,' + Buffer.from(message.source).toString('base64'));
      decide = module.default || module.decide;
      if (typeof decide !== 'function') throw new Error('需要默认导出 decide(state) 函数');
      parentPort.postMessage({ type: 'ready' });
    } catch (error) { parentPort.postMessage({ type: 'init-error', detail: String(error.message).slice(0, 300) }); }
  } else if (message.type === 'decide') {
    try {
      const start = performance.now();
      const result = await decide(message.state), elapsed = performance.now() - start;
      parentPort.postMessage({ type: 'decision', request: message.request, result: elapsed > budget ? { error: '决策超时' } : result, elapsed });
    } catch (error) {
      parentPort.postMessage({ type: 'decision', request: message.request, result: { error: '策略异常' }, detail: String(error.message).slice(0, 300) });
    }
  }
});

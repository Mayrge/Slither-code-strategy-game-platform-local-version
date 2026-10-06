let decide;
let playerId;
let budget;

function seededRandom(seed) {
  let value = seed >>> 0 || 1;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}

self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'init') {
    try {
      playerId = message.id;
      budget = message.budget;
      Math.random = seededRandom(message.seed);
      const blob = new Blob([message.source], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        const module = await import(url);
        decide = module.default || module.decide;
      } finally { URL.revokeObjectURL(url); }
      if (typeof decide !== 'function') throw new Error('需要导出 default function decide(state)');
      self.postMessage({ type: 'ready', id: playerId });
    } catch (error) { self.postMessage({ type: 'init-error', error: String(error.message).slice(0, 180) }); }
  } else if (message.type === 'decide') {
    try {
      const start = performance.now();
      const result = await decide(message.state);
      const elapsed = performance.now() - start;
      self.postMessage({ type: 'decision', request: message.request, result: elapsed > budget ? { error: '决策超时' } : result, elapsed });
    } catch (error) {
      self.postMessage({ type: 'decision', request: message.request, result: { error: '策略异常' }, detail: String(error.message).slice(0, 180) });
    }
  }
};

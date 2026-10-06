import { COLORS } from './engine.js';

export const PROFILES = [
  { name: '青柠 · 寻路', role: '均衡策略', food: 12, safety: 90, space: 0.13, hunt: 0, center: 0.05 },
  { name: '冰川 · 守望', role: '谨慎避险', food: 8, safety: 160, space: 0.22, hunt: 0, center: 0.03 },
  { name: '珊瑚 · 追猎', role: '主动接近', food: 12, safety: 45, space: 0.06, hunt: 1.6, center: 0.1 },
  { name: '紫罗兰 · 漫游', role: '空间探索', food: 6, safety: 110, space: 0.3, hunt: 0, center: 0.02 },
  { name: '琥珀 · 拾荒', role: '食物优先', food: 20, safety: 60, space: 0.05, hunt: 0.1, center: 0.03 },
  { name: '薄荷 · 游击', role: '均衡策略', food: 11, safety: 85, space: 0.12, hunt: 0.5, center: 0.07 },
  { name: '桃粉 · 突进', role: '高风险抢食', food: 22, safety: 30, space: 0.03, hunt: 1, center: 0.12 },
  { name: '日落 · 巡航', role: '谨慎避险', food: 9, safety: 140, space: 0.16, hunt: 0, center: 0.04 },
  { name: '靛蓝 · 侦察', role: '空间探索', food: 8, safety: 100, space: 0.23, hunt: 0.3, center: 0.06 },
  { name: '月白 · 采集', role: '食物优先', food: 17, safety: 75, space: 0.09, hunt: 0, center: 0.04 }
];

function builtinDecide(state) {
  const me = state.snakes.find(s => s.id === state.you);
  const { width: w, height: h } = state;
  const moves = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  const opposite = { up: 'down', right: 'left', down: 'up', left: 'right' };
  const key = (x, y) => y * w + x;
  const enemies = state.snakes.filter(s => s.alive && s.id !== me.id);
  const blocked = new Set(enemies.flatMap(s => s.body.map(([x, y]) => key(x, y))));
  const foods = new Set(state.food.map(([x, y]) => key(x, y)));
  const danger = new Set();
  for (const enemy of enemies) {
    const [x, y] = enemy.body[0];
    for (const [name, [dx, dy]] of Object.entries(moves)) {
      if (name === opposite[enemy.direction]) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) danger.add(key(nx, ny));
    }
  }
  function explore(sx, sy) {
    const queue = [[sx, sy, 0]];
    const seen = new Set([key(sx, sy)]);
    let distance = w + h;
    for (let i = 0; i < queue.length; i++) {
      const [x, y, d] = queue[i];
      if (foods.has(key(x, y))) distance = Math.min(distance, d);
      for (const [dx, dy] of Object.values(moves)) {
        const nx = x + dx, ny = y + dy, cell = key(nx, ny);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || blocked.has(cell) || seen.has(cell)) continue;
        seen.add(cell); queue.push([nx, ny, d + 1]);
      }
    }
    return { distance, space: seen.size };
  }
  const [hx, hy] = me.body[0];
  let best = -Infinity, choice = me.direction;
  for (const [name, [dx, dy]] of Object.entries(moves)) {
    if (name === opposite[me.direction]) continue;
    const x = hx + dx, y = hy + dy, cell = key(x, y);
    if (x < 0 || y < 0 || x >= w || y >= h || blocked.has(cell)) continue;
    const result = explore(x, y);
    const nearest = enemies.length ? Math.min(...enemies.map(s => Math.abs(s.body[0][0] - x) + Math.abs(s.body[0][1] - y))) : w + h;
    const centerDistance = Math.abs(x - (w - 1) / 2) + Math.abs(y - (h - 1) / 2);
    const score = -result.distance * PROFILE.food + result.space * PROFILE.space
      - (danger.has(cell) ? PROFILE.safety : 0) - nearest * PROFILE.hunt
      - centerDistance * PROFILE.center + (foods.has(cell) ? PROFILE.food * 2 : 0)
      + (name === me.direction ? 0.3 : 0) + Math.random() * 0.2;
    if (score > best) { best = score; choice = name; }
  }
  return { direction: choice };
}

export function defaultPlayers() {
  return PROFILES.map((profile, index) => ({
    id: index + 1, name: profile.name, role: profile.role, color: COLORS[index], enabled: true,
    source: `// ${profile.name} · ${profile.role}\n// 修改权重，或者替换整个 decide 函数。\nconst PROFILE = ${JSON.stringify(profile, null, 2)};\n\nexport default ${builtinDecide.toString()}\n`
  }));
}

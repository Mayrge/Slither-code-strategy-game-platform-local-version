// Snake Arena 入门策略。可在竞技台「策略实验室」导入此文件。
// 所有坐标均为 [x, y]，左上角为 [0, 0]。
// 自碰免死；必须每回合移动，禁止180度反向。

export default function decide(state) {
  const me = state.snakes.find(snake => snake.id === state.you);
  const [x, y] = me.body[0];
  const moves = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const occupied = new Set(
    state.snakes.filter(s => s.alive && s.id !== me.id)
      .flatMap(s => s.body.map(([bx, by]) => `${bx},${by}`))
  );
  let direction = me.direction;
  let best = Infinity;
  for (const [name, [dx, dy]] of Object.entries(moves)) {
    if (name === opposite[me.direction]) continue;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height || occupied.has(`${nx},${ny}`)) continue;
    const distance = state.food.length
      ? Math.min(...state.food.map(([fx, fy]) => Math.abs(fx - nx) + Math.abs(fy - ny)))
      : 0;
    if (distance < best) { best = distance; direction = name; }
  }
  return { direction };
}

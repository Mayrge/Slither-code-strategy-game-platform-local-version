import { SnakeGame, rankSnakes } from './engine.js';
import { defaultPlayers } from './bots.js';
import { StrategyRunner } from './runner.js';
import { makeReplay, validateReplay } from './replay.js';

const output = document.getElementById('results');
const button = document.getElementById('run');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

button.addEventListener('click', async () => {
  button.disabled = true; output.textContent = '';
  const report = line => { output.textContent += line + '\n'; };
  let runner;
  try {
    const players = defaultPlayers();
    const game = new SnakeGame(players, { seed: 'BROWSER-INTEGRATION' });
    runner = new StrategyRunner(players, game.seed);
    await runner.initialize();
    assert([...runner.slots.values()].every(s => !s.error), '示例策略初始化失败');
    report('PASS · 10个真实Worker成功加载模块');
    const frames = [game.snapshot()];
    while (!game.done) {
      const actions = await runner.decide(game);
      frames.push(game.step(actions)); runner.retire(game);
      assert(game.snakes.every(s => !s.alive || s.body.length === s.score), '长度和分数不一致');
      assert([...game.food].every(c => !game.occupied().has(c)), '食物落在蛇身上');
      if (game.turn % 100 === 0) report(`进度 · ${game.turn}/500回合 · ${game.snakes.filter(s => s.alive).length}条存活`);
    }
    runner.dispose();
    assert(game.turn === 500, '示例场未能保持存活到500回合');
    report('PASS · 完整500回合，长度、分数和食物约束成立');
    assert(!game.snakes.some(s => ['代码加载失败', '策略异常', '决策超时', '输出无效', '反向移动'].includes(s.deathReason)), '示例策略出现接口或执行错误');
    report('PASS · 示例策略没有代码错误、非法输出或超时');
    validateReplay(JSON.parse(JSON.stringify(makeReplay(game.config, game.seed, frames))));
    report(`PASS · 501帧回放导出/导入校验，大小${(JSON.stringify(frames).length / 1024).toFixed(0)}KB`);
    report('最终长度 · ' + rankSnakes(game.snakes).map(s => `${s.name}:${s.score}`).join(' / '));
    const failureSources = [
      ['执行异常', 'export default function decide(){ throw new Error("expected"); }', '策略异常'],
      ['死循环', 'export default function decide(){ while(true){} }', '决策超时'],
      ['无效输出', 'export default function decide(){ return "diagonal"; }', '输出无效'],
      ['语法错误', 'export default function decide( {', '代码加载失败']
    ];
    for (const [name, source, reason] of failureSources) {
      const p = [{ ...players[0], source }, players[1]];
      const match = new SnakeGame(p, { seed: 'FAILURE-CHECK' });
      runner = new StrategyRunner(p, match.seed); await runner.initialize();
      const actions = await runner.decide(match); match.step(actions); runner.dispose();
      assert(match.snakes[0].deathReason === reason && match.snakes[0].score === 5, name + '未正确淘汰');
      assert(match.snakes[1].alive, '错误策略影响对手');
      report(`PASS · ${name}正确淘汰，冻结分数，未阻塞对手`);
    }
    report('ALL PASSED');
  } catch (error) { report('FAIL · ' + error.message); }
  finally { runner?.dispose(); button.disabled = false; }
});

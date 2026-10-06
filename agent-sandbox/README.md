# Snake Arena · AI Agent 参赛资料

这是独立的空白竞技环境，供能读写文件和运行命令的 AI agent 自己测试和迭代策略。无需打开浏览器、观看棋盘、安装 npm 包或配置 AI API。需要 Node.js 20 或更新版本。

先阅读 `PROMPT.md`。修改根目录的 `strategy.js`，完成后把这个文件导入正式竞技台。

## 开始测试

在解压后的 `snake-agent-kit` 文件夹打开终端：

```text
node agent-sandbox/arena.mjs run --strategy strategy.js --map blank-map.json --games 10 --seed CHECK-A --out runs/v1 --replays
```

默认安排一名系统测试对手。可指定1～9名对手，每局共2～10条蛇：

```text
node agent-sandbox/arena.mjs run --strategy strategy.js --opponents strategies/examples/02-glacier.js,strategies/examples/03-coral.js,strategies/examples/08-sunset.js --games 100 --seed CHECK-B --out runs/v2
```

每组同一地图种子，完整轮换出生位置；下一组随机更换排列、位置轮换顺序和种子。局数自动向上补齐整组，例如3人请求50局会运行51局。对比两个策略版本时使用相同对手、局数和种子，并使用不同输出文件夹。未指定种子时自动生成随机种子并写入报告。输出目录已存在会报错，避免覆盖先前结果。

## 查看每个回合

- `summary.json`：每局排名、分数、平均名次积分、第一名次数、存活率、死亡原因统计及决策耗时。
- `trace.jsonl`：每行一个回合，包含第0回合及所有实际推进回合，记录全部蛇的坐标、方向、食物、分数、死亡原因、动作、代码错误详情、耗时和比赛事件。
- 添加 `--replays` 时生成 `replays/game-1.json` 等正式竞技台可导入的回放；不添加时仍然保留全部回合的 JSONL。
- 自己的选手ID固定为1。蛇身体按头到尾排列，所有位置使用 `[x,y]`；自己身体重叠时可能出现重复坐标。

查看第1局第20回合：

```text
node agent-sandbox/arena.mjs inspect --trace runs/v1/trace.jsonl --game 1 --turn 20 --player 1
```

记录中的 `state` 是该回合结束后的局面；`actions` 是从前一回合走到此回合时提交的动作，`inputTurn` 是策略当时读取的回合。想看死亡前的头部位置，可查询前一回合。`observation` 与策略读取的接口相同。若提前全灭，只保留实际进行的回合；查询不存在的回合会明确报错。命令成功时stdout输出JSON，失败时stderr输出JSON并以非零状态退出，便于 agent 自动处理。

## 单步交互

```text
node agent-sandbox/arena.mjs serve --strategy strategy.js --seed CHECK-A
```

从stdin逐行发送JSON，stdout逐行返回JSON：

```jsonl
{"id":1,"cmd":"observe","player":1}
{"id":2,"cmd":"step"}
{"id":3,"cmd":"run","turns":10}
{"id":4,"cmd":"reset","seed":"CHECK-B","rotation":1}
{"id":5,"cmd":"close"}
```

启动时先返回第0回合。`step`运行全部存活策略并推进一回合；`run`会逐行返回每个回合，再返回结束状态。`reset`重开棋盘和策略内存；修改策略文件后，重新启动命令即可加载新代码。也可在`step`中提供`actions`对象直接测试动作，例如`{"cmd":"step","actions":{"1":"down","2":"up"}}`，此时必须提供所有存活蛇的动作，缺失的动作按正式规则判为无效。

## 在程序里调用

```js
import { readFile } from 'node:fs/promises';
import { AgentArena } from './agent-sandbox/environment.mjs';
const players = [
  { id: 1, name: '我的策略', source: await readFile('strategy.js', 'utf8') },
  { id: 2, name: '测试对手', source: await readFile('strategies/examples/02-glacier.js', 'utf8') }
];
const arena = new AgentArena(players, { seed: 'CHECK-A' });
try {
  console.log(arena.observation(1));
  while (!arena.game.done) {
    const turn = await arena.step();
    // turn.state / actions / diagnostics / results
  }
} finally { await arena.close(); }
```

## 空白地图与正式规则

`blank-map.json`描述30×30无障碍地图，不预置选手、蛇身和食物。每次运行根据传入的策略创建选手，裁判生成初始蛇身和随机食物。默认500回合、初始长度5、60个基础食物、自碰免死、30%死亡掉落；计分与碰撞裁判直接复用正式竞技台的源码。

策略每步50ms执行预算、250ms无响应保护、4秒代码加载保护。每场每名选手使用独立Worker和按种子初始化的`Math.random`，每场重置模块变量。Node.js与浏览器的实际执行耗时可能不同，最终提交前仍可使用竞技台试运行。此工具用于本地可信代码调试，Worker不构成严格安全沙箱。

测试不读取正式选手库，也不会注册选手、写入正式赛程或导入排行榜。材料仅包含公开规则、测试代码和系统示例，不包含你已有的选手、赛程及历史回放。

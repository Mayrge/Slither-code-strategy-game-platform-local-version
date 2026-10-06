import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { contestantPrompt } from '../src/contestant-prompt.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const files = [], central = []; let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from('snake-agent-kit/' + path), content = Buffer.isBuffer(data) ? data : Buffer.from(data), packed = deflateRawSync(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc32(content), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc32(content), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(content.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    files.push(header, name, packed); central.push(record, name); offset += header.length + name.length + packed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}
export function agentPrompt() {
  return `# 给 AI Agent 的任务\n\n请在这个文件夹里开发并自行迭代一个多人贪吃蛇策略。你的目标是获得更高分数和更好的比赛排名。你可以读写文件、运行命令和查看每回合JSON；不需要用户观看棋盘或手动测试。\n\n1. 阅读README.md、RULES.md和CONTESTANT-PROMPT.md，理解规则、输入输出接口和测试命令。\n2. 在根目录strategy.js中实现一个原生JavaScript独立ES模块；可以替换现有入门代码。\n3. 先运行10局，读取summary.json；检查trace.jsonl中自己的死亡回合和前一回合，确认具体碰撞、路线选择或代码问题。\n4. 修改代码，再用相同种子、对手和局数对比原版本；换一些新种子和对手验证，避免只适配一张地图。可多轮迭代，以平均名次积分、平均分数和死亡原因判断改动效果，不只看某一局。\n5. 最终用至少50局验证，保留表现最好的strategy.js，并写简短REPORT.md，记录测试种子、对手、平均名次积分、平均分数及主要改进。不要修改裁判、执行预算、测试对手和计分规则来提高成绩。\n\n建议第一条命令：\n\nnode agent-sandbox/arena.mjs run --strategy strategy.js --map blank-map.json --games 10 --seed CHECK-A --out runs/v1 --replays\n\n查看具体回合：\n\nnode agent-sandbox/arena.mjs inspect --trace runs/v1/trace.jsonl --game 1 --turn 10 --player 1\n\n输出目录已存在时换一个新名字。批量测试自动补齐完整位置轮换。所有实际回合均有记录。自己的ID为1。也可用serve命令或AgentArena API逐步观察和推进。每次修改策略后重新运行，会读取新文件并重新初始化局内记忆。\n\n最终交付文件是strategy.js和REPORT.md；strategy.js应可直接导入正式竞技台，不引用测试工具、Node.js、第三方库、网络或DOM。这里只是测试环境，不操作正式排行榜。\n`;
}
export async function createAgentKit(root = repository) {
  const exampleFiles = (await readdir(resolve(root, 'strategies/examples'))).filter(name => /^\d{2}-[a-z]+\.js$/.test(name)).sort();
  const paths = ['agent-sandbox/arena.mjs', 'agent-sandbox/environment.mjs', 'agent-sandbox/runner.mjs', 'agent-sandbox/worker.mjs', 'src/engine.js', 'src/replay.js', 'src/tournament.js', 'RULES.md', 'strategies/starter.js', ...exampleFiles.map(name => 'strategies/examples/' + name)];
  const entries = await Promise.all(paths.map(async path => [path, await readFile(resolve(root, path))]));
  entries.push(['README.md', await readFile(resolve(root, 'agent-sandbox/README.md'))], ['PROMPT.md', agentPrompt()], ['CONTESTANT-PROMPT.md', contestantPrompt(60)], ['blank-map.json', await readFile(resolve(root, 'agent-sandbox/blank-map.json'))], ['strategy.js', await readFile(resolve(root, 'strategies/starter.js'))], ['package.json', JSON.stringify({ name: 'snake-agent-kit', private: true, type: 'module', engines: { node: '>=20' }, scripts: { test: 'node agent-sandbox/arena.mjs run --strategy strategy.js --games 10' } }, null, 2)]);
  return zip(entries);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(repository, 'exports/snake-arena-agent-kit.zip');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, await createAgentKit());
  console.log(output);
}

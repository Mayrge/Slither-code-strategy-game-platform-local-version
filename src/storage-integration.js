import { saveTournamentSession, saveTournamentRound, readTournamentSession, readTournamentReplay, listTournaments, deleteTournament } from './tournament-store.js';
import { SnakeGame } from './engine.js';
import { makeReplay } from './replay.js';

document.getElementById('run').addEventListener('click', async () => {
  const button = document.getElementById('run'), result = document.getElementById('result');
  button.disabled = true; result.textContent = '';
  const prefix = 'storage-test-' + crypto.randomUUID(), ids = [prefix, prefix + '-neighbor'];
  const check = (condition, message) => { if (!condition) throw new Error(message); result.textContent += 'PASS ' + message + '\n'; };
  try {
    const before = await listTournaments();
    const contestants = [{ id: 11, name: '测试 A', color: '#aabbcc', source: 'export default () => "down";' }, { id: 22, name: '测试 B', color: '#112233', source: 'export default () => "up";' }];
    const draft = id => ({ id, name: '临时赛程', createdAt: new Date().toISOString(), startedAt: null, status: 'draft', masterSeed: 'STORE-CHECK', total: 2, completed: 0, config: { width: 30, height: 30, maxTurns: 500 }, contestants, stats: [], games: [] });
    await saveTournamentSession(draft(ids[0])); await saveTournamentSession(draft(ids[1]));
    const list = await listTournaments();
    check(list.length === before.length + 2 && ids.every(id => list.some(s => s.id === id)), '多个赛程独立保存，原赛程保留');
    const saved = await readTournamentSession(ids[0]);
    saved.name = '重命名赛程'; await saveTournamentSession(saved);
    const renamed = await readTournamentSession(ids[0]);
    check(renamed.name === saved.name && renamed.contestants[0].source === contestants[0].source, '名称和参赛代码快照保存');
    const game = new SnakeGame(contestants);
    const replay = makeReplay(game.config, game.seed, [game.snapshot(), game.step({ 11: 'down', 22: 'up' })]);
    await saveTournamentRound(saved, 1, replay); await saveTournamentRound(saved, 2, replay);
    await saveTournamentRound(draft(ids[1]), 1, replay);
    check((await readTournamentReplay(ids[0], 2)).frames.length === 2, '赛程中的多局回放可读取');
    await deleteTournament(ids[0]);
    check(await readTournamentSession(ids[0]) === null, '赛程信息已删除');
    for (const round of [1, 2]) {
      let missing = false; try { await readTournamentReplay(ids[0], round); } catch { missing = true; }
      check(missing, `第${round}局回放随赛程一起删除`);
    }
    check((await readTournamentReplay(ids[1], 1)).frames.length === 2, '相似ID的其他赛程与回放保留');
    await deleteTournament(ids[1]);
    check((await listTournaments()).length === before.length, '临时数据已清理，原记录数量一致');
    result.textContent += '\nALL PASSED';
  } catch (error) { result.textContent += 'FAIL ' + error.message; }
  finally { for (const id of ids) await deleteTournament(id).catch(() => {}); button.disabled = false; }
});

import { emptyRanking, analyzeTournament, applyTournament } from './ranking.js';
export function createRankingStore(databaseName = 'snake-arena-rankings-v1') {
  let database;
  function openDatabase() {
    return database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
      request.onerror = () => { database = null; reject(new Error('排行榜存储不可用，请允许浏览器本地存储')); };
      request.onblocked = () => { database = null; reject(new Error('排行榜被旧页面占用，请关闭旧页面后重试')); };
    });
  }
  // One record and one transaction: registrations, order and duplicate-import ledger commit together.
  async function change(action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
      let value, problem;
      const request = store.get('arena');
      request.onsuccess = () => {
        try { value = action(request.result || { registrations: [], ranking: emptyRanking() }); store.put(value, 'arena'); }
        catch (error) { problem = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(problem || new Error('排行榜未保存，可能是存储空间不足；本次排名未生效'));
    });
  }
  async function readRankingStore() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('arena');
      request.onsuccess = () => resolve(request.result || { registrations: [], ranking: emptyRanking() });
      request.onerror = () => reject(new Error('读取排行榜失败'));
    });
  }
  async function registerContestant(player, kind = 'user', fixedId) {
    if (kind !== 'user' && kind !== 'system') throw new Error('注册类型无效');
    const name = player.name.trim();
    if (!name || name.length > 24 || !player.source?.trim() || player.source.length > 200000) throw new Error('请填写名称和完整策略代码');
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(player.source)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return change(data => {
      const existing = fixedId && data.registrations.find(r => r.id === fixedId);
      if (existing) {
        if (existing.name !== name || existing.source !== player.source) throw new Error('系统注册版本已经锁定，不能覆盖');
        return data;
      }
      if (data.registrations.some(r => r.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('该选手名称已注册，请为新版本使用不同名称');
      data.registrations.push({ id: fixedId || crypto.randomUUID(), name, source: player.source, color: player.color, role: player.role, kind, fingerprint, registeredAt: new Date().toISOString() });
      return data;
    });
  }
  async function updateContestantAppearance(player) {
    if (!/^#[0-9a-f]{6}$/i.test(player.color)) throw new Error('颜色格式无效');
    return change(data => {
      const r = data.registrations.find(r => r.id === player.registrationId);
      if (!r || r.name !== player.name || r.source !== player.source) throw new Error('注册名称与代码已锁定');
      r.color = player.color; r.role = String(player.role || '').slice(0, 24);
      return data;
    });
  }
  async function importRankedTournament(session, expectedRevision) {
    return change(data => {
      if (data.ranking.revision !== expectedRevision) throw new Error('排行榜在其他页面已变化，请刷新后重新核验');
      const analysis = analyzeTournament(session, data.registrations, data.ranking);
      data.ranking = applyTournament(data.ranking, session, analysis);
      return data;
    });
  }

  return { readRankingStore, registerContestant, importRankedTournament, updateContestantAppearance, close: async () => { if (database) (await database).close(); database = null; } };
}
const mainStore = createRankingStore();
export const { readRankingStore, registerContestant, importRankedTournament, updateContestantAppearance } = mainStore;

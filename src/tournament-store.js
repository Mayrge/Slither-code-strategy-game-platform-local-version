let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('snake-arena-tournaments-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('replays', { keyPath: 'key' });
      const sessions = request.result.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('createdAt', 'createdAt');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => { database = null; reject(new Error('浏览器未能打开回放存储，请允许本地存储后重试。')); };
    request.onblocked = () => { database = null; reject(new Error('回放存储被其他页面占用，请关闭旧版竞技台页面后重试。')); };
  });
  return database;
}

export async function packReplay(replay) {
  const blob = new Blob([JSON.stringify(replay)], { type: 'application/json' });
  if (typeof CompressionStream === 'undefined') return { codec: 'json', blob };
  return { codec: 'gzip', blob: await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob() };
}

export async function unpackReplay(value) {
  if (!value) throw new Error('未找到该局回放，可能已清理浏览器数据。');
  const blob = value.codec === 'gzip'
    ? await new Response(value.blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob()
    : value.blob;
  return JSON.parse(await blob.text());
}

function commit(db, stores, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(new Error('回放保存失败，可能是浏览器存储空间不足；已完成的比赛记录保留。'));
    action(tx);
  });
}

export async function saveTournamentSession(metadata) {
  const db = await openDatabase();
  await commit(db, ['sessions'], tx => tx.objectStore('sessions').put(metadata));
}

export async function saveTournamentRound(metadata, round, replay) {
  const packed = await packReplay(replay);
  const db = await openDatabase();
  await commit(db, ['sessions', 'replays'], tx => {
    tx.objectStore('sessions').put(metadata);
    tx.objectStore('replays').put({ key: `${metadata.id}:${round}`, ...packed });
  });
}

export async function readTournamentReplay(id, round) {
  const db = await openDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction('replays').objectStore('replays').get(`${id}:${round}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('读取回放失败，请重试。'));
  });
  return unpackReplay(value);
}

export async function latestTournament() {
  return (await listTournaments())[0] || null;
}

export async function listTournaments() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sessions').objectStore('sessions').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
    request.onerror = () => reject(new Error('读取赛程列表失败，请重试。'));
  });
}

export async function readTournamentSession(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sessions').objectStore('sessions').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('读取赛程失败。'));
  });
}

export async function deleteTournament(id) {
  const db = await openDatabase();
  await commit(db, ['sessions', 'replays'], tx => {
    tx.objectStore('sessions').delete(id);
    const prefix = `${id}:`;
    tx.objectStore('replays').delete(IDBKeyRange.bound(prefix, prefix + '\uffff'));
  });
}

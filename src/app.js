import { SnakeGame, rankSnakes, DEFAULTS } from './engine.js';
import { defaultPlayers } from './bots.js';
import { StrategyRunner } from './runner.js';
import { BoardRenderer } from './renderer.js';
import { makeReplay, validateReplay, scoreRound } from './replay.js';
import { contestantPrompt } from './contestant-prompt.js';
import { restorePlayers, createPlayer, validColor, starterSource } from './players.js';
import { makeSchedule, filterGames, tournamentMetadata } from './tournament.js';
import { saveTournamentSession, saveTournamentRound, readTournamentReplay, listTournaments, readTournamentSession, deleteTournament } from './tournament-store.js';

import { LEAGUES, emptyRanking, leagueMembers, placementTier, planRanked, boundarySelection, rankedCount, makeRankSchedule, analyzeTournament } from './ranking.js';
import { readRankingStore, registerContestant, importRankedTournament, updateContestantAppearance } from './ranking-store.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = value => String(value).padStart(3, '0');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const renderer = new BoardRenderer($('board'));
const templates = defaultPlayers();
let players = loadPlayers();
let selectedId = players[0].id;
let dirty = false;
let page = 'ranking';
let registrations = [];
let ranking = emptyRanking();
let rankingReady = false;
let historyLimit = 10;
let game;
let runner;
let frames = [];
let frameIndex = 0;
let phase = 'ready';
let replayMode = false;
let replayConfig = null;
let replaySeed = '';
let replayLabel = '';
let replayLoadRequest = 0;
let tournamentPage = 1;
let epoch = 0;
let busy = false;
let timer;
let toastTimer;
let tournament = null;
let tournamentArchive = [];
let archiveBusy = false;
let examplesExpanded = false;

function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
}

function loadPlayers() {
  try {
    const saved = JSON.parse(localStorage.getItem('snake-arena-players-v1'));
    const restored = restorePlayers(saved, templates);
    if (restored) return restored;
  } catch { /* Missing or damaged saved settings fall back to the examples. */ }
  return defaultPlayers();
}

function persist() {
  try { localStorage.setItem('snake-arena-players-v1', JSON.stringify(players)); }
  catch { toast('浏览器未能保存策略；可以下载代码备份。'); }
}

function activePlayers() { return players.filter(p => p.enabled); }
function locked() { return !rankingReady || archiveBusy || phase === 'running' || phase === 'initializing' || Boolean(tournament?.running); }
function options() {
  const foodTarget = Number($('food-target').value);
  if (!Number.isInteger(foodTarget) || foodTarget < 1 || foodTarget > 180) throw new Error('基础食物数量需要是1～180的整数');
  if (activePlayers().length < 2) throw new Error('请至少勾选两名参赛选手');
  if (activePlayers().length > 10) throw new Error('每场比赛最多勾选10名选手');
  return { ...DEFAULTS, seed: $('seed').value.trim() || 'SNAKE-2026', foodTarget };
}

function showPage(next) {
  if (page === 'lab' && dirty && !savePlayer(false)) return;
  page = next;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + next));
  document.querySelectorAll('.nav-button').forEach(el => { el.classList.toggle('active', el.dataset.page === next); el.setAttribute('aria-current', el.dataset.page === next ? 'page' : 'false'); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetMatch(quiet = false) {
  if (tournament?.running) { if (!quiet) toast('请先停止多局测试。'); return; }
  try {
    const settings = options();
    epoch++; clearTimeout(timer); runner?.dispose(); runner = null; busy = false;
    replayLoadRequest++; replayMode = false; replayConfig = null; replayLabel = ''; phase = 'ready';
    game = new SnakeGame(activePlayers(), settings);
    frames = [game.snapshot()]; frameIndex = 0;
    renderer.focus = null;
    refresh();
  } catch (error) { toast(error.message); }
}

function refresh() {
  renderPrompt();
  const frame = frames[frameIndex];
  if (!frame) return;
  const config = replayMode ? replayConfig : game.config;
  const lastIndex = frames.length - 1;
  const alive = frame.snakes.filter(s => s.alive).length;
  renderer.draw(frame, config);
  $('alive-count').textContent = alive;
  $('food-count').textContent = frame.food.length;
  $('occupied-count').textContent = (new Set(frame.snakes.filter(s => s.alive).flatMap(s => s.body)).size / (config.width * config.height) * 100).toFixed(1);
  $('turn-display').innerHTML = `回合 <b>${pad(frame.turn)}</b> / ${config.maxTurns}`;
  $('seed-display').textContent = replayMode ? replaySeed : game.seed;
  $('timeline').max = lastIndex; $('timeline').value = frameIndex;
  $('timeline').disabled = phase === 'running' || phase === 'initializing' || lastIndex === 0;
  $('timeline-position').textContent = pad(frame.turn); $('timeline-end').textContent = pad(lastIndex);
  const labels = { ready: '准备就绪', initializing: '加载策略', running: replayMode ? '回放中' : '比赛进行中', paused: frameIndex < lastIndex ? '历史回合' : '已暂停', done: replayMode ? '回放结束' : '比赛结束' };
  $('match-status').textContent = labels[phase];
  $('match-dot').className = 'status-dot' + (phase === 'running' ? ' busy' : phase === 'done' ? ' done' : '');
  $('start-match').innerHTML = phase === 'running' ? '暂停 <span>Ⅱ</span>' : phase === 'initializing' ? '加载中…' : phase === 'ready' ? '开始比赛 <span>▶</span>' : phase === 'done' ? (replayMode ? '重新播放 <span>↻</span>' : '再赛一局 <span>↻</span>') : (replayMode ? '播放回放 <span>▶</span>' : '继续比赛 <span>▶</span>');
  $('start-match').disabled = phase === 'initializing' || Boolean(tournament?.running && !replayMode);
  $('step-match').disabled = phase === 'initializing' || phase === 'running' || Boolean(tournament?.running && !replayMode) || (phase === 'done' && !replayMode);
  $('reset-match').disabled = Boolean(tournament?.running);
  $('board-overlay').hidden = phase !== 'ready';
  $('board-overlay').querySelector('h3').textContent = `${activePlayers().length} 个策略，等待交锋`;
  $('board-corner-text').textContent = replayMode ? `${replayLabel || '回放记录'} · 不执行策略` : '同步回合 · 完整信息';
  $('back-to-tournament').hidden = !replayLabel;
  $('export-replay').disabled = frames.length < 2;
  $('import-replay').disabled = locked();
  $('playback-hint').textContent = replayMode ? `${replayLabel || '导入回放'}：播放实际局面记录，不运行参赛代码。` : frameIndex < lastIndex ? '正在查看历史回合；继续比赛会回到最新局面。' : '比赛过程自动录制；暂停后可拖动查看历史回合。';
  for (const id of ['seed', 'food-target', 'random-seed']) $(id).disabled = locked();
  $('player-count').textContent = `${activePlayers().length} / 10`;
  $('ranking-title').textContent = frame.done ? '最终排名' : '实时排名';
  renderLeaderboard(frame); renderEvents(frameIndex); renderLock();
}

function renderLeaderboard(frame) {
  const ranking = rankSnakes(frame.snakes);
  $('leaderboard').innerHTML = ranking.map(s => `<div class="leader-row ${renderer.focus === s.id ? 'focused' : ''}" data-focus="${s.id}" role="button" tabindex="0" aria-label="聚焦${escape(s.name)}"><span class="leader-rank">${String(s.rank).padStart(2, '0')}</span><span class="player-dot" style="--player-color:${s.color}"></span><div class="leader-info"><div class="leader-name">${escape(s.name)}</div><div class="leader-subline ${s.alive ? '' : 'dead'}"><span class="status-dot"></span>${s.alive ? '存活' : `第${s.deathTurn}回合 · ${escape(s.deathReason)}`}</div></div><div class="leader-score">${s.score}<span>${s.alive ? '长度 / 分' : '冻结分数'}</span></div></div>`).join('');
  $('winner-summary').hidden = !frame.done;
  if (frame.done) {
    const winners = ranking.filter(s => s.rank === 1);
    $('winner-summary').textContent = `${winners.length > 1 ? '并列第一' : '本局第一'}：${winners.map(s => s.name).join('、')} · ${winners[0].score}分。${frame.turn >= 500 ? '完成500回合。' : '所有玩家已死亡，提前结算。'}`;
  }
}

function renderEvents(toIndex) {
  const items = [];
  for (let i = 0; i <= toIndex; i++) {
    for (const event of frames[i].events) {
      if (event.type === 'eat') continue;
      const snake = frames[i].snakes.find(s => s.id === event.id);
      let message, tag = '';
      if (event.type === 'death') { message = `${event.name} · ${event.reason}，分数冻结为 ${event.score}`; tag = '淘汰'; }
      if (event.type === 'drop') { message = `${event.name} 留下 ${event.count} 个食物`; tag = '掉落'; }
      if (event.type === 'finish') { message = `${event.reason}，按分数结算全部玩家`; tag = '结算'; }
      if (message) items.push({ turn: i, message, tag, color: snake?.color || '#b9fa74' });
    }
  }
  $('event-count').textContent = items.length ? `${items.length} 条记录` : phase === 'ready' ? '等待开赛' : '争夺食物中';
  $('events').innerHTML = items.length ? items.slice(-40).reverse().map(e => `<div class="event-row"><span class="event-turn">T ${pad(e.turn)}</span><span class="player-dot" style="--player-color:${e.color}"></span><span class="event-message">${escape(e.message)}</span><span class="event-tag">${e.tag}</span></div>`).join('') : `<div class="empty-inline">${phase === 'ready' ? '每一次淘汰、食物掉落和名次变化，都留在这里。' : '蛇群正在发育，等待第一次交锋。'}</div>`;
}

function renderLock() {
  const isLocked = locked();
  for (const id of ['add-player', 'save-player', 'restore-player', 'restore-all', 'upload-strategy', 'player-name', 'player-role', 'player-color-picker', 'player-color-hex', 'code-editor', 'test-strategy', 'run-tournament', 'tournament-rounds', 'tournament-custom-rounds', 'tournament-seed', 'random-tournament-seed', 'new-tournament', 'save-tournament', 'tournament-name', 'use-tournament-roster']) $(id).disabled = isLocked;
  const historical = tournament && !isDraftTournament(tournament);
  for (const id of ['run-tournament', 'tournament-rounds', 'tournament-custom-rounds', 'tournament-seed', 'random-tournament-seed', 'use-tournament-roster']) $(id).disabled ||= Boolean(historical);
  $('save-tournament').disabled ||= !tournament;
  $('tournament-edit-hint').textContent = historical
    ? '正在查看已开赛的记录。可修改名称并保存；准备下一组比赛请点击“新增赛程”。'
    : '开始前可修改名称、局数和种子。保存后，重新打开也能继续准备这份赛程。';
  const registered = registrationFor(players.find(p => p.id === selectedId));
  $('player-name').readOnly = Boolean(registered); $('code-editor').readOnly = Boolean(registered);
  for (const id of ['upload-strategy', 'restore-player']) $(id).disabled ||= Boolean(registered);
  $('restore-all').disabled = true; $('restore-all').hidden = true;
  $('register-player').disabled = isLocked || Boolean(registered);
  $('clone-player').disabled = isLocked;
  for (const id of ['generate-ranked', 'ranked-select-active', 'ranked-rounds', 'ranked-first', 'ranked-second', 'ranked-third', 'ranked-boundary-one', 'ranked-boundary-two']) $(id).disabled = isLocked;
  document.querySelectorAll('[data-ranked-id], [data-place-candidate]').forEach(el => { el.disabled = isLocked; });
  $('use-tournament-roster').disabled ||= Boolean(tournament?.rankPlan);
  renderImportEligibility();
  renderTournamentLibrary();
  document.querySelectorAll('.roster-row input').forEach(el => { el.disabled = isLocked; });
}

async function initializeMatch() {
  try { options(); } catch (error) { toast(error.message); return false; }
  const token = epoch;
  phase = 'initializing'; refresh();
  const nextRunner = new StrategyRunner(activePlayers().map(p => ({ ...p })), game.seed, 50);
  runner = nextRunner;
  await nextRunner.initialize();
  if (token !== epoch) { nextRunner.dispose(); return false; }
  phase = 'paused'; refresh(); return true;
}

async function advance() {
  if (busy || !runner) return;
  const token = epoch; busy = true;
  try {
    const actions = await runner.decide(game);
    if (token !== epoch) return;
    frames.push(game.step(actions)); frameIndex = frames.length - 1;
    runner.retire(game);
    if (game.done) { phase = 'done'; runner.dispose(); runner = null; }
    refresh();
  } catch (error) {
    if (token === epoch) { phase = 'paused'; toast('比赛暂停：' + error.message); refresh(); }
  } finally { if (token === epoch) busy = false; }
}

async function playbackLoop(token) {
  if (token !== epoch || phase !== 'running') return;
  const start = performance.now();
  if (replayMode) {
    if (frameIndex < frames.length - 1) frameIndex++;
    if (frameIndex === frames.length - 1) phase = 'done';
    refresh();
  } else await advance();
  if (token !== epoch || phase !== 'running') return;
  const speed = Number($('speed').value);
  const delay = speed ? Math.max(0, 1000 / speed - (performance.now() - start)) : 0;
  timer = setTimeout(() => playbackLoop(token), delay);
}

async function startOrPause() {
  if ((tournament?.running && !replayMode) || phase === 'initializing') return;
  if (phase === 'running') { phase = 'paused'; clearTimeout(timer); refresh(); return; }
  if (replayMode) {
    if (frameIndex >= frames.length - 1) frameIndex = 0;
    phase = 'running'; refresh(); playbackLoop(epoch); return;
  }
  if (phase === 'done') resetMatch(true);
  if (phase === 'ready' && !await initializeMatch()) return;
  frameIndex = frames.length - 1;
  phase = 'running'; refresh(); playbackLoop(epoch);
}

async function singleStep() {
  if (phase === 'running' || phase === 'initializing' || (tournament?.running && !replayMode)) return;
  if (replayMode) { frameIndex = Math.min(frames.length - 1, frameIndex + 1); phase = frameIndex === frames.length - 1 ? 'done' : 'paused'; refresh(); return; }
  if (phase === 'done') return;
  if (phase === 'ready' && !await initializeMatch()) return;
  frameIndex = frames.length - 1; await advance();
}

function renderRoster() {
  const previousFolder = $('example-strategies');
  if (previousFolder) examplesExpanded = previousFolder.open;
  updateTournamentPlan();
  $('roster-count').textContent = `${activePlayers().length} / 10 参赛 · 共 ${players.length} 名`;
  const exampleIds = new Set(players.filter(p => registrationFor(p)?.kind === 'system').map(p => p.id));
  const examples = players.filter(p => exampleIds.has(p.id));
  const custom = players.filter(p => !exampleIds.has(p.id));
  const row = p => `<div class="roster-row ${p.id === selectedId ? 'selected' : ''}" data-player="${p.id}" role="button" tabindex="0" aria-label="编辑${escape(p.name)}"><input type="checkbox" ${p.enabled ? 'checked' : ''} data-enabled="${p.id}" aria-label="${escape(p.name)}参赛"><span class="player-dot" style="--player-color:${p.color}"></span><div class="roster-info"><strong>${escape(p.name)}</strong><small>${escape(registrationFor(p) ? (registrationFor(p).kind === 'system' ? '系统选手 · 已注册' : '注册选手') : (p.role || '未注册草稿'))}</small></div><span class="edit-chevron">›</span></div>`;
  $('roster').innerHTML = `<div class="roster-group-label">我的选手 <span>${custom.length} 名</span></div>${custom.length ? custom.map(row).join('') : '<p class="roster-empty">点击上方按钮添加自己的 AI 选手。</p>'}<details id="example-strategies" class="strategy-folder" ${examplesExpanded ? 'open' : ''}><summary><span>📁 系统选手</span><small>${examples.length} 个 · ${examples.filter(p => p.enabled).length} 个参赛</small></summary><p class="folder-hint">10份初始策略已注册。展开选择参赛；修改策略请复制为新版本。</p>${examples.map(row).join('')}</details>`;
  renderLock();
}

function loadEditor() {
  const player = players.find(p => p.id === selectedId);
  $('player-name').value = player.name; $('player-role').value = player.role;
  $('player-color-picker').value = player.color; $('player-color-hex').value = player.color;
  $('code-editor').value = player.source; $('editor-title').textContent = player.name;
  $('editor-color').style.setProperty('--player-color', player.color);
  $('restore-player').textContent = templates.some(p => p.id === player.id) ? '恢复示例代码' : '载入入门代码';
  dirty = false; $('editor-save-state').textContent = '已保存'; $('strategy-test-result').hidden = true;
  const registration = registrationFor(player);
  $('registration-status').textContent = registration ? (registration.kind === 'system' ? '系统选手 · 已注册' : '注册选手 · 已锁定') : '未注册草稿';
  $('registration-hint').textContent = registration ? '名称与代码已锁定。颜色和标签可调整；改策略请复制为新版本并重新注册。' : '保存名称与代码后注册，即可参加排位。注册后名称与代码不可修改。';
  renderLock();
}

function savePlayer(notify = true) {
  if (locked()) { if (notify) toast('比赛进行中，请暂停后再修改策略。'); return false; }
  const player = players.find(p => p.id === selectedId);
  if ($('code-editor').value.length > 200000) { toast('策略代码不能超过200,000个字符。'); return false; }
  const color = $('player-color-hex').value.trim();
  if (!validColor(color)) { toast('颜色请填写六位色值，例如 #66ccff，或使用颜色选择器。'); $('player-color-hex').focus(); return false; }
  const registration = registrationFor(player);
  if (registration && ($('player-name').value !== registration.name || $('code-editor').value !== registration.source)) { toast('注册名称与代码已锁定，请复制为新版本。'); loadEditor(); return false; }
  player.name = $('player-name').value.trim() || `选手 ${player.id}`;
  player.color = color.toLowerCase();
  player.role = $('player-role').value.trim() || '自定义策略'; player.source = $('code-editor').value;
  if (registration && (registration.color !== player.color || registration.role !== player.role)) {
    registration.color = player.color; registration.role = player.role;
    renderRanking(); renderRegisteredChoices();
    updateContestantAppearance({ ...player }).catch(error => toast('注册资料未保存：' + error.message));
  }
  persist(); dirty = false; $('editor-save-state').textContent = '已保存'; $('editor-title').textContent = player.name;
  renderRoster();
  $('editor-color').style.setProperty('--player-color', player.color);
  if (phase === 'ready') resetMatch(true);
  if (notify) toast('策略已保存，下一场比赛使用新代码。');
  return true;
}

function addPlayer() {
  if (locked() || (dirty && !savePlayer(false))) return;
  const player = createPlayer(players);
  players.push(player); selectedId = player.id;
  persist(); renderRoster(); loadEditor();
  if (player.enabled) { $('food-target').value = 20 + 4 * activePlayers().length; resetMatch(true); }
  $('player-name').focus(); $('player-name').select();
  toast(player.enabled ? '已添加选手，请自定义名称、颜色和代码后保存。' : '已添加候选选手；当前10人满员，取消一名选手后可勾选新选手参赛。');
}

function setDirty() { dirty = true; $('editor-save-state').textContent = '未保存'; }

async function download(name, content, mime = 'application/json') {
  try {
    const response = await fetch('/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content, type: mime }) });
    if (!response.ok) throw new Error('导出失败，请确认本地服务正在运行且文件未超过20MB。');
    const result = await response.json();
    toast(`已保存到项目exports文件夹：${result.filename}`);
    $('export-file-link').href = result.url;
    $('export-file-link').textContent = '下载刚导出的文件 ↗';
    $('export-result').hidden = false;
    $('export-file-name').textContent = result.filename;
  } catch (error) { toast(error.message); }
}

function renderPrompt() {
  const value = contestantPrompt(Number($('food-target').value) || 60);
  if ($('contestant-prompt').value !== value) $('contestant-prompt').value = value;
  return value;
}

async function copyPrompt() {
  const value = renderPrompt();
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    showPage('guide');
    const preview = $('contestant-prompt');
    preview.focus(); preview.select();
    if (!document.execCommand('copy')) {
      toast('浏览器未允许自动复制，已选中全文，请按 Ctrl+C 复制。');
      return;
    }
  }
  toast('参赛提示词已复制，直接粘贴给AI即可生成策略。');
}

async function downloadAgentKit() {
  const button = $('download-agent-kit'); button.disabled = true;
  try {
    const response = await fetch('/api/agent-kit', { method: 'POST' });
    if (!response.ok) throw new Error('资料打包失败；更新后请关闭并重新启动竞技台服务。');
    const result = await response.json();
    $('agent-kit-link').href = result.url; $('agent-kit-link').download = result.filename;
    $('agent-kit-filename').textContent = result.filename; $('agent-kit-result').hidden = false;
    $('agent-kit-link').click();
    toast('资料包已保存到 exports 文件夹，包含提示词、空白地图和 Agent 测试工具。');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function testStrategy() {
  if (locked()) return;
  if (!savePlayer(false)) return;
  const player = players.find(p => p.id === selectedId);
  const testPlayers = [player, { ...templates[0], id: Math.max(...players.map(p => p.id)) + 1 }];
  const testGame = new SnakeGame(testPlayers, { seed: 'STRATEGY-CHECK', foodTarget: 28 });
  const testRunner = new StrategyRunner(testPlayers, testGame.seed);
  $('test-strategy').disabled = true;
  $('strategy-test-result').hidden = false; $('strategy-test-result').className = 'test-result';
  $('strategy-test-result').textContent = '正在加载代码并检查前12步…';
  try {
    await testRunner.initialize();
    let elapsed = 0;
    for (let i = 0; i < 12 && !testGame.done; i++) {
      const actions = await testRunner.decide(testGame);
      testGame.step(actions); testRunner.retire(testGame);
      const me = testGame.snakes.find(s => s.id === player.id);
      const slot = testRunner.slots.get(player.id);
      elapsed = Math.max(elapsed, slot?.elapsed || 0);
      if (!me.alive) throw new Error(`第${testGame.turn}步：${me.deathReason}${slot?.detail ? ' · ' + slot.detail : ''}`);
    }
    $('strategy-test-result').textContent = `接口检查通过 · 前${testGame.turn}步存活 · 单步最大执行耗时${elapsed.toFixed(2)}ms。完整对战仍可能出现碰撞风险。`;
  } catch (error) {
    $('strategy-test-result').className = 'test-result error'; $('strategy-test-result').textContent = error.message;
  } finally { testRunner.dispose(); renderLock(); }
}

function tournamentCount() {
  const count = Number($('tournament-rounds').value === 'custom' ? $('tournament-custom-rounds').value : $('tournament-rounds').value);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('测试局数需要是1～1000的整数');
  return count;
}

function randomTournamentSeed() {
  const values = new Uint32Array(2); crypto.getRandomValues(values);
  $('tournament-seed').value = 'CUP-' + [...values].map(v => v.toString(16).padStart(8, '0')).join('');
}

function updateTournamentPlan() {
  $('tournament-custom-field').hidden = $('tournament-rounds').value !== 'custom';
  try {
    const count = tournamentCount(), n = tournament?.stats.length || activePlayers().length;
    if (tournament?.rankPlan?.kind === 'placement' && n === 11) { $('tournament-plan').textContent = `${count}局 · 每100局覆盖10种对手组合，每组10局轮换位置；定位选手全程参赛，其余10名对手各参赛90局。`; return; }
    const full = Math.floor(count / n), remainder = count % n;
    $('tournament-plan').textContent = `${count}局 · ${Math.ceil(count / n)}组地图种子 · 每${n}局完整轮换出生位置。${remainder ? `末组${remainder}局，各出生位置的使用次数最多相差1。` : `每名选手在每个出生位置恰好参赛${full}次。`}`;
  } catch (error) { $('tournament-plan').textContent = error.message; }
}

async function runTournament() {
  if (locked() || (tournament && !isDraftTournament(tournament))) return;
  let session = null;
  try {
    const count = tournamentCount();
    if (page === 'lab' && dirty && !savePlayer(false)) return;
    const draft = tournament || buildTournamentDraft();
    const settings = { ...draft.config };
    const contestants = draft.contestants?.map(p => ({ ...p }));
    if (!contestants?.length) throw new Error('请先选择“使用当前参赛选手”保存参赛策略。');
    const masterSeed = $('tournament-seed').value.trim() || 'ARENA-CUP';
    if (draft.rankPlan && draft.rankPlan.revision !== ranking.revision) throw new Error('排行榜已变化，请重新生成排位赛程');
    if (draft.rankPlan && count !== rankedCount(draft.rankPlan, count)) throw new Error('排位局数必须不少于50且完整轮换，请使用生成时的局数');
    const schedule = makeRankSchedule(contestants, count, masterSeed, draft.rankPlan);
    const byId = new Map(contestants.map(p => [p.id, p]));
    epoch++; clearTimeout(timer); runner?.dispose(); runner = null; phase = 'paused';
    session = { ...draft, name: $('tournament-name').value.trim() || draft.name, startedAt: new Date().toISOString(), status: 'running', masterSeed, config: settings, contestants,
      running: true, cancelled: false, total: count, completed: 0, games: [], runner: null,
      stats: contestants.map(p => ({ id: p.id, name: p.name, color: p.color, points: 0, score: 0, wins: 0, alive: 0, games: 0 })) };
    tournament = session; tournamentPage = 1;
    $('tournament-search').value = ''; $('tournament-winner').value = '';
    renderWinnerFilter();
    $('stop-tournament').disabled = false; $('export-tournament').disabled = true;
    refresh(); renderTournament();
    await saveTournamentSession(tournamentMetadata(session));
    for (const entry of schedule) {
      if (session.cancelled) break;
      const { seed, rotation, round, order, cycle } = entry;
      const orderedPlayers = order.map(id => byId.get(id));
      const match = new SnakeGame(orderedPlayers, { ...settings, seed, rotation });
      const matchFrames = [match.snapshot()];
      const localRunner = new StrategyRunner(orderedPlayers, seed); session.runner = localRunner;
      session.currentRound = round; session.currentTurn = 0; renderTournamentStatus();
      await localRunner.initialize();
      while (!match.done && !session.cancelled) {
        const actions = await localRunner.decide(match);
        if (session.cancelled) break;
        matchFrames.push(match.step(actions)); localRunner.retire(match);
        if (match.turn % 20 === 0) {
          session.currentTurn = match.turn; renderTournamentStatus(); await wait(0);
        }
      }
      localRunner.dispose(); session.runner = null;
      if (session.cancelled) break;
      const results = scoreRound(match.snakes);
      const nextStats = session.stats.map(stat => {
        const result = results.find(s => s.id === stat.id);
        if (!result) return stat;
        return { ...stat, points: stat.points + result.points, score: stat.score + result.score,
          wins: stat.wins + (result.rank === 1 ? 1 : 0), alive: stat.alive + (result.alive ? 1 : 0), games: stat.games + 1 };
      });
      const nextGame = { round, seed, rotation, order, cycle, turns: match.turn, results: results.map(({ body, ...s }) => s) };
      const next = { ...session, completed: session.completed + 1, stats: nextStats, games: [...session.games, nextGame] };
      await saveTournamentRound(tournamentMetadata(next), round, makeReplay(match.config, seed, matchFrames));
      session.completed = next.completed; session.stats = nextStats; session.games = next.games;
      $('export-tournament').disabled = false;
      renderTournament(); await wait(0);
    }
    toast(session.cancelled ? `测试已停止，保留${session.completed}局完整结果与回放。` : `${session.completed}局测试完成，每局回放均已保存。`);
  } catch (error) {
    if (session) session.error = error.message;
    toast(error.message);
  } finally {
    if (session) {
      session.running = false; session.status = session.completed === session.total ? 'completed' : session.error ? 'interrupted' : 'stopped'; session.runner?.dispose(); session.runner = null;
      try { await saveTournamentSession(tournamentMetadata(session)); } catch { /* Existing committed rounds remain intact. */ }
      $('stop-tournament').disabled = true; $('export-tournament').disabled = session.completed === 0;
      renderTournament();
      if (!replayMode) resetMatch(true); else refresh();
      renderLock();
    }
  }
}

function renderTournamentStatus() {
  if (!tournament) return;
  const t = tournament;
  $('tournament-status').textContent = t.running
    ? `第${t.currentRound || 1}/${t.total}局 · 回合${t.currentTurn || 0}/500 · 已完成${t.completed}局`
    : `${isDraftTournament(t) ? '未开始' : t.error ? '已中断' : t.completed === t.total ? '已完成' : '已停止'} · ${t.completed}/${t.total}局`;
}

function renderWinnerFilter() {
  const selected = $('tournament-winner').value;
  $('tournament-winner').innerHTML = '<option value="">全部获胜者</option>' + (tournament?.stats || []).map(p => `<option value="${p.id}">${escape(p.name)}</option>`).join('');
  if ([...$('tournament-winner').options].some(o => o.value === selected)) $('tournament-winner').value = selected;
}

function renderTournamentGames() {
  const games = filterGames(tournament?.games || [], $('tournament-search').value, $('tournament-winner').value);
  const pages = Math.max(1, Math.ceil(games.length / 20));
  tournamentPage = Math.min(pages, Math.max(1, tournamentPage));
  $('tournament-list-info').textContent = `${games.length}局符合筛选 · 第${tournamentPage}/${pages}页`;
  $('tournament-prev').disabled = tournamentPage <= 1; $('tournament-next').disabled = tournamentPage >= pages;
  $('tournament-games').innerHTML = games.length ? games.slice((tournamentPage - 1) * 20, tournamentPage * 20).map(g => `<article class="game-chip"><div class="game-chip-heading"><strong>第${g.round}局</strong><span>${g.turns}回合</span></div><b>${escape(g.results.filter(s => s.rank === 1).map(s => s.name).join('、'))}</b><span class="game-seed">${escape(g.seed)}</span><small>第${g.cycle || Math.floor((g.round - 1) / tournament.stats.length) + 1}组 · 公平位置轮换</small><button class="button secondary" data-tournament-replay="${g.round}">查看第${g.round}局回放 ↗</button></article>`).join('') : '<p class="tournament-empty">暂无符合筛选的完整比赛。每局完成后会自动出现在这里。</p>';
}

function renderTournament() {
  if (!tournament) return;
  const t = tournament;
  updateArchiveEntry(tournamentMetadata(t)); renderTournamentLibrary();
  $('tournament-progress-bar').style.width = `${t.completed / t.total * 100}%`;
  renderTournamentStatus();
  $('tournament-session-info').textContent = `${t.name || t.masterSeed} · 赛程种子：${t.masterSeed} · 每局回放随赛程保存。`;
  const sorted = [...t.stats].sort((a, b) => (b.games ? b.points / b.games : 0) - (a.games ? a.points / a.games : 0) || a.id - b.id);
  let previousAverage = null, rank = 0;
  $('tournament-table').innerHTML = sorted.map((s, i) => {
    const average = s.games ? s.points / s.games : 0;
    if (previousAverage === null || Math.abs(average - previousAverage) > 1e-8) rank = i + 1;
    previousAverage = average;
    return `<tr><td>${rank}</td><td><span class="player-dot" style="--player-color:${s.color};margin-right:9px"></span>${escape(s.name)}</td><td>${average.toFixed(1)}</td><td>${s.games ? (s.score / s.games).toFixed(1) : '—'}</td><td>${s.wins}</td><td>${s.games ? Math.round(s.alive / s.games * 100) + '%' : '—'}</td><td>${s.games}</td></tr>`;
  }).join('');
  renderTournamentGames(); renderImportEligibility();
}

async function openTournamentReplay(round) {
  const session = tournament;
  if (!session?.games.some(g => g.round === round)) return;
  const request = ++replayLoadRequest;
  try {
    const value = validateReplay(await readTournamentReplay(session.id, round));
    if (request !== replayLoadRequest || tournament !== session) return;
    epoch++; clearTimeout(timer); runner?.dispose(); runner = null; busy = false;
    frames = value.frames; frameIndex = 0; replayConfig = value.config; replaySeed = value.seed;
    replayMode = true; replayLabel = `${session.name || session.masterSeed} · 第${round}局`; phase = 'paused'; renderer.focus = null;
    showPage('arena'); refresh(); toast(`已载入第${round}局回放，可播放、单步或拖动进度查看。`);
  } catch (error) { toast(error.message); }
}

function isDraftTournament(session) {
  return session?.status === 'draft' && !session.startedAt && !session.completed && !session.running;
}

function tournamentTitle(session) { return session.name || session.masterSeed || '未命名赛程'; }
function updateArchiveEntry(metadata) {
  const index = tournamentArchive.findIndex(s => s.id === metadata.id);
  if (index < 0) tournamentArchive.push(metadata); else tournamentArchive[index] = metadata;
  tournamentArchive.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function renderTournamentLibrary() {
  const disabled = locked();
  $('tournament-library-count').textContent = `${tournamentArchive.length} 个赛程`;
  $('tournament-library-list').innerHTML = tournamentArchive.length ? tournamentArchive.map(s => {
    const label = s.status === 'draft' ? '未开始' : s.status === 'completed' ? '已完成' : s.status === 'running' && tournament?.id === s.id && tournament.running ? '进行中' : '已停止';
    const date = new Date(s.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    return `<article class="saved-tournament ${s.id === tournament?.id ? 'selected' : ''}"><button class="saved-tournament-open" data-select-tournament="${escape(s.id)}" ${disabled ? 'disabled' : ''}><strong>${escape(tournamentTitle(s))}</strong><span>${label} · ${s.completed}/${s.total}局 · ${s.stats.length}名选手</span><small>${date}</small></button><button class="text-button delete-tournament" data-delete-tournament="${escape(s.id)}" ${disabled ? 'disabled' : ''}>删除</button></article>`;
  }).join('') : '<p class="tournament-empty">还没有保存的赛程。点击“新增赛程”，设置后保存或开始。</p>';
}

function buildTournamentDraft() {
  const contestants = activePlayers().map(p => ({ ...p }));
  const createdAt = new Date().toISOString();
  const date = new Date(createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return { id: crypto.randomUUID(), name: '赛程 ' + date, createdAt, startedAt: null, status: 'draft', rankingRevision: ranking.revision, masterSeed: $('tournament-seed').value.trim() || 'ARENA-CUP',
    total: tournamentCount(), completed: 0, config: options(), contestants, running: false, cancelled: false,
    games: [], runner: null, stats: contestants.map(p => ({ id: p.id, name: p.name, color: p.color, points: 0, score: 0, wins: 0, alive: 0, games: 0 })) };
}

function displayTournament(saved) {
  if (replayMode) resetMatch(true);
  replayLoadRequest++;
  tournament = { ...saved, name: tournamentTitle(saved), running: false, cancelled: saved.completed < saved.total, runner: null };
  tournamentPage = 1; $('tournament-search').value = ''; $('tournament-winner').value = '';
  $('tournament-name').value = tournament.name;
  const preset = [...$('tournament-rounds').options].some(o => o.value === String(saved.total));
  $('tournament-rounds').value = preset ? String(saved.total) : 'custom';
  $('tournament-custom-rounds').value = saved.total;
  $('tournament-seed').value = saved.masterSeed;
  $('tournament-contestants').textContent = '参赛选手：' + saved.stats.map(p => p.name).join('、') + '。新增赛程时保存所选选手的代码快照。';
  $('export-tournament').disabled = saved.completed === 0;
  updateTournamentPlan(); renderWinnerFilter(); renderTournament(); renderLock();
}

async function newTournament() {
  if (locked()) return;
  archiveBusy = true; renderLock();
  try {
    randomTournamentSeed();
    const draft = buildTournamentDraft();
    await saveTournamentSession(tournamentMetadata(draft));
    archiveBusy = false; displayTournament(draft);
    $('tournament-name').focus(); $('tournament-name').select();
    toast('已新增并保存赛程；可修改名称、局数和种子后开始。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}

async function saveSelectedTournament(useCurrentRoster = false) {
  if (locked() || !tournament) return;
  archiveBusy = true; renderLock();
  try {
    const next = { ...tournament, name: $('tournament-name').value.trim() || tournamentTitle(tournament) };
    if (isDraftTournament(tournament)) {
      next.total = tournamentCount(); next.masterSeed = $('tournament-seed').value.trim() || 'ARENA-CUP';
      if (useCurrentRoster) {
        if (next.rankPlan) throw new Error('排位赛名单已固定，请重新生成');
        next.rankingRevision = ranking.revision;
        next.config = options(); next.contestants = activePlayers().map(p => ({ ...p }));
        next.stats = next.contestants.map(p => ({ id: p.id, name: p.name, color: p.color, points: 0, score: 0, wins: 0, alive: 0, games: 0 }));
      }
    }
    await saveTournamentSession(tournamentMetadata(next));
    archiveBusy = false; displayTournament(next);
    toast(useCurrentRoster ? '已保存当前参赛选手、颜色和策略代码快照。' : '赛程已保存。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}

async function selectSavedTournament(id) {
  if (locked()) return;
  archiveBusy = true; renderLock();
  try {
    const saved = await readTournamentSession(id);
    if (!saved) throw new Error('未找到该赛程，请刷新页面。');
    archiveBusy = false; displayTournament(saved);
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}

async function removeSavedTournament(id) {
  if (locked()) return;
  const saved = tournamentArchive.find(s => s.id === id);
  if (!saved) return;
  if (!confirm(`删除“${tournamentTitle(saved)}”？该赛程的积分榜、设置和全部${saved.completed}局回放将同时删除，无法恢复。已导入排行榜的排名与变动记录会保留。`)) return;
  archiveBusy = true; renderLock();
  try {
    await deleteTournament(id);
    tournamentArchive = tournamentArchive.filter(s => s.id !== id);
    if (tournament?.id === id) {
      if (replayMode) resetMatch(true);
      tournament = null; replayLoadRequest++;
      if (tournamentArchive.length) { archiveBusy = false; displayTournament(tournamentArchive[0]); }
      else {
        $('tournament-name').value = ''; $('tournament-contestants').textContent = '新增赛程时会保存当前勾选选手的策略代码。';
        $('tournament-status').textContent = '尚未开始'; $('tournament-progress-bar').style.width = '0%';
        $('tournament-table').innerHTML = '<tr><td colspan="7" class="table-empty">新增赛程后开始比赛。</td></tr>';
        $('tournament-session-info').textContent = '没有选中的赛程。'; $('export-tournament').disabled = true;
        renderWinnerFilter(); renderTournamentGames();
      }
    }
    toast('赛程及全部回放已删除，存储空间已释放。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}

async function restoreTournamentLibrary() {
  try {
    tournamentArchive = await listTournaments();
    if (tournament) updateArchiveEntry(tournamentMetadata(tournament));
    else {
      const saved = tournamentArchive[0];
      if (saved) displayTournament(saved);
    }
    renderLock();
  } catch (error) { toast(error.message); }
}

document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
for (const id of ['open-lab', 'manage-players']) $(id).addEventListener('click', () => showPage('lab'));
$('lab-to-arena').addEventListener('click', () => showPage('arena'));
$('start-match').addEventListener('click', startOrPause); $('overlay-start').addEventListener('click', startOrPause);
$('step-match').addEventListener('click', singleStep); $('reset-match').addEventListener('click', () => resetMatch());
$('seed').addEventListener('change', () => resetMatch(true)); $('food-target').addEventListener('change', () => resetMatch(true));
$('random-seed').addEventListener('click', () => { $('seed').value = 'SNAKE-' + Math.random().toString(36).slice(2, 8).toUpperCase(); resetMatch(true); });
$('timeline').addEventListener('input', () => { frameIndex = Number($('timeline').value); refresh(); });
$('fullscreen-board').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('board-wrap').requestFullscreen(); }
  catch { toast('浏览器不支持全屏，可以调整窗口大小查看。'); }
});
function focusRow(event) {
  const row = event.target.closest('[data-focus]'); if (!row) return;
  const id = Number(row.dataset.focus); renderer.focus = renderer.focus === id ? null : id; refresh();
}
$('leaderboard').addEventListener('click', focusRow);
$('leaderboard').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusRow(event); } });
$('roster').addEventListener('click', event => {
  if (event.target.matches('input')) return;
  const row = event.target.closest('[data-player]'); if (!row) return;
  if (dirty && !savePlayer(false)) return; selectedId = Number(row.dataset.player); renderRoster(); loadEditor();
});
$('roster').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-player]')) { event.preventDefault(); event.target.click(); } });
$('roster').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-enabled]'); if (!checkbox) return;
  const player = players.find(p => p.id === Number(checkbox.dataset.enabled));
  if (locked() || (!checkbox.checked && activePlayers().length <= 2)) { checkbox.checked = player.enabled; toast('每场比赛至少需要两名选手。'); return; }
  if (checkbox.checked && !player.enabled && activePlayers().length >= 10) { checkbox.checked = false; toast('每场最多10名选手，请先取消另一名选手。'); return; }
  player.enabled = checkbox.checked; persist(); $('food-target').value = 20 + 4 * activePlayers().length;
  renderRoster(); resetMatch(true);
});
for (const id of ['player-name', 'player-role', 'code-editor']) $(id).addEventListener('input', setDirty);
$('player-color-picker').addEventListener('input', () => {
  $('player-color-hex').value = $('player-color-picker').value;
  $('editor-color').style.setProperty('--player-color', $('player-color-picker').value); setDirty();
});
$('player-color-hex').addEventListener('input', () => {
  const color = $('player-color-hex').value.trim();
  if (validColor(color)) { $('player-color-picker').value = color; $('editor-color').style.setProperty('--player-color', color); }
  setDirty();
});
$('add-player').addEventListener('click', addPlayer);
$('code-editor').addEventListener('keydown', event => {
  if (event.key === 'Tab' && !event.target.readOnly) {
    event.preventDefault(); const textarea = event.target; const start = textarea.selectionStart;
    textarea.setRangeText('  ', start, textarea.selectionEnd, 'end'); setDirty();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); savePlayer(); }
});
$('save-player').addEventListener('click', () => savePlayer());
$('restore-player').addEventListener('click', () => {
  if (locked() || registrationFor(players.find(p => p.id === selectedId))) return;
  if (!confirm('用入门或示例代码替换当前代码？名称和颜色保留。')) return;
  const player = players.find(p => p.id === selectedId);
  player.source = templates.find(p => p.id === selectedId)?.source || starterSource;
  persist(); renderRoster(); loadEditor(); if (phase === 'ready') resetMatch(true); toast('已载入策略代码，名称和颜色保留。');
});
$('restore-all').addEventListener('click', () => {
  if (locked() || !confirm('恢复10名示例选手的名称、颜色和代码？新增的自定义选手保留，参赛勾选保留。')) return;
  players = players.map(p => { const template = templates.find(t => t.id === p.id); return template ? { ...template, enabled: p.enabled } : p; });
  persist(); renderRoster(); loadEditor(); resetMatch(true); toast('已恢复示例选手，新增选手和参赛勾选保留。');
});
$('upload-strategy').addEventListener('click', () => $('strategy-file').click());
$('strategy-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (locked()) throw new Error('请暂停比赛后再导入策略');
    if (registrationFor(players.find(p => p.id === selectedId))) throw new Error('注册代码已锁定，请复制为新版本再导入');
    if (file.size > 600000) throw new Error('策略文件太大');
    const source = await file.text(); if (source.length > 200000) throw new Error('策略不能超过200,000个字符');
    $('code-editor').value = source; $('player-role').value = '自定义策略'; setDirty();
    toast(`已载入${file.name}，保存后即可参赛。`);
  } catch (error) { toast(error.message); } finally { event.target.value = ''; }
});
$('download-strategy').addEventListener('click', () => download(`strategy-${selectedId}.js`, $('code-editor').value, 'text/javascript'));
$('test-strategy').addEventListener('click', testStrategy);
for (const id of ['copy-prompt', 'guide-copy-prompt', 'lab-copy-prompt', 'prompt-copy']) $(id).addEventListener('click', copyPrompt);
$('download-agent-kit').addEventListener('click', downloadAgentKit);
$('export-replay').addEventListener('click', () => {
  const config = replayMode ? replayConfig : game.config, seed = replayMode ? replaySeed : game.seed;
  download(`snake-arena-${seed.replace(/[^a-zA-Z0-9_-]/g, '_')}-T${frames.length - 1}.json`, JSON.stringify(makeReplay(config, seed, frames)));
});
$('import-replay').addEventListener('click', () => $('replay-file').click());
$('replay-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (locked()) throw new Error('请先暂停比赛');
    if (file.size > 20 * 1024 * 1024) throw new Error('回放不能超过20MB');
    const value = validateReplay(JSON.parse(await file.text()));
    epoch++; clearTimeout(timer); runner?.dispose(); runner = null; busy = false;
    frames = value.frames; frameIndex = 0; replayConfig = value.config; replaySeed = value.seed; replayLoadRequest++; replayMode = true; replayLabel = ''; phase = 'paused'; renderer.focus = null;
    refresh(); toast(`已载入${frames.length - 1}回合的回放。`);
  } catch (error) { toast(error instanceof SyntaxError ? '回放文件不是有效的JSON。' : error.message); }
  finally { event.target.value = ''; }
});
$('run-tournament').addEventListener('click', runTournament);
$('stop-tournament').addEventListener('click', () => { if (tournament?.running) { tournament.cancelled = true; tournament.runner?.dispose(); $('tournament-status').textContent = '正在停止…'; } });
$('export-tournament').addEventListener('click', () => {
  if (!tournament?.completed) return;
  download('snake-arena-tournament.json', JSON.stringify({ format: 'snake-arena-tournament', version: 2, ...tournamentMetadata(tournament) }, null, 2));
});
$('close-export').addEventListener('click', () => { $('export-result').hidden = true; });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

renderRoster(); loadEditor(); resetMatch(true);

$('tournament-rounds').addEventListener('change', updateTournamentPlan);
$('tournament-custom-rounds').addEventListener('input', updateTournamentPlan);
$('random-tournament-seed').addEventListener('click', randomTournamentSeed);
$('tournament-search').addEventListener('input', () => { tournamentPage = 1; renderTournamentGames(); });
$('tournament-winner').addEventListener('change', () => { tournamentPage = 1; renderTournamentGames(); });
$('tournament-prev').addEventListener('click', () => { tournamentPage--; renderTournamentGames(); });
$('tournament-next').addEventListener('click', () => { tournamentPage++; renderTournamentGames(); });
$('tournament-games').addEventListener('click', event => {
  const button = event.target.closest('[data-tournament-replay]');
  if (button) openTournamentReplay(Number(button.dataset.tournamentReplay));
});
$('back-to-tournament').addEventListener('click', () => showPage('tournament'));
randomTournamentSeed(); updateTournamentPlan(); restoreTournamentLibrary(); initializeRegistry();

$('new-tournament').addEventListener('click', newTournament);
$('save-tournament').addEventListener('click', () => saveSelectedTournament());
$('use-tournament-roster').addEventListener('click', () => saveSelectedTournament(true));
$('tournament-library-list').addEventListener('click', event => {
  const open = event.target.closest('[data-select-tournament]');
  const remove = event.target.closest('[data-delete-tournament]');
  if (open) selectSavedTournament(open.dataset.selectTournament);
  else if (remove) removeSavedTournament(remove.dataset.deleteTournament);
});


function registrationFor(player) { return player && registrations.find(r => r.id === player.registrationId && r.name === player.name && r.source === player.source); }
function reconcileRegistry() {
  for (const player of players) {
    const binding = registrations.find(r => r.id === player.registrationId);
    if (binding) { player.name = binding.name; player.source = binding.source; }
    else player.registrationId = registrations.find(r => r.name === player.name && r.source === player.source)?.id || null;
  }
  for (const r of registrations) {
    if (players.some(p => p.registrationId === r.id)) continue;
    players.push({ id: Math.max(...players.map(p => p.id)) + 1, name: r.name, color: r.color, role: r.role || '注册选手', source: r.source, registrationId: r.id, enabled: false });
  }
  persist();
}
async function initializeRegistry() {
  try {
    for (const template of templates) await registerContestant(template, 'system', 'system-' + template.id);
    const saved = await readRankingStore(); registrations = saved.registrations; ranking = saved.ranking;
    reconcileRegistry(); rankingReady = true;
    renderRoster(); loadEditor(); renderRanking(); renderRegisteredChoices(); refresh();
  } catch (error) { $('ranking-count').textContent = error.message; toast(error.message); }
}
function renderRanking() {
  const byId = new Map(registrations.map(r => [r.id, r]));
  $('ranking-count').textContent = registrations.length + ' 名注册选手 · ' + ranking.order.length + ' 个在榜席位 / 30 · 三级联赛';
  $('ranking-revision').textContent = ranking.updatedAt ? '第 ' + ranking.revision + ' 次排名调整 · ' + new Date(ranking.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未定榜 · 先完成初始排位赛';
  const medals = [['金', '#f5d375', '#f5d37517'], ['银', '#cbdbe8', '#cbdbe814'], ['铜', '#dea27a', '#dea27a14']];
  $('ranking-podium').innerHTML = medals.map(([label, color, glow], i) => {
    const r = byId.get(ranking.order[i]);
    return '<article class="podium-card" data-place="' + (i + 1) + '" style="--medal:' + color + ';--medal-glow:' + glow + '"><div class="podium-label"><b>' + ['♛', '◇', '◇'][i] + '</b>' + label + '榜 · 第' + (i + 1) + '名</div><h2>' + (r ? '<span class="player-dot" style="--player-color:' + r.color + '"></span>' + escape(r.name) : '虚位以待') + '</h2><p>' + (r ? '华山论剑 <span class="badge">' + (r.kind === 'system' ? '系统选手' : '注册选手') + '</span><br>最近赛程平均积分 ' + (ranking.records[r.id]?.average ?? 0).toFixed(1) : '等待策略在赛场上赢得席位') + '</p></article>';
  }).join('');
  $('league-list').innerHTML = LEAGUES.map((name, tier) => {
    const members = leagueMembers(ranking, tier);
    return '<article class="panel league-card"><div class="panel-heading"><div class="league-title"><small>LEAGUE 0' + (tier + 1) + '</small><h2>' + name + '</h2></div><span class="badge">' + members.length + ' / 10</span></div>' + (members.length ? members.map((id, index) => {
      const r = byId.get(id), global = tier * 10 + index + 1, record = ranking.records[id];
      return '<div class="league-row top-' + global + '"><span>' + String(global).padStart(2, '0') + '</span><span class="player-dot" style="--player-color:' + r.color + '"></span><div><strong>' + escape(r.name) + '</strong><small>' + (r.kind === 'system' ? '系统选手' : '注册选手') + ' · 累计 ' + (record?.appearances || 0) + ' 局排位</small></div><div class="league-performance">' + (record?.average ?? 0).toFixed(1) + '<small>最近积分</small></div></div>';
    }).join('') : '<div class="league-empty">席位尚空，等待下一位挑战者。<br>新选手通过定位赛进入相应级别。</div>') + '<div class="league-footnote">' + (tier === 0 ? '最高联赛 · 守住席位，迎接挑战' : '通过交界挑战升降级 · 每级最多10名') + '</div></article>';
  }).join('');
  const pending = registrations.filter(r => !ranking.order.includes(r.id));
  $('ranking-pending').innerHTML = pending.length ? pending.map(r => '<div class="pending-row"><span class="player-dot" style="--player-color:' + r.color + '"></span><div><strong>' + escape(r.name) + '</strong><small>' + (r.kind === 'system' ? '系统选手' : '注册选手') + ' · ' + (ranking.placements[r.id]?.reserve ? '候补 · 挑战潜龙试剑' : ranking.order.length ? '待定位 · 下一站' + LEAGUES[placementTier(ranking, r.id)] : '待初始定榜') + '</small></div><button class="text-button" data-place-candidate="' + escape(r.id) + '">' + (ranking.order.length ? '生成定位赛 ↗' : '选择定榜 ↗') + '</button></div>').join('') : '<div class="league-empty">所有注册选手均已进入联赛。</div>';
  $('ranking-history').innerHTML = ranking.imports.length ? ranking.imports.slice(0, historyLimit).map(log => {
    const changes = [...new Set([...log.before, ...log.after])].map(id => {
      const old = log.before.indexOf(id), now = log.after.indexOf(id);
      if (old === now) return '';
      return escape(byId.get(id)?.name || id) + ' ' + (old < 0 ? '待定位' : '#' + (old + 1)) + ' → ' + (now < 0 ? '候补' : '#' + (now + 1));
    }).filter(Boolean).join('；');
    return '<article><strong>' + escape(log.name) + ' · ' + log.total + '局</strong><p>' + escape(log.message) + '</p>' + (changes ? '<p>' + changes + '</p>' : '<p>榜单席位未变化，比赛表现已记录。</p>') + '<small>' + new Date(log.at).toLocaleString('zh-CN', { hour12: false }) + '</small></article>';
  }).join('') : '<div class="league-empty">完成赛程后，点击“导入排行榜”建立第一份排名。</div>';
  $('ranking-history-more').hidden = ranking.imports.length <= historyLimit;
}
function renderRegisteredChoices(selected = null) {
  const checked = selected || [...document.querySelectorAll('[data-ranked-id]:checked')].map(el => el.dataset.rankedId);
  $('ranked-contestants').innerHTML = registrations.map(r => {
    const position = ranking.order.indexOf(r.id), label = position < 0 ? '待定位' : LEAGUES[Math.floor(position / 10)] + ' · #' + (position + 1);
    return '<label class="ranked-choice"><input type="checkbox" data-ranked-id="' + escape(r.id) + '" ' + (checked.includes(r.id) ? 'checked' : '') + '><span class="player-dot" style="--player-color:' + r.color + '"></span><div><strong>' + escape(r.name) + '</strong><small>' + (r.kind === 'system' ? '系统选手' : '注册选手') + ' · ' + label + '</small></div></label>';
  }).join(''); renderLock();
}
async function registerSelected() {
  if (locked() || !savePlayer(false)) return;
  const player = players.find(p => p.id === selectedId);
  if (registrationFor(player)) return;
  archiveBusy = true; renderLock();
  try {
    const saved = await registerContestant(player);
    registrations = saved.registrations; ranking = saved.ranking; reconcileRegistry();
    archiveBusy = false; renderRoster(); loadEditor(); renderRanking(); renderRegisteredChoices();
    toast('选手已注册，名称与代码已锁定，可生成排位赛程。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}
function cloneSelected() {
  if (locked() || (dirty && !savePlayer(false))) return;
  const original = players.find(p => p.id === selectedId), clone = createPlayer(players);
  const suffix = ' · 新版' + clone.id;
  Object.assign(clone, { name: original.name.slice(0, 24 - suffix.length) + suffix, source: original.source, role: original.role, color: original.color });
  players.push(clone); selectedId = clone.id; persist(); renderRoster(); loadEditor();
  $('player-name').focus(); $('player-name').select(); toast('已复制为可编辑草稿；改好名称与代码后重新注册。');
}
async function generateRanked(selection) {
  if (locked()) return;
  if (dirty && !savePlayer(false)) return;
  try {
    const fresh = await readRankingStore(); registrations = fresh.registrations; ranking = fresh.ranking;
    const selected = selection || [...document.querySelectorAll('[data-ranked-id]:checked')].map(el => el.dataset.rankedId);
    const plan = planRanked(ranking, registrations, selected);
    const total = rankedCount(plan, Number($('ranked-rounds').value));
    const contestants = plan.members.map(id => {
      const r = registrations.find(r => r.id === id), local = players.find(p => p.registrationId === id);
      if (!local) throw new Error('选手资料已变化，请刷新页面再生成');
      return { ...local, name: r.name, source: r.source, registrationId: id };
    });
    const label = { bootstrap: '初始定榜', league: LEAGUES[Math.floor(ranking.order.indexOf(plan.members[0]) / 10)] + '排位', boundary: '交界挑战', placement: LEAGUES[plan.tier] + '定位' }[plan.kind];
    const createdAt = new Date().toISOString();
    randomTournamentSeed();
    const draft = { id: crypto.randomUUID(), name: label + ' · ' + new Date().toLocaleString('zh-CN', { hour12: false }), createdAt, startedAt: null, status: 'draft', rankPlan: plan, rankingRevision: ranking.revision, masterSeed: $('tournament-seed').value, total, completed: 0,
      config: { ...DEFAULTS, foodTarget: 60 }, contestants, games: [], stats: contestants.map(p => ({ id: p.id, name: p.name, color: p.color, points: 0, score: 0, wins: 0, alive: 0, games: 0 })) };
    archiveBusy = true; renderLock(); await saveTournamentSession(tournamentMetadata(draft)); archiveBusy = false;
    displayTournament(draft); renderRanking(); renderRegisteredChoices(selected); showPage('tournament');
    $('ranked-generator-hint').textContent = '已生成：' + label + ' · ' + total + '局 · ' + contestants.length + '名注册选手（每局最多10名）。点击“开始赛程”，全部完成后导入。';
    toast('已生成并保存公平排位赛程，共' + total + '局。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}
function renderImportEligibility() {
  const button = $('import-ranking'), title = $('rank-import-status'), hint = $('rank-import-hint');
  button.disabled = true;
  try {
    if (!rankingReady) throw new Error('正在读取排行榜');
    const analysis = analyzeTournament(tournament, registrations, ranking);
    title.textContent = '符合排位条件 · 可导入';
    hint.textContent = '已核验注册身份、固定代码、完整局数和出生位置轮换；点击后核验每局回放并一次性保存排名。';
    button.disabled = locked(); title.parentElement.parentElement.classList.remove('invalid');
    return analysis;
  } catch (error) {
    const imported = tournament && ranking.imports.some(log => log.sessionId === tournament.id);
    title.textContent = imported ? '已导入排行榜 · 排名独立保留' : '暂不可导入排行榜';
    hint.textContent = error.message; title.parentElement.parentElement.classList.add('invalid');
    return null;
  }
}
async function importRanking() {
  if (locked()) return;
  const session = tournament, analysis = renderImportEligibility(); if (!analysis) return;
  archiveBusy = true; renderLock();
  try {
    const revision = ranking.revision;
    for (const g of session.games) {
      $('rank-import-hint').textContent = '核验回放 ' + g.round + ' / ' + session.total + '…';
      const replay = validateReplay(await readTournamentReplay(session.id, g.round)), last = replay.frames.at(-1);
      if (replay.seed !== g.seed || !last.done || (last.turn < 500 && last.snakes.some(s => s.alive)) || last.turn !== g.turns || !sameIds(replay.frames[0].snakes.map(s => s.id), g.order) || ['width', 'height', 'maxTurns', 'foodTarget', 'initialLength', 'dropRatio', 'decisionMs'].some(k => replay.config[k] !== session.config[k]) || last.snakes.some(s => g.results.find(r => r.id === s.id)?.score !== s.score || session.contestants.find(p => p.id === s.id)?.name !== s.name)) throw new Error('第' + g.round + '局回放与结算不一致，不能导入');
    }
    const saved = await importRankedTournament(session, revision);
    registrations = saved.registrations; ranking = saved.ranking;
    archiveBusy = false; renderRanking(); renderRegisteredChoices(); renderImportEligibility(); showPage('ranking');
    toast('赛程已导入。删除原赛程不会影响这份排名。');
  } catch (error) { toast(error.message); }
  finally { archiveBusy = false; renderLock(); }
}
function sameIds(a, b) { return a.length === b.length && a.every((id, i) => id === b[i]); }
$('register-player').addEventListener('click', registerSelected);
$('clone-player').addEventListener('click', cloneSelected);
$('ranking-to-tournament').addEventListener('click', () => showPage('tournament'));
$('ranking-register').addEventListener('click', () => { showPage('lab'); addPlayer(); });
$('ranking-history-more').addEventListener('click', () => { historyLimit += 10; renderRanking(); });
$('ranking-pending').addEventListener('click', event => {
  const button = event.target.closest('[data-place-candidate]'); if (!button) return;
  if (!ranking.order.length) { renderRegisteredChoices([button.dataset.placeCandidate]); showPage('tournament'); toast('初始定榜请再勾选至少一名对手。'); }
  else generateRanked([button.dataset.placeCandidate]);
});
$('generate-ranked').addEventListener('click', () => generateRanked());
$('ranked-select-active').addEventListener('click', () => renderRegisteredChoices(activePlayers().map(p => p.registrationId).filter(Boolean)));
for (const [i, id] of ['ranked-first', 'ranked-second', 'ranked-third'].entries()) $(id).addEventListener('click', () => generateRanked(leagueMembers(ranking, i)));
for (const [i, id] of ['ranked-boundary-one', 'ranked-boundary-two'].entries()) $(id).addEventListener('click', () => { try { generateRanked(boundarySelection(ranking, i)); } catch (error) { toast(error.message); } });
$('import-ranking').addEventListener('click', importRanking);
window.addEventListener('focus', async () => {
  if (!rankingReady || locked() || dirty) return;
  try { const saved = await readRankingStore(); if (saved.ranking.revision !== ranking.revision || saved.registrations.length !== registrations.length) { registrations = saved.registrations; ranking = saved.ranking; reconcileRegistry(); renderRoster(); loadEditor(); renderRanking(); renderRegisteredChoices(); } }
  catch { /* Leave the current view usable while storage is temporarily unavailable. */ }
});

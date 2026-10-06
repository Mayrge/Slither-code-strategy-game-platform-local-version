import { makeSchedule } from './tournament.js';
import { scoreRound } from './replay.js';
import { makeRandom } from './engine.js';

export const LEAGUES = ['华山论剑', '凌云争锋', '潜龙试剑'];
export const emptyRanking = () => ({ revision: 0, order: [], placements: {}, records: {}, imports: [], updatedAt: null });
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const fail = message => { throw new Error(message); };
export const leagueMembers = (state, tier) => state.order.slice(tier * 10, tier * 10 + 10);
export function placementTier(state, id) {
  const occupied = Math.ceil(state.order.length / 10);
  return state.placements[id]?.tier ?? Math.floor((Math.max(1, occupied) - 1) / 2);
}
export function planRanked(state, registrations, selected) {
  const byId = new Map(registrations.map(r => [r.id, r]));
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !byId.has(id))) fail('请选择已注册的选手');
  if (!state.order.length) {
    if (selected.length < 2 || selected.length > 10) fail('初始定榜需要选择2～10名注册选手');
    return { kind: 'bootstrap', revision: state.revision, members: [...selected] };
  }
  const newcomers = selected.filter(id => !state.order.includes(id));
  if (newcomers.length) {
    if (newcomers.length !== 1) fail('每份定位赛只定位一名新选手，请单独选择该选手');
    const candidate = newcomers[0], tier = placementTier(state, candidate);
    const anchors = leagueMembers(state, tier);
    if (!anchors.length) fail('该级还没有已定位选手');
    return { kind: 'placement', revision: state.revision, tier, candidate, members: [candidate, ...anchors] };
  }
  if (selected.length < 2 || selected.length > 10) fail('排位赛需要2～10名注册选手');
  const positions = selected.map(id => state.order.indexOf(id)).sort((a, b) => a - b);
  if (positions.at(-1) - positions[0] !== selected.length - 1) fail('请选同级中连续名次的选手，或生成交界挑战，避免跳过未参赛选手调整名次');
  const firstTier = Math.floor(positions[0] / 10), lastTier = Math.floor(positions.at(-1) / 10);
  if (lastTier - firstTier > 1) fail('跨级比赛只接受相邻两级的交界挑战');
  return { kind: firstTier === lastTier ? 'league' : 'boundary', revision: state.revision, members: positions.map(i => state.order[i]) };
}
export function boundarySelection(state, tier) {
  if (tier < 0 || tier > 1) fail('只支持三级联赛之间的挑战');
  const upper = leagueMembers(state, tier), lower = leagueMembers(state, tier + 1);
  if (!upper.length || !lower.length) fail('相邻两级都需要有已定位选手');
  return [...upper.slice(-5), ...lower.slice(0, 5)];
}
export function rankedCount(plan, requested) {
  const unit = plan.members.length === 11 ? 100 : plan.members.length;
  return Math.min(Math.floor(1000 / unit) * unit, Math.ceil(Math.max(50, requested) / unit) * unit);
}
export function makeRankSchedule(contestants, count, seed, plan) {
  if (contestants.length <= 10) return makeSchedule(contestants, count, seed);
  if (plan?.kind !== 'placement' || contestants.length !== 11 || count % 100) fail('十人联赛的定位赛需要100局的整数倍');
  const candidate = contestants.find(p => p.registrationId === plan.candidate);
  const anchors = contestants.filter(p => p !== candidate);
  if (!candidate || anchors.length !== 10) fail('定位赛的注册身份不完整');
  const random = makeRandom(seed), schedule = [];
  for (let pass = 0; schedule.length < count; pass++) {
    const omitted = [...anchors];
    for (let i = 9; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [omitted[i], omitted[j]] = [omitted[j], omitted[i]]; }
    omitted.forEach((skip, index) => {
      const group = [candidate, ...anchors.filter(p => p !== skip)];
      const rounds = makeSchedule(group, 10, String(seed).slice(0, 20) + '-P' + pass + '-G' + index);
      for (const round of rounds) schedule.push({ ...round, round: schedule.length + 1, cycle: pass * 10 + index + 1 });
    });
  }
  return schedule;
}

export function analyzeTournament(session, registrations, state) {
  if (!session?.id) fail('请先选择赛程');
  if (state.imports.some(log => log.sessionId === session.id)) fail('这份赛程已导入，不能重复计入');
  if (session.status !== 'completed' || session.running || session.completed !== session.total || session.games?.length !== session.total) fail('赛程必须全部完成，中断或停止的赛程不能导入');
  const c = session.config;
  if (!c || c.width !== 30 || c.height !== 30 || c.maxTurns !== 500 || c.initialLength !== 5 || c.dropRatio !== 0.3 || c.decisionMs !== 50 || c.foodTarget !== 60) fail('排位统一使用30×30、500回合、60个基础食物及默认执行预算');
  const contestants = session.contestants;
  if (!Array.isArray(contestants) || contestants.length < 2 || contestants.length > 11) fail('缺少可核验的参赛代码快照，旧版赛程不能导入');
  const byId = new Map(registrations.map(r => [r.id, r]));
  const identities = contestants.map(p => {
    const r = byId.get(p.registrationId) || registrations.find(r => r.name === p.name && r.source === p.source);
    if (!r || r.name !== p.name || r.source !== p.source || !session.startedAt || r.registeredAt > session.startedAt) fail('所有选手必须在开赛前注册，名称和代码必须与注册版本一致');
    return r.id;
  });
  if (new Set(identities).size !== identities.length || new Set(contestants.map(p => p.id)).size !== contestants.length) fail('同一个注册选手不能重复参赛');
  let plan = session.rankPlan;
  if (plan) {
    if (plan.revision !== state.revision) fail('排行榜已变化，这份排位赛已过期，请按当前排名重新生成');
    const current = planRanked(state, registrations, plan.kind === 'placement' ? [plan.candidate] : plan.members);
    if (current.kind !== plan.kind || current.tier !== plan.tier || !same(current.members, plan.members) || !same(identities, plan.members)) fail('参赛名单与当前排位方案不一致');
  } else {
    if (session.rankingRevision != null && session.rankingRevision !== state.revision) fail('开赛所依据的排行榜已变化，请重新生成赛程');
    if (state.updatedAt && session.startedAt < state.updatedAt) fail('比赛早于最近一次排名调整，请重新比赛');
    plan = planRanked(state, registrations, identities);
    if (plan.members.length !== identities.length || !plan.members.every(id => identities.includes(id))) fail('定位赛必须覆盖目标联赛的全部选手，请使用排位赛生成器');
  }
  if (!Number.isInteger(session.total) || session.total < 50 || session.total > 1000 || session.total !== rankedCount(plan, session.total)) fail('至少50局，并且必须完整轮换出生位置；请使用排位赛生成器');
  const normalized = contestants.map((p, i) => ({ ...p, registrationId: identities[i] }));
  const schedule = makeRankSchedule(normalized, session.total, session.masterSeed, plan);
  const stats = new Map(identities.map(id => [id, { points: 0, games: 0, score: 0 }]));
  const numericIdentity = new Map(contestants.map((p, i) => [p.id, identities[i]]));
  const pair = new Map();
  for (let i = 0; i < schedule.length; i++) {
    const expected = schedule[i], actual = session.games[i];
    if (!actual || actual.round !== expected.round || actual.seed !== expected.seed || actual.rotation !== expected.rotation || !Array.isArray(actual.order) || !same(actual.order, expected.order)) fail('赛程的种子、参赛顺序或出生位置轮换不完整');
    if (!Number.isInteger(actual.turns) || actual.turns < 1 || actual.turns > 500 || actual.results?.length !== expected.order.length || new Set(actual.results.map(r => r.id)).size !== expected.order.length || actual.results.some(r => !expected.order.includes(r.id) || !Number.isInteger(r.score) || r.score < 5 || r.score > 505)) fail('比赛结果数据无效');
    const results = scoreRound(actual.results);
    for (const r of results) { const s = stats.get(numericIdentity.get(r.id)); s.points += r.points; s.score += r.score; s.games++; }
    if (plan.kind === 'placement') {
      const candidate = results.find(r => numericIdentity.get(r.id) === plan.candidate);
      if (!candidate) fail('定位选手没有参加全部比赛');
      for (const opponent of results.filter(r => r !== candidate)) {
        const id = numericIdentity.get(opponent.id), s = pair.get(id) || { margin: 0, games: 0 };
        s.margin += candidate.points - opponent.points; s.games++; pair.set(id, s);
      }
    }
  }
  const averages = Object.fromEntries([...stats].map(([id, s]) => [id, { ...s, average: s.points / s.games }]));
  return { plan, averages, pair: Object.fromEntries(pair), identities };
}
export function applyTournament(state, session, analysis, now = new Date().toISOString()) {
  const next = structuredClone(state), { plan, averages } = analysis;
  const before = [...next.order];
  let message;
  if (plan.kind === 'placement') {
    const anchors = plan.members.filter(id => id !== plan.candidate);
    const beaten = anchors.filter(id => analysis.pair[id]?.margin / analysis.pair[id]?.games > 1e-8);
    const index = anchors.length - beaten.length;
    const occupied = Math.ceil(next.order.length / 10);
    if (index === 0 && plan.tier > 0) {
      next.placements[plan.candidate] = { tier: plan.tier - 1 };
      message = '定位表现领先全级，获得向上挑战资格';
    } else if (index === anchors.length && plan.tier < occupied - 1) {
      next.placements[plan.candidate] = { tier: plan.tier + 1 };
      message = '定位表现落后全级，进入下一级继续定位';
    } else {
      next.order.splice(plan.tier * 10 + index, 0, plan.candidate);
      delete next.placements[plan.candidate];
      if (next.order.length > 30) { const reserve = next.order.pop(); next.placements[reserve] = { tier: 2, reserve: true }; }
      message = '完成定位，按与同场对手的积分差进入榜单';
    }
  } else {
    const positions = plan.members.map(id => next.order.indexOf(id));
    const sorted = [...plan.members].sort((a, b) => averages[b].average - averages[a].average || plan.members.indexOf(a) - plan.members.indexOf(b));
    if (plan.kind === 'bootstrap') { next.order = sorted; message = '完成初始定榜'; }
    else { positions.sort((a, b) => a - b).forEach((position, i) => { next.order[position] = sorted[i]; }); message = plan.kind === 'boundary' ? '交界挑战完成，胜者前进，名额随排名升降' : '同级排位完成，按平均名次积分调整'; }
  }
  for (const [id, s] of Object.entries(averages)) {
    const old = next.records[id] || { appearances: 0 };
    next.records[id] = { appearances: old.appearances + s.games, average: s.average, lastSession: session.name || session.masterSeed };
  }
  next.revision++; next.updatedAt = now;
  next.imports.unshift({ sessionId: session.id, name: session.name || session.masterSeed, at: now, kind: plan.kind, message, before, after: [...next.order], participants: analysis.identities, total: session.total });
  return next;
}

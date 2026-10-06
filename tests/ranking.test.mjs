import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/engine.js';
import { LEAGUES, emptyRanking, planRanked, boundarySelection, rankedCount, makeRankSchedule, analyzeTournament, applyTournament } from '../src/ranking.js';
const registrations = Array.from({length: 35}, (_, i) => ({id: 'r' + i, name: '选手' + i, source: 'code' + i, registeredAt: '2026-10-01T00:00:00Z'}));
function session(state, selected, score = () => 10, requested = 50) {
  const plan = planRanked(state, registrations, selected), total = rankedCount(plan, requested);
  const contestants = plan.members.map(id => { const r=registrations.find(r=>r.id===id); return {...r, id: Number(id.slice(1))+1, registrationId: id}; });
  const schedule = makeRankSchedule(contestants,total,'FAIR-RANK',plan);
  const s = {id: 'cup-' + state.revision, name: '排位测试', startedAt:'2026-10-05T00:00:00Z', status:'completed', total, completed:total, config:{...DEFAULTS,foodTarget:60}, contestants, rankPlan:plan, masterSeed:'FAIR-RANK'};
  s.games=schedule.map(g=>({...g, turns:500, results:g.order.map(id=>({id,score:score('r'+(id-1)),alive:true,name:registrations[id-1].name}))}));
  return s;
}
test('three leagues only; initial ranking is measured, ties preserve selection order',()=>{
  assert.equal(LEAGUES.length,3); assert.ok(LEAGUES.every(n=>n.length===4));
  const state=emptyRanking(), cup=session(state,['r0','r1','r2'],id=>id==='r2'?100:10);
  const next=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.deepEqual(next.order,['r2','r0','r1']); assert.equal(next.revision,1); assert.equal(state.order.length,0);
});
test('11-person placement covers all 10 opponents and all positions without 11 snakes in one game',()=>{
  const state={...emptyRanking(),order:registrations.slice(0,10).map(r=>r.id)};
  const cup=session(state,['r10'],id=>id==='r10'?100:10);
  assert.equal(cup.total,100); assert.equal(cup.contestants.length,11);
  const counts=new Map(cup.contestants.map(p=>[p.id,Array(10).fill(0)]));
  for(const g of cup.games){assert.equal(g.order.length,10);g.order.forEach((id,i)=>counts.get(id)[(i+g.rotation)%10]++);}
  assert.deepEqual(counts.get(11),Array(10).fill(10));
  for(let id=1;id<=10;id++) assert.deepEqual(counts.get(id),Array(10).fill(9));
  const next=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.equal(next.order[0],'r10'); assert.equal(next.order.length,11);
});
test('strong newcomers climb from middle tier and can become first; 30 seats force a reserve',()=>{
  let state={...emptyRanking(),order:registrations.slice(0,30).map(r=>r.id)};
  let cup=session(state,['r30'],id=>id==='r30'?100:10);
  assert.equal(cup.rankPlan.tier,1);
  state=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.equal(state.order.includes('r30'),false); assert.equal(state.placements.r30.tier,0);
  cup=session(state,['r30'],id=>id==='r30'?100:10);
  state=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.equal(state.order[0],'r30'); assert.equal(state.order.length,30); assert.equal(state.placements.r29.reserve,true);
});
test('a partial bottom league permits placement with one incumbent',()=>{
  let state={...emptyRanking(),order:registrations.slice(0,11).map(r=>r.id)};
  let cup=session(state,['r11'],id=>id==='r11'?5:20);
  state=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.equal(state.placements.r11.tier,1);
  cup=session(state,['r11'],id=>id==='r11'?5:20);
  state=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.equal(state.order.at(-1),'r11');
});
test('adjacent league challenge changes only played boundary slots, preserving unplayed ranks',()=>{
  const state={...emptyRanking(),order:registrations.slice(0,25).map(r=>r.id)};
  const selection=boundarySelection(state,0), cup=session(state,selection,id=>Number(id.slice(1))+5);
  const next=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.deepEqual(next.order.slice(0,5),state.order.slice(0,5));
  assert.deepEqual(next.order.slice(15),state.order.slice(15));
  assert.equal(next.order[5],'r14'); assert.equal(next.order[14],'r5');
  assert.throws(()=>planRanked(state,registrations,['r0','r9']),/连续/);
});
test('imports reject unregistered/modified/late strategies, unfinished schedules and stale plans',()=>{
  const state=emptyRanking(), cup=session(state,['r0','r1']);
  for(const mutation of [s=>s.contestants[0].source='new',s=>s.contestants[0].name='new',s=>s.completed--,s=>s.games.pop(),s=>s.config.foodTarget=61,s=>s.games[0].rotation=99,s=>s.games[0].results[0].score=999]) {
    const bad=structuredClone(cup);mutation(bad);assert.throws(()=>analyzeTournament(bad,registrations,state));
  }
  assert.throws(()=>analyzeTournament(cup,registrations.map(r=>({...r,registeredAt:'2026-10-06T00:00:00Z'})),state),/开赛前/);
  const next=applyTournament(state,cup,analyzeTournament(cup,registrations,state));
  assert.throws(()=>analyzeTournament(cup,registrations,next),/重复/);
  const stale={...cup,id:'other'};assert.throws(()=>analyzeTournament(stale,registrations,next),/过期/);
});
test('ordinary full fair tournaments can be imported, but incomplete cycles and unknown snapshots cannot',()=>{
  const state=emptyRanking(), cup=session(state,['r0','r1']); delete cup.rankPlan;
  assert.equal(analyzeTournament(cup,registrations,state).plan.kind,'bootstrap');
  const old={...cup,contestants:null};assert.throws(()=>analyzeTournament(old,registrations,state),/快照/);
  const odd=session(state,['r0','r1','r2']);odd.total=50;odd.completed=50;odd.games=odd.games.slice(0,50);assert.throws(()=>analyzeTournament(odd,registrations,state),/轮换/);
});

test('ranked round counts remain complete cycles at the 1000-game ceiling',()=>{
  for(let n=2;n<=10;n++){const count=rankedCount({members:Array(n).fill('x')},1000);assert.ok(count<=1000&&count>=50);assert.equal(count%n,0);}
  assert.equal(rankedCount({members:Array(11).fill('x')},500),500);
});

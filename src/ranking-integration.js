import { createRankingStore } from './ranking-store.js';
import { planRanked, makeRankSchedule, analyzeTournament } from './ranking.js';
import { DEFAULTS, SnakeGame } from './engine.js';
import { makeReplay, scoreRound } from './replay.js';
import { saveTournamentRound, readTournamentReplay, deleteTournament, readTournamentSession } from './tournament-store.js';
document.getElementById('run').addEventListener('click', async () => {
  const output = document.getElementById('result'), button=document.getElementById('run');button.disabled=true;output.textContent='';
  const dbName='ranking-test-'+crypto.randomUUID(), cupId='ranking-test-'+crypto.randomUUID(), store=createRankingStore(dbName);
  const check=(condition,message)=>{if(!condition)throw new Error(message);output.textContent+='PASS '+message+'\n';};
  try {
    const players=[1,2,3].map(id=>({id,name:'测试选手'+id,role:'临时验证',color:'#aabbcc',source:'export default s => s.snakes.find(p => p.id === s.you).direction;'}));
    for(const p of players) await store.registerContestant(p,'system','test-'+p.id);
    let data=await store.readRankingStore();check(data.registrations.length===3,'注册资料持久保存');
    let rejected=false;try{await store.registerContestant({...players[0],source:'modified'},'system','test-1');}catch{rejected=true;}check(rejected,'已注册名称与代码不可覆盖');
    rejected=false;try{await store.registerContestant(players[0]);}catch{rejected=true;}check(rejected,'重复注册名称被拒绝');
    await store.updateContestantAppearance({...players[0],registrationId:'test-1',color:'#112233'});
    data=await store.readRankingStore();check(data.registrations[0].color==='#112233'&&data.registrations[0].source===players[0].source,'颜色可调整并持久保存，代码保持锁定');
    const plan=planRanked(data.ranking,data.registrations,data.registrations.map(r=>r.id));
    const contestants=players.map(p=>({...p,registrationId:'test-'+p.id}));
    const cup={id:cupId,name:'临时排位验证',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),status:'completed',rankPlan:plan,contestants,total:51,completed:51,masterSeed:'STORE-RANK',config:{...DEFAULTS,foodTarget:60},stats:[],games:[]};
    const schedule=makeRankSchedule(contestants,51,cup.masterSeed,plan);
    for(const entry of schedule){
      const game=new SnakeGame(entry.order.map(id=>contestants.find(p=>p.id===id)),{...cup.config,seed:entry.seed,rotation:entry.rotation});
      const frames=[game.snapshot()];while(!game.done)frames.push(game.step(Object.fromEntries(game.snakes.filter(p=>p.alive).map(p=>[p.id,p.direction]))));
      cup.games.push({...entry,turns:game.turn,results:scoreRound(game.snakes).map(({body,...r})=>r)});
      await saveTournamentRound(cup,entry.round,makeReplay(game.config,game.seed,frames));
    }
    check(analyzeTournament(cup,data.registrations,data.ranking).plan.kind==='bootstrap','完整公平赛程通过资格核验');
    const attempts=await Promise.allSettled([store.importRankedTournament(cup,0),store.importRankedTournament(cup,0)]);
    check(attempts.filter(r=>r.status==='fulfilled').length===1,'并发导入仅一次生效');
    data=await store.readRankingStore();const before=JSON.stringify(data.ranking);check(data.ranking.order.length===3&&data.ranking.imports.length===1,'排名与防重复账本一次性保存');
    await deleteTournament(cupId);check(await readTournamentSession(cupId)===null,'原赛程已删除');
    let missing=false;try{await readTournamentReplay(cupId,51);}catch{missing=true;}check(missing,'原赛程回放同步物理删除');
    check(JSON.stringify((await store.readRankingStore()).ranking)===before,'删除赛程后已导入排行榜完全保留');
    rejected=false;try{await store.importRankedTournament(cup,1);}catch{rejected=true;}check(rejected,'删除原赛程后同一结果仍不能重复导入');
    await store.close();const reopened=createRankingStore(dbName);check(JSON.stringify((await reopened.readRankingStore()).ranking)===before,'重新打开恢复注册资料、排名与导入记录');await reopened.close();
    output.textContent+='\nALL PASSED';
  } catch(error){output.textContent+='FAIL '+error.message;}
  finally {await deleteTournament(cupId).catch(()=>{});await store.close();indexedDB.deleteDatabase(dbName);button.disabled=false;}
});

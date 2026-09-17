/* Analytics engine, kept in its own file only for testing.
   It gets inlined into index.html for shipping. */

var SLOT_ELIGIBILITY = {
  QB:["QB"], RB:["RB"], WR:["WR"], TE:["TE"], K:["K"], DEF:["DEF"],
  FLEX:["RB","WR","TE"],
  WRRB_FLEX:["RB","WR"],
  REC_FLEX:["WR","TE"],
  WRRB_WRT:["RB","WR","TE"],
  SUPER_FLEX:["QB","RB","WR","TE"],
  IDP_FLEX:["DL","LB","DB"],
  DL:["DL"], LB:["LB"], DB:["DB"]
};
var BENCH_SLOTS = {BN:1, IR:1, TAXI:1};

function positionsOf(pid, players){
  var p = players && players[pid];
  if(p){
    if(p.fantasy_positions && p.fantasy_positions.length) return p.fantasy_positions;
    if(p.position) return [p.position];
  }
  if(/^[A-Z]{2,4}$/.test(pid)) return ["DEF"];
  return [];
}

/* Best score obtainable from these players under these slot rules. */
function optimalLineup(playerIds, pointsMap, rosterPositions, players){
  var slots = (rosterPositions||[]).filter(function(s){ return !BENCH_SLOTS[s]; });
  if(!slots.length) return null;

  var pool = playerIds.map(function(pid){
    return { pid:pid, pts:Number(pointsMap[pid])||0, pos:positionsOf(pid, players) };
  });

  var order = slots.map(function(s,i){
    var elig = SLOT_ELIGIBILITY[s] || [s];
    return { slot:s, elig:elig, i:i };
  }).sort(function(a,b){ return a.elig.length - b.elig.length; });

  function eligible(cand, slot){
    for(var i=0;i<slot.elig.length;i++){
      if(cand.pos.indexOf(slot.elig[i])>=0) return true;
    }
    return false;
  }

  // Most-constrained slot first, take the best available body.
  var used = {}, assign = [];
  order.forEach(function(slot){
    var best=null;
    pool.forEach(function(c){
      if(used[c.pid]) return;
      if(!eligible(c,slot)) return;
      if(!best||c.pts>best.pts) best=c;
    });
    if(best){ used[best.pid]=1; assign.push({slot:slot, cand:best}); }
    else assign.push({slot:slot, cand:null});
  });

  // Greedy can leave points on the table. Try swaps until nothing improves.
  var improved = true, guard = 0;
  while(improved && guard++ < 40){
    improved = false;
    for(var a=0;a<assign.length;a++){
      for(var b=a+1;b<assign.length;b++){
        var A=assign[a], B=assign[b];
        if(A.cand && B.cand){
          if(eligible(A.cand,B.slot) && eligible(B.cand,A.slot)){
            // swapping two filled slots never changes the total, skip
          }
        }
        // try moving an unused player into a slot, replacing its occupant
      }
      // replacement pass: is there a bench player who beats this slot's pick?
      var slotA = assign[a];
      var bestAlt = null;
      pool.forEach(function(c){
        if(used[c.pid]) return;
        if(!eligible(c, slotA.slot)) return;
        if(!bestAlt || c.pts > bestAlt.pts) bestAlt = c;
      });
      if(bestAlt && (!slotA.cand || bestAlt.pts > slotA.cand.pts)){
        if(slotA.cand) delete used[slotA.cand.pid];
        used[bestAlt.pid]=1;
        slotA.cand = bestAlt;
        improved = true;
      }
    }
  }

  var total = 0, lineup = [];
  assign.forEach(function(x){
    if(x.cand){ total += x.cand.pts; lineup.push({slot:x.slot.slot, pid:x.cand.pid, pts:x.cand.pts}); }
  });
  return { points: total, lineup: lineup };
}

/* Standard normal, Box-Muller. */
function gauss(){
  var u=0,v=0;
  while(u===0) u=Math.random();
  while(v===0) v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

function meanSd(list){
  if(!list.length) return {mean:0, sd:0, n:0};
  var m = list.reduce(function(t,v){return t+v;},0)/list.length;
  if(list.length<2) return {mean:m, sd:0, n:1};
  var varc = list.reduce(function(t,v){return t+(v-m)*(v-m);},0)/(list.length-1);
  return {mean:m, sd:Math.sqrt(varc), n:list.length};
}

/* Monte Carlo the rest of the regular season. */
function simulateSeason(opts){
  var teams = opts.teams;            // [{rid, wins, pts, mean, sd}]
  var schedule = opts.schedule;      // [{week, pairs:[[ridA,ridB],...]}]
  var spots = opts.playoffSpots || 6;
  var runs = opts.runs || 5000;

  var made={}, top={}, idx={};
  teams.forEach(function(t,i){ made[t.rid]=0; top[t.rid]=0; idx[t.rid]=i; });

  var n = teams.length;
  for(var r=0;r<runs;r++){
    var wins=new Array(n), pts=new Array(n);
    for(var i=0;i<n;i++){ wins[i]=teams[i].wins; pts[i]=teams[i].pts; }

    for(var w=0;w<schedule.length;w++){
      var pairs=schedule[w].pairs;
      for(var p=0;p<pairs.length;p++){
        var ia=idx[pairs[p][0]], ib=idx[pairs[p][1]];
        if(ia===undefined||ib===undefined) continue;
        var sa=teams[ia].mean+teams[ia].sd*gauss();
        var sb=teams[ib].mean+teams[ib].sd*gauss();
        if(sa<0) sa=0; if(sb<0) sb=0;
        pts[ia]+=sa; pts[ib]+=sb;
        if(sa>sb) wins[ia]++; else if(sb>sa) wins[ib]++;
        else { wins[ia]+=0.5; wins[ib]+=0.5; }
      }
    }

    var order=[];
    for(var k=0;k<n;k++) order.push({i:k, w:wins[k], p:pts[k]});
    order.sort(function(a,b){ return b.w-a.w || b.p-a.p; });
    for(var s=0;s<n && s<spots;s++) made[teams[order[s].i].rid]++;
    if(order.length) top[teams[order[0].i].rid]++;
  }

  return teams.map(function(t){
    return { rid:t.rid, playoffs:made[t.rid]/runs, topSeed:top[t.rid]/runs };
  });
}

/* Replay every team's scores against every other team's slate. */
function scheduleSwap(scoresByWeek, schedules){
  // scoresByWeek: {week: {rid: points}}
  // schedules:    {week: {rid: opponentRid}}
  var weeks = Object.keys(schedules).filter(function(w){ return scoresByWeek[w]; });
  var rids = [];
  weeks.forEach(function(w){
    Object.keys(schedules[w]).forEach(function(r){
      if(rids.indexOf(Number(r))<0) rids.push(Number(r));
    });
  });

  var out = {};
  rids.forEach(function(me){
    out[me] = {};
    rids.forEach(function(owner){
      var w=0,l=0,t=0;
      weeks.forEach(function(wk){
        var myScore = scoresByWeek[wk][me];
        if(myScore==null) return;
        var opp = schedules[wk][owner];
        if(opp==null) return;
        if(opp===me) opp = owner;          // would have played yourself, use them
        if(opp===me) return;
        var oppScore = scoresByWeek[wk][opp];
        if(oppScore==null) return;
        if(myScore>oppScore) w++; else if(myScore<oppScore) l++; else t++;
      });
      out[me][owner]={w:w,l:l,t:t};
    });
  });
  return out;
}

/* How many of each position the league starts in total. Flex slots are
   split across their eligible positions in proportion to dedicated slots. */
function positionalDemand(rosterPositions, teams){
  var base={}, flex=[];
  (rosterPositions||[]).forEach(function(s){
    if(BENCH_SLOTS[s]) return;
    var elig = SLOT_ELIGIBILITY[s] || [s];
    if(elig.length===1) base[elig[0]] = (base[elig[0]]||0)+1;
    else flex.push(elig);
  });
  var snap={};
  Object.keys(base).forEach(function(p){ snap[p]=base[p]; });
  flex.forEach(function(elig){
    var total=0;
    elig.forEach(function(p){ total += snap[p]||0; });
    elig.forEach(function(p){
      base[p] = (base[p]||0) + (total ? (snap[p]||0)/total : 1/elig.length);
    });
  });
  var demand={};
  Object.keys(base).forEach(function(p){ demand[p] = base[p]*(teams||12); });
  return demand;
}

/* Draft value.

   The honest way to compare a quarterback to a running back is not talent
   ranking, it is points above the worst starter you could have had instead.
   In a one-QB league the twelfth quarterback is nearly as good as the first,
   so QB1 is worth little over replacement; the same is not true at running
   back. Kickers land at essentially zero by construction.

   Projected points drive this when they are available. Without them we fall
   back to ranking players within their own position, which still removes the
   fake bonus every team gets for waiting on quarterback, but cannot tell you
   that a kicker in round two was a crime. */
function gradeDraft(picks, players, rosterPositions, projections, teams){
  var demand = positionalDemand(rosterPositions, teams);

  var slots={}, flexSlots=[];
  (rosterPositions||[]).forEach(function(s){
    if(BENCH_SLOTS[s]) return;
    var elig = SLOT_ELIGIBILITY[s] || [s];
    if(elig.length===1) slots[elig[0]] = (slots[elig[0]]||0)+1;
    else flexSlots.push(elig);
  });
  function depthFor(pos){
    var d = slots[pos]||0;
    flexSlots.forEach(function(e){ if(e.indexOf(pos)>=0) d++; });
    return d||1;
  }

  function infoFor(p){
    var pl = players && players[p.player_id];
    var rank = pl && pl.search_rank!=null ? Number(pl.search_rank) : null;
    if(rank!=null && !isFinite(rank)) rank = null;
    var pos = (pl && pl.position) || (p.metadata && p.metadata.position) || "?";
    var age = pl && pl.age ? Number(pl.age) : null;
    var proj = projections && projections[p.player_id]!=null ? Number(projections[p.player_id]) : null;
    if(proj!=null && !isFinite(proj)) proj = null;
    return {rank:rank, pos:pos, age:age, proj:proj};
  }

  // Group the drafted pool by position.
  var byPos={}, haveProj=0, total=0;
  picks.forEach(function(p){
    var info = infoFor(p);
    if(info.pos==="?") return;
    total++;
    if(info.proj!=null) haveProj++;
    (byPos[info.pos] = byPos[info.pos] || []).push({pick:p.pick_no, info:info});
  });
  var useProj = total>0 && haveProj/total >= 0.6;

  var expected = {}, vorpOf = {};

  if(useProj){
    // Replacement level is the last startable body at each position.
    var board = [];
    Object.keys(byPos).forEach(function(pos){
      var list = byPos[pos].filter(function(x){ return x.info.proj!=null; })
        .sort(function(a,b){ return b.info.proj-a.info.proj; });
      if(!list.length) return;
      var idx = Math.max(0, Math.min(list.length-1, Math.round(demand[pos]||list.length)));
      var repl = list[idx] ? list[idx].info.proj : list[list.length-1].info.proj;
      list.forEach(function(x){
        var v = x.info.proj - repl;
        vorpOf[x.pick] = v;
        board.push({pick:x.pick, v:v});
      });
    });
    var used = board.map(function(x){ return x.pick; }).sort(function(a,b){ return a-b; });
    board.sort(function(a,b){ return b.v-a.v; });
    board.forEach(function(x,i){ expected[x.pick] = used[i]; });
  } else {
    Object.keys(byPos).forEach(function(pos){
      var list = byPos[pos].filter(function(x){ return x.info.rank!=null; });
      if(!list.length) return;
      var used = list.map(function(x){ return x.pick; }).sort(function(a,b){ return a-b; });
      list.slice().sort(function(a,b){ return a.info.rank-b.info.rank; })
        .forEach(function(x,i){ expected[x.pick] = used[i]; });
    });
  }

  var byRoster = {};
  picks.forEach(function(p){
    var rid = p.roster_id;
    if(rid==null) return;
    if(!byRoster[rid]) byRoster[rid] = {rid:rid, picks:[], ages:[], positions:{}};
    var slot = byRoster[rid], info = infoFor(p);
    slot.positions[info.pos] = (slot.positions[info.pos]||0)+1;
    if(info.age) slot.ages.push(info.age);

    var value = null, exp = expected[p.pick_no];
    if(exp!=null){
      value = p.pick_no - exp;
      if(value >  75) value =  75;
      if(value < -75) value = -75;
    }
    slot.picks.push({pid:p.player_id, pick:p.pick_no, round:p.round, pos:info.pos,
                     rank:info.rank, proj:info.proj, vorp:vorpOf[p.pick_no]!=null?vorpOf[p.pick_no]:null,
                     expected:exp, value:value});
  });

  var rows = Object.keys(byRoster).map(function(k){
    var s = byRoster[k];

    // Who on this roster is plausibly a starter at their own position.
    var seen = {};
    s.picks.slice().sort(function(a,b){
      if(useProj) return (b.proj==null?-1e9:b.proj) - (a.proj==null?-1e9:a.proj);
      return (a.rank==null?1e9:a.rank) - (b.rank==null?1e9:b.rank);
    }).forEach(function(p){
      var n = (seen[p.pos] = (seen[p.pos]||0)+1);
      p.starter = n <= depthFor(p.pos);
      p.weight = p.starter ? 1 : 0.35;
    });

    var wv=0, wt=0;
    s.picks.forEach(function(p){
      if(p.value==null) return;
      wv += p.value*p.weight;
      wt += p.weight;
    });
    s.value = wv;
    s.counted = s.picks.filter(function(p){ return p.value!=null; }).length;
    s.avgValue = wt ? wv/wt : 0;
    s.avgAge = s.ages.length ? s.ages.reduce(function(t,v){return t+v;},0)/s.ages.length : null;
    s.basis = useProj ? "projection" : "rank";
    s.picks.sort(function(a,b){ return a.pick-b.pick; });

    var scored = s.picks.filter(function(p){ return p.value!=null && p.starter; });
    if(!scored.length) scored = s.picks.filter(function(p){ return p.value!=null; });
    s.best  = scored.slice().sort(function(a,b){ return b.value-a.value; })[0] || null;
    s.worst = scored.slice().sort(function(a,b){ return a.value-b.value; })[0] || null;
    return s;
  });
  rows.sort(function(a,b){ return b.avgValue-a.avgValue; });
  return rows;
}

/* Blend what a team has actually scored with what their roster projects.
   Early on the projection carries it; by midseason the real scores do. */
function blendMean(observed, n, projected, priorWeight){
  var pw = priorWeight==null ? 4 : priorWeight;
  if(projected==null) return observed;
  if(!n) return projected;
  var w = n/(n+pw);
  return w*observed + (1-w)*projected;
}


/* Score a predicted ordering against how things actually turned out.
   Pairwise accuracy is the readable one: of every pair of teams, how
   often did you put them in the right order. */
function scoreRanking(predicted, actualRank){
  var list = (predicted||[]).filter(function(id){ return actualRank[id]!=null; });
  var n = list.length;
  if(n < 2) return null;

  var sumErr = 0, worst = null, best = null;
  list.forEach(function(id,i){
    var pred = i+1, act = actualRank[id], err = Math.abs(pred-act);
    sumErr += err;
    if(!worst || err > worst.err) worst = {id:id, err:err, predicted:pred, actual:act};
    if(!best  || err < best.err)  best  = {id:id, err:err, predicted:pred, actual:act};
  });

  var pairs = 0, correct = 0;
  for(var a=0; a<n; a++){
    for(var b=a+1; b<n; b++){
      pairs++;
      if(actualRank[list[a]] < actualRank[list[b]]) correct++;
    }
  }

  return {
    n:n, pairs:pairs, correct:correct,
    pairwise: pairs ? correct/pairs : 0,
    mae: sumErr/n,
    exact: list.filter(function(id,i){ return actualRank[id]===i+1; }).length,
    worst: worst, best: best,
    top: {id:list[0], actual:actualRank[list[0]]},
    bottom: {id:list[n-1], actual:actualRank[list[n-1]]}
  };
}


/* When a projection is missing, treating it as zero silently deletes a
   player from a roster's projected total. That is what made a healthy
   team look like the tenth best in the league for four days. Substitute a
   conservative value for his position instead, and report what was filled. */
function fillProjectionGaps(projMap, players, rosterIds){
  var out = {}, filled = [], byPos = {};
  Object.keys(projMap || {}).forEach(function(k){ out[k] = projMap[k]; });

  function posOf(pid){
    var p = players && players[pid];
    if(p && p.fantasy_positions && p.fantasy_positions.length) return p.fantasy_positions[0];
    if(p && p.position) return p.position;
    if(/^[A-Z]{2,4}$/.test(pid)) return "DEF";
    return null;
  }

  // Build the distribution of known projections at each position.
  (rosterIds || []).forEach(function(pid){
    var v = out[pid];
    if(v == null || !isFinite(v)) return;
    var pos = posOf(pid);
    if(!pos) return;
    (byPos[pos] = byPos[pos] || []).push(Number(v));
  });
  var floor = {};
  Object.keys(byPos).forEach(function(pos){
    var list = byPos[pos].slice().sort(function(a,b){ return a-b; });
    // 25th percentile: "we do not know, assume replacement level"
    floor[pos] = list[Math.floor(list.length * 0.25)];
  });

  (rosterIds || []).forEach(function(pid){
    if(out[pid] != null && isFinite(out[pid])) return;
    var pos = posOf(pid);
    if(!pos || floor[pos] == null) return;
    out[pid] = floor[pos];
    filled.push({pid:pid, pos:pos, value:floor[pos]});
  });

  return {map: out, filled: filled};
}

if (typeof module !== "undefined") {
  module.exports = { optimalLineup, simulateSeason, scheduleSwap, gradeDraft, meanSd, positionsOf, blendMean, positionalDemand, scoreRanking, fillProjectionGaps };
}

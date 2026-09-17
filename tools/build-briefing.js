#!/usr/bin/env node
/* Builds briefing.txt from Sleeper, so nobody has to copy it out of a browser.
   Runs in GitHub Actions. Needs no API key and costs nothing: it only reads
   public endpoints and writes a text file back into the repo.

   The analysis functions come from engine.js, which is the same code the
   website uses, so the two cannot drift apart. */

const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

const LEAGUE_ID = process.env.LEAGUE_ID || '1385278901562929152';
const API = 'https://api.sleeper.app/v1';
const PROJ_API = 'https://api.sleeper.com';
const STATUS_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const OUT = path.join(__dirname, '..', 'briefing.txt');
const DRAFT_PROJ_WEEK = 1;

const TEAM_ALIAS = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
const normTeam = t => TEAM_ALIAS[String(t || '').toUpperCase()] || String(t || '').toUpperCase();

async function get(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label || url} returned ${r.status}`);
  return r.json();
}
async function soft(url, label, fallback = null) {
  try { return await get(url, label); }
  catch (e) { console.error('  (soft fail) ' + e.message); return fallback; }
}

const n2 = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(d);
const pts = (a, b) => (Number(a) || 0) + (Number(b) || 0) / 100;

(async function main() {
  const L = [];
  const state = await get(`${API}/state/nfl`, 'state');
  const [league, users, rosters] = await Promise.all([
    get(`${API}/league/${LEAGUE_ID}`, 'league'),
    get(`${API}/league/${LEAGUE_ID}/users`, 'users'),
    get(`${API}/league/${LEAGUE_ID}/rosters`, 'rosters')
  ]);

  let week = Number(state.display_week || state.week || 1) || 1;
  if (String(league.season) !== String(state.season)) week = 1;
  week = Math.max(1, Math.min(week, 18));

  const playoffStart = (league.settings && league.settings.playoff_week_start) || 15;
  const regWeeks = Math.max(1, Math.min(playoffStart - 1, 18));
  const budget = (league.settings && league.settings.waiver_budget) || 100;
  const slots = league.roster_positions || [];

  let finalWeek = 0;
  for (const r of rosters) {
    const s = r.settings || {};
    finalWeek = Math.max(finalWeek, (s.wins || 0) + (s.losses || 0) + (s.ties || 0));
  }
  finalWeek = Math.min(finalWeek, week);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
  const teamName = rid => {
    const r = rosterById[rid], u = r && userById[r.owner_id];
    if (!u) return 'Roster ' + rid;
    return (u.metadata && u.metadata.team_name) || u.display_name || 'Roster ' + rid;
  };
  const manager = rid => {
    const r = rosterById[rid], u = r && userById[r.owner_id];
    return u ? (u.display_name || '') : '';
  };

  // ---- bulk fetches ----
  const weeks = Array.from({ length: regWeeks }, (_, i) => i + 1);
  const txWeeks = Array.from({ length: week }, (_, i) => i + 1);
  const [matchupList, txList, drafts] = await Promise.all([
    Promise.all(weeks.map(w => soft(`${API}/league/${LEAGUE_ID}/matchups/${w}`, `matchups ${w}`, []))),
    Promise.all(txWeeks.map(w => soft(`${API}/league/${LEAGUE_ID}/transactions/${w}`, `tx ${w}`, []))),
    soft(`${API}/league/${LEAGUE_ID}/drafts`, 'drafts', [])
  ]);
  const matchups = {};
  weeks.forEach((w, i) => { matchups[w] = matchupList[i] || []; });
  const transactions = [];
  txWeeks.forEach((w, i) => (txList[i] || []).forEach(t => { t._week = w; transactions.push(t); }));
  transactions.sort((a, b) => (b.status_updated || 0) - (a.status_updated || 0));

  let picks = [];
  if (drafts && drafts.length && drafts[0].draft_id) {
    picks = await soft(`${API}/draft/${drafts[0].draft_id}/picks`, 'picks', []) || [];
  }

  let players = await soft(`${API}/players/nfl?active=true`, 'players', null);
  if (!players || Object.keys(players).length < 500) {
    players = await soft(`${API}/players/nfl`, 'players full', {}) || {};
  }

  const scoringKey = (() => {
    const rec = Number((league.scoring_settings || {}).rec) || 0;
    return rec >= 1 ? 'pts_ppr' : (rec > 0 ? 'pts_half_ppr' : 'pts_std');
  })();
  async function projectionsFor(w) {
    const rows = await soft(
      `${PROJ_API}/projections/nfl/${league.season}/${w}?season_type=regular&order_by=ppr`,
      `projections ${w}`, null);
    if (!rows || !rows.length) return null;
    const map = {};
    for (const row of rows) {
      const pid = row.player_id || (row.player && row.player.player_id);
      if (!pid) continue;
      const st = row.stats || {};
      const v = st[scoringKey] ?? st.pts_ppr ?? st.pts_std;
      if (v == null) continue;
      map[pid] = Number(v) || 0;
    }
    return Object.keys(map).length ? map : null;
  }
  const projections = await projectionsFor(week);
  const draftProj = DRAFT_PROJ_WEEK === week ? projections : (await projectionsFor(DRAFT_PROJ_WEEK)) || projections;

  let gameStatus = null, statusError = null;
  try {
    const sc = await get(`${STATUS_API}?week=${week}&seasontype=2&dates=${league.season}`, 'status');
    const map = {};
    for (const ev of sc.events || []) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      const st = comp.status?.type?.state || ev.status?.type?.state;
      if (!st) continue;
      for (const c of comp.competitors || []) {
        const ab = c?.team?.abbreviation;
        if (ab) map[normTeam(ab)] = st;
      }
    }
    if (Object.keys(map).length) gameStatus = map; else statusError = 'no teams in feed';
  } catch (e) { statusError = e.message; }

  const playerName = pid => {
    const p = players[pid];
    if (p) return p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || pid;
    if (/^[A-Z]{2,4}$/.test(pid)) return pid + ' defense';
    return 'Player ' + pid;
  };
  const playerMeta = pid => {
    const p = players[pid];
    return p ? [p.position, p.team].filter(Boolean).join(' \u00b7 ') : '';
  };
  const injuryOf = pid => {
    const p = players[pid];
    if (!p || !p.injury_status) return null;
    const part = p.injury_body_part ? String(p.injury_body_part) : '';
    return { status: String(p.injury_status), label: String(p.injury_status) + (part ? ` (${part})` : '') };
  };
  const gameState = pid => {
    if (!gameStatus) return null;
    const p = players[pid];
    const team = p && p.team ? normTeam(p.team) : (/^[A-Z]{2,4}$/.test(pid) ? normTeam(pid) : null);
    return team ? (gameStatus[team] || null) : null;
  };
  const stateLabel = s => s === 'pre' ? 'yet to play' : s === 'in' ? 'playing now' : s === 'post' ? 'final' : '';

  // ---- derived ----
  const scoresByWeek = {};
  for (const w of weeks) {
    if (w > finalWeek) continue;
    const rows = matchups[w] || [];
    if (!rows.some(m => (Number(m.points) || 0) > 0)) continue;
    scoresByWeek[w] = Object.fromEntries(rows.map(m => [m.roster_id, Number(m.points) || 0]));
  }
  const schedules = {};
  for (const w of weeks) {
    const g = {};
    for (const m of matchups[w] || []) {
      if (m.matchup_id == null) continue;
      (g[m.matchup_id] = g[m.matchup_id] || []).push(m.roster_id);
    }
    const map = {};
    for (const k of Object.keys(g)) if (g[k].length === 2) { map[g[k][0]] = g[k][1]; map[g[k][1]] = g[k][0]; }
    if (Object.keys(map).length) schedules[w] = map;
  }
  const allPlay = {};
  rosters.forEach(r => { allPlay[r.roster_id] = { w: 0, l: 0, games: 0 }; });
  for (const w of Object.keys(scoresByWeek)) {
    const entries = Object.entries(scoresByWeek[w]).map(([rid, p]) => ({ rid: Number(rid), p }));
    for (const me of entries) for (const o of entries) {
      if (me.rid === o.rid) continue;
      allPlay[me.rid].games++;
      if (me.p > o.p) allPlay[me.rid].w++; else if (me.p < o.p) allPlay[me.rid].l++;
    }
  }

  const rosterPlayerIds = rosters.flatMap(r => r.players || []);
  const gapFix = projections ? E.fillProjectionGaps(projections, players, rosterPlayerIds) : null;
  const projFilled = gapFix ? gapFix.map : null;

  const strength = {};
  if (projFilled && slots.length) {
    for (const r of rosters) {
      const best = E.optimalLineup(r.players || [], projFilled, slots, players);
      if (best && best.points) strength[r.roster_id] = best.points;
    }
  }

  const eff = {};
  if (slots.length) {
    for (const r of rosters) eff[r.roster_id] = { actual: 0, optimal: 0 };
    for (const w of weeks) {
      if (w > finalWeek) continue;
      for (const m of matchups[w] || []) {
        const e = eff[m.roster_id];
        if (!e) continue;
        const pp = m.players_points || {};
        const ids = (m.players && m.players.length) ? m.players : Object.keys(pp);
        if (!ids.length) continue;
        const best = E.optimalLineup(ids, pp, slots, players);
        if (!best || !best.points) continue;
        e.actual += Number(m.points) || 0;
        e.optimal += best.points;
      }
    }
    for (const k of Object.keys(eff)) {
      eff[k].pct = eff[k].optimal ? eff[k].actual / eff[k].optimal : null;
      eff[k].lost = eff[k].optimal - eff[k].actual;
    }
  }

  // ---------------- output ----------------
  L.push('LEAGUE BRIEFING');
  L.push(`${league.name}, ${league.season} season, through week ${week}`);
  L.push(`Teams: ${rosters.length}. FAAB budget: $${budget}.`);
  L.push(`Generated automatically at ${new Date().toISOString()}.`);
  L.push('');

  L.push('STANDINGS (rank, team, manager, record, points for, points against, all-play, expected wins, luck)');
  const standings = rosters.map(r => {
    const s = r.settings || {};
    const w = s.wins || 0, l = s.losses || 0, t = s.ties || 0;
    const a = allPlay[r.roster_id] || { w: 0, l: 0, games: 0 };
    const pct = a.games ? a.w / a.games : 0;
    return {
      rid: r.roster_id, w, l, t,
      pf: pts(s.fpts, s.fpts_decimal), pa: pts(s.fpts_against, s.fpts_against_decimal),
      a, exp: pct * (w + l + t), luck: w - pct * (w + l + t)
    };
  }).sort((x, y) => y.w - x.w || y.pf - x.pf);
  standings.forEach((r, i) => L.push(
    `${i + 1}. ${teamName(r.rid)} (${manager(r.rid)}) ${r.w}-${r.l}${r.t ? '-' + r.t : ''}, ` +
    `PF ${n2(r.pf)}, PA ${n2(r.pa)}, all-play ${r.a.w}-${r.a.l}, ` +
    `expected ${n2(r.exp, 1)}, luck ${r.luck > 0 ? '+' : ''}${n2(r.luck, 1)}`));
  L.push('');

  if (finalWeek) {
    L.push(`WEEK ${finalWeek} RESULTS`);
    const g = {};
    for (const m of matchups[finalWeek] || []) {
      if (m.matchup_id == null) continue;
      (g[m.matchup_id] = g[m.matchup_id] || []).push(m);
    }
    for (const k of Object.keys(g)) {
      const p = g[k];
      if (p.length < 2) continue;
      const [a, b] = p;
      const pa = Number(a.points) || 0, pb = Number(b.points) || 0;
      const hi = pa >= pb ? a : b, lo = pa >= pb ? b : a;
      L.push(`${teamName(hi.roster_id)} ${n2(Math.max(pa, pb))} def ${teamName(lo.roster_id)} ` +
        `${n2(Math.min(pa, pb))} (margin ${n2(Math.abs(pa - pb))})`);
    }
    L.push('');
  }

  if (Object.keys(eff).length && finalWeek) {
    L.push('LINEUP EFFICIENCY (actual points as a share of the best lineup available)');
    Object.entries(eff).filter(([, e]) => e.pct != null)
      .sort((a, b) => b[1].pct - a[1].pct)
      .forEach(([rid, e]) => L.push(
        `${teamName(Number(rid))}: ${Math.round(e.pct * 100)}%, ${n2(e.lost, 1)} points left unstarted`));
    L.push('');
  }

  if (gapFix && gapFix.filled.length) {
    L.push('MISSING PROJECTIONS (substituted with replacement level at that position, not zero)');
    gapFix.filled.slice(0, 25).forEach(g =>
      L.push(`  ${playerName(g.pid)} (${g.pos}) had no published projection, using ${n2(g.value, 1)}`));
    L.push('');
  }

  if (Object.keys(strength).length) {
    L.push(`PROJECTED WEEKLY SCORE (best lineup each roster could start, week ${week})`);
    Object.entries(strength).sort((a, b) => b[1] - a[1])
      .forEach(([rid, p], i) => L.push(`${i + 1}. ${teamName(Number(rid))}: ${n2(p, 1)}`));
    L.push('');
  }

  // playoff odds
  const perTeam = {};
  rosters.forEach(r => { perTeam[r.roster_id] = []; });
  for (const w of Object.keys(scoresByWeek))
    for (const [rid, p] of Object.entries(scoresByWeek[w])) perTeam[rid]?.push(p);
  const allScores = Object.values(perTeam).flat();
  const leagueSd = E.meanSd(allScores).sd;
  const played = Math.max(0, ...Object.values(perTeam).map(a => a.length));
  if (Object.keys(strength).length || played >= 2) {
    const teams = rosters.map(r => {
      const s = r.settings || {};
      const list = perTeam[r.roster_id] || [];
      const ms = E.meanSd(list);
      const mean = E.blendMean(ms.mean, list.length, strength[r.roster_id] ?? null);
      let sd = (list.length >= 3 && ms.sd > 0) ? ms.sd : (leagueSd > 0 ? leagueSd : Math.max(18, mean * 0.2));
      return { rid: r.roster_id, wins: (s.wins || 0) + (s.ties || 0) * 0.5, pts: pts(s.fpts, s.fpts_decimal), mean, sd };
    });
    const remaining = [];
    for (let w = finalWeek + 1; w <= regWeeks; w++) {
      if (!schedules[w]) continue;
      const seen = {}, pairs = [];
      for (const [a, b] of Object.entries(schedules[w])) {
        const key = Math.min(a, b) + '-' + Math.max(a, b);
        if (seen[key]) continue;
        seen[key] = 1;
        pairs.push([Number(a), Number(b)]);
      }
      if (pairs.length) remaining.push({ week: w, pairs });
    }
    const spots = (league.settings && league.settings.playoff_teams) || 6;
    const res = E.simulateSeason({ teams, schedule: remaining, playoffSpots: spots, runs: 5000 });
    L.push(`PLAYOFF ODDS (5000 simulations, top ${spots} advance, ${remaining.length} weeks left)`);
    res.sort((a, b) => b.playoffs - a.playoffs).forEach(r =>
      L.push(`${teamName(r.rid)}: ${Math.round(r.playoffs * 100)}% playoffs, ${Math.round(r.topSeed * 100)}% top seed`));
    L.push('');
  }

  if (picks.length) {
    const dr = E.gradeDraft(picks, players, slots, draftProj, rosters.length);
    if (dr.length) {
      L.push('DRAFT VALUE (positive means players fell to them, negative means they reached)');
      L.push(`Graded against week ${DRAFT_PROJ_WEEK} projections, so this table should not move week to week.`);
      dr.forEach((r, i) => L.push(
        `${i + 1}. ${teamName(r.rid)}: ${r.avgValue > 0 ? '+' : ''}${n2(r.avgValue, 1)} per pick` +
        (r.best ? `, best ${playerName(r.best.pid)} at pick ${r.best.pick}` : '') +
        (r.worst ? `, worst ${playerName(r.worst.pid)} at pick ${r.worst.pick}` : '') +
        (r.avgAge ? `, average age ${n2(r.avgAge, 1)}` : '')));
      L.push('');
    }
  }

  L.push('FAAB REMAINING');
  rosters.map(r => ({ rid: r.roster_id, used: Number((r.settings || {}).waiver_budget_used) || 0 }))
    .sort((a, b) => a.used - b.used)
    .forEach(r => L.push(`${teamName(r.rid)}: $${budget - r.used} left, $${r.used} spent`));
  L.push('');

  // waiver claims, winners and losers together
  const claims = {};
  for (const t of transactions) {
    if (t.type !== 'waiver' || !t.adds) continue;
    for (const pid of Object.keys(t.adds)) {
      const key = `${t._week}:${pid}`;
      const c = claims[key] || (claims[key] = { week: t._week, pid, bids: [], when: t.status_updated });
      c.bids.push({
        roster: (t.roster_ids && t.roster_ids[0]) || t.adds[pid],
        amount: (t.settings && t.settings.waiver_bid) || 0,
        won: t.status === 'complete'
      });
    }
  }
  L.push('WAIVER CLAIMS, NEWEST FIRST (winning bid first, then losing bids)');
  Object.values(claims).sort((a, b) => (b.when || 0) - (a.when || 0)).slice(0, 25).forEach(c => {
    c.bids.sort((a, b) => b.amount - a.amount);
    L.push(`Week ${c.week}: ${playerName(c.pid)} -- ` +
      c.bids.map(b => `${teamName(b.roster)} $${b.amount}${b.won ? ' WON' : ' lost'}`).join('; '));
  });
  L.push('');

  L.push('RECENT FREE AGENT MOVES');
  transactions.filter(t => t.type === 'free_agent' && t.status === 'complete').slice(0, 20).forEach(t => {
    const a = Object.entries(t.adds || {}).map(([pid, rid]) => `${playerName(pid)} to ${teamName(rid)}`);
    const d = Object.entries(t.drops || {}).map(([pid, rid]) => `${playerName(pid)} from ${teamName(rid)}`);
    L.push(`Week ${t._week}: added ${a.join(', ') || 'none'}; dropped ${d.join(', ') || 'none'}`);
  });
  L.push('');

  // player scoring with game state
  L.push(`PLAYER SCORING, WEEK ${week} (${finalWeek >= week ? 'final' : 'still in progress'})`);
  L.push('Starters listed as: player (position, NFL team) projected -> actual. A dash means no projection was published.');
  if (gameStatus) {
    L.push('Each starter is tagged with his game state: yet to play, playing now, or final.');
    L.push('A player marked final with 0.00 scored nothing. He is not still to come.');
  } else {
    L.push(`GAME STATUS UNAVAILABLE${statusError ? ' (' + statusError + ')' : ''}. A 0.00 may mean the player has not kicked off or may mean he scored nothing. Do not guess which.`);
  }
  const groups = {};
  for (const m of matchups[week] || []) {
    const k = m.matchup_id == null ? 'bye' + m.roster_id : m.matchup_id;
    (groups[k] = groups[k] || []).push(m);
  }
  const remainingFor = m => {
    if (!gameStatus) return null;
    const out = { count: 0, proj: 0, players: [] };
    for (const pid of m.starters || []) {
      if (!pid || pid === '0') continue;
      const st = gameState(pid);
      if (st !== 'pre' && st !== 'in') continue;
      const pr = projections && projections[pid] != null ? Number(projections[pid]) : 0;
      out.count++; out.proj += pr;
      out.players.push({ pid, proj: pr });
    }
    return out;
  };
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    L.push('');
    if (g.length === 2) {
      L.push(`MATCHUP: ${teamName(g[0].roster_id)} ${n2(g[0].points)} vs ${teamName(g[1].roster_id)} ${n2(g[1].points)}`);
    }
    for (const m of g) {
      const pp = m.players_points || {}, starters = m.starters || [];
      let projTotal = 0, hasProj = false;
      for (const pid of starters) if (projections && projections[pid] != null) { projTotal += Number(projections[pid]); hasProj = true; }
      const rem = remainingFor(m);
      L.push(`${teamName(m.roster_id)} (${manager(m.roster_id)}) scored ${n2(m.points)}` +
        (hasProj ? `, projected ${n2(projTotal, 1)}` : '') +
        (rem ? `, ${rem.count} starter${rem.count === 1 ? '' : 's'} left worth ${n2(rem.proj, 1)} projected` : ''));
      for (const pid of starters) {
        if (!pid || pid === '0') { L.push('  empty slot'); continue; }
        const pr = projections && projections[pid] != null ? n2(projections[pid], 1) : '--';
        const meta = playerMeta(pid), gs = stateLabel(gameState(pid));
        const inj = injuryOf(pid);
        L.push(`  ${playerName(pid)}${meta ? ' (' + meta + ')' : ''} ${pr} -> ${n2(pp[pid] || 0)}${gs ? '  [' + gs + ']' : ''}${inj ? '  INJURY: ' + inj.label : ''}`);
      }
      const bench = (m.players || []).filter(pid => !starters.includes(pid) && pp[pid] != null)
        .map(pid => `${playerName(pid)} ${n2(pp[pid])}`);
      if (bench.length) L.push('  bench: ' + bench.join(', '));
    }
  }
  L.push('');

  // injury report
  {
    const starters = {};
    for (const m of matchups[week] || []) for (const p of m.starters || []) starters[`${m.roster_id}:${p}`] = 1;
    const rows = [];
    for (const r of rosters) for (const pid of r.players || []) {
      const inj = injuryOf(pid);
      if (inj) rows.push({ rid: r.roster_id, pid, inj, starting: !!starters[`${r.roster_id}:${pid}`] });
    }
    if (rows.length) {
      const rank = { out: 0, ir: 0, doubtful: 1, questionable: 2 };
      rows.sort((a, b) => (rank[a.inj.status.toLowerCase()] ?? 3) - (rank[b.inj.status.toLowerCase()] ?? 3)
        || (b.starting ? 1 : 0) - (a.starting ? 1 : 0));
      L.push('INJURY REPORT (designation from Sleeper, not a post-game write-up)');
      for (const x of rows.slice(0, 40))
        L.push(`  ${playerName(x.pid)} (${playerMeta(x.pid) || '?'}) ${x.inj.label} -- ${teamName(x.rid)}` +
          (x.starting ? ', IN THE LINEUP this week' : ', on the bench'));
      L.push('');
    }
  }

  // still to play
  if (!gameStatus) {
    L.push('STILL TO PLAY: unknown, the game status feed is unavailable.');
  } else {
    L.push(`STILL TO PLAY, WEEK ${week}`);
    let live = 0;
    for (const k of Object.keys(groups)) {
      const g = groups[k];
      if (g.length !== 2) continue;
      const [a, b] = g;
      const sa = Number(a.points) || 0, sb = Number(b.points) || 0;
      const ra = remainingFor(a), rb = remainingFor(b);
      const lead = sa >= sb ? a : b, trail = sa >= sb ? b : a;
      const rLead = sa >= sb ? ra : rb, rTrail = sa >= sb ? rb : ra;
      const margin = Math.abs(sa - sb);
      let line = `${teamName(lead.roster_id)} ${n2(Math.max(sa, sb))} leads ${teamName(trail.roster_id)} ` +
        `${n2(Math.min(sa, sb))} by ${n2(margin)}. ${teamName(trail.roster_id)} has ${rTrail.count} left ` +
        `(${n2(rTrail.proj, 1)} projected), ${teamName(lead.roster_id)} has ${rLead.count} left (${n2(rLead.proj, 1)} projected).`;
      if (!rTrail.count) line += ' DECIDED: the trailing team has nobody left.';
      else { live++; line += ` LIVE: needs ${n2(margin + rLead.proj, 1)} from those players if the leader hits projection.`; }
      L.push(line);
      for (const p of rTrail.players)
        L.push(`   ${teamName(trail.roster_id)} still to come: ${playerName(p.pid)} (${playerMeta(p.pid) || '?'}) projected ${n2(p.proj, 1)}`);
      for (const p of rLead.players)
        L.push(`   ${teamName(lead.roster_id)} still to come: ${playerName(p.pid)} (${playerMeta(p.pid) || '?'}) projected ${n2(p.proj, 1)}`);
    }
    L.push(live ? `${live} matchup${live === 1 ? ' is' : 's are'} still live.` : 'Every matchup is decided.');
  }
  L.push('');

  // ---- editorial context from what has been published ----
  const readLocal = f => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')); }
    catch (e) { return null; }
  };
  const news = readLocal('news.json');
  const archIdx = readLocal('archive/index.json');
  const editions = [];
  for (const e of (archIdx && archIdx.editions) || []) {
    const doc = readLocal(path.join('archive', typeof e === 'string' ? e : e.file));
    if (doc) { if (doc.week == null && e.week != null) doc.week = e.week; editions.push(doc); }
  }
  if (news) editions.push(news);

  if (editions.length) {
    L.push('EDITORIAL CONTEXT');
    for (const ed of editions.slice(-2)) {
      L.push('');
      L.push(`${ed.week != null ? 'WEEK ' + ed.week : 'PREVIOUS'} HEADLINES`);
      for (const s of ed.stories || []) L.push('- ' + s.headline);
    }
    const last = editions[editions.length - 1];
    const byAnalyst = {};
    for (const s of (last && last.stories) || [])
      for (const t of s.takes || []) (byAnalyst[t.analyst] = byAnalyst[t.analyst] || []).push(t.text);
    if (Object.keys(byAnalyst).length) {
      L.push('');
      L.push('MOST RECENT ANALYST TAKES (these are on the record and can be judged)');
      for (const [k, arr] of Object.entries(byAnalyst)) {
        L.push(k + ':');
        arr.slice(0, 4).forEach(t => L.push('  - ' + (t.length > 200 ? t.slice(0, 197) + '...' : t)));
      }
    }

    const actualRank = {};
    if (finalWeek) standings.forEach((r, i) => { actualRank[r.rid] = i + 1; });
    const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const resolve = nm => {
      const k = normKey(nm);
      for (const r of rosters) if (normKey(teamName(r.roster_id)) === k) return r.roster_id;
      for (const r of rosters) {
        const tk = normKey(teamName(r.roster_id));
        if (tk && (tk.startsWith(k) || k.startsWith(tk))) return r.roster_id;
      }
      return null;
    };
    for (const ed of editions.filter(e => e.poll && e.poll.ballots).slice(-2)) {
      L.push('');
      L.push(`BALLOTS ON THE RECORD: ${ed.poll.title || 'poll'}${ed.week != null ? ' (week ' + ed.week + ')' : ''}`);
      for (const b of ed.poll.ballots) {
        if (!b.ranking) continue;
        L.push(`${b.analyst}: ${b.ranking.join(' > ')}`);
        if (finalWeek) {
          const ids = b.ranking.map(resolve).filter(x => x != null);
          const sc = E.scoreRanking(ids, actualRank);
          if (sc) L.push(`  scored so far: ${Math.round(sc.pairwise * 100)}% pairwise, ${n2(sc.mae, 1)} spots off on average` +
            (sc.worst ? `, worst call ${teamName(sc.worst.id)} (had them ${sc.worst.predicted}, actually ${sc.worst.actual})` : ''));
        }
      }
    }

    const open = editions.flatMap(ed => (ed.stories || []).map(s => s.storyline).filter(Boolean));
    if (open.length) {
      L.push('');
      L.push('ONGOING STORYLINES');
      open.forEach(s => L.push('- ' + s));
    }
    L.push('');
  }

  L.push('HOW TO USE THIS');
  L.push('Work out what actually changed since the previous edition first, then continue existing');
  L.push('storylines, then check whether any earlier take can now be judged, then look for new stories.');
  L.push("Do not manufacture continuity and do not rerun last week's article unless the evidence moved.");
  L.push('Every factual claim must come from this briefing. Analysts may exaggerate what the facts mean;');
  L.push('they may not invent facts.');

  fs.writeFileSync(OUT, L.join('\n') + '\n', 'utf8');
  console.log(`wrote ${OUT}, ${L.length} lines, ${fs.statSync(OUT).size} bytes`);
})().catch(e => { console.error('FAILED: ' + (e.stack || e.message)); process.exit(1); });

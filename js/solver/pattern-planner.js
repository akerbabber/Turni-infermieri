/**
 * @file pattern-planner.js — Coverage-aware cyclic pattern beam planner
 * @description Builds schedules by selecting whole-month nurse patterns with
 * coverage-aware beam search, then lets the shared repair/polish layer refine it.
 */

'use strict';

/* global LOCAL_SEARCH_ITERS, MP_CYCLE_PATTERNS, SHORT_MP_CYCLE_PATTERNS, SHIFT_HOURS */
/* global buildContext, collectViolations, computeScore */
/* global computeStats, getAllowedMPCyclePatterns, getMPCyclePlan */
/* global getNightPatternInfo, getShiftAt, hasForbiddenExtraNightRest, isForbiddenRestrictedNoDiurniRestDay */
/* global isMPCycleLimitedNurse, isSplitRestDay, localSearch, requiredRest, transitionOk */

// ---------------------------------------------------------------------------
// Pattern Beam planner
// ---------------------------------------------------------------------------

const PATTERN_BEAM_WIDTH = 64;
const PATTERN_CANDIDATE_LIMIT = 24;

function solvePattern(config, timeBudgetSec) {
  const ctx = buildContext(config);
  const initial = constructPatternSchedule(ctx);
  const improved = localSearch(initial, ctx, LOCAL_SEARCH_ITERS, timeBudgetSec || 0);
  const violations = collectViolations(improved, ctx);
  const stats = computeStats(improved, ctx);
  const score = computeScore(improved, ctx);
  return { schedule: improved, violations, stats, score: score.total };
}

function constructPatternSchedule(ctx, options) {
  const beamWidth = Math.max(1, options?.beamWidth || PATTERN_BEAM_WIDTH);
  const candidateLimit = Math.max(1, options?.candidateLimit || PATTERN_CANDIDATE_LIMIT);
  const individualCandidates = Array.from({ length: ctx.numNurses }, (_, n) =>
    getPatternCandidateRows(ctx, n, candidateLimit)
  );
  const groups = buildPatternGroups(ctx, individualCandidates);

  const greedySchedule = constructGreedyPatternSchedule(ctx, groups, individualCandidates);
  if (options?.greedyOnly) return greedySchedule;
  let states = [makePatternState(ctx)];
  for (const group of groups) {
    const nextStates = [];
    for (const state of states) {
      for (const candidate of group.candidates) {
        nextStates.push(addPatternGroup(state, candidate, ctx));
      }
    }
    nextStates.sort((a, b) => patternStateEstimate(a, ctx) - patternStateEstimate(b, ctx));
    states = nextStates.slice(0, beamWidth);
  }

  let bestSchedule = null;
  let bestScore = Infinity;
  for (const state of states) {
    const schedule = finalizePatternSchedule(state, ctx, individualCandidates);
    const score = computeScore(schedule, ctx);
    const total = score.total + state.rowCost * 0.01;
    if (total < bestScore) {
      bestScore = total;
      bestSchedule = schedule;
    }
  }
  if (!bestSchedule) return greedySchedule;
  return computeScore(greedySchedule, ctx).total < computeScore(bestSchedule, ctx).total
    ? greedySchedule
    : bestSchedule;
}

function constructGreedyPatternSchedule(ctx, groups, individualCandidates) {
  let state = makePatternState(ctx);
  for (const group of groups) {
    let bestState = null;
    let bestScore = Infinity;
    for (const candidate of group.candidates) {
      const next = addPatternGroup(state, candidate, ctx);
      const score = patternCandidateLoadCost(state, candidate, next, ctx);
      if (score < bestScore) {
        bestState = next;
        bestScore = score;
      }
    }
    state = bestState || state;
  }
  return finalizePatternSchedule(state, ctx, individualCandidates);
}

function patternCandidateLoadCost(before, candidate, after, ctx) {
  let score = candidate.rowCost + candidate.hardCost * 1000;
  for (const item of candidate.rows) {
    for (let d = 0; d < ctx.numDays; d++) {
      const shift = item.row[d];
      if (shift === 'N') {
        score += before.covN[d] * 120;
        score += Math.max(0, after.covN[d] - ctx.maxCovN) * 2000;
      } else if (shift === 'D') {
        score += (before.covM[d] + before.covP[d]) * 24;
        score += Math.max(0, after.covM[d] - ctx.maxCovM) * 900;
        score += Math.max(0, after.covP[d] - ctx.maxCovP) * 900;
      } else if (shift === 'M') {
        score += before.covM[d] * 18;
        score += Math.max(0, after.covM[d] - ctx.maxCovM) * 700;
      } else if (shift === 'P') {
        score += before.covP[d] * 18;
        score += Math.max(0, after.covP[d] - ctx.maxCovP) * 700;
      }
    }
  }
  score += patternStateEstimate(after, ctx) * 0.05;
  return score;
}

function buildPatternGroups(ctx, individualCandidates) {
  const groups = [];
  const used = new Set();
  const pair = ctx.coppiaTurni;
  if (pair && Array.isArray(pair) && pair.length === 2) {
    const [n1, n2] = pair;
    if (
      n1 >= 0 &&
      n1 < ctx.numNurses &&
      n2 >= 0 &&
      n2 < ctx.numNurses &&
      n1 !== n2 &&
      patternSameNurseType(ctx.nurseProps[n1], ctx.nurseProps[n2])
    ) {
      const candidates = buildPairedPatternCandidates(ctx, n1, n2, individualCandidates[n1]);
      if (candidates.length > 0) {
        groups.push({ nurses: [n1, n2], candidates });
        used.add(n1);
        used.add(n2);
      }
    }
  }

  for (let n = 0; n < ctx.numNurses; n++) {
    if (used.has(n)) continue;
    groups.push({
      nurses: [n],
      candidates: individualCandidates[n].map(candidate => ({
        rows: [{ n, row: candidate.row }],
        rowCost: candidate.cost,
        hardCost: candidate.hard,
      })),
    });
  }

  groups.sort((a, b) => {
    const aNight = a.nurses.some(n => patternNightEligible(ctx.nurseProps[n])) ? 0 : 1;
    const bNight = b.nurses.some(n => patternNightEligible(ctx.nurseProps[n])) ? 0 : 1;
    if (a.candidates.length !== b.candidates.length) return a.candidates.length - b.candidates.length;
    if (aNight !== bNight) return aNight - bNight;
    return a.nurses[0] - b.nurses[0];
  });
  return groups;
}

function buildPairedPatternCandidates(ctx, n1, n2, masterCandidates) {
  const paired = [];
  for (const candidate of masterCandidates) {
    if (!patternRowHonorsPinned(candidate.row, ctx, n2)) continue;
    const hard2 = patternRowHardCost(candidate.row, ctx, n2);
    paired.push({
      rows: [
        { n: n1, row: candidate.row },
        { n: n2, row: [...candidate.row] },
      ],
      rowCost: candidate.cost + patternRowSoftCost(candidate.row, ctx, n2),
      hardCost: candidate.hard + hard2,
    });
  }
  return paired.slice(0, PATTERN_CANDIDATE_LIMIT);
}

function makePatternState(ctx) {
  return {
    rows: new Array(ctx.numNurses).fill(null),
    covM: new Array(ctx.numDays).fill(0),
    covP: new Array(ctx.numDays).fill(0),
    covD: new Array(ctx.numDays).fill(0),
    covN: new Array(ctx.numDays).fill(0),
    assigned: 0,
    rowCost: 0,
  };
}

function addPatternGroup(state, candidate, ctx) {
  const next = {
    rows: state.rows.slice(),
    covM: state.covM.slice(),
    covP: state.covP.slice(),
    covD: state.covD.slice(),
    covN: state.covN.slice(),
    assigned: state.assigned,
    rowCost: state.rowCost + candidate.rowCost + candidate.hardCost * 1000,
  };
  for (const item of candidate.rows) {
    next.rows[item.n] = item.row;
    next.assigned++;
    for (let d = 0; d < ctx.numDays; d++) addPatternCoverage(next, d, item.row[d], 1);
  }
  return next;
}

function addPatternCoverage(state, d, shift, delta) {
  if (shift === 'M') state.covM[d] += delta;
  else if (shift === 'P') state.covP[d] += delta;
  else if (shift === 'D') {
    state.covD[d] += delta;
    state.covM[d] += delta;
    state.covP[d] += delta;
  } else if (shift === 'N') state.covN[d] += delta;
}

function patternStateEstimate(state, ctx) {
  const nightTarget = patternTargetNightCoverage(ctx);
  let score = state.rowCost * 0.18;
  for (let d = 0; d < ctx.numDays; d++) {
    const expectedM = ctx.minCovM;
    const expectedP = ctx.minCovP;
    const expectedN = nightTarget;
    const mDef = Math.max(0, expectedM - state.covM[d]);
    const pDef = Math.max(0, expectedP - state.covP[d]);
    const nDef = Math.max(0, expectedN - state.covN[d]);
    const mOver = Math.max(0, state.covM[d] - ctx.maxCovM);
    const pOver = Math.max(0, state.covP[d] - ctx.maxCovP);
    const nOver = Math.max(0, state.covN[d] - ctx.maxCovN);
    score += mDef * mDef * 18 + pDef * pDef * 18 + nDef * nDef * 260;
    score += mOver * mOver * 220 + pOver * pOver * 220 + nOver * nOver * 520;
  }
  return score;
}

function finalizePatternSchedule(state, ctx, individualCandidates) {
  const schedule = state.rows.map((row, n) => (row ? [...row] : [...individualCandidates[n][0].row]));
  for (let n = 0; n < ctx.numNurses; n++) {
    for (let d = 0; d < ctx.numDays; d++) {
      if (schedule[n][d] === null || schedule[n][d] === undefined) schedule[n][d] = ctx.pinned[n][d] || 'R';
    }
  }
  return schedule;
}

function getPatternCandidateRows(ctx, n, candidateLimit) {
  const families = getPatternFamilies(ctx, n);
  const seen = new Set();
  const candidates = [];

  function addRow(row, label) {
    const key = row.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const hard = patternRowHardCost(row, ctx, n);
    const cost = patternRowSoftCost(row, ctx, n);
    candidates.push({ row, label, hard, cost });
  }

  for (const family of families) {
    for (let offset = 0; offset < family.pattern.length; offset++) {
      addRow(materializePatternRow(ctx, n, family.pattern, offset), family.label);
    }
  }
  if (candidates.length === 0 || !candidates.some(candidate => candidate.hard === 0)) {
    addRow(makePinnedRestRow(ctx, n), 'pinned-rest');
  }

  candidates.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard - b.hard;
    return a.cost - b.cost;
  });

  return candidates.slice(0, candidateLimit);
}

function getPatternFamilies(ctx, n) {
  const props = ctx.nurseProps[n];
  const families = [];

  function add(label, pattern) {
    families.push({ label, pattern });
  }

  if (props.soloMattine || props.quattroMattineVenerdiNotte) {
    add('fixed-pinned', ['R']);
    return families;
  }

  if (isMPCycleLimitedNurse(props)) {
    for (const pattern of getAllowedMPCyclePatterns(props)) add('mp-cycle', pattern);
    return families;
  }

  if (props.mattineEPomeriggi) {
    for (const pattern of MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS)) add('mp-cycle', pattern);
    return families;
  }

  if (props.soloNotti) {
    add('solo-notti-4', ['N', 'S', 'R', 'R']);
    add('solo-notti-5', ['N', 'S', 'R', 'R', 'R']);
    return families;
  }

  if (props.noDiurni && !props.noNotti && !props.diurniNoNotti) {
    add('mp-night-5', ['M', 'P', 'N', 'S', 'R']);
    add('mp-night-5-mm', ['M', 'M', 'N', 'S', 'R']);
    add('mp-night-5-pp', ['P', 'P', 'N', 'S', 'R']);
    add('mp-night-6-mmp', ['M', 'M', 'P', 'N', 'S', 'R']);
    add('mp-night-6-mpp', ['M', 'P', 'P', 'N', 'S', 'R']);
    return families;
  }

  if (props.soloDiurni || props.noNotti || props.diurniNoNotti) {
    add('diurni-balanced', ['D', 'R', 'D', 'R', 'R']);
    add('diurni-light', ['D', 'R', 'R']);
    if (ctx.consente2D) add('diurni-double', ['D', 'D', 'R', 'R', 'R']);
    return families;
  }

  add('dn-5', ['D', 'N', 'S', 'R', 'R']);
  add('dn-5-rest-first', ['R', 'D', 'N', 'S', 'R']);
  add('drdn-7', ['D', 'R', 'D', 'N', 'S', 'R', 'R']);
  return families;
}

function materializePatternRow(ctx, n, pattern, offset) {
  const row = new Array(ctx.numDays);
  for (let d = 0; d < ctx.numDays; d++) {
    row[d] = ctx.pinned[n][d] || pattern[(d + offset) % pattern.length];
  }
  return row;
}

function makePinnedRestRow(ctx, n) {
  const row = new Array(ctx.numDays);
  for (let d = 0; d < ctx.numDays; d++) row[d] = ctx.pinned[n][d] || 'R';
  return row;
}

function patternRowHardCost(row, ctx, n) {
  const tmpSchedule = [];
  tmpSchedule[n] = row;
  const props = ctx.nurseProps[n];
  let hard = 0;

  if (!patternRowHonorsPinned(row, ctx, n)) hard += 1000;
  for (let d = 0; d < ctx.numDays; d++) {
    if (!patternShiftAllowed(props, row[d])) hard += 50;
    const prev = d > 0 ? row[d - 1] : null;
    if (!transitionOk(prev, row[d], ctx, tmpSchedule, n, d)) hard += 20;
  }

  for (let d = 0; d < ctx.numDays - 1; d++) {
    if (row[d] === 'N' && row[d + 1] !== 'S') hard += 100;
    if (row[d] === 'S' && row[d + 1] !== 'R') hard += 100;
  }
  for (let d = ctx.prevTail ? -3 : 0; d < ctx.numDays - 3; d++) {
    if (
      getShiftAt(tmpSchedule, ctx, n, d) === 'N' &&
      getShiftAt(tmpSchedule, ctx, n, d + 1) === 'S' &&
      getShiftAt(tmpSchedule, ctx, n, d + 2) === 'R' &&
      !props.noDiurni &&
      getShiftAt(tmpSchedule, ctx, n, d + 3) !== 'R'
    ) {
      hard += 100;
    }
  }
  if (ctx.consente2D) {
    for (let d = 1; d < ctx.numDays - 1; d++) {
      if (row[d - 1] === 'D' && row[d] === 'D' && row[d + 1] !== 'R') hard += 40;
    }
    for (let d = 2; d < ctx.numDays; d++) {
      if (row[d - 2] === 'D' && row[d - 1] === 'D' && row[d] === 'D') hard += 80;
    }
  }
  if (ctx.minRPerWeek > 0) {
    for (const wDays of ctx.weekDaysList) {
      const need = requiredRest(wDays.length, ctx.minRPerWeek);
      let have = 0;
      for (const d of wDays) if (row[d] === 'R') have++;
      if (have < need) hard += (need - have) * 40;
    }
  }
  for (let d = 0; d < ctx.numDays; d++) {
    if (row[d] !== 'N') continue;
    const info = getNightPatternInfo(tmpSchedule, ctx, n, d);
    if (info && !info.validLead) hard += 80;
    if (hasForbiddenExtraNightRest(tmpSchedule, ctx, n, d)) hard += 30;
  }
  if (isMPCycleLimitedNurse(props)) {
    hard += getMPCyclePlan(tmpSchedule, n, ctx.numDays, props).mismatch * 40;
  }
  return hard;
}

function patternRowSoftCost(row, ctx, n) {
  const tmpSchedule = [];
  tmpSchedule[n] = row;
  const props = ctx.nurseProps[n];
  const hours = row.reduce((sum, shift) => sum + (SHIFT_HOURS[shift] || 0), 0);
  const target = ctx.monthlyTargetHours + (ctx.hourDeltas ? ctx.hourDeltas[n] || 0 : 0);
  let cost = hours < target ? (target - hours) * 4 : (hours - target) * 2.5;

  if (patternNightEligible(props)) {
    const nights = row.filter(shift => shift === 'N').length;
    cost += Math.abs(nights - ctx.targetNights) * 18;
  }

  let splitRest = 0;
  for (let d = ctx.prevTail ? 0 : 1; d < ctx.numDays - 1; d++) {
    if (isSplitRestDay(tmpSchedule, ctx, n, d)) splitRest++;
    if (isForbiddenRestrictedNoDiurniRestDay(tmpSchedule, ctx, n, d)) splitRest += 2;
  }
  cost += splitRest * 8;
  return cost;
}

function patternRowHonorsPinned(row, ctx, n) {
  for (let d = 0; d < ctx.numDays; d++) {
    if (ctx.pinned[n][d] && row[d] !== ctx.pinned[n][d]) return false;
  }
  return true;
}

function patternShiftAllowed(props, shift) {
  if (shift === 'F' || shift === 'MA' || shift === 'L104' || shift === 'PR' || shift === 'MT') return true;
  if (props.soloMattine) return shift === 'M' || shift === 'R';
  if (props.soloDiurni) return shift === 'D' || shift === 'R';
  if (props.soloNotti) return shift === 'N' || shift === 'S' || shift === 'R';
  if (props.diurniENotturni) return shift === 'D' || shift === 'N' || shift === 'S' || shift === 'R';
  if (props.mattineEPomeriggi) return shift === 'M' || shift === 'P' || shift === 'R';
  if ((props.noNotti || props.diurniNoNotti) && (shift === 'N' || shift === 'S')) return false;
  if (props.noDiurni && shift === 'D') return false;
  return true;
}

function patternNightEligible(props) {
  return !(props.soloMattine || props.soloDiurni || props.noNotti || props.diurniNoNotti || props.mattineEPomeriggi);
}

function patternSameNurseType(a, b) {
  return (
    a.soloMattine === b.soloMattine &&
    a.quattroMattineVenerdiNotte === b.quattroMattineVenerdiNotte &&
    a.soloDiurni === b.soloDiurni &&
    a.soloNotti === b.soloNotti &&
    a.diurniENotturni === b.diurniENotturni &&
    a.noNotti === b.noNotti &&
    a.diurniNoNotti === b.diurniNoNotti &&
    a.noDiurni === b.noDiurni &&
    a.mattineEPomeriggi === b.mattineEPomeriggi
  );
}

function patternTargetNightCoverage(ctx) {
  let eligible = 0;
  for (const props of ctx.nurseProps) if (patternNightEligible(props)) eligible++;
  const target = (ctx.targetNights * eligible) / Math.max(1, ctx.numDays);
  return Math.max(ctx.minCovN, Math.min(ctx.maxCovN, target));
}

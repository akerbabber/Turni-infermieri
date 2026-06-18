/**
 * @file pattern-planner.js — Coverage-aware cyclic pattern beam planner
 * @description Builds schedules by selecting whole-month nurse patterns with
 * coverage-aware beam search, then lets the shared repair/polish layer refine it.
 */

'use strict';

/* global LOCAL_SEARCH_ITERS, MP_CYCLE_PATTERNS, SHORT_MP_CYCLE_PATTERNS, SHIFT_HOURS */
/* global buildContext, collectViolations, computeScore, construct, countWeekRest */
/* global dayCoverage, nurseHours */
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

function solveNightFirstPattern(config, timeBudgetSec) {
  const ctx = buildContext(config);
  // Night-first mode pins a balanced night skeleton before filling day shifts, so
  // localSearch must run against the same pinned context to preserve those nights.
  const nightCtx = withNightSkeletonPins(ctx);
  const initial = constructNightFirstPatternSchedule(nightCtx);
  const improved = localSearch(initial, nightCtx, LOCAL_SEARCH_ITERS, timeBudgetSec || 0);
  const violations = collectViolations(improved, ctx);
  const stats = computeStats(improved, ctx);
  const score = computeScore(improved, ctx);
  return { schedule: improved, violations, stats, score: score.total };
}

/**
 * Night-only mode: build a grid where only the night coverage (N-S-R-R blocks)
 * and the deterministic/fixed nurses are filled in, leaving the morning/afternoon
 * cells of flexible M/P nurses blank ('') for manual assignment by the user.
 *
 * Rationale: when the automatic optimiser keeps producing too many nights and too
 * few mornings/afternoons, this mode lets the planner own only the hard part
 * (balanced night coverage with its mandatory rest tail) while the user fills in
 * mornings and afternoons by hand. Nurses whose shift is fully determined by their
 * tags (solo mattine, solo diurni, solo notti, turni fissi, diurni/notturni, …)
 * are still assigned automatically so the user only fills the genuinely free cells.
 *
 * @param {object} config - solver configuration (same shape as solve())
 * @returns {{schedule: string[][], violations: object[], stats: object[], score: number}}
 */
function solveNightOnly(config) {
  const ctx = buildContext(config);
  // A full, valid schedule used as the source for the night skeleton and for the
  // fully-automatic (non manual-M/P) nurses.
  const full = construct(ctx);
  const { numDays, numNurses, nurseProps, pinned } = ctx;
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(''));

  for (let n = 0; n < numNurses; n++) {
    const manual = nightOnlyManualNurse(nurseProps[n]);
    for (let d = 0; d < numDays; d++) {
      if (!manual) {
        // Deterministic / fixed-type nurse: keep the full auto-assigned schedule.
        schedule[n][d] = full[n][d];
        continue;
      }
      // Flexible M/P nurse: keep absences/pinned cells and the night blocks
      // (N, S and their mandatory rest tail), blank everything else for manual fill.
      if (pinned[n][d]) {
        schedule[n][d] = pinned[n][d];
      } else if (full[n][d] === 'N' || full[n][d] === 'S') {
        schedule[n][d] = full[n][d];
      } else if (full[n][d] === 'R' && isSkeletonNightRest(full, ctx, n, d)) {
        schedule[n][d] = 'R';
      } else {
        schedule[n][d] = '';
      }
    }
  }

  const violations = collectViolations(schedule, ctx);
  const stats = computeStats(schedule, ctx);
  const score = computeScore(schedule, ctx);
  return { schedule, violations, stats, score: score.total };
}

/**
 * Fill-only mode for the night-only workflow: take a schedule whose nights and
 * fixed-type nurses are already assigned (typically produced by solveNightOnly and
 * then manually corrected by the user) and distribute mornings/afternoons over the
 * remaining empty cells only. Every non-empty cell of `fixedSchedule` is treated as
 * locked, so the algorithm works exclusively on the genuinely free slots and never
 * adds, moves or removes nights.
 *
 * Empty cells are first set to R, then greedily promoted to M or P (lowest-hours
 * nurse first, for fairness) until each day reaches its target M/P coverage, while
 * respecting forbidden transitions and the weekly rest minimum. Cells that cannot or
 * need not become M/P stay as R.
 *
 * "Saturating" means each day is filled up to its maximum coverage (which always
 * satisfies the minimum), so the correct number of nurses is staffed every day
 * instead of stopping at the bare minimum.
 *
 * @param {object} config - solver configuration (same shape as solve())
 * @param {string[][]} fixedSchedule - current grid; '' (or null) marks a free cell
 * @returns {{schedule: string[][], violations: object[], stats: object[], score: number}}
 */
function solveFillMP(config, fixedSchedule) {
  const ctx = buildContext(config);
  const { numDays, numNurses, minCovM, minCovP, maxCovM, maxCovP, pinned, weekDaysList, weekOf, minRPerWeek } = ctx;
  const base = fixedSchedule || [];

  // Build the working grid from the provided schedule; cells that are empty (and not
  // structurally pinned) are the only ones we may assign. Initialise them to R.
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(''));
  const free = Array.from({ length: numNurses }, () => new Array(numDays).fill(false));
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      const cell = (base[n] && base[n][d]) || '';
      if (cell === '' && !pinned[n][d]) {
        free[n][d] = true;
        schedule[n][d] = 'R';
      } else {
        schedule[n][d] = cell;
      }
    }
  }

  // True when (n, d) may legally take shift s (M or P), given the surrounding fixed
  // cells. The cell must be free, and both the incoming and outgoing transitions valid.
  function canAssignMP(n, d, s) {
    if (!free[n][d]) return false;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    if (!transitionOk(prev, s, ctx, schedule, n, d)) return false;
    const next = d < numDays - 1 ? schedule[n][d + 1] : null;
    if (next && !transitionOk(s, next, ctx, schedule, n, d + 1)) return false;
    return true;
  }

  // Promoting an R to a working shift must not drop the week below its rest minimum.
  function keepsWeeklyRest(n, d) {
    const wDays = weekDaysList[weekOf(d)];
    const restAfter = countWeekRest(schedule, n, wDays) - 1;
    return restAfter >= requiredRest(wDays.length, minRPerWeek);
  }

  // Promote free R cells of day `d` to `target` (M or P) until the day reaches
  // `limit` coverage for that shift, always picking the lowest-hours nurse for fairness.
  // When `respectWeeklyRest` is true a promotion is skipped if it would drop the nurse's
  // week below the rest minimum; meeting the daily minimum coverage takes priority over
  // the weekly rest minimum, so that first pass relaxes this guard.
  function fillDayTo(d, target, limit, respectWeeklyRest) {
    // Each promotion adds exactly one unit of coverage, so at most numNurses steps.
    for (let guard = 0; guard <= numNurses; guard++) {
      const cov = dayCoverage(schedule, d, numNurses);
      if ((target === 'M' ? cov.M : cov.P) >= limit) break;
      let pick = -1;
      let pickHours = Infinity;
      for (let n = 0; n < numNurses; n++) {
        if (schedule[n][d] !== 'R' || !free[n][d]) continue;
        if (!canAssignMP(n, d, target)) continue;
        if (respectWeeklyRest && !keepsWeeklyRest(n, d)) continue;
        const h = nurseHours(schedule, n, numDays);
        if (h < pickHours) {
          pickHours = h;
          pick = n;
        }
      }
      if (pick === -1) break;
      schedule[pick][d] = target;
    }
  }

  for (let d = 0; d < numDays; d++) {
    // First guarantee the minimum coverage for both shifts so every day reaches the
    // required staffing — even when that means dipping below the weekly rest minimum.
    fillDayTo(d, 'M', minCovM, false);
    fillDayTo(d, 'P', minCovP, false);
    // …then saturate up to the maximum coverage to keep the correct number of nurses
    // on duty each day, this time preserving the weekly rest minimum.
    fillDayTo(d, 'M', maxCovM, true);
    fillDayTo(d, 'P', maxCovP, true);
  }

  const violations = collectViolations(schedule, ctx);
  const stats = computeStats(schedule, ctx);
  const score = computeScore(schedule, ctx);
  return { schedule, violations, stats, score: score.total };
}

/**
 * True when the nurse is flexible on mornings/afternoons and therefore must be
 * filled in by hand in night-only mode. These nurses can take both M and P, so
 * the planner leaves their non-night working cells blank. Nurses with a
 * deterministic shift type (only mornings, only day-long, only nights, day+night,
 * fixed weekly pattern, …) return false and are assigned automatically.
 */
function nightOnlyManualNurse(props) {
  return !(
    props.soloMattine ||
    props.soloDiurni ||
    props.soloNotti ||
    props.diurniENotturni ||
    props.diurniNoNotti ||
    props.quattroMattineVenerdiNotte
  );
}

function constructPatternSchedule(ctx, options) {
  const beamWidth = Math.max(1, options?.beamWidth || PATTERN_BEAM_WIDTH);
  const candidateLimit = Math.max(1, options?.candidateLimit || PATTERN_CANDIDATE_LIMIT);
  const individualCandidates = Array.from({ length: ctx.numNurses }, (_, n) =>
    getPatternCandidateRows(ctx, n, candidateLimit)
  );
  const groups = buildPatternGroups(ctx, individualCandidates, { nightFirst: !!options?.nightFirst });

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

function constructNightFirstPatternSchedule(ctx, options) {
  return constructPatternSchedule(ctx, { ...(options || {}), nightFirst: true });
}

/**
 * Build a context whose `pinned` matrix additionally fixes a balanced night
 * skeleton (N and S cells, plus the mandatory post-night rest days).
 *
 * The cyclic pattern beam cannot, on its own, coordinate per-nurse night offsets
 * to evenly meet the daily minimum night coverage — rigid month-long cycles tend
 * to cluster nights, leaving some days short even when enough staff is available.
 * The greedy construction heuristic (`construct`) already places nights day-by-day
 * to satisfy the minimum coverage, so we reuse its night placement as a fixed
 * skeleton and let the pattern beam fill the remaining day shifts (M/P/D) around it.
 *
 * Returns the original context unchanged when there is no night demand.
 */
function withNightSkeletonPins(ctx) {
  if (ctx.minCovN <= 0) return ctx;
  const { numDays, numNurses, pinned } = ctx;
  const skeleton = construct(ctx);
  const newPinned = Array.from({ length: numNurses }, (_, n) => pinned[n].slice());
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (newPinned[n][d]) continue;
      const shift = skeleton[n][d];
      // Pin the night block (N, S) and its mandatory rest tail so the day-shift
      // fill and localSearch cannot displace the balanced night coverage.
      if (shift === 'N' || shift === 'S') {
        newPinned[n][d] = shift;
      } else if (shift === 'R' && isSkeletonNightRest(skeleton, ctx, n, d)) {
        newPinned[n][d] = 'R';
      }
    }
  }
  // The `nightSkeletonPinned` flag signals downstream pattern selection
  // (getPatternFamilies) to fill free cells with day-only patterns, since the
  // night demand is now fully covered by the pinned skeleton.
  return { ...ctx, pinned: newPinned, nightSkeletonPinned: true };
}

/**
 * True when `R` at (n, d) is part of a night block's mandatory rest tail
 * (the R days immediately following an N-S sequence).
 */
function isSkeletonNightRest(skeleton, ctx, n, d) {
  const noDiurni = ctx.nurseProps[n].noDiurni;
  // First R after N-S: day d-1 is S and day d-2 is N.
  if (d >= 2 && skeleton[n][d - 1] === 'S' && skeleton[n][d - 2] === 'N') return true;
  // Second R after N-S-R (only for nurses requiring the full N-S-R-R block).
  if (!noDiurni && d >= 3 && skeleton[n][d - 1] === 'R' && skeleton[n][d - 2] === 'S' && skeleton[n][d - 3] === 'N')
    return true;
  return false;
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

function buildPatternGroups(ctx, individualCandidates, options) {
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
    if (options?.nightFirst && aNight !== bNight) return aNight - bNight;
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

  // When the night skeleton is already pinned, the daily night demand is fully
  // satisfied by the pinned N/S cells. Fill the remaining free cells with
  // day-only patterns so the beam never adds surplus nights (which would breach
  // the maximum night coverage). Each nurse's pinned nights still appear in the
  // materialized row because pinned cells override the pattern.
  if (ctx.nightSkeletonPinned) return getDayOnlyPatternFamilies(ctx, n);

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

/**
 * Day-only pattern families used when a night skeleton is already pinned.
 * Returns rest/morning/afternoon/day-long cycles (never N or S) tailored to what
 * each nurse is allowed to work, so free cells are filled with day shifts only.
 */
function getDayOnlyPatternFamilies(ctx, n) {
  const props = ctx.nurseProps[n];
  const families = [];

  function add(label, pattern) {
    families.push({ label, pattern });
  }

  // Fully pinned profiles (their whole month is fixed) just need a rest filler.
  // soloNotti nurses work only nights, which are already pinned by the skeleton, so
  // their remaining free cells are rest days.
  if (props.soloMattine || props.quattroMattineVenerdiNotte || props.soloNotti) {
    add('night-skeleton-rest', ['R']);
    return families;
  }

  if (isMPCycleLimitedNurse(props)) {
    for (const pattern of getAllowedMPCyclePatterns(props)) add('mp-cycle', pattern);
    return families;
  }

  const canDayLong = !props.noDiurni && !props.mattineEPomeriggi;
  const canMorningAfternoon = !props.soloDiurni && !props.diurniENotturni;

  if (canDayLong) {
    add('diurni-balanced', ['D', 'R', 'D', 'R', 'R']);
    add('diurni-light', ['D', 'R', 'R']);
    if (ctx.consente2D) add('diurni-double', ['D', 'D', 'R', 'R', 'R']);
  }
  if (canMorningAfternoon) {
    for (const pattern of MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS)) add('mp-cycle', pattern);
  }
  if (families.length === 0) add('night-skeleton-rest', ['R']);
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

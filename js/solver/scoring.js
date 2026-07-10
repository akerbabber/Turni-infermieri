/**
 * @file scoring.js — Constraint helpers, scoring, violations, and stats
 * @description Functions for evaluating schedule quality and collecting violations.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constraint helpers
// ---------------------------------------------------------------------------

function transitionOk(prev, next, ctx, schedule, nurseIdx, dayIdx) {
  if (!prev) {
    // At day 0, use previous month tail shift if available
    if (dayIdx === 0 && nurseIdx !== undefined && ctx.prevTail) {
      const tail = ctx.prevTail[nurseIdx];
      prev = tail && tail.length > 0 ? tail[tail.length - 1] : null;
    }
    if (!prev) return true;
  }
  const fb = ctx.forbidden[prev];
  if (fb && fb.includes(next)) return false;
  if (ctx.rules.minGap11h && SHIFT_END[prev] !== undefined && SHIFT_START[next] !== undefined) {
    if (gapHours(prev, next) < 11) return false;
  }
  if (ctx.consente2D && prev === 'D' && next === 'D' && nurseIdx !== undefined && dayIdx >= 2) {
    if (schedule[nurseIdx][dayIdx - 2] === 'D') return false;
  }
  return true;
}

// Read a shift from the current month schedule, or from previousMonthTail when
// dayIdx is negative. Negative indices are translated from the tail end so
// dayIdx === -1 means "last shift of previous month", dayIdx === -2 the one before, etc.
function getShiftAt(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null) return null;
  if (dayIdx >= 0) {
    if (dayIdx >= schedule[nurseIdx].length) return null;
    return schedule[nurseIdx][dayIdx];
  }
  if (!ctx.prevTail) return null;
  const tail = ctx.prevTail[nurseIdx];
  if (!tail) return null;
  const tailIdx = tail.length + dayIdx;
  return tailIdx >= 0 ? tail[tailIdx] : null;
}

const DIURNI_NOTTURNI_EXTRA_REST_OFFSET = 4;

function isRestrictedNoDiurniNightNurse(props) {
  if (!props || !props.noDiurni) return false;
  const excludedFlags = [
    'noNotti',
    'diurniNoNotti',
    'mattineEPomeriggi',
    'quattroMattineVenerdiNotte',
    'soloMattine',
    'soloDiurni',
    'soloNotti',
    'diurniENotturni',
  ];
  return !excludedFlags.some(flag => props[flag]);
}

function getForbiddenExtraRecoveryOffset(props) {
  if (!props || props.soloNotti || props.noDiurni) return null;
  return DIURNI_NOTTURNI_EXTRA_REST_OFFSET;
}

function isForbiddenExtraNightRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  const offset = getForbiddenExtraRecoveryOffset(props);
  if (offset === null) return false;
  const nightDayIdx = dayIdx - offset;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx) !== 'N') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 1) !== 'S') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 2) !== 'R') return false;
  if (!props.noDiurni && getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 3) !== 'R') return false;
  return true;
}

function hasForbiddenExtraNightRest(schedule, ctx, nurseIdx, nightDayIdx) {
  const props = ctx.nurseProps[nurseIdx];
  const offset = getForbiddenExtraRecoveryOffset(props);
  if (offset === null) return false;
  const extraRestDayIdx = nightDayIdx + offset;
  return (
    getShiftAt(schedule, ctx, nurseIdx, extraRestDayIdx) === 'R' &&
    isForbiddenExtraNightRestDay(schedule, ctx, nurseIdx, extraRestDayIdx)
  );
}

// Detect the mandatory rest day of a night block: only the first R immediately
// after S is locked. The second R after N-S-R is ALLOWED but never mandatory
// (per updated contract rules) — see isOptionalRestAfterNSR.
function isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  return getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'S';
}

// The second R after N-S-R: allowed for every profile, required by none.
function isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'R' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2) === 'S' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 3) === 'N'
  );
}

function canAssignRestrictedNoDiurniRest(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  if (!isRestrictedNoDiurniNightNurse(props)) return true;
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'S' ||
    (getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'R' &&
      getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2) === 'S' &&
      getShiftAt(schedule, ctx, nurseIdx, dayIdx - 3) === 'N')
  );
}

function isForbiddenRestrictedNoDiurniRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  if (!isRestrictedNoDiurniNightNurse(props)) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  return !canAssignRestrictedNoDiurniRest(schedule, ctx, nurseIdx, dayIdx);
}

function isWorkShift(shift) {
  return shift === 'M' || shift === 'P' || shift === 'D' || shift === 'N';
}

function isDRDNBridge(schedule, ctx, nurseIdx, dayIdx) {
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'D' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx + 1) === 'D' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx + 2) === 'N'
  );
}

function isSplitRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0 || dayIdx >= ctx.numDays) return false;
  if (ctx.pinned && ctx.pinned[nurseIdx] && ctx.pinned[nurseIdx][dayIdx]) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  if (isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx)) return false;
  if (isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx)) return false;

  const prev = getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1);
  const next = getShiftAt(schedule, ctx, nurseIdx, dayIdx + 1);
  if (!isWorkShift(prev) || !isWorkShift(next)) return false;

  // Keep the D-R-D-N bridge available when diurni need to stay separated before a night.
  if (isDRDNBridge(schedule, ctx, nurseIdx, dayIdx)) return false;

  return true;
}

function getRestPromotionPriority(props) {
  if (props.noDiurni) return 0;
  if (props.mattineEPomeriggi) return 1;
  return 2;
}

function dayCoverage(schedule, d, numNurses) {
  let M = 0,
    P = 0,
    D = 0,
    N = 0;
  for (let n = 0; n < numNurses; n++) {
    const s = schedule[n][d];
    if (s === 'M') M++;
    else if (s === 'P') P++;
    else if (s === 'D') {
      D++;
      M++;
      P++;
    } else if (s === 'N') N++;
  }
  return { M, P, D, N };
}

function nurseHours(schedule, n, numDays) {
  let h = 0;
  for (let d = 0; d < numDays; d++) h += SHIFT_HOURS[schedule[n][d]] || 0;
  return h;
}

function nightCount(schedule, n, numDays) {
  let c = 0;
  for (let d = 0; d < numDays; d++) if (schedule[n][d] === 'N') c++;
  return c;
}

function diurniCount(schedule, n, numDays) {
  let c = 0;
  for (let d = 0; d < numDays; d++) if (schedule[n][d] === 'D') c++;
  return c;
}

function countWeekRest(schedule, n, weekDays) {
  let c = 0;
  for (const d of weekDays) if (schedule[n][d] === 'R') c++;
  return c;
}

function requiredRest(weekLen, minR) {
  if (weekLen >= 7) return minR;
  if (weekLen <= 2) return 0;
  return Math.max(1, Math.ceil((weekLen * minR) / 7));
}

const MP_CYCLE_PATTERNS = [
  ['M', 'M', 'P', 'P', 'R', 'R'],
  ['M', 'P', 'P', 'P', 'R', 'R'],
  ['M', 'M', 'M', 'P', 'R', 'R'],
];

const SHORT_MP_CYCLE_PATTERNS = [
  ['M', 'M', 'P', 'R', 'R'],
  ['M', 'P', 'P', 'R', 'R'],
];
const MP_NIGHT_PATTERNS = [
  ['M', 'M', 'P'],
  ['M', 'P', 'P'],
  ['M', 'M', 'M'],
  ['P', 'P', 'P'],
  ['M', 'P'],
  ['M', 'M'],
  ['P', 'P'],
];
const D_NIGHT_PATTERNS = [['D'], ['D', 'R', 'D']];
const MP_CYCLE_PATTERN_LABELS = MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS)
  .map(pattern => pattern.join('-'))
  .join(', ');
const MP_NIGHT_PATTERN_LABELS = MP_NIGHT_PATTERNS.map(pattern => pattern.join('-')).join(', ');
const D_NIGHT_PATTERN_LABELS = D_NIGHT_PATTERNS.map(pattern => pattern.join('-')).join(', ');

function isMPCycleLimitedNurse(props) {
  return props.mattineEPomeriggi || (props.noNotti && props.noDiurni);
}

function getAllowedMPCyclePatterns(props) {
  return props.mattineEPomeriggi ? MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS) : MP_CYCLE_PATTERNS;
}

function isAllowedMPCycleShift(shift) {
  return shift === 'M' || shift === 'P' || shift === 'R';
}

function getMPCyclePlan(schedule, nurseIdx, numDays, props) {
  const row = schedule[nurseIdx];
  const patterns = getAllowedMPCyclePatterns(props);
  const memo = new Map();

  function solve(startDay) {
    if (startDay >= numDays) return { mismatch: 0, segments: [] };
    if (memo.has(startDay)) return memo.get(startDay);

    let best = { mismatch: Infinity, segments: [] };
    for (const pattern of patterns) {
      const blockLen = Math.min(pattern.length, numDays - startDay);
      let mismatch = 0;
      let comparable = false;
      for (let offset = 0; offset < blockLen; offset++) {
        const shift = row[startDay + offset];
        if (!isAllowedMPCycleShift(shift)) {
          comparable = false;
          mismatch = Infinity;
          break;
        }
        comparable = true;
        if (shift !== pattern[offset]) mismatch++;
      }
      if (!comparable || !Number.isFinite(mismatch)) continue;

      const tail = solve(startDay + blockLen);
      const totalMismatch = mismatch + tail.mismatch;
      if (totalMismatch < best.mismatch) {
        best = {
          mismatch: totalMismatch,
          segments: [{ startDay, blockLen, mismatch, pattern }, ...tail.segments],
        };
      }
    }

    const result = Number.isFinite(best.mismatch) ? best : { mismatch: 0, segments: [] };
    memo.set(startDay, result);
    return result;
  }

  return solve(0);
}

function getMPCycleBlockMismatch(schedule, nurseIdx, startDay, numDays, props) {
  const plan = getMPCyclePlan(schedule, nurseIdx, numDays, props);
  const segment = plan.segments.find(entry => entry.startDay === startDay);
  return segment ? segment.mismatch : 0;
}

function matchesPatternEndingAt(schedule, ctx, nurseIdx, endDayIdx, pattern) {
  const startDayIdx = endDayIdx - pattern.length + 1;
  for (let offset = 0; offset < pattern.length; offset++) {
    if (getShiftAt(schedule, ctx, nurseIdx, startDayIdx + offset) !== pattern[offset]) return false;
  }
  return true;
}

function getComparablePatterns(ctx, nurseIdx, nightDayIdx, patterns) {
  return patterns.filter(pattern => {
    const startDayIdx = nightDayIdx - pattern.length;
    if (startDayIdx >= 0) return true;
    const tail = ctx.prevTail && ctx.prevTail[nurseIdx];
    return !!(tail && tail.length >= -startDayIdx);
  });
}

function getNightPatternInfo(schedule, ctx, nurseIdx, nightDayIdx) {
  const props = ctx.nurseProps[nurseIdx];
  if (!props || props.soloNotti) return null;
  if (props.noDiurni) {
    const comparablePatterns = getComparablePatterns(ctx, nurseIdx, nightDayIdx, MP_NIGHT_PATTERNS);
    return {
      type: 'mp',
      validLead:
        comparablePatterns.length === 0 ||
        comparablePatterns.some(pattern => matchesPatternEndingAt(schedule, ctx, nurseIdx, nightDayIdx - 1, pattern)),
    };
  }
  if (props.diurniENotturni) {
    const comparablePatterns = getComparablePatterns(ctx, nurseIdx, nightDayIdx, D_NIGHT_PATTERNS);
    return {
      type: 'd',
      validLead:
        comparablePatterns.length === 0 ||
        comparablePatterns.some(pattern => matchesPatternEndingAt(schedule, ctx, nurseIdx, nightDayIdx - 1, pattern)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reperibile notturno (night on-call) helpers
// ---------------------------------------------------------------------------

// True when at least one nurse works a night on day d+1.
function hasNightTomorrow(schedule, d, numNurses) {
  for (let n = 0; n < numNurses; n++) {
    if (schedule[n][d + 1] === 'N') return true;
  }
  return false;
}

// True when the nurse can serve as night on-call on day d.
// With diurni in use (maxCovD > 0) the on-call is the nurse on SMONTO today
// (just off last night's shift); without diurni it is a nurse working the
// morning today whose next-day shift is a night.
function isReperibileEligible(schedule, ctx, n, d) {
  if (ctx.maxCovD > 0) return schedule[n][d] === 'S';
  return schedule[n][d] === 'M' && schedule[n][d + 1] === 'N';
}

// The (first) eligible night on-call for day d, or -1 when none exists.
function findReperibile(schedule, d, numNurses, ctx) {
  for (let n = 0; n < numNurses; n++) {
    if (isReperibileEligible(schedule, ctx, n, d)) return n;
  }
  return -1;
}

/**
 * True when assigning `newShift` at (n, d) would NOT break the currently-valid
 * lead-in of a night up to 3 days later (no_diurni nurses need an M/P sequence
 * right before N, diurni_e_notturni need a D or D-R-D block).
 */
function keepsNightLeadIns(schedule, ctx, n, d, newShift) {
  for (let nd = d + 1; nd <= d + 3 && nd < ctx.numDays; nd++) {
    if (schedule[n][nd] !== 'N') continue;
    const before = getNightPatternInfo(schedule, ctx, n, nd);
    if (!before || !before.validLead) return true;
    const old = schedule[n][d];
    schedule[n][d] = newShift;
    const after = getNightPatternInfo(schedule, ctx, n, nd);
    schedule[n][d] = old;
    return !after || after.validLead;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scoring — lower is better (0 = perfect)
// ---------------------------------------------------------------------------

function computeScore(schedule, ctx) {
  const {
    numDays,
    numNurses,
    minCovM,
    minCovP,
    minCovN,
    minCovD,
    maxCovM,
    maxCovP,
    maxCovN,
    maxCovD,
    targetNights,
    maxNights,
    hardMaxNights,
    minRPerWeek,
    consente2D,
    forbidden,
    nurseProps,
    weekDaysList,
    hourDeltas,
    monthlyTargetHours,
    coppiaTurni,
  } = ctx;
  let hard = 0,
    soft = 0;

  // Coverage — under-minimum coverage is penalized UNDER_COVERAGE_WEIGHT× harder so
  // the solver guarantees the required daily minimums first and only then assigns extra
  // staff toward the maximum. Night overcoverage is penalized 3× harder so the solver
  // prefers to exceed on M/P/D positions rather than on night shifts.
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM) hard += (minCovM - cov.M) * UNDER_COVERAGE_WEIGHT;
    if (cov.M > maxCovM) hard += cov.M - maxCovM;
    if (cov.P < minCovP) hard += (minCovP - cov.P) * UNDER_COVERAGE_WEIGHT;
    if (cov.P > maxCovP) hard += cov.P - maxCovP;
    if (cov.N < minCovN) hard += (minCovN - cov.N) * UNDER_COVERAGE_WEIGHT;
    if (cov.N > maxCovN) hard += (cov.N - maxCovN) * 3;
    if (cov.D < minCovD) hard += (minCovD - cov.D) * UNDER_COVERAGE_WEIGHT;
    if (cov.D > maxCovD) hard += cov.D - maxCovD;
  }

  // Per-nurse hard constraints
  for (let n = 0; n < numNurses; n++) {
    // Check transition from previous month to day 0
    if (ctx.prevTail) {
      const tail = ctx.prevTail[n];
      if (tail && tail.length > 0) {
        const lastShift = tail[tail.length - 1];
        const secondLastShift = tail.length >= 2 ? tail[tail.length - 2] : null;
        if (lastShift) {
          const day0 = schedule[n][0];
          const fb0 = forbidden[lastShift];
          if (fb0 && fb0.includes(day0)) hard++;
          if (lastShift === 'N' && day0 !== 'S') hard++;
          if (lastShift === 'S' && day0 !== 'R') hard++;
        }
        // D-D boundary checks (when consente2D enabled)
        if (consente2D) {
          const day0 = schedule[n][0];
          // Previous month ends D-D → day 0 must be R
          if (lastShift === 'D' && secondLastShift === 'D' && day0 !== 'R') hard++;
          // Previous month ends …D → D on day 0 means D-D, so day 1 must be R
          if (lastShift === 'D' && day0 === 'D' && numDays > 1 && schedule[n][1] !== 'R') hard++;
          // Previous month ends D-D → D on day 0 means 3 consecutive D (forbidden)
          if (lastShift === 'D' && secondLastShift === 'D' && day0 === 'D') hard++;
        }
      }
    }
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d],
        nxt = schedule[n][d + 1];
      // Forbidden transitions
      const fb = forbidden[cur];
      if (fb && fb.includes(nxt)) hard++;
      // N must be followed by S
      if (cur === 'N' && nxt !== 'S') hard++;
      // S must be followed by R
      if (cur === 'S' && nxt !== 'R') hard++;
    }
    // Note: the second R after N-S-R is optional for every profile (allowed but
    // never required), so no hard penalty is applied here anymore.
    // D-D must be followed by R; no 3 consecutive D
    if (consente2D) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d - 1] === 'D' && schedule[n][d] === 'D' && schedule[n][d + 1] !== 'R') hard++;
      }
      for (let d = 2; d < numDays; d++) {
        if (schedule[n][d - 2] === 'D' && schedule[n][d - 1] === 'D' && schedule[n][d] === 'D') hard++;
      }
    }
    // Weekly rest — weighted 2× so the annealer does not systematically strip
    // rest days to patch coverage (which weighs UNDER_COVERAGE_WEIGHT).
    if (minRPerWeek > 0) {
      for (const wDays of weekDaysList) {
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have < need) hard += (need - have) * 2;
      }
    }
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] !== 'N') continue;
      const info = getNightPatternInfo(schedule, ctx, n, d);
      if (info && !info.validLead) hard++;
      if (hasForbiddenExtraNightRest(schedule, ctx, n, d)) hard++;
    }
    if (isMPCycleLimitedNurse(nurseProps[n])) {
      hard += getMPCyclePlan(schedule, n, numDays, nurseProps[n]).mismatch;
    }
  }

  // Soft: hours equity (weight 3 — on par with night fairness)
  // When hourDeltas from previous month are available, each nurse has an individual
  // target (avg + delta) so that nurses who worked less before work more now.
  const hours = [];
  for (let n = 0; n < numNurses; n++) hours.push(nurseHours(schedule, n, numDays));
  for (let n = 0; n < numNurses; n++) {
    const target = monthlyTargetHours + (hourDeltas ? hourDeltas[n] || 0 : 0);
    const hourDiff = hours[n] - target;
    // Deficit hours weigh more than surplus: the monthly monte ore must be met,
    // extra shifts are always preferable to missing hours.
    soft += hourDiff < 0 ? Math.abs(hourDiff) * 7 : Math.abs(hourDiff) * 3;
  }

  // Soft: night-count fairness
  for (let n = 0; n < numNurses; n++) {
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].noNotti ||
      nurseProps[n].diurniNoNotti ||
      nurseProps[n].mattineEPomeriggi
    )
      continue;
    const nc = nightCount(schedule, n, numDays);
    soft += Math.abs(nc - targetNights) * 3;
  }

  // Per-nurse night caps: exceeding the soft cap (maxNights) costs extra soft
  // penalty, exceeding the absolute cap (hardMaxNights) is a hard violation.
  // quattro_mattine_venerdi_notte nurses are excluded: their nights are pinned
  // structurally (every Friday) and not controlled by the solver.
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].quattroMattineVenerdiNotte) continue;
    const nc = nightCount(schedule, n, numDays);
    if (nc > maxNights) soft += (nc - maxNights) * 8;
    if (nc > hardMaxNights) hard += nc - hardMaxNights;
  }

  // Soft: D-shift (diurno) count fairness among D-eligible nurses
  {
    const dEligible = [];
    for (let n = 0; n < numNurses; n++) {
      if (
        nurseProps[n].soloMattine ||
        nurseProps[n].soloNotti ||
        nurseProps[n].noDiurni ||
        nurseProps[n].mattineEPomeriggi
      )
        continue;
      dEligible.push(n);
    }
    if (dEligible.length >= 2) {
      const dCounts = dEligible.map(n => diurniCount(schedule, n, numDays));
      const dAvg = dCounts.reduce((a, b) => a + b, 0) / dCounts.length;
      for (const dc of dCounts) soft += Math.abs(dc - dAvg) * 3;
    }
  }

  // Soft: M/P balance for nurses limited to M/P-heavy workloads
  for (let n = 0; n < numNurses; n++) {
    if (
      !nurseProps[n].noDiurni &&
      !nurseProps[n].mattineEPomeriggi &&
      !nurseProps[n].noNotti &&
      !nurseProps[n].diurniNoNotti
    )
      continue;
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].soloNotti ||
      nurseProps[n].diurniENotturni
    )
      continue;
    let mC = 0,
      pC = 0;
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === 'M') mC++;
      else if (schedule[n][d] === 'P') pC++;
    }
    soft += Math.abs(mC - pC) * 2;
  }

  // Soft: discourage isolated discretionary rest days between work stretches.
  // If extra rest is needed, prefer keeping it attached to post-night recovery.
  for (let n = 0; n < numNurses; n++) {
    for (let d = ctx.prevTail ? 0 : 1; d < numDays - 1; d++) {
      if (isSplitRestDay(schedule, ctx, n, d)) soft += 4;
    }
  }

  // Soft: for M/P/N-only nurses, keep discretionary rests attached to the
  // post-night recovery block instead of scattering them across the month.
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (isForbiddenRestrictedNoDiurniRestDay(schedule, ctx, n, d)) soft += 6;
    }
  }

  // Hard: coppiaTurni must have identical schedules (BUG #1 fix)
  if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
    const [n1, n2] = coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        if (schedule[n1][d] !== schedule[n2][d]) hard++;
      }
    }
  }

  // Hard: nurses outside the monthly hour band (weekly sliders scaled to the month).
  // A nurse is exempt from the minimum only when actually absent (has absence
  // shifts): an all-R row is an unassigned nurse, not an absent one.
  {
    const absShifts = ['F', 'MA', 'L104', 'PR', 'MT'];
    for (let n = 0; n < numNurses; n++) {
      const hasAbsence = schedule[n].some(s => absShifts.includes(s));
      const isFullyAbsent = hasAbsence && schedule[n].every(s => absShifts.includes(s) || s === 'R');
      if (ctx.minMonthlyHours > 0 && !isFullyAbsent && hours[n] < ctx.minMonthlyHours) hard++;
      if (hours[n] > ctx.maxMonthlyHours) hard++;
    }
  }

  // HARD: more than 2 consecutive R days are not allowed (smonto S excluded —
  // S,R,R after a night is fine, R,R,R is not).
  for (let n = 0; n < numNurses; n++) {
    let consRest = 0;
    for (let d = 0; d <= numDays; d++) {
      if (d < numDays && schedule[n][d] === 'R') {
        consRest++;
      } else {
        if (consRest > MAX_CONSECUTIVE_REST) hard += consRest - MAX_CONSECUTIVE_REST;
        consRest = 0;
      }
    }
  }

  // Weekly rest cap ("solo 2 riposi a settimana"): one extra rest above the
  // minimum can be unavoidable for D/N cycles (N-S-R blocks + no D-D adjacency
  // make some 3-rest calendar weeks mathematically forced), so it costs soft
  // points; from TWO extras up (4+ rests in a week) it is a hard violation.
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      for (const wDays of weekDaysList) {
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have > need + 1) hard += have - need - 1;
        if (have > need) soft += (have - need) * 10;
      }
    }
  }

  // Hard: reperibile notturno — every day with nights scheduled tomorrow must
  // have at least one nurse working the morning (M or D) today AND the night
  // tomorrow, so they can be designated as the night on-call.
  if (ctx.reperibileNotturno) {
    for (let d = 0; d < numDays - 1; d++) {
      // In smonto mode nobody can be on S on day 1 without previous-month data.
      if (ctx.maxCovD > 0 && d === 0 && !ctx.prevTail) continue;
      if (!hasNightTomorrow(schedule, d, numNurses)) continue;
      if (findReperibile(schedule, d, numNurses, ctx) === -1) hard++;
    }
  }

  return { hard, soft, total: hard * 1000 + soft };
}

// ---------------------------------------------------------------------------
// Violations — detailed constraint violation report
// ---------------------------------------------------------------------------

function collectViolations(schedule, ctx) {
  const {
    numDays,
    numNurses,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovN,
    maxCovN,
    minCovD,
    maxCovD,
    consente2D,
    forbidden,
    nurseProps,
    minRPerWeek,
    weekDaysList,
  } = ctx;
  const violations = [];

  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM)
      violations.push({
        day: d,
        type: 'coverage_M',
        msg: `Giorno ${d + 1}: copertura mattina insufficiente (${cov.M}/${minCovM})`,
      });
    if (cov.M > maxCovM)
      violations.push({
        day: d,
        type: 'coverage_M_max',
        msg: `Giorno ${d + 1}: copertura mattina eccessiva (${cov.M}/${maxCovM})`,
      });
    if (cov.P < minCovP)
      violations.push({
        day: d,
        type: 'coverage_P',
        msg: `Giorno ${d + 1}: copertura pomeriggio insufficiente (${cov.P}/${minCovP})`,
      });
    if (cov.P > maxCovP)
      violations.push({
        day: d,
        type: 'coverage_P_max',
        msg: `Giorno ${d + 1}: copertura pomeriggio eccessiva (${cov.P}/${maxCovP})`,
      });
    if (cov.N < minCovN)
      violations.push({
        day: d,
        type: 'coverage_N',
        msg: `Giorno ${d + 1}: copertura notte insufficiente (${cov.N}/${minCovN})`,
      });
    if (cov.N > maxCovN)
      violations.push({
        day: d,
        type: 'coverage_N_max',
        msg: `Giorno ${d + 1}: copertura notte eccessiva (${cov.N}/${maxCovN})`,
      });
    if (cov.D < minCovD)
      violations.push({
        day: d,
        type: 'coverage_D',
        msg: `Giorno ${d + 1}: copertura diurni insufficiente (${cov.D}/${minCovD})`,
      });
    if (cov.D > maxCovD)
      violations.push({
        day: d,
        type: 'coverage_D_max',
        msg: `Giorno ${d + 1}: copertura diurni eccessiva (${cov.D}/${maxCovD})`,
      });
  }

  for (let n = 0; n < numNurses; n++) {
    // Check transition from previous month to day 0
    if (ctx.prevTail) {
      const tail = ctx.prevTail[n];
      if (tail && tail.length > 0) {
        const lastShift = tail[tail.length - 1];
        const secondLastShift = tail.length >= 2 ? tail[tail.length - 2] : null;
        if (lastShift) {
          const day0 = schedule[n][0];
          const fb0 = forbidden[lastShift];
          if (fb0 && fb0.includes(day0))
            violations.push({
              nurse: n,
              day: -1,
              type: 'transition',
              msg: `Infermiere ${n + 1}, confine mese: transizione vietata ${lastShift}→${day0}`,
            });
          if (lastShift === 'N' && day0 !== 'S')
            violations.push({
              nurse: n,
              day: -1,
              type: 'N_no_S',
              msg: `Infermiere ${n + 1}, confine mese: N non seguito da S`,
            });
          if (lastShift === 'S' && day0 !== 'R')
            violations.push({
              nurse: n,
              day: -1,
              type: 'S_no_R',
              msg: `Infermiere ${n + 1}, confine mese: S non seguito da R`,
            });
          // D-D boundary checks (when consente2D enabled)
          if (consente2D) {
            if (lastShift === 'D' && secondLastShift === 'D' && day0 !== 'R')
              violations.push({
                nurse: n,
                day: -1,
                type: 'DD_no_R',
                msg: `Infermiere ${n + 1}, confine mese: D-D non seguito da R`,
              });
            if (lastShift === 'D' && day0 === 'D' && numDays > 1 && schedule[n][1] !== 'R')
              violations.push({
                nurse: n,
                day: 0,
                type: 'DD_no_R',
                msg: `Infermiere ${n + 1}, confine mese: D-D non seguito da R`,
              });
            if (lastShift === 'D' && secondLastShift === 'D' && day0 === 'D')
              violations.push({
                nurse: n,
                day: -1,
                type: 'DDD',
                msg: `Infermiere ${n + 1}, confine mese: 3 D consecutivi vietati`,
              });
          }
        }
      }
    }
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d],
        nxt = schedule[n][d + 1];
      const fb = forbidden[cur];
      if (fb && fb.includes(nxt))
        violations.push({
          nurse: n,
          day: d,
          type: 'transition',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}-${d + 2}: transizione vietata ${cur}→${nxt}`,
        });
      if (cur === 'N' && nxt !== 'S')
        violations.push({
          nurse: n,
          day: d,
          type: 'N_no_S',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}: N non seguito da S`,
        });
      if (cur === 'S' && nxt !== 'R')
        violations.push({
          nurse: n,
          day: d,
          type: 'S_no_R',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}: S non seguito da R (primo riposo dopo smonto)`,
        });
    }
    // The second R after N-S-R is optional for every profile: no violation.
    if (consente2D) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d - 1] === 'D' && schedule[n][d] === 'D' && schedule[n][d + 1] !== 'R')
          violations.push({
            nurse: n,
            day: d,
            type: 'DD_no_R',
            msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo D-D serve R`,
          });
      }
      for (let d = 2; d < numDays; d++) {
        if (schedule[n][d - 2] === 'D' && schedule[n][d - 1] === 'D' && schedule[n][d] === 'D')
          violations.push({
            nurse: n,
            day: d,
            type: 'DDD',
            msg: `Infermiere ${n + 1}, giorno ${d + 1}: 3 diurni consecutivi non consentiti`,
          });
      }
    }
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] !== 'N') continue;
      const info = getNightPatternInfo(schedule, ctx, n, d);
      if (info && !info.validLead)
        violations.push({
          nurse: n,
          day: d,
          type: info.type === 'mp' ? 'mp_night_pattern' : 'd_night_pattern',
          msg:
            info.type === 'mp'
              ? `Infermiere ${n + 1}, giorno ${d + 1}: prima della notte serve una sequenza tra ${MP_NIGHT_PATTERN_LABELS}`
              : `Infermiere ${n + 1}, giorno ${d + 1}: il blocco diurno/notte deve seguire ${D_NIGHT_PATTERN_LABELS}`,
        });
      if (hasForbiddenExtraNightRest(schedule, ctx, n, d))
        violations.push({
          nurse: n,
          day: d,
          type: 'night_extra_rest',
          msg: nurseProps[n].noDiurni
            ? `Infermiere ${n + 1}, giorno ${d + 1}: non è consentito un secondo riposo dopo N-S-R`
            : `Infermiere ${n + 1}, giorno ${d + 1}: non è consentito un terzo riposo dopo il blocco N-S-R-R`,
        });
    }
    if (isMPCycleLimitedNurse(nurseProps[n])) {
      const plan = getMPCyclePlan(schedule, n, numDays, nurseProps[n]);
      for (const segment of plan.segments) {
        if (segment.mismatch > 0) {
          violations.push({
            nurse: n,
            day: segment.startDay,
            type: 'mp_cycle_4_2',
            msg:
              `Infermiere ${n + 1}, giorni ${segment.startDay + 1}-${Math.min(numDays, segment.startDay + segment.blockLen)}: ` +
              `il ciclo M/P deve seguire uno tra ${MP_CYCLE_PATTERN_LABELS}`,
          });
        }
      }
    }
  }

  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      for (let w = 0; w < weekDaysList.length; w++) {
        const wDays = weekDaysList[w];
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have < need)
          violations.push({
            nurse: n,
            week: w,
            type: 'min_R_week',
            msg: `Infermiere ${n + 1}, settimana ${w + 1}: solo ${have} riposi (minimo ${need})`,
          });
        if (have > need + 1)
          violations.push({
            nurse: n,
            week: w,
            type: 'troppi_riposi_settimana',
            msg: `Infermiere ${n + 1}, settimana ${w + 1}: ${have} riposi (massimo ${need + 1})`,
          });
      }
    }
  }

  // BUG #1 fix: coppia divergente violations
  if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [n1, n2] = ctx.coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        if (schedule[n1][d] !== schedule[n2][d]) {
          violations.push({
            type: 'coppia_divergente',
            nurse: n2,
            day: d,
            msg: `Coppia: ${ctx.nurses[n1].name} e ${ctx.nurses[n2].name} hanno turni diversi il giorno ${d + 1}`,
          });
        }
      }
    }
  }

  // Monthly hour band violations (weekly sliders scaled to the month) and
  // per-nurse absolute night cap (hardMaxNights).
  {
    const absShiftsV = ['F', 'MA', 'L104', 'PR', 'MT'];
    for (let n = 0; n < numNurses; n++) {
      const h = nurseHours(schedule, n, numDays);
      const hasAbsence = schedule[n].some(s => absShiftsV.includes(s));
      const isFullyAbsent = hasAbsence && schedule[n].every(s => absShiftsV.includes(s) || s === 'R');
      if (ctx.minMonthlyHours > 0 && !isFullyAbsent && h < ctx.minMonthlyHours) {
        violations.push({
          type: 'low_hours',
          nurse: n,
          day: -1,
          msg: `${ctx.nurses[n].name}: ore totali ${h.toFixed(1)} < minimo mensile ${ctx.minMonthlyHours}`,
        });
      }
      if (h > ctx.maxMonthlyHours) {
        violations.push({
          type: 'high_hours',
          nurse: n,
          day: -1,
          msg: `${ctx.nurses[n].name}: ore totali ${h.toFixed(1)} > massimo mensile ${ctx.maxMonthlyHours}`,
        });
      }
      if (!nurseProps[n].quattroMattineVenerdiNotte) {
        const nc = nightCount(schedule, n, numDays);
        if (nc > ctx.hardMaxNights) {
          violations.push({
            type: 'troppe_notti',
            nurse: n,
            day: -1,
            msg: `${ctx.nurses[n].name}: ${nc} notti > massimo assoluto ${ctx.hardMaxNights}`,
          });
        }
      }
    }
  }

  // Isole di riposo: more than 2 consecutive R days (S excluded) must be avoided.
  for (let n = 0; n < numNurses; n++) {
    let consRest = 0;
    let islandStart = 0;
    for (let d = 0; d <= numDays; d++) {
      if (d < numDays && schedule[n][d] === 'R') {
        if (consRest === 0) islandStart = d;
        consRest++;
      } else {
        if (consRest > MAX_CONSECUTIVE_REST) {
          violations.push({
            type: 'isola_di_riposo',
            nurse: n,
            day: islandStart,
            msg: `${ctx.nurses[n].name}: ${consRest} riposi consecutivi dal giorno ${islandStart + 1} (max 2)`,
          });
        }
        consRest = 0;
      }
    }
  }

  // Reperibile notturno: a day with nights tomorrow needs a nurse on M/D today
  // with N tomorrow to serve as the night on-call.
  if (ctx.reperibileNotturno) {
    for (let d = 0; d < numDays - 1; d++) {
      // In smonto mode nobody can be on S on day 1 without previous-month data.
      if (ctx.maxCovD > 0 && d === 0 && !ctx.prevTail) continue;
      if (!hasNightTomorrow(schedule, d, numNurses)) continue;
      if (findReperibile(schedule, d, numNurses, ctx) === -1) {
        violations.push({
          type: 'reperibile_mancante',
          day: d,
          msg:
            ctx.maxCovD > 0
              ? `Giorno ${d + 1}: nessun reperibile notturno (serve un infermiere in smonto)`
              : `Giorno ${d + 1}: nessun reperibile notturno (mattina oggi + notte domani)`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Stats — same format expected by the UI
// ---------------------------------------------------------------------------

function computeStats(schedule, ctx) {
  const { year, month, numDays, nurses } = ctx;
  return nurses.map((_, n) => {
    let totalHours = 0,
      nights = 0,
      diurni = 0,
      weekends = 0;
    for (let d = 0; d < numDays; d++) {
      const s = schedule[n][d];
      totalHours += SHIFT_HOURS[s] || 0;
      if (s === 'N') nights++;
      if (s === 'D') diurni++;
      if (isWeekend(year, month, d + 1) && s && s !== 'R') weekends++;
    }
    return { totalHours: Math.round(totalHours * 10) / 10, nights, diurni, weekends };
  });
}

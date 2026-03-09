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

// Detect mandatory rest days inside an N-S-R-R block:
// - the first R immediately after S is always locked
// - the second R after N-S-R is also locked for nurses who are not noDiurni
function isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  const prev1 = getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1);
  const prev2 = getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2);
  if (prev1 === 'S') return true;
  return !ctx.nurseProps[nurseIdx].noDiurni && prev1 === 'R' && prev2 === 'S';
}

function isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  if (!props || !props.noDiurni || props.noNotti || props.soloNotti) return false;
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'R' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2) === 'S' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 3) === 'N'
  );
}

function isWorkShift(shift) {
  return shift === 'M' || shift === 'P' || shift === 'D' || shift === 'N';
}

function isSplitRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (ctx.pinned && ctx.pinned[nurseIdx] && ctx.pinned[nurseIdx][dayIdx]) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  if (isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx)) return false;
  if (isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx)) return false;

  const prev = getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1);
  const next = getShiftAt(schedule, ctx, nurseIdx, dayIdx + 1);
  if (!isWorkShift(prev) || !isWorkShift(next)) return false;

  // Keep the D-R-D-N bridge available when diurni need to stay separated before a night.
  if (prev === 'D' && next === 'D' && getShiftAt(schedule, ctx, nurseIdx, dayIdx + 2) === 'N') return false;

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
const MP_CYCLE_PATTERN_LABELS = MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS)
  .map(pattern => pattern.join('-'))
  .join(', ');

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
    maxCovM,
    maxCovP,
    maxCovN,
    targetNights,
    minRPerWeek,
    consente2D,
    forbidden,
    nurseProps,
    weekDaysList,
    hourDeltas,
  } = ctx;
  let hard = 0,
    soft = 0;

  // Coverage — night overcoverage is penalized 3× harder so the solver
  // prefers to exceed on M/P/D positions rather than on night shifts.
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM) hard += minCovM - cov.M;
    if (cov.M > maxCovM) hard += cov.M - maxCovM;
    if (cov.P < minCovP) hard += minCovP - cov.P;
    if (cov.P > maxCovP) hard += cov.P - maxCovP;
    if (cov.N < minCovN) hard += minCovN - cov.N;
    if (cov.N > maxCovN) hard += (cov.N - maxCovN) * 3;
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
    // N-S-R-R: second R required (except no_diurni nurses need only 1 R),
    // including night blocks that started in the previous month tail.
    for (let d = ctx.prevTail ? -3 : 0; d < numDays - 3; d++) {
      if (
        getShiftAt(schedule, ctx, n, d) === 'N' &&
        getShiftAt(schedule, ctx, n, d + 1) === 'S' &&
        getShiftAt(schedule, ctx, n, d + 2) === 'R' &&
        !nurseProps[n].noDiurni &&
        getShiftAt(schedule, ctx, n, d + 3) !== 'R'
      ) {
        hard++;
      }
    }
    // D-D must be followed by R; no 3 consecutive D
    if (consente2D) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d - 1] === 'D' && schedule[n][d] === 'D' && schedule[n][d + 1] !== 'R') hard++;
      }
      for (let d = 2; d < numDays; d++) {
        if (schedule[n][d - 2] === 'D' && schedule[n][d - 1] === 'D' && schedule[n][d] === 'D') hard++;
      }
    }
    // Weekly rest
    if (minRPerWeek > 0) {
      for (const wDays of weekDaysList) {
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have < need) hard += need - have;
      }
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
  const avg = hours.reduce((a, b) => a + b, 0) / numNurses;
  for (let n = 0; n < numNurses; n++) {
    const target = avg + (hourDeltas ? hourDeltas[n] || 0 : 0);
    soft += Math.abs(hours[n] - target) * 3;
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
    for (let d = ctx.prevTail ? -3 : 0; d < numDays - 3; d++) {
      if (
        getShiftAt(schedule, ctx, n, d) === 'N' &&
        getShiftAt(schedule, ctx, n, d + 1) === 'S' &&
        getShiftAt(schedule, ctx, n, d + 2) === 'R' &&
        !nurseProps[n].noDiurni &&
        getShiftAt(schedule, ctx, n, d + 3) !== 'R'
      ) {
        violations.push({
          nurse: n,
          day: d < 0 ? -1 : d,
          type: 'need_2R_after_night',
          msg:
            d < 0
              ? `Infermiere ${n + 1}, confine mese: dopo N-S-R serve un altro R (2 riposi dopo notte, S non conta)`
              : `Infermiere ${n + 1}, giorno ${d + 1}: dopo N-S-R serve un altro R (2 riposi dopo notte, S non conta)`,
        });
      }
    }
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

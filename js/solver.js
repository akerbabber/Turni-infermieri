/**
 * solver.js — Web Worker for nursing shift scheduling
 *
 * Uses a multi-restart local-search approach:
 *   1. Pin fixed assignments (absences, solo_mattine)
 *   2. Construct initial solution via greedy heuristic
 *   3. Optimise via simulated-annealing local search
 *   4. Repeat with different random seeds, keep best
 *
 * Shift codes:
 *   M     Mattina    08:00–14:12  (6.2 h)
 *   P     Pomeriggio 14:00–20:12  (6.2 h)
 *   D     Diurno     08:00–20:12  (12.2 h)
 *   N     Notte      20:00–08:12  (12.2 h)
 *   S     Smonto     (post-notte, 0 h, non-rest)
 *   R     Riposo     (0 h, real rest)
 *   F     Ferie      (7.12 h)
 *   MA    Malattia   (7.12 h)
 *   L104  104        (7.12 h)
 *   PR    Permesso Retribuito (7.12 h)
 *   MT    Maternità  (7.12 h)
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 7.12, MA: 7.12, L104: 7.12, PR: 7.12, MT: 7.12 };

const ABSENCE_TAG_TO_SHIFT = {
  'ferie': 'F',
  'malattia': 'MA',
  '104': 'L104',
  'permesso_retribuito': 'PR',
  'maternita': 'MT'
};

const SHIFT_END   = { M: 14.2, P: 20.2, D: 20.2, N: 8.2 };
const SHIFT_START  = { M: 8, P: 14, D: 8, N: 20 };

const BASE_FORBIDDEN_NEXT = {
  P: ['M', 'D'],
  D: ['M', 'P', 'D'],
  N: ['M', 'P', 'D', 'R', 'N'],
  S: ['M', 'P', 'D', 'N', 'S'],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dayOfWeek(year, month, day) { return new Date(year, month, day).getDay(); }
function isWeekend(year, month, day) { const d = dayOfWeek(year, month, day); return d === 0 || d === 6; }
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

function gapHours(prev, next) {
  if (!SHIFT_END[prev] || !SHIFT_START[next]) return Infinity;
  if (prev === 'N') return SHIFT_START[next] - SHIFT_END[prev];
  return (24 - SHIFT_END[prev]) + SHIFT_START[next];
}

function deepCopy(schedule) { return schedule.map(row => [...row]); }

// ---------------------------------------------------------------------------
// Preprocessing — build a shared context object used by all phases
// ---------------------------------------------------------------------------

function buildContext(config) {
  const { year, month, nurses, rules } = config;
  const numDays   = daysInMonth(year, month);
  const numNurses = nurses.length;

  // Forbidden-transition table (may be relaxed by rule flags)
  const forbidden = {
    P: [...BASE_FORBIDDEN_NEXT.P],
    D: [...BASE_FORBIDDEN_NEXT.D],
    N: [...BASE_FORBIDDEN_NEXT.N],
    S: [...BASE_FORBIDDEN_NEXT.S],
  };
  if (rules.consentePomeriggioDiurno)  forbidden.P = forbidden.P.filter(s => s !== 'D');
  if (rules.consente2DiurniConsecutivi) forbidden.D = forbidden.D.filter(s => s !== 'D');

  // Per-nurse properties
  const nurseProps = nurses.map(n => ({
    soloMattine: n.tags.includes('solo_mattine'),
    noNotti:     n.tags.includes('no_notti'),
    noDiurni:    n.tags.includes('no_diurni'),
  }));

  // Day-of-week cache & week index helpers
  const dows = [];
  for (let d = 0; d < numDays; d++) dows.push(dayOfWeek(year, month, d + 1));
  const firstDow = dayOfWeek(year, month, 1);
  const adjustedFirstDow = firstDow === 0 ? 6 : firstDow - 1;
  const weekOf = d => Math.floor((d + adjustedFirstDow) / 7);
  const numWeeks = weekOf(numDays - 1) + 1;

  // Coverage targets
  const minCovM = rules.minCoverageM ?? 6, maxCovM = rules.maxCoverageM ?? 7;
  const minCovP = rules.minCoverageP ?? 6, maxCovP = rules.maxCoverageP ?? 7;
  const minCovD = rules.minCoverageD ?? 0, maxCovD = rules.maxCoverageD ?? 4;
  const minCovN = rules.minCoverageN ?? 2, maxCovN = rules.maxCoverageN ?? 4;

  const targetNights = rules.targetNights ?? 4;
  const maxNights    = rules.maxNights ?? 7;
  const minRPerWeek  = rules.minRPerWeek ?? 2;
  const preferDiurni = rules.preferDiurni ?? false;
  const coppiaTurni  = rules.coppiaTurni ?? null;
  const consente2D   = rules.consente2DiurniConsecutivi ?? false;

  // Pre-compute pinned cells (absences + solo_mattine)
  // pinned[n][d] = shift code or null
  const pinned = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));
  for (let n = 0; n < numNurses; n++) {
    const nurse = nurses[n];
    for (let d = 0; d < numDays; d++) {
      const abs = getAbsenceShift(nurse, d + 1, year, month);
      if (abs) { pinned[n][d] = abs; continue; }
      if (nurseProps[n].soloMattine) {
        pinned[n][d] = (dows[d] === 0 || dows[d] === 6) ? 'R' : 'M';
      }
    }
  }

  // Precompute week day-lists
  const weekDaysList = Array.from({ length: numWeeks }, () => []);
  for (let d = 0; d < numDays; d++) weekDaysList[weekOf(d)].push(d);

  return {
    year, month, nurses, rules, numDays, numNurses,
    forbidden, nurseProps, dows, weekOf, numWeeks, pinned, weekDaysList,
    minCovM, maxCovM, minCovP, maxCovP, minCovD, maxCovD,
    minCovN, maxCovN, targetNights, maxNights, minRPerWeek,
    preferDiurni, coppiaTurni, consente2D,
  };
}

function getAbsenceShift(nurse, day1Based, year, month) {
  if (!nurse.absencePeriods) return null;
  for (const [tagKey, shiftCode] of Object.entries(ABSENCE_TAG_TO_SHIFT)) {
    if (!nurse.tags.includes(tagKey)) continue;
    const period = nurse.absencePeriods[tagKey];
    if (period && period.start && period.end) {
      const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day1Based).padStart(2, '0')}`;
      if (ds >= period.start && ds <= period.end) return shiftCode;
    } else {
      return shiftCode;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constraint helpers
// ---------------------------------------------------------------------------

function transitionOk(prev, next, ctx, schedule, nurseIdx, dayIdx) {
  if (!prev) return true;
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

function dayCoverage(schedule, d, numNurses) {
  let M = 0, P = 0, D = 0, N = 0;
  for (let n = 0; n < numNurses; n++) {
    const s = schedule[n][d];
    if (s === 'M') M++;
    else if (s === 'P') P++;
    else if (s === 'D') { D++; M++; P++; }
    else if (s === 'N') N++;
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

function countWeekRest(schedule, n, weekDays) {
  let c = 0;
  for (const d of weekDays) if (schedule[n][d] === 'R') c++;
  return c;
}

function requiredRest(weekLen, minR) {
  if (weekLen >= 7) return minR;
  if (weekLen <= 2) return 0;
  return Math.max(1, Math.ceil(weekLen * minR / 7));
}

// ---------------------------------------------------------------------------
// Scoring — lower is better (0 = perfect)
// ---------------------------------------------------------------------------

function computeScore(schedule, ctx) {
  const { numDays, numNurses, minCovM, minCovP, minCovN, maxCovM, maxCovP, maxCovN,
          targetNights, minRPerWeek, consente2D, forbidden, nurseProps, weekDaysList } = ctx;
  let hard = 0, soft = 0;

  // Coverage
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM) hard += (minCovM - cov.M);
    if (cov.P < minCovP) hard += (minCovP - cov.P);
    if (cov.N < minCovN) hard += (minCovN - cov.N);
  }

  // Per-nurse hard constraints
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d], nxt = schedule[n][d + 1];
      // Forbidden transitions
      const fb = forbidden[cur];
      if (fb && fb.includes(nxt)) hard++;
      // N must be followed by S
      if (cur === 'N' && nxt !== 'S') hard++;
      // S must be followed by R
      if (cur === 'S' && nxt !== 'R') hard++;
    }
    // N-S-R-R: second R required (except no_diurni nurses need only 1 R)
    for (let d = 0; d < numDays - 3; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d+1] === 'S' && schedule[n][d+2] === 'R') {
        if (schedule[n][d+3] !== 'R' && !nurseProps[n].noDiurni) hard++;
      }
    }
    // D-D must be followed by R; no 3 consecutive D
    if (consente2D) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d-1] === 'D' && schedule[n][d] === 'D' && schedule[n][d+1] !== 'R') hard++;
      }
      for (let d = 2; d < numDays; d++) {
        if (schedule[n][d-2] === 'D' && schedule[n][d-1] === 'D' && schedule[n][d] === 'D') hard++;
      }
    }
    // Weekly rest
    if (minRPerWeek > 0) {
      for (const wDays of weekDaysList) {
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have < need) hard += (need - have);
      }
    }
  }

  // Soft: hours equity
  const hours = [];
  for (let n = 0; n < numNurses; n++) hours.push(nurseHours(schedule, n, numDays));
  const avg = hours.reduce((a, b) => a + b, 0) / numNurses;
  for (const h of hours) soft += Math.abs(h - avg);

  // Soft: night-count fairness
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].noNotti) continue;
    const nc = nightCount(schedule, n, numDays);
    soft += Math.abs(nc - targetNights) * 3;
  }

  return { hard, soft, total: hard * 1000 + soft };
}

// ---------------------------------------------------------------------------
// Construction heuristic (one attempt)
// ---------------------------------------------------------------------------

function construct(ctx) {
  const { numDays, numNurses, nurses, rules, nurseProps, pinned,
          minCovM, maxCovM, minCovP, maxCovP, minCovD, maxCovD,
          minCovN, maxCovN, targetNights, maxNights, preferDiurni,
          coppiaTurni, consente2D, minRPerWeek, weekDaysList } = ctx;

  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));

  // Phase 1 — Pin absences & solo_mattine
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) schedule[n][d] = pinned[n][d];
    }
  }

  // Phase 2 — Night blocks (N-S-R-R)
  const nightEligible = [];
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].soloMattine && !nurseProps[n].noNotti) nightEligible.push(n);
  }
  const nc = new Array(numNurses).fill(0);

  function canNight(n, d) {
    if (schedule[n][d] !== null || nc[n] >= maxNights) return false;
    const noDiurni = nurseProps[n].noDiurni;
    if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
    if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
    if (!noDiurni && d + 3 < numDays && schedule[n][d + 3] !== null) return false;
    if (d > 0 && schedule[n][d - 1] === 'S') return false;
    if (d > 1 && schedule[n][d - 1] === 'R' && schedule[n][d - 2] === 'S') return false;
    if (!noDiurni && d > 2 && schedule[n][d - 2] === 'R' && schedule[n][d - 3] === 'S') return false;
    return true;
  }

  function placeNight(n, d) {
    schedule[n][d] = 'N';
    if (d + 1 < numDays) schedule[n][d + 1] = 'S';
    if (d + 2 < numDays) schedule[n][d + 2] = 'R';
    if (!nurseProps[n].noDiurni && d + 3 < numDays) schedule[n][d + 3] = 'R';
    nc[n]++;
  }

  // 2a — Ensure minimum night coverage per day
  const nightStarts = new Array(numDays).fill(0);
  const dayOrder = Array.from({ length: numDays }, (_, i) => i);
  shuffle(dayOrder);
  for (const d of dayOrder) {
    let cov = 0;
    for (let n = 0; n < numNurses; n++) if (schedule[n][d] === 'N') cov++;
    while (cov < minCovN) {
      const cands = shuffle([...nightEligible]).filter(n => canNight(n, d))
        .sort((a, b) => nc[a] - nc[b]);
      if (cands.length === 0) break;
      placeNight(cands[0], d);
      nightStarts[d]++;
      cov++;
    }
  }

  // 2b — Fill nights to target per nurse
  for (const n of shuffle([...nightEligible])) {
    if (nc[n] >= targetNights) continue;
    const days = shuffle(Array.from({ length: numDays }, (_, i) => i).filter(d => canNight(n, d)));
    days.sort((a, b) => (nightStarts[a] || 0) - (nightStarts[b] || 0));
    for (const d of days) {
      if (nc[n] >= targetNights) break;
      if (!canNight(n, d)) continue;
      placeNight(n, d);
      nightStarts[d]++;
    }
  }

  // Phase 3 — Day shifts (M, P, D)
  function eligible(n, d, s) {
    if (schedule[n][d] !== null) return false;
    if (nurseProps[n].soloMattine) return false;
    if (s === 'N' && nurseProps[n].noNotti) return false;
    if (s === 'D' && nurseProps[n].noDiurni) return false;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    if (!transitionOk(prev, s, ctx, schedule, n, d)) return false;
    if (consente2D && s === 'D' && prev === 'D' && d + 1 < numDays && schedule[n][d + 1] !== null) return false;
    if (s === 'N') {
      if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
      if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
      if (!nurseProps[n].noDiurni && d + 3 < numDays && schedule[n][d + 3] !== null) return false;
    }
    return true;
  }

  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    const avail = () => {
      const nurses = shuffle(Array.from({ length: numNurses }, (_, i) => i)
        .filter(n => schedule[n][d] === null));
      // Primary sort: prefer nurses who still have weekly-rest budget for this day's week
      // Secondary sort: fewest hours first (equity)
      nurses.sort((a, b) => {
        const aOk = hasWeekBudget(a, d) ? 0 : 1;
        const bOk = hasWeekBudget(b, d) ? 0 : 1;
        if (aOk !== bOk) return aOk - bOk;
        return nurseHours(schedule, a, numDays) - nurseHours(schedule, b, numDays);
      });
      return nurses;
    };

    // Check if a nurse can still accept a work shift based on weekly rest budget
    // Returns true if assigning a work shift won't make weekly rest impossible
    function hasWeekBudget(n, day) {
      if (minRPerWeek <= 0) return true;
      const wIdx = ctx.weekOf(day);
      const wDays = weekDaysList[wIdx];
      const need = requiredRest(wDays.length, minRPerWeek);
      let haveRest = 0, freeSlots = 0;
      for (const wd of wDays) {
        if (schedule[n][wd] === 'R') haveRest++;
        else if (schedule[n][wd] === null && wd !== day) freeSlots++;
      }
      return haveRest + freeSlots >= need;
    }

    if (preferDiurni) {
      for (const n of avail().filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine)) {
        if (cov.D >= maxCovD || (cov.M >= maxCovM && cov.P >= maxCovP)) break;
        if (!eligible(n, d, 'D')) continue;
        schedule[n][d] = 'D'; cov.D++; cov.M++; cov.P++;
      }
    }

    // Alternate M/P assignment: assign one at a time to the most-needed slot
    while (cov.M < maxCovM || cov.P < maxCovP) {
      let assigned = false;
      const mGap = Math.max(0, minCovM - cov.M);
      const pGap = Math.max(0, minCovP - cov.P);
      const first = mGap >= pGap ? 'M' : 'P';
      const second = first === 'M' ? 'P' : 'M';
      for (const s of [first, second]) {
        if (s === 'M' && cov.M >= maxCovM) continue;
        if (s === 'P' && cov.P >= maxCovP) continue;
        // Below minCov: prioritize coverage (ignore weekly budget)
        // At or above minCov: respect weekly budget
        const belowMin = (s === 'M' ? cov.M < minCovM : cov.P < minCovP);
        for (const n of avail()) {
          if (!eligible(n, d, s)) continue;
          if (!belowMin && !hasWeekBudget(n, d)) continue;
          schedule[n][d] = s;
          if (s === 'M') cov.M++; else cov.P++;
          assigned = true;
          break;
        }
        if (assigned) break;
      }
      if (!assigned) break;
    }

    // If still short on M or P, try promoting to D (covers both M+P slots)
    if (cov.M < minCovM || cov.P < minCovP) {
      for (const n of avail().filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine)) {
        if (cov.M >= maxCovM && cov.P >= maxCovP) break;
        if (!eligible(n, d, 'D')) continue;
        schedule[n][d] = 'D'; cov.D++; cov.M++; cov.P++;
      }
    }
  }

  // Phase 4 — Fill remaining with R
  for (let n = 0; n < numNurses; n++)
    for (let d = 0; d < numDays; d++)
      if (schedule[n][d] === null) schedule[n][d] = 'R';

  // Phase 4.5 — Weekly rest enforcement
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      for (const wDays of weekDaysList) {
        let rest = countWeekRest(schedule, n, wDays);
        const need = requiredRest(wDays.length, minRPerWeek);
        while (rest < need) {
          let converted = false;
          for (const d of wDays) {
            const s = schedule[n][d];
            if (s !== 'M' && s !== 'P') continue;
            const cov = dayCoverage(schedule, d, numNurses);
            if ((s === 'M' ? cov.M : cov.P) <= (s === 'M' ? minCovM : minCovP)) continue;
            const prev = d > 0 ? schedule[n][d - 1] : null;
            const next = d < numDays - 1 ? schedule[n][d + 1] : null;
            if (transitionOk(prev, 'R', ctx, schedule, n, d) && transitionOk('R', next, ctx, schedule, n, d + 1)) {
              schedule[n][d] = 'R'; rest++; converted = true; break;
            }
          }
          if (!converted) break;
        }
      }
    }
  }

  // Phase 4.6 — M/P balance for no_diurni nurses
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].noDiurni || nurseProps[n].soloMattine) continue;
    const mid = Math.floor(numDays / 2);
    let f1M = 0, f1P = 0, f2M = 0, f2P = 0;
    const mD = [], pD = [];
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === 'M') { (d < mid ? f1M++ : f2M++); mD.push(d); }
      if (schedule[n][d] === 'P') { (d < mid ? f1P++ : f2P++); pD.push(d); }
    }
    const thr = 3;
    if (f1M - f1P > thr && f2P - f2M > thr) trySwapMP(schedule, n, mD, pD, mid, true, ctx);
    if (f1P - f1M > thr && f2M - f2P > thr) trySwapMP(schedule, n, pD, mD, mid, false, ctx);
  }

  // Phase 4.7 — Nurse pairing
  if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
    const [n1, n2] = coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses && n1 !== n2)
      for (let d = 0; d < numDays; d++) schedule[n2][d] = schedule[n1][d];
  }

  // Phase 4.8 — D-D rest enforcement
  if (consente2D) {
    for (let n = 0; n < numNurses; n++) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d - 1] !== 'D' || schedule[n][d] !== 'D') continue;
        if (schedule[n][d + 1] === 'R') continue;
        const s = schedule[n][d + 1];
        if (s === 'M' || s === 'P') {
          const cov = dayCoverage(schedule, d + 1, numNurses);
          if ((s === 'M' ? cov.M : cov.P) > (s === 'M' ? minCovM : minCovP)) schedule[n][d + 1] = 'R';
        } else if (s === 'D') {
          const cov = dayCoverage(schedule, d + 1, numNurses);
          if (cov.M > minCovM && cov.P > minCovP && cov.D > 1) schedule[n][d + 1] = 'R';
        }
      }
    }
  }

  return schedule;
}

function trySwapMP(schedule, n, srcDays, dstDays, mid, srcIsM, ctx) {
  const { numDays, numNurses, minCovM, maxCovM, minCovP, maxCovP, rules } = ctx;
  for (const sDay of srcDays) {
    if (srcIsM ? sDay >= mid : sDay >= mid) { if (srcIsM) continue; } else { if (!srcIsM) continue; }
    if (srcIsM && sDay >= mid) continue;
    if (!srcIsM && sDay >= mid) continue;
    for (const dDay of dstDays) {
      if (srcIsM && dDay < mid) continue;
      if (!srcIsM && dDay < mid) continue;
      const newSrc = srcIsM ? 'P' : 'M';
      const newDst = srcIsM ? 'M' : 'P';
      const prevS = sDay > 0 ? schedule[n][sDay - 1] : null;
      const nextS = sDay < numDays - 1 ? schedule[n][sDay + 1] : null;
      const prevD = dDay > 0 ? schedule[n][dDay - 1] : null;
      const nextD = dDay < numDays - 1 ? schedule[n][dDay + 1] : null;
      if (!transitionOk(prevS, newSrc, ctx, schedule, n, sDay)) continue;
      if (!transitionOk(newSrc, nextS, ctx, schedule, n, sDay)) continue;
      if (!transitionOk(prevD, newDst, ctx, schedule, n, dDay)) continue;
      if (!transitionOk(newDst, nextD, ctx, schedule, n, dDay)) continue;
      const covS = dayCoverage(schedule, sDay, numNurses);
      const covD = dayCoverage(schedule, dDay, numNurses);
      const okS = srcIsM ? (covS.M > minCovM && covS.P < maxCovP) : (covS.P > minCovP && covS.M < maxCovM);
      const okD = srcIsM ? (covD.P > minCovP && covD.M < maxCovM) : (covD.M > minCovM && covD.P < maxCovP);
      if (okS && okD) {
        schedule[n][sDay] = newSrc;
        schedule[n][dDay] = newDst;
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Local search — simulated annealing
// ---------------------------------------------------------------------------

function localSearch(schedule, ctx, maxIter) {
  let current     = deepCopy(schedule);
  let currentScore = computeScore(current, ctx);
  let best         = deepCopy(current);
  let bestScore    = currentScore;

  const changes = []; // reusable array for tracking cell changes

  for (let iter = 0; iter < maxIter; iter++) {
    const temp = 2000 * (1 - iter / maxIter);
    const r = Math.random();
    changes.length = 0;

    // Pick a move type — bias toward weekly-rest fix when hard violations exist
    let moved = false;
    if (currentScore.hard > 0 && r < 0.30) {
      moved = tryWeeklyRestMove(current, ctx, changes);
    } else if (r < 0.35) {
      moved = trySwapMove(current, ctx, changes);
    } else if (r < 0.60) {
      moved = tryChangeMove(current, ctx, changes);
    } else if (r < 0.80) {
      moved = tryEquityMove(current, ctx, changes);
    } else {
      moved = tryWeeklyRestMove(current, ctx, changes);
    }

    if (!moved) continue;

    const newScore = computeScore(current, ctx);
    const delta = newScore.total - currentScore.total;
    if (delta <= 0 || (temp > 0 && Math.random() < Math.exp(-delta / Math.max(temp, 0.01)))) {
      // Accept
      currentScore = newScore;
      if (newScore.total < bestScore.total) {
        best = deepCopy(current);
        bestScore = newScore;
      }
    } else {
      // Reject — undo changes (lightweight, no deepCopy)
      for (const c of changes) current[c.n][c.d] = c.old;
    }
  }
  return best;
}

// Helper: record a cell change for undo
function setCell(schedule, n, d, val, changes) {
  if (changes) changes.push({ n, d, old: schedule[n][d] });
  schedule[n][d] = val;
}

function trySwapMove(schedule, ctx, changes) {
  const { numDays, numNurses, pinned, nurseProps } = ctx;
  const d = Math.floor(Math.random() * numDays);
  const n1 = Math.floor(Math.random() * numNurses);
  const n2 = Math.floor(Math.random() * numNurses);
  if (n1 === n2) return false;
  if (pinned[n1][d] || pinned[n2][d]) return false;
  const s1 = schedule[n1][d], s2 = schedule[n2][d];
  if (s1 === s2) return false;
  if (s1 === 'N' || s1 === 'S' || s2 === 'N' || s2 === 'S') return false;
  const prev1 = d > 0 ? schedule[n1][d - 1] : null, next1 = d < numDays - 1 ? schedule[n1][d + 1] : null;
  const prev2 = d > 0 ? schedule[n2][d - 1] : null, next2 = d < numDays - 1 ? schedule[n2][d + 1] : null;
  if (!transitionOk(prev1, s2, ctx, schedule, n1, d)) return false;
  if (!transitionOk(s2, next1, ctx, schedule, n1, d)) return false;
  if (!transitionOk(prev2, s1, ctx, schedule, n2, d)) return false;
  if (!transitionOk(s1, next2, ctx, schedule, n2, d)) return false;
  if (s2 === 'D' && nurseProps[n1].noDiurni) return false;
  if (s1 === 'D' && nurseProps[n2].noDiurni) return false;
  setCell(schedule, n1, d, s2, changes);
  setCell(schedule, n2, d, s1, changes);
  return true;
}

function tryChangeMove(schedule, ctx, changes) {
  const { numDays, numNurses, pinned, nurseProps } = ctx;
  const d = Math.floor(Math.random() * numDays);
  const n = Math.floor(Math.random() * numNurses);
  if (pinned[n][d]) return false;
  const old = schedule[n][d];
  if (old === 'N' || old === 'S') return false;
  if (nurseProps[n].soloMattine) return false;
  const choices = ['M', 'P', 'R'].filter(s => s !== old);
  if (!nurseProps[n].noDiurni && old !== 'D') choices.push('D');
  shuffle(choices);
  for (const s of choices) {
    if (s === 'D' && nurseProps[n].noDiurni) continue;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    const next = d < numDays - 1 ? schedule[n][d + 1] : null;
    if (!transitionOk(prev, s, ctx, schedule, n, d)) continue;
    if (!transitionOk(s, next, ctx, schedule, n, d + 1)) continue;
    setCell(schedule, n, d, s, changes);
    return true;
  }
  return false;
}

function tryEquityMove(schedule, ctx, changes) {
  const { numDays, numNurses, pinned, nurseProps, minCovM, maxCovM, minCovP, maxCovP,
          minRPerWeek, weekDaysList, weekOf } = ctx;
  const n = Math.floor(Math.random() * numNurses);
  if (nurseProps[n].soloMattine) return false;
  const h = nurseHours(schedule, n, numDays);
  const allH = [];
  for (let i = 0; i < numNurses; i++) allH.push(nurseHours(schedule, i, numDays));
  const avg = allH.reduce((a, b) => a + b, 0) / numNurses;

  if (h > avg + 4) {
    const days = shuffle(Array.from({ length: numDays }, (_, i) => i));
    for (const d of days) {
      if (pinned[n][d]) continue;
      const s = schedule[n][d];
      if (s !== 'M' && s !== 'P') continue;
      const cov = dayCoverage(schedule, d, numNurses);
      if ((s === 'M' ? cov.M : cov.P) <= (s === 'M' ? ctx.minCovM : ctx.minCovP)) continue;
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (!transitionOk(prev, 'R', ctx, schedule, n, d)) continue;
      if (!transitionOk('R', next, ctx, schedule, n, d + 1)) continue;
      setCell(schedule, n, d, 'R', changes);
      return true;
    }
  } else if (h < avg - 4) {
    const days = shuffle(Array.from({ length: numDays }, (_, i) => i));
    for (const d of days) {
      if (pinned[n][d] || schedule[n][d] !== 'R') continue;
      if (minRPerWeek > 0) {
        const wIdx = weekOf(d);
        const wDays = weekDaysList[wIdx];
        if (countWeekRest(schedule, n, wDays) <= requiredRest(wDays.length, minRPerWeek)) continue;
      }
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      const cov = dayCoverage(schedule, d, numNurses);
      for (const s of shuffle(['M', 'P'])) {
        if (s === 'M' && cov.M >= maxCovM) continue;
        if (s === 'P' && cov.P >= maxCovP) continue;
        if (!transitionOk(prev, s, ctx, schedule, n, d)) continue;
        if (!transitionOk(s, next, ctx, schedule, n, d + 1)) continue;
        setCell(schedule, n, d, s, changes);
        return true;
      }
    }
  }
  return false;
}

function tryWeeklyRestMove(schedule, ctx, changes) {
  const { numDays, numNurses, pinned, nurseProps, minRPerWeek, weekDaysList } = ctx;
  if (minRPerWeek <= 0) return false;

  // Find a nurse with a weekly-rest deficit
  const nOrder = shuffle(Array.from({ length: numNurses }, (_, i) => i));
  for (const n of nOrder) {
    for (let w = 0; w < weekDaysList.length; w++) {
      const wDays = weekDaysList[w];
      const need = requiredRest(wDays.length, minRPerWeek);
      const have = countWeekRest(schedule, n, wDays);
      if (have >= need) continue;

      // Nurse n needs more rest in week w.
      // Try to swap an M/P of nurse n with an R from another nurse on the same day.
      const workDays = shuffle(wDays.filter(d => !pinned[n][d] && (schedule[n][d] === 'M' || schedule[n][d] === 'P')));
      for (const d of workDays) {
        const sN = schedule[n][d];
        // Find another nurse with R on this day who has excess weekly rest
        const others = shuffle(Array.from({ length: numNurses }, (_, i) => i).filter(i => i !== n));
        for (const o of others) {
          if (pinned[o][d] || schedule[o][d] !== 'R') continue;
          if (nurseProps[o].soloMattine) continue;
          // Check other nurse doesn't go below weekly rest minimum
          const oHave = countWeekRest(schedule, o, wDays);
          const oNeed = requiredRest(wDays.length, minRPerWeek);
          if (oHave <= oNeed) continue;
          // Check tag constraints
          if (sN === 'D' && nurseProps[o].noDiurni) continue;
          // Check transitions for both
          const prevN = d > 0 ? schedule[n][d-1] : null, nextN = d < numDays-1 ? schedule[n][d+1] : null;
          const prevO = d > 0 ? schedule[o][d-1] : null, nextO = d < numDays-1 ? schedule[o][d+1] : null;
          if (!transitionOk(prevN, 'R', ctx, schedule, n, d)) continue;
          if (!transitionOk('R', nextN, ctx, schedule, n, d+1)) continue;
          if (!transitionOk(prevO, sN, ctx, schedule, o, d)) continue;
          if (!transitionOk(sN, nextO, ctx, schedule, o, d+1)) continue;
          setCell(schedule, n, d, 'R', changes);
          setCell(schedule, o, d, sN, changes);
          return true;
        }
      }
    }
  }
  return false;
}

function collectViolations(schedule, ctx) {
  const { numDays, numNurses, minCovM, minCovP, minCovN, consente2D,
          forbidden, nurseProps, minRPerWeek, weekDaysList } = ctx;
  const violations = [];

  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM) violations.push({ day: d, type: 'coverage_M', msg: `Giorno ${d + 1}: copertura mattina insufficiente (${cov.M}/${minCovM})` });
    if (cov.P < minCovP) violations.push({ day: d, type: 'coverage_P', msg: `Giorno ${d + 1}: copertura pomeriggio insufficiente (${cov.P}/${minCovP})` });
    if (cov.N < minCovN) violations.push({ day: d, type: 'coverage_N', msg: `Giorno ${d + 1}: copertura notte insufficiente (${cov.N}/${minCovN})` });
  }

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d], nxt = schedule[n][d + 1];
      const fb = forbidden[cur];
      if (fb && fb.includes(nxt))
        violations.push({ nurse: n, day: d, type: 'transition', msg: `Infermiere ${n + 1}, giorno ${d + 1}-${d + 2}: transizione vietata ${cur}→${nxt}` });
      if (cur === 'N' && nxt !== 'S')
        violations.push({ nurse: n, day: d, type: 'N_no_S', msg: `Infermiere ${n + 1}, giorno ${d + 1}: N non seguito da S` });
      if (cur === 'S' && nxt !== 'R')
        violations.push({ nurse: n, day: d, type: 'S_no_R', msg: `Infermiere ${n + 1}, giorno ${d + 1}: S non seguito da R (primo riposo dopo smonto)` });
    }
    for (let d = 0; d < numDays - 3; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d+1] === 'S' && schedule[n][d+2] === 'R' && schedule[n][d+3] !== 'R') {
        if (!nurseProps[n].noDiurni)
          violations.push({ nurse: n, day: d, type: 'need_2R_after_night', msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo N-S-R serve un altro R (2 riposi dopo notte, S non conta)` });
      }
    }
    if (consente2D) {
      for (let d = 1; d < numDays - 1; d++) {
        if (schedule[n][d-1] === 'D' && schedule[n][d] === 'D' && schedule[n][d+1] !== 'R')
          violations.push({ nurse: n, day: d, type: 'DD_no_R', msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo D-D serve R` });
      }
      for (let d = 2; d < numDays; d++) {
        if (schedule[n][d-2] === 'D' && schedule[n][d-1] === 'D' && schedule[n][d] === 'D')
          violations.push({ nurse: n, day: d, type: 'DDD', msg: `Infermiere ${n + 1}, giorno ${d + 1}: 3 diurni consecutivi non consentiti` });
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
          violations.push({ nurse: n, week: w, type: 'min_R_week', msg: `Infermiere ${n + 1}, settimana ${w + 1}: solo ${have} riposi (minimo ${need})` });
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
    let totalHours = 0, nights = 0, weekends = 0;
    for (let d = 0; d < numDays; d++) {
      const s = schedule[n][d];
      totalHours += SHIFT_HOURS[s] || 0;
      if (s === 'N') nights++;
      if (isWeekend(year, month, d + 1) && s && s !== 'R') weekends++;
    }
    return { totalHours: Math.round(totalHours * 10) / 10, nights, weekends };
  });
}

// ---------------------------------------------------------------------------
// Main solver — multi-restart + local search
// ---------------------------------------------------------------------------

const NUM_RESTARTS       = 10;
const LOCAL_SEARCH_ITERS = 4000;

function solve(config) {
  const ctx = buildContext(config);

  let bestSchedule = null;
  let bestScore    = { total: Infinity, hard: Infinity, soft: Infinity };

  for (let r = 0; r < NUM_RESTARTS; r++) {
    progress(5 + Math.floor(r * (80 / NUM_RESTARTS)),
             `Tentativo ${r + 1}/${NUM_RESTARTS}…`);

    const schedule = construct(ctx);
    const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS);
    const score    = computeScore(improved, ctx);

    if (score.total < bestScore.total) {
      bestSchedule = improved;
      bestScore    = score;
    }

    // Early exit when no hard violations remain and soft penalty is low
    if (bestScore.hard === 0 && bestScore.soft < 40) break;
  }

  progress(90, 'Validazione…');

  const violations = collectViolations(bestSchedule, ctx);
  const stats      = computeStats(bestSchedule, ctx);

  progress(100, 'Fatto!');
  return { schedule: bestSchedule, violations, stats };
}

// ---------------------------------------------------------------------------
// Worker interface (unchanged)
// ---------------------------------------------------------------------------

self.onmessage = function (e) {
  if (e.data.type === 'solve') {
    try {
      const result = solve(e.data.config);
      self.postMessage({ type: 'result', schedule: result.schedule, violations: result.violations, stats: result.stats });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

function progress(percent, message) {
  self.postMessage({ type: 'progress', percent, message });
}

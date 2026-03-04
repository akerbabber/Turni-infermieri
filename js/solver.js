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
 *   F     Ferie      (6.12 h)
 *   MA    Malattia   (6.12 h)
 *   L104  104        (6.12 h)
 *   PR    Permesso Retribuito (6.12 h)
 *   MT    Maternità  (6.12 h)
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 6.12, MA: 6.12, L104: 6.12, PR: 6.12, MT: 6.12 };

const EQUITY_THRESHOLD_HOURS = 2;        // ±hours from average before equity move triggers
const HOUR_EQUITY_MILP_WEIGHT = 0.3;     // weight for minimax hour equity in MILP objective
const NIGHT_EQUITY_MILP_WEIGHT = 0.15;   // weight for minimax night equity in MILP objective
const DIURNI_EQUITY_MILP_WEIGHT = 0.15;  // weight for minimax D-shift equity in MILP objective
const MP_BALANCE_MILP_WEIGHT = 0.1;      // weight for M/P balance penalty in MILP objective

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
    soloDiurni:  n.tags.includes('solo_diurni'),
    soloNotti:   n.tags.includes('solo_notti'),
    diurniENotturni: n.tags.includes('diurni_e_notturni'),
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
  const minCovN = rules.minCoverageN ?? 6, maxCovN = rules.maxCoverageN ?? 6;

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
    if (cov.M > maxCovM) hard += (cov.M - maxCovM);
    if (cov.P < minCovP) hard += (minCovP - cov.P);
    if (cov.P > maxCovP) hard += (cov.P - maxCovP);
    if (cov.N < minCovN) hard += (minCovN - cov.N);
    if (cov.N > maxCovN) hard += (cov.N - maxCovN);
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
    // Now diurni_e_notturni uses the same N-S-R-R pattern as regular nurses
    for (let d = 0; d < numDays - 3; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d+1] === 'S' && schedule[n][d+2] === 'R') {
        if (!nurseProps[n].noDiurni && schedule[n][d+3] !== 'R') {
          hard++;
        }
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

  // Soft: hours equity (weight 3 — on par with night fairness)
  const hours = [];
  for (let n = 0; n < numNurses; n++) hours.push(nurseHours(schedule, n, numDays));
  const avg = hours.reduce((a, b) => a + b, 0) / numNurses;
  for (const h of hours) soft += Math.abs(h - avg) * 3;

  // Soft: night-count fairness
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].noNotti) continue;
    const nc = nightCount(schedule, n, numDays);
    soft += Math.abs(nc - targetNights) * 3;
  }

  // Soft: D-shift (diurno) count fairness among D-eligible nurses
  {
    const dEligible = [];
    for (let n = 0; n < numNurses; n++) {
      if (nurseProps[n].soloMattine || nurseProps[n].soloNotti || nurseProps[n].noDiurni) continue;
      dEligible.push(n);
    }
    if (dEligible.length >= 2) {
      const dCounts = dEligible.map(n => diurniCount(schedule, n, numDays));
      const dAvg = dCounts.reduce((a, b) => a + b, 0) / dCounts.length;
      for (const dc of dCounts) soft += Math.abs(dc - dAvg) * 3;
    }
  }

  // Soft: M/P balance for no_diurni nurses (including no_diurni+no_notti)
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].noDiurni) continue;
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].soloNotti || nurseProps[n].diurniENotturni) continue;
    let mC = 0, pC = 0;
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === 'M') mC++;
      else if (schedule[n][d] === 'P') pC++;
    }
    soft += Math.abs(mC - pC) * 2;
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
    if (!nurseProps[n].soloMattine && !nurseProps[n].soloDiurni && !nurseProps[n].noNotti) nightEligible.push(n);
  }
  const nc = new Array(numNurses).fill(0);

  function canNight(n, d) {
    if (schedule[n][d] !== null || nc[n] >= maxNights) return false;
    const noDiurni = nurseProps[n].noDiurni;
    if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
    if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
    // For regular nurses (including diurni_e_notturni): need 2 R after N-S (total 4 slots: N-S-R-R)
    // For noDiurni nurses: need only 1 R after N-S (total 3 slots: N-S-R)
    if (!noDiurni && d + 3 < numDays && schedule[n][d + 3] !== null) return false;
    
    // Cannot start night if we're still in mandatory post-night rest period
    // Check backward: if previous day is S, we're at first R position (cannot start night)
    if (d > 0 && schedule[n][d - 1] === 'S') return false;
    // If d-1 is R and d-2 is S, we're at second R position (mandatory for non-noDiurni)
    if (d > 1 && schedule[n][d - 1] === 'R' && schedule[n][d - 2] === 'S') return false;
    // After N-S-R-R (4 days), day 5 is free to start a new night
    return true;
  }

  function placeNight(n, d) {
    schedule[n][d] = 'N';
    if (d + 1 < numDays) schedule[n][d + 1] = 'S';
    if (d + 2 < numDays) schedule[n][d + 2] = 'R';
    // For diurni_e_notturni and regular nurses: 2 R after smonto
    // For noDiurni nurses: only 1 R after smonto
    if (!nurseProps[n].noDiurni && d + 3 < numDays) {
      schedule[n][d + 3] = 'R';
    }
    nc[n]++;
  }

  // 2a — Ensure minimum night coverage per day (with smart spreading)
  const nightStarts = new Array(numDays).fill(0);
  
  // Calculate optimal spacing per nurse based on their block size:
  // noDiurni nurses need N-S-R (3 days), others need N-S-R-R (4 days)
  // Cycle length = block size + 1 (minimum gap between night shift starts)
  
  // Assign initial starting offsets to spread nurses across the cycle
  // Use nurse-specific cycle lengths for better spreading
  const nurseStartOffset = new Map();
  const nurseCycleLen = new Map();
  nightEligible.forEach((n, idx) => {
    const nBlock = nurseProps[n].noDiurni ? 3 : 4;
    const nCycle = nBlock + 1;
    nurseCycleLen.set(n, nCycle);
    nurseStartOffset.set(n, idx % nCycle);
  });
  
  // Phase 2a.1: First, place nights to meet minimum coverage, respecting offsets
  // Go day by day and ensure we meet minCovN
  for (let d = 0; d < numDays; d++) {
    let cov = 0;
    for (let n = 0; n < numNurses; n++) if (schedule[n][d] === 'N') cov++;
    
    while (cov < minCovN) {
      // Find candidates who can do night on this day
      // Prefer nurses whose offset matches this day (mod their cycle)
      const cands = shuffle([...nightEligible])
        .filter(n => canNight(n, d))
        .sort((a, b) => {
          // Primary: prefer nurses whose offset matches their cycle
          const aCycle = nurseCycleLen.get(a);
          const bCycle = nurseCycleLen.get(b);
          const aMatch = (d % aCycle === nurseStartOffset.get(a)) ? 0 : 1;
          const bMatch = (d % bCycle === nurseStartOffset.get(b)) ? 0 : 1;
          if (aMatch !== bMatch) return aMatch - bMatch;
          // Secondary: prefer noDiurni nurses (shorter blocks, more efficient)
          const aNd = nurseProps[a].noDiurni ? 0 : 1;
          const bNd = nurseProps[b].noDiurni ? 0 : 1;
          if (aNd !== bNd) return aNd - bNd;
          // Tertiary: prefer nurses with fewer nights
          return nc[a] - nc[b];
        });
      
      if (cands.length === 0) break;
      placeNight(cands[0], d);
      nightStarts[d]++;
      cov++;
    }
  }
  
  // Phase 2a.2: Fill in any remaining gaps (days with cov < minCovN)
  // Try a more aggressive approach: look for nurses who can shift their schedule
  for (let d = 0; d < numDays; d++) {
    let cov = 0;
    for (let n = 0; n < numNurses; n++) if (schedule[n][d] === 'N') cov++;
    if (cov >= minCovN) continue;
    
    // Try to find nurses who have R (not from a recent N-S block) or null
    for (const n of shuffle([...nightEligible])) {
      if (cov >= minCovN) break;
      if (nc[n] >= maxNights) continue;
      
      const s = schedule[n][d];
      // Skip if pinned or in the middle of a required N-S-R-R sequence
      if (pinned[n][d]) continue;
      
      // Check if we can place a night here
      if (s !== null && s !== 'R') continue;
      
      // For R: check it's not part of a mandatory post-night rest
      if (s === 'R' && d > 0) {
        const prev = schedule[n][d - 1];
        if (prev === 'S') continue; // This is the first R after S, mandatory
        if (prev === 'R' && d > 1 && schedule[n][d - 2] === 'S') continue; // Second R after N-S, mandatory
      }
      
      // Check if we can clear the required slots
      const noDiurni = nurseProps[n].noDiurni;
      const needSlots = noDiurni ? 3 : 4;
      if (d + needSlots > numDays) continue;
      
      let canClear = true;
      for (let i = 0; i < needSlots; i++) {
        const slot = schedule[n][d + i];
        if (pinned[n][d + i]) { canClear = false; break; }
        if (slot !== null && slot !== 'R') { canClear = false; break; }
        // If it's R, check it's not mandatory post-night rest
        if (slot === 'R' && d + i > 0) {
          const prevSlot = schedule[n][d + i - 1];
          if (prevSlot === 'S') { canClear = false; break; }
          if (prevSlot === 'R' && d + i > 1 && schedule[n][d + i - 2] === 'S') { canClear = false; break; }
        }
      }
      if (!canClear) continue;
      
      // Clear and place
      for (let i = 0; i < needSlots; i++) schedule[n][d + i] = null;
      placeNight(n, d);
      nightStarts[d]++;
      cov++;
    }
  }

  // 2c — Fill nights to target per nurse, prioritizing days with less coverage
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

  // 2d — Final pass: ensure we don't exceed maxCovN per day (reduce excess)
  for (let d = 0; d < numDays; d++) {
    let cov = 0;
    const nightNurses = [];
    for (let n = 0; n < numNurses; n++) {
      if (schedule[n][d] === 'N') { cov++; nightNurses.push(n); }
    }
    while (cov > maxCovN && nightNurses.length > 0) {
      // Find nurse with most nights to remove
      nightNurses.sort((a, b) => nc[b] - nc[a]);
      const n = nightNurses.shift();
      // Clear N-S-R-R block (set to null to be filled later by day shift phase)
      const noDiurni = nurseProps[n].noDiurni;
      const needSlots = noDiurni ? 3 : 4;
      for (let i = 0; i < needSlots && d + i < numDays; i++) {
        if (!pinned[n][d + i]) schedule[n][d + i] = null;
      }
      nc[n]--;
      cov--;
      nightStarts[d]--;
    }
  }


  // Phase 3 — Day shifts (M, P, D)
  function eligible(n, d, s) {
    if (schedule[n][d] !== null) return false;
    if (nurseProps[n].soloMattine) return false;
    // solo_diurni: only D or R allowed
    if (nurseProps[n].soloDiurni && s !== 'D' && s !== 'R') return false;
    // solo_notti: only N, S, or R allowed
    if (nurseProps[n].soloNotti && s !== 'N' && s !== 'S' && s !== 'R') return false;
    // diurni_e_notturni: only D, N, S, R allowed (no M, P)
    if (nurseProps[n].diurniENotturni && s !== 'D' && s !== 'N' && s !== 'S' && s !== 'R') return false;
    if (s === 'N' && nurseProps[n].noNotti) return false;
    if (s === 'D' && nurseProps[n].noDiurni) return false;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    if (!transitionOk(prev, s, ctx, schedule, n, d)) return false;
    if (consente2D && s === 'D' && prev === 'D' && d + 1 < numDays && schedule[n][d + 1] !== null) return false;
    if (s === 'N') {
      if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
      if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
      // For diurni_e_notturni and regular nurses: need 2 R after N-S
      // For noDiurni nurses: only 1 R needed after N-S
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
      for (const n of avail().filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine && !nurseProps[n].soloNotti)) {
        if (cov.D >= maxCovD || cov.M >= maxCovM || cov.P >= maxCovP) break;
        if (!eligible(n, d, 'D')) continue;
        schedule[n][d] = 'D'; cov.D++; cov.M++; cov.P++;
      }
    }

    // Alternate M/P assignment: assign one at a time to the most-needed slot
    // Pre-compute M/P counts per nurse for balance sorting
    const mpCount = new Array(numNurses);
    for (let n = 0; n < numNurses; n++) {
      let mc = 0, pc = 0;
      for (let dd = 0; dd < numDays; dd++) {
        if (schedule[n][dd] === 'M') mc++; else if (schedule[n][dd] === 'P') pc++;
      }
      mpCount[n] = { m: mc, p: pc };
    }
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
        const candidates = avail().filter(n => eligible(n, d, s) && (belowMin || hasWeekBudget(n, d)));
        // Sort candidates: prefer nurses who need this shift type for personal M/P balance
        candidates.sort((a, b) => {
          const aBal = s === 'M' ? (mpCount[a].m - mpCount[a].p) : (mpCount[a].p - mpCount[a].m);
          const bBal = s === 'M' ? (mpCount[b].m - mpCount[b].p) : (mpCount[b].p - mpCount[b].m);
          return aBal - bBal;
        });
        if (candidates.length > 0) {
          const n = candidates[0];
          schedule[n][d] = s;
          if (s === 'M') { cov.M++; mpCount[n].m++; } else { cov.P++; mpCount[n].p++; }
          assigned = true;
          break;
        }
      }
      if (!assigned) break;
    }

    // If still short on M or P, try promoting to D (covers both M+P slots)
    // Only if D won't push either M or P over their maximum
    if (cov.M < minCovM || cov.P < minCovP) {
      for (const n of avail().filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine && !nurseProps[n].soloNotti)) {
        if (cov.M >= maxCovM || cov.P >= maxCovP) break;
        if (cov.D >= maxCovD) break;
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

  // Phase 4.6 — M/P balance for no_diurni and no_notti nurses
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].soloNotti || nurseProps[n].diurniENotturni) continue;
    // Apply to no_diurni nurses and also to no_diurni+no_notti nurses
    if (!nurseProps[n].noDiurni) continue;
    let mCount = 0, pCount = 0;
    const mDays = [], pDays = [];
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === 'M') { mCount++; mDays.push(d); }
      if (schedule[n][d] === 'P') { pCount++; pDays.push(d); }
    }
    // Swap excess M to P or vice versa to balance
    const diff = mCount - pCount;
    if (Math.abs(diff) > 1) {
      const srcDays = diff > 0 ? mDays : pDays;
      const newShift = diff > 0 ? 'P' : 'M';
      const srcShift = diff > 0 ? 'M' : 'P';
      let swaps = Math.floor(Math.abs(diff) / 2);
      for (const d of shuffle([...srcDays])) {
        if (swaps <= 0) break;
        const cov = dayCoverage(schedule, d, numNurses);
        const srcCov = srcShift === 'M' ? cov.M : cov.P;
        const dstCov = newShift === 'M' ? cov.M : cov.P;
        const srcMin = srcShift === 'M' ? minCovM : minCovP;
        const dstMax = newShift === 'M' ? maxCovM : maxCovP;
        if (srcCov <= srcMin || dstCov >= dstMax) continue;
        const prev = d > 0 ? schedule[n][d - 1] : null;
        const next = d < numDays - 1 ? schedule[n][d + 1] : null;
        if (!transitionOk(prev, newShift, ctx, schedule, n, d)) continue;
        if (!transitionOk(newShift, next, ctx, schedule, n, d + 1)) continue;
        schedule[n][d] = newShift;
        swaps--;
      }
    }
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
    if (sDay >= mid) continue;
    for (const dDay of dstDays) {
      if (dDay < mid) continue;
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

function localSearch(schedule, ctx, maxIter, timeLimitSec) {
  const { numDays, numNurses } = ctx;
  let current     = deepCopy(schedule);
  let currentScore = computeScore(current, ctx);
  let best         = deepCopy(current);
  let bestScore    = currentScore;

  const changes = []; // reusable array for tracking cell changes

  // Cache nurse hours for fast equity lookups — avoids O(numNurses × numDays) per equity move
  const cachedHours = new Array(numNurses);
  for (let n = 0; n < numNurses; n++) cachedHours[n] = nurseHours(current, n, numDays);

  // Pre-allocate reusable index arrays to reduce GC pressure in hot paths
  const _dayIndices = Array.from({ length: numDays }, (_, i) => i);
  const _nurseIndices = Array.from({ length: numNurses }, (_, i) => i);

  // Adaptive move selection: track acceptance rates per move type
  const moveStats = [
    { attempts: 0, accepts: 0, weight: 0.25 }, // 0: swap
    { attempts: 0, accepts: 0, weight: 0.20 }, // 1: change
    { attempts: 0, accepts: 0, weight: 0.30 }, // 2: equity
    { attempts: 0, accepts: 0, weight: 0.25 }, // 3: weekly rest
  ];
  const ADAPT_INTERVAL = 500;  // recalculate weights every N iterations
  const MIN_WEIGHT = 0.05;     // floor to prevent starving any move type

  const useTimeLimit = timeLimitSec > 0;
  const startMs = useTimeLimit ? Date.now() : 0;
  const timeLimitMs = useTimeLimit ? timeLimitSec * 1000 : 0;
  let now = startMs;

  for (let iter = 0; ; iter++) {
    // Stopping criterion: time-based when timeLimitSec is set, else iteration-based
    if (useTimeLimit) {
      if (iter % 200 === 0) {
        now = Date.now();
        if (now - startMs >= timeLimitMs) break;
      }
    } else {
      if (iter >= maxIter) break;
    }

    // Temperature: use time fraction when time-limited, else iteration fraction
    const fraction = useTimeLimit
      ? Math.min(1, (now - startMs) / timeLimitMs)
      : iter / maxIter;
    const temp = 2000 * (1 - fraction);

    changes.length = 0;

    // Adaptive move selection with hard-violation priority
    let moveType;
    if (currentScore.hard > 0 && Math.random() < 0.30) {
      moveType = 3; // weekly rest fix when hard violations exist
    } else {
      // Weighted random selection using adaptive weights
      const totalW = moveStats.reduce((s, m) => s + m.weight, 0);
      let r = Math.random() * totalW;
      moveType = 0;
      for (let i = 0; i < moveStats.length; i++) {
        r -= moveStats[i].weight;
        if (r <= 0) { moveType = i; break; }
      }
    }

    let moved = false;
    switch (moveType) {
      case 0: moved = trySwapMove(current, ctx, changes); break;
      case 1: moved = tryChangeMove(current, ctx, changes); break;
      case 2: moved = tryEquityMove(current, ctx, changes, cachedHours, _dayIndices); break;
      case 3: moved = tryWeeklyRestMove(current, ctx, changes, _nurseIndices); break;
    }

    moveStats[moveType].attempts++;
    if (!moved) continue;

    const newScore = computeScore(current, ctx);
    const delta = newScore.total - currentScore.total;
    if (delta <= 0 || (temp > 0 && Math.random() < Math.exp(-delta / Math.max(temp, 0.01)))) {
      // Accept
      currentScore = newScore;
      moveStats[moveType].accepts++;
      // Update cached hours incrementally from changes
      for (const c of changes) {
        cachedHours[c.n] += (SHIFT_HOURS[current[c.n][c.d]] || 0) - (SHIFT_HOURS[c.old] || 0);
      }
      if (newScore.total < bestScore.total) {
        best = deepCopy(current);
        bestScore = newScore;
      }
    } else {
      // Reject — undo changes (lightweight, no deepCopy)
      for (const c of changes) current[c.n][c.d] = c.old;
    }

    // Periodically adapt move weights based on acceptance rates
    if (iter > 0 && iter % ADAPT_INTERVAL === 0) {
      let totalRate = 0;
      for (const ms of moveStats) {
        ms._rate = ms.attempts > 0 ? ms.accepts / ms.attempts : 0;
        totalRate += ms._rate;
      }
      if (totalRate > 0) {
        for (const ms of moveStats) {
          ms.weight = Math.max(MIN_WEIGHT, ms._rate / totalRate);
        }
      }
      // Reset counters for next adaptation window
      for (const ms of moveStats) { ms.attempts = 0; ms.accepts = 0; }
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
  // solo_diurni: can only have D or R
  if (nurseProps[n1].soloDiurni && s2 !== 'D' && s2 !== 'R') return false;
  if (nurseProps[n2].soloDiurni && s1 !== 'D' && s1 !== 'R') return false;
  // solo_notti: can only have N, S, R (N/S already handled above)
  if (nurseProps[n1].soloNotti && s2 !== 'R') return false;
  if (nurseProps[n2].soloNotti && s1 !== 'R') return false;
  // diurni_e_notturni: can only have D, N, S, R (N/S already handled above)
  if (nurseProps[n1].diurniENotturni && s2 !== 'D' && s2 !== 'R') return false;
  if (nurseProps[n2].diurniENotturni && s1 !== 'D' && s1 !== 'R') return false;
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
  // solo_diurni: can only change to D or R
  if (nurseProps[n].soloDiurni) {
    const choices = ['D', 'R'].filter(s => s !== old);
    shuffle(choices);
    for (const s of choices) {
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (!transitionOk(prev, s, ctx, schedule, n, d)) continue;
      if (!transitionOk(s, next, ctx, schedule, n, d + 1)) continue;
      setCell(schedule, n, d, s, changes);
      return true;
    }
    return false;
  }
  // solo_notti: can only have N, S, R (N/S changes are already blocked above, so no change possible)
  if (nurseProps[n].soloNotti) return false;
  // diurni_e_notturni: can only change to D or R (N/S changes already blocked above)
  if (nurseProps[n].diurniENotturni) {
    const choices = ['D', 'R'].filter(s => s !== old);
    shuffle(choices);
    for (const s of choices) {
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (!transitionOk(prev, s, ctx, schedule, n, d)) continue;
      if (!transitionOk(s, next, ctx, schedule, n, d + 1)) continue;
      setCell(schedule, n, d, s, changes);
      return true;
    }
    return false;
  }
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

function tryEquityMove(schedule, ctx, changes, cachedHours, dayIndices) {
  const { numDays, numNurses, pinned, nurseProps, minCovM, maxCovM, minCovP, maxCovP,
          minRPerWeek, weekDaysList, weekOf, consente2D } = ctx;
  const n = Math.floor(Math.random() * numNurses);
  if (nurseProps[n].soloMattine || nurseProps[n].soloNotti) return false;

  // Use cached hours: O(numNurses) instead of O(numNurses × numDays)
  const h = cachedHours ? cachedHours[n] : nurseHours(schedule, n, numDays);
  let avg;
  if (cachedHours) {
    let sum = 0;
    for (let i = 0; i < numNurses; i++) sum += cachedHours[i];
    avg = sum / numNurses;
  } else {
    const allH = [];
    for (let i = 0; i < numNurses; i++) allH.push(nurseHours(schedule, i, numDays));
    avg = allH.reduce((a, b) => a + b, 0) / numNurses;
  }

  const isDiurniOnly = nurseProps[n].soloDiurni || nurseProps[n].diurniENotturni;

  // Reuse pre-allocated day indices array instead of allocating new ones
  const days = dayIndices ? shuffle([...dayIndices]) : shuffle(Array.from({ length: numDays }, (_, i) => i));

  if (h > avg + EQUITY_THRESHOLD_HOURS) {
    for (const d of days) {
      if (pinned[n][d]) continue;
      const s = schedule[n][d];
      if (isDiurniOnly) {
        if (s !== 'D') continue;
        const cov = dayCoverage(schedule, d, numNurses);
        if (cov.M <= minCovM || cov.P <= minCovP) continue;
      } else {
        if (s !== 'M' && s !== 'P') continue;
        const cov = dayCoverage(schedule, d, numNurses);
        if ((s === 'M' ? cov.M : cov.P) <= (s === 'M' ? ctx.minCovM : ctx.minCovP)) continue;
      }
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (!transitionOk(prev, 'R', ctx, schedule, n, d)) continue;
      if (!transitionOk('R', next, ctx, schedule, n, d + 1)) continue;
      setCell(schedule, n, d, 'R', changes);
      return true;
    }
  } else if (h < avg - EQUITY_THRESHOLD_HOURS) {
    for (const d of days) {
      if (pinned[n][d] || schedule[n][d] !== 'R') continue;
      if (minRPerWeek > 0) {
        const wIdx = weekOf(d);
        const wDays = weekDaysList[wIdx];
        if (countWeekRest(schedule, n, wDays) <= requiredRest(wDays.length, minRPerWeek)) continue;
      }
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (isDiurniOnly) {
        if (!transitionOk(prev, 'D', ctx, schedule, n, d)) continue;
        if (!transitionOk('D', next, ctx, schedule, n, d + 1)) continue;
        if (consente2D) {
          if (prev === 'D') {
            if (next !== null && next !== 'R') continue;
            if (d > 1 && schedule[n][d - 2] === 'D') continue;
          }
          if (next === 'D') {
            const next2 = d + 2 < numDays ? schedule[n][d + 2] : null;
            if (next2 !== null && next2 !== 'R') continue;
            if (prev === 'D') continue;
          }
        } else if (prev === 'D' || next === 'D') continue;
        setCell(schedule, n, d, 'D', changes);
        return true;
      } else {
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
  }
  return false;
}

function tryWeeklyRestMove(schedule, ctx, changes, nurseIndices) {
  const { numDays, numNurses, pinned, nurseProps, minRPerWeek, weekDaysList } = ctx;
  if (minRPerWeek <= 0) return false;

  // Find a nurse with a weekly-rest deficit (reuse pre-allocated array when available)
  const nOrder = nurseIndices ? shuffle([...nurseIndices]) : shuffle(Array.from({ length: numNurses }, (_, i) => i));
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
          if (nurseProps[o].soloMattine || nurseProps[o].soloDiurni || nurseProps[o].soloNotti || nurseProps[o].diurniENotturni) continue;
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
  const { numDays, numNurses, minCovM, maxCovM, minCovP, maxCovP, minCovN, maxCovN, consente2D,
          forbidden, nurseProps, minRPerWeek, weekDaysList } = ctx;
  const violations = [];

  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    if (cov.M < minCovM) violations.push({ day: d, type: 'coverage_M', msg: `Giorno ${d + 1}: copertura mattina insufficiente (${cov.M}/${minCovM})` });
    if (cov.M > maxCovM) violations.push({ day: d, type: 'coverage_M_max', msg: `Giorno ${d + 1}: copertura mattina eccessiva (${cov.M}/${maxCovM})` });
    if (cov.P < minCovP) violations.push({ day: d, type: 'coverage_P', msg: `Giorno ${d + 1}: copertura pomeriggio insufficiente (${cov.P}/${minCovP})` });
    if (cov.P > maxCovP) violations.push({ day: d, type: 'coverage_P_max', msg: `Giorno ${d + 1}: copertura pomeriggio eccessiva (${cov.P}/${maxCovP})` });
    if (cov.N < minCovN) violations.push({ day: d, type: 'coverage_N', msg: `Giorno ${d + 1}: copertura notte insufficiente (${cov.N}/${minCovN})` });
    if (cov.N > maxCovN) violations.push({ day: d, type: 'coverage_N_max', msg: `Giorno ${d + 1}: copertura notte eccessiva (${cov.N}/${maxCovN})` });
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
      if (schedule[n][d] === 'N' && schedule[n][d+1] === 'S' && schedule[n][d+2] === 'R') {
        // N-S-R-R: second R required for diurni_e_notturni and regular nurses (except noDiurni)
        if (!nurseProps[n].noDiurni && schedule[n][d+3] !== 'R') {
          violations.push({ nurse: n, day: d, type: 'need_2R_after_night', msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo N-S-R serve un altro R (2 riposi dopo notte, S non conta)` });
        }
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
    let totalHours = 0, nights = 0, diurni = 0, weekends = 0;
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

// ---------------------------------------------------------------------------
// Main solver — multi-restart + local search (fallback)
// ---------------------------------------------------------------------------

const NUM_RESTARTS       = 10;
const LOCAL_SEARCH_ITERS = 4000;

function solveFallback(config) {
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
  return { schedule: bestSchedule, violations, stats, score: bestScore.total };
}

// ---------------------------------------------------------------------------
// HiGHS MILP solver — generates fast heuristics via optimization
// ---------------------------------------------------------------------------

// Seeded PRNG for reproducible random perturbations
function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7FFFFFFF;
    return s / 0x7FFFFFFF;
  };
}

/**
 * Build a CPLEX LP format string for the nurse scheduling problem.
 * @param {object} ctx - build context from buildContext()
 * @param {number} perturbSeed - seed for objective perturbation (0 = no perturbation)
 * @returns {string} LP format problem
 */
function buildLP(ctx, perturbSeed) {
  const { numDays, numNurses, pinned, nurseProps,
          minCovM, maxCovM, minCovP, maxCovP, minCovD, maxCovD, minCovN, maxCovN,
          targetNights, maxNights, minRPerWeek, weekDaysList, weekOf,
          forbidden, consente2D, coppiaTurni } = ctx;

  // Shift indices: M=0, P=1, N=2, S=3, R=4, D=5
  const SHIFTS = ['M', 'P', 'N', 'S', 'R', 'D'];
  const S_HRS  = [6.2, 6.2, 12.2, 0, 0, 12.2];
  const V = (n, d, s) => `x${n}_${d}_${s}`;

  const lines   = [];
  const binVars = [];

  // Determine which cells are free (not pinned)
  const isFree = (n, d) => !pinned[n][d];

  // Pre-compute pinned coverage per day
  const pinnedCovM = new Array(numDays).fill(0);
  const pinnedCovP = new Array(numDays).fill(0);
  const pinnedCovN = new Array(numDays).fill(0);
  const pinnedCovD = new Array(numDays).fill(0);
  for (let d = 0; d < numDays; d++) {
    for (let n = 0; n < numNurses; n++) {
      const p = pinned[n][d];
      if (!p) continue;
      if (p === 'M' || p === 'D') pinnedCovM[d]++;
      if (p === 'P' || p === 'D') pinnedCovP[d]++;
      if (p === 'N') pinnedCovN[d]++;
      if (p === 'D') pinnedCovD[d]++;
    }
  }

  // Pre-compute pinned hours/nights per nurse
  const pinnedHrs = new Array(numNurses).fill(0);
  const pinnedNights = new Array(numNurses).fill(0);
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      const p = pinned[n][d];
      if (p) {
        pinnedHrs[n] += SHIFT_HOURS[p] || 0;
        if (p === 'N') pinnedNights[n]++;
      }
    }
  }

  // --- Objective ---
  const objTerms = [];
  // Small perturbation for diversity
  const rng = perturbSeed > 0 ? seededRandom(perturbSeed * 137) : null;

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (!isFree(n, d)) continue;
      for (let s = 0; s < SHIFTS.length; s++) {
        const vn = V(n, d, s);
        binVars.push(vn);
        // Add small random perturbation to objective for diversity
        if (rng) {
          const w = (rng() * 0.04 - 0.02);
          if (Math.abs(w) > 0.001) objTerms.push(`${w.toFixed(5)} ${vn}`);
        }
      }
    }
  }

  // Penalize rest to encourage work distribution (very small weight)
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (!isFree(n, d)) continue;
      objTerms.push(`0.001 ${V(n, d, 4)}`); // slight penalty for excess R
    }
  }

  // --- Hour equity via minimax: minimize (hmax - hmin) of total hours ---
  // Identify nurses whose hours the MILP can meaningfully control
  const contVars = [];
  const controllable = [];
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloDiurni || nurseProps[n].soloMattine) continue;
    let hasFree = false;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) { hasFree = true; break; }
    }
    if (hasFree) controllable.push(n);
  }
  const eqConstraints = [];
  if (controllable.length >= 2) {
    contVars.push('hmax', 'hmin');
    objTerms.push(`${HOUR_EQUITY_MILP_WEIGHT} hmax`);
    objTerms.push(`-${HOUR_EQUITY_MILP_WEIGHT} hmin`);

    for (const n of controllable) {
      const hTerms = [];
      for (let d = 0; d < numDays; d++) {
        if (!isFree(n, d)) continue;
        for (let s = 0; s < SHIFTS.length; s++) {
          if (S_HRS[s] > 0) hTerms.push(`${S_HRS[s]} ${V(n, d, s)}`);
        }
      }
      if (hTerms.length === 0) continue;
      // totalHrs_n = pinnedHrs[n] + freeHrs_n <= hmax
      eqConstraints.push(` eqMx${n}: ${hTerms.join(' + ')} - hmax <= ${(-pinnedHrs[n]).toFixed(2)}`);
      // totalHrs_n = pinnedHrs[n] + freeHrs_n >= hmin
      eqConstraints.push(` eqMn${n}: hmin - ${hTerms.join(' - ')} <= ${pinnedHrs[n].toFixed(2)}`);
    }
  }

  // --- Night equity via minimax: minimize (nmax - nmin) of night counts ---
  const nightElig = [];
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].noNotti) continue;
    let hasFreeN = false;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) { hasFreeN = true; break; }
    }
    if (hasFreeN) nightElig.push(n);
  }
  if (nightElig.length >= 2) {
    contVars.push('nmax', 'nmin');
    objTerms.push(`${NIGHT_EQUITY_MILP_WEIGHT} nmax`);
    objTerms.push(`-${NIGHT_EQUITY_MILP_WEIGHT} nmin`);

    for (const n of nightElig) {
      const nTerms = [];
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) nTerms.push(V(n, d, 2)); // N shift index
      }
      if (nTerms.length === 0) continue;
      eqConstraints.push(` neqMx${n}: ${nTerms.join(' + ')} - nmax <= ${(-pinnedNights[n])}`);
      eqConstraints.push(` neqMn${n}: nmin - ${nTerms.join(' - ')} <= ${pinnedNights[n]}`);
    }
  }

  // --- D-shift (diurno) equity via minimax: minimize (dmax - dmin) of D counts ---
  const pinnedDiurni = new Array(numNurses).fill(0);
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d] === 'D') pinnedDiurni[n]++;
    }
  }
  const diurniElig = [];
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].soloNotti || nurseProps[n].noDiurni) continue;
    let hasFreeDay = false;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) { hasFreeDay = true; break; }
    }
    if (hasFreeDay) diurniElig.push(n);
  }
  if (diurniElig.length >= 2) {
    contVars.push('dmax', 'dmin');
    objTerms.push(`${DIURNI_EQUITY_MILP_WEIGHT} dmax`);
    objTerms.push(`-${DIURNI_EQUITY_MILP_WEIGHT} dmin`);

    for (const n of diurniElig) {
      const dTerms = [];
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) dTerms.push(V(n, d, 5)); // D shift index
      }
      if (dTerms.length === 0) continue;
      eqConstraints.push(` deqMx${n}: ${dTerms.join(' + ')} - dmax <= ${(-pinnedDiurni[n])}`);
      eqConstraints.push(` deqMn${n}: dmin - ${dTerms.join(' - ')} <= ${pinnedDiurni[n]}`);
    }
  }

  // --- M/P balance for no_diurni nurses: penalize |M_count - P_count| ---
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].noDiurni) continue;
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].soloNotti || nurseProps[n].diurniENotturni) continue;
    const mTerms = [], pTerms = [];
    let pinnedM = 0, pinnedP = 0;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) {
        mTerms.push(V(n, d, 0));
        pTerms.push(V(n, d, 1));
      } else {
        if (pinned[n][d] === 'M') pinnedM++;
        if (pinned[n][d] === 'P') pinnedP++;
      }
    }
    if (mTerms.length === 0 && pTerms.length === 0) continue;
    // Linearize |M - P| using slack: M - P - mpOver + mpUnder = pinnedP - pinnedM
    const overVar = `mpOv${n}`, underVar = `mpUn${n}`;
    contVars.push(overVar, underVar);
    objTerms.push(`${MP_BALANCE_MILP_WEIGHT} ${overVar}`);
    objTerms.push(`${MP_BALANCE_MILP_WEIGHT} ${underVar}`);
    const posStr = mTerms.length > 0 ? mTerms.join(' + ') : '';
    const negStr = pTerms.length > 0 ? ' - ' + pTerms.join(' - ') : '';
    const rhs = pinnedP - pinnedM;
    eqConstraints.push(` mpBal${n}: ${posStr}${negStr} - ${overVar} + ${underVar} = ${rhs}`);
  }

  lines.push('Minimize');
  if (objTerms.length === 0) objTerms.push('0 ' + binVars[0]);
  // Split long objective across lines
  const objChunks = [];
  for (let i = 0; i < objTerms.length; i += 12) {
    objChunks.push(objTerms.slice(i, i + 12).join(' + '));
  }
  lines.push(' obj: ' + objChunks.join('\n + '));
  lines.push('Subject To');

  // --- Hour equity constraints (hmax/hmin bounds) ---
  for (const c of eqConstraints) lines.push(c);

  // --- Assignment: one shift per nurse per day (free cells only) ---
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (!isFree(n, d)) continue;
      lines.push(` a${n}_${d}: ${SHIFTS.map((_, s) => V(n, d, s)).join(' + ')} = 1`);
    }
  }

  // --- Coverage constraints (D covers both morning and afternoon slots) ---
  for (let d = 0; d < numDays; d++) {
    const mFree = [], pFree = [], nFree = [], dFree = [];
    for (let n = 0; n < numNurses; n++) {
      if (!isFree(n, d)) continue;
      mFree.push(V(n, d, 0));
      pFree.push(V(n, d, 1));
      nFree.push(V(n, d, 2));
      dFree.push(V(n, d, 5));
    }
    // Morning coverage: M + D (D covers morning slot too)
    const mAll = [...mFree, ...dFree];
    if (mAll.length > 0) {
      const needMin = Math.max(0, minCovM - pinnedCovM[d]);
      const needMax = Math.max(0, maxCovM - pinnedCovM[d]);
      if (needMin > 0) lines.push(` cMn${d}: ${mAll.join(' + ')} >= ${needMin}`);
      if (needMax < mAll.length) lines.push(` cMx${d}: ${mAll.join(' + ')} <= ${needMax}`);
    }
    // Afternoon coverage: P + D
    const pAll = [...pFree, ...dFree];
    if (pAll.length > 0) {
      const needMin = Math.max(0, minCovP - pinnedCovP[d]);
      const needMax = Math.max(0, maxCovP - pinnedCovP[d]);
      if (needMin > 0) lines.push(` cPn${d}: ${pAll.join(' + ')} >= ${needMin}`);
      if (needMax < pAll.length) lines.push(` cPx${d}: ${pAll.join(' + ')} <= ${needMax}`);
    }
    // Night coverage
    if (nFree.length > 0) {
      const needMin = Math.max(0, minCovN - pinnedCovN[d]);
      const needMax = Math.max(0, maxCovN - pinnedCovN[d]);
      if (needMin > 0) lines.push(` cNn${d}: ${nFree.join(' + ')} >= ${needMin}`);
      if (needMax < nFree.length) lines.push(` cNx${d}: ${nFree.join(' + ')} <= ${needMax}`);
    }
    // D coverage limits (dedicated D slots)
    if (dFree.length > 0) {
      const dNeedMin = Math.max(0, minCovD - pinnedCovD[d]);
      const dNeedMax = Math.max(0, maxCovD - pinnedCovD[d]);
      if (dNeedMin > 0) lines.push(` cDn${d}: ${dFree.join(' + ')} >= ${dNeedMin}`);
      if (dNeedMax < dFree.length) lines.push(` cDx${d}: ${dFree.join(' + ')} <= ${dNeedMax}`);
    }
  }

  // --- Transition constraints ---
  // Shift indices: M=0, P=1, N=2, S=3, R=4, D=5

  // Pre-compute forbidden transition flags from the transition table
  const isPMForbidden = forbidden.P && forbidden.P.includes('M');
  const isDMForbidden = forbidden.D && forbidden.D.includes('M');
  const isDPForbidden = forbidden.D && forbidden.D.includes('P');
  const isPDForbidden = forbidden.P && forbidden.P.includes('D');
  const isDDForbidden = forbidden.D && forbidden.D.includes('D');

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const free0 = isFree(n, d);
      const free1 = isFree(n, d + 1);
      if (!free0 && !free1) continue;

      if (free0 && free1) {
        // P -> M forbidden
        if (isPMForbidden) lines.push(` pm${n}_${d}: ${V(n,d,1)} + ${V(n,d+1,0)} <= 1`);
        // D -> M forbidden
        if (isDMForbidden) lines.push(` dm${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,0)} <= 1`);
        // D -> P forbidden
        if (isDPForbidden) lines.push(` dp${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,1)} <= 1`);
        // P -> D forbidden (unless consentePomeriggioDiurno relaxed it)
        if (isPDForbidden) lines.push(` pd${n}_${d}: ${V(n,d,1)} + ${V(n,d+1,5)} <= 1`);
        // D -> D forbidden (unless consente2DiurniConsecutivi)
        if (isDDForbidden) lines.push(` dd${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,5)} <= 1`);
        // N must be followed by S
        lines.push(` ns${n}_${d}: ${V(n,d,2)} - ${V(n,d+1,3)} <= 0`);
        // S must be followed by R
        lines.push(` sr${n}_${d}: ${V(n,d,3)} - ${V(n,d+1,4)} <= 0`);
        // No orphan S without preceding N
        lines.push(` sn${n}_${d}: ${V(n,d+1,3)} - ${V(n,d,2)} <= 0`);
        // N cannot follow N, S, R (already handled by N->S->R chain but add safety)
        lines.push(` nn${n}_${d}: ${V(n,d,2)} + ${V(n,d+1,2)} <= 1`);
      } else if (!free0 && free1) {
        // Pinned day d, free day d+1
        const p = pinned[n][d];
        if (p === 'P' && isPMForbidden) lines.push(` tpm${n}_${d}: ${V(n,d+1,0)} <= 0`);
        if (p === 'P' && isPDForbidden) lines.push(` tpd${n}_${d}: ${V(n,d+1,5)} <= 0`);
        if (p === 'D' && isDMForbidden) lines.push(` tdm${n}_${d}: ${V(n,d+1,0)} <= 0`);
        if (p === 'D' && isDPForbidden) lines.push(` tdp${n}_${d}: ${V(n,d+1,1)} <= 0`);
        if (p === 'D' && isDDForbidden) lines.push(` tdd${n}_${d}: ${V(n,d+1,5)} <= 0`);
        if (p === 'N') lines.push(` tns${n}_${d}: ${V(n,d+1,3)} = 1`); // force S after pinned N
        if (p === 'S') lines.push(` tsr${n}_${d}: ${V(n,d+1,4)} = 1`); // force R after pinned S
      } else if (free0 && !free1) {
        // Free day d, pinned day d+1
        const p1 = pinned[n][d + 1];
        // N on free day d must be followed by S — if d+1 is not S, ban N
        if (p1 !== 'S') lines.push(` fn${n}_${d}: ${V(n,d,2)} <= 0`);
        // S on free day d must be followed by R — if d+1 is not R, ban S
        if (p1 !== 'R') lines.push(` fs${n}_${d}: ${V(n,d,3)} <= 0`);
        // D transition: ban D if next day is M or P (D->M, D->P forbidden)
        if (p1 === 'M' && isDMForbidden) lines.push(` fdm${n}_${d}: ${V(n,d,5)} <= 0`);
        if (p1 === 'P' && isDPForbidden) lines.push(` fdp${n}_${d}: ${V(n,d,5)} <= 0`);
        if (p1 === 'D' && isDDForbidden) lines.push(` fdd${n}_${d}: ${V(n,d,5)} <= 0`);
        if (p1 === 'D' && isPDForbidden) lines.push(` fpd${n}_${d}: ${V(n,d,1)} <= 0`);
      }
    }
  }

  // --- D-D rules when consente2D is enabled ---
  if (consente2D) {
    for (let n = 0; n < numNurses; n++) {
      for (let d = 0; d < numDays - 2; d++) {
        const f0 = isFree(n, d), f1 = isFree(n, d+1), f2 = isFree(n, d+2);
        // D-D-D forbidden: at most 2 consecutive D
        if (f0 && f1 && f2) {
          lines.push(` ddd${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,5)} + ${V(n,d+2,5)} <= 2`);
        }
        // D-D must be followed by R
        if (f0 && f1 && f2) {
          lines.push(` ddr${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,5)} - ${V(n,d+2,4)} <= 1`);
        } else if (f0 && f1 && !f2 && pinned[n][d+2] !== 'R') {
          // Pinned d+2 is not R: D-D on d,d+1 forbidden
          lines.push(` ddrp${n}_${d}: ${V(n,d,5)} + ${V(n,d+1,5)} <= 1`);
        }
        // Handle pinned D followed by free slots
        if (!f0 && pinned[n][d] === 'D' && f1 && f2) {
          lines.push(` pddr${n}_${d}: ${V(n,d+1,5)} - ${V(n,d+2,4)} <= 0`);
        }
        if (f0 && !f1 && pinned[n][d+1] === 'D' && f2) {
          lines.push(` dpdr${n}_${d}: ${V(n,d,5)} - ${V(n,d+2,4)} <= 0`);
        }
      }
    }
  }

  // --- Night block: N-S-R-R (second R for non-noDiurni) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noDiurni) continue; // noDiurni nurses only need N-S-R
    for (let d = 0; d < numDays - 3; d++) {
      if (isFree(n, d) && isFree(n, d + 3)) {
        lines.push(` rr${n}_${d}: ${V(n,d,2)} - ${V(n,d+3,4)} <= 0`);
      } else if (isFree(n, d) && !isFree(n, d + 3)) {
        if (pinned[n][d + 3] !== 'R') lines.push(` rrp${n}_${d}: ${V(n,d,2)} <= 0`);
      }
    }
  }

  // --- Max nights per nurse ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noNotti || nurseProps[n].soloMattine || nurseProps[n].soloDiurni) continue;
    const nTerms = [];
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) nTerms.push(V(n, d, 2));
    }
    if (nTerms.length > 0) {
      const limit = Math.max(0, maxNights - pinnedNights[n]);
      lines.push(` maxN${n}: ${nTerms.join(' + ')} <= ${limit}`);
    }
  }

  // --- Nurse-specific: no_notti → ban N shift ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noNotti) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) lines.push(` noN${n}_${d}: ${V(n,d,2)} <= 0`);
      }
    }
  }

  // --- Nurse-specific: solo_diurni → only D or R allowed ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloDiurni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          // Ban M, P, N, S (indices 0, 1, 2, 3)
          lines.push(` sdM${n}_${d}: ${V(n,d,0)} <= 0`);
          lines.push(` sdP${n}_${d}: ${V(n,d,1)} <= 0`);
          lines.push(` sdN${n}_${d}: ${V(n,d,2)} <= 0`);
          lines.push(` sdS${n}_${d}: ${V(n,d,3)} <= 0`);
        }
      }
    }
  }

  // --- Nurse-specific: solo_notti → only N, S, R allowed (ban M, P, D) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloNotti) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          lines.push(` snM${n}_${d}: ${V(n,d,0)} <= 0`);
          lines.push(` snP${n}_${d}: ${V(n,d,1)} <= 0`);
          lines.push(` snD${n}_${d}: ${V(n,d,5)} <= 0`);
        }
      }
    }
  }

  // --- Nurse-specific: no_diurni → ban D shift ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noDiurni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) lines.push(` ndD${n}_${d}: ${V(n,d,5)} <= 0`);
      }
    }
  }

  // --- Nurse-specific: diurni_e_notturni → only D, N, S, R allowed (no M, P) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].diurniENotturni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          // Ban M, P (indices 0, 1)
          lines.push(` denBanM${n}_${d}: ${V(n,d,0)} <= 0`);
          lines.push(` denBanP${n}_${d}: ${V(n,d,1)} <= 0`);
        }
      }
    }
  }

  // --- Nurse-specific: solo_mattine → only M or R (handled by pinning, but safety) ---
  // Already handled by pinned cells

  // --- Per-week rest constraints (proper weekly distribution) ---
  // Enforce minimum rest days per actual week, not just monthly average.
  // This prevents bunching rest in some weeks and having none in others.
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      for (let w = 0; w < weekDaysList.length; w++) {
        const wDays = weekDaysList[w];
        const need = requiredRest(wDays.length, minRPerWeek);
        if (need <= 0) continue;
        let pinnedRest = 0;
        const rTerms = [];
        for (const d of wDays) {
          if (pinned[n][d]) {
            if (pinned[n][d] === 'R') pinnedRest++;
          } else {
            rTerms.push(V(n, d, 4));
          }
        }
        const reqFree = Math.max(0, need - pinnedRest);
        if (reqFree > 0 && rTerms.length > 0) {
          lines.push(` wr${n}_${w}: ${rTerms.join(' + ')} >= ${reqFree}`);
        }
      }
    }
  }

  // --- Nurse pairing ---
  if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
    const [n1, n2] = coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses && n1 !== n2) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n1, d) && isFree(n2, d)) {
          for (let s = 0; s < SHIFTS.length; s++) {
            lines.push(` cp${n1}_${n2}_${d}_${s}: ${V(n1,d,s)} - ${V(n2,d,s)} = 0`);
          }
        }
      }
    }
  }

  // --- Bounds & Binary ---
  lines.push('Bounds');
  for (const cv of contVars) lines.push(` 0 <= ${cv}`);
  lines.push('Binary');
  for (let i = 0; i < binVars.length; i += 20) {
    lines.push(' ' + binVars.slice(i, i + 20).join(' '));
  }
  lines.push('End');

  return lines.join('\n');
}

/**
 * Parse HiGHS solution into schedule array.
 */
function parseSolution(result, ctx) {
  const { numDays, numNurses, pinned } = ctx;
  const SHIFTS = ['M', 'P', 'N', 'S', 'R', 'D'];
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));

  // Fill pinned cells
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) schedule[n][d] = pinned[n][d];
    }
  }

  // Fill from MILP solution
  for (const [name, col] of Object.entries(result.Columns)) {
    if (!name.startsWith('x')) continue;
    if (Math.round(col.Primal) !== 1) continue;
    const parts = name.substring(1).split('_');
    const n = parseInt(parts[0]), d = parseInt(parts[1]), s = parseInt(parts[2]);
    if (n >= 0 && n < numNurses && d >= 0 && d < numDays) {
      schedule[n][d] = SHIFTS[s];
    }
  }

  // Fill any remaining nulls with R
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === null) schedule[n][d] = 'R';
    }
  }

  return schedule;
}

/**
 * Load HiGHS WASM solver. Returns the highs instance or null on failure.
 */
let _highsPromise = null;
function loadHiGHS() {
  if (_highsPromise) return _highsPromise;
  _highsPromise = new Promise((resolve) => {
    try {
      importScripts('https://cdn.jsdelivr.net/npm/highs@1.8.0/build/highs.js');
      const initHiGHS = Module || self.Module;
      if (typeof initHiGHS === 'function') {
        const inst = initHiGHS({
          locateFile: (file) => 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/' + file
        });
        // initHiGHS might return a promise
        if (inst && typeof inst.then === 'function') {
          inst.then(h => resolve(h)).catch(() => resolve(null));
        } else {
          resolve(inst);
        }
      } else {
        resolve(null);
      }
    } catch (e) {
      resolve(null);
    }
  });
  return _highsPromise;
}

/**
 * Solve a single MILP instance with HiGHS.
 */
function solveOneMILP(highs, ctx, perturbSeed, timeLimit) {
  const lp = buildLP(ctx, perturbSeed);
  const opts = {
    time_limit: timeLimit,
    mip_rel_gap: 0.02,
    random_seed: perturbSeed * 137,
    output_flag: false,
    log_to_console: false,
  };
  const result = highs.solve(lp, opts);
  if (result.Status === 'Optimal' || result.Status === 'Time limit reached' || result.Status === 'Target for objective reached') {
    return parseSolution(result, ctx);
  }
  return null;
}

const MILP_MIN_TIME_PER_SOLUTION = 1;
const MILP_MAX_TIME_PER_SOLUTION = 8;
const MILP_DEFAULT_TOTAL_TIME_BUDGET = 30;

// Safety cap to prevent indefinite runs in zero-violations mode (10 minutes)
const UNTIL_ZERO_MAX_TIME = 600;

// ---------------------------------------------------------------------------
// GLPK.js solver loading and LP-to-GLPK conversion
// ---------------------------------------------------------------------------

let _glpkPromise = null;
function loadGLPK() {
  if (_glpkPromise) return _glpkPromise;
  _glpkPromise = new Promise((resolve) => {
    try {
      importScripts('https://cdn.jsdelivr.net/npm/glpk.js/dist/glpk.min.js');
      const initGLPK = self.GLPK || self.glpk;
      if (typeof initGLPK === 'function') {
        const inst = initGLPK();
        if (inst && typeof inst.then === 'function') {
          inst.then(g => resolve(g)).catch(() => resolve(null));
        } else {
          resolve(inst);
        }
      } else {
        resolve(null);
      }
    } catch (_e) {
      resolve(null);
    }
  });
  return _glpkPromise;
}

/**
 * Parse LP-format linear expression into array of {name, coef} terms.
 */
function parseLPTerms(expr) {
  const terms = [];
  const s = expr.replace(/\+\s*-/g, '- ').replace(/-\s*-/g, '+ ').trim();
  const re = /([+-])?\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)?\s*([a-zA-Z_]\w*)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const sign = m[1] === '-' ? -1 : 1;
    const coef = m[2] ? parseFloat(m[2]) : 1;
    terms.push({ name: m[3], coef: sign * coef });
  }
  return terms;
}

/**
 * Convert a CPLEX LP format string (from buildLP) into a GLPK.js JSON model.
 */
function lpToGLPKModel(lpString, glpk) {
  const lines = lpString.split('\n');
  let section = null;
  // GLP constants: GLP_MIN=1, GLP_MAX=2, GLP_LO=2, GLP_UP=3, GLP_FX=5
  const GLP_MIN = glpk.GLP_MIN, GLP_LO = glpk.GLP_LO, GLP_UP = glpk.GLP_UP, GLP_FX = glpk.GLP_FX;
  const objective = { direction: GLP_MIN, name: 'obj', vars: [] };
  const subjectTo = [];
  const modelBounds = [];
  const binaries = [];
  let objExpr = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower === 'minimize' || lower === 'min') { section = 'obj'; continue; }
    if (lower === 'maximize' || lower === 'max') { section = 'obj'; objective.direction = glpk.GLP_MAX; continue; }
    if (lower === 'subject to' || lower === 'st' || lower.startsWith('subject to')) { section = 'st'; continue; }
    if (lower === 'bounds') { section = 'bounds'; continue; }
    if (lower === 'binary' || lower === 'binaries' || lower === 'bin') { section = 'bin'; continue; }
    if (lower === 'end') break;

    switch (section) {
      case 'obj': {
        const part = line.includes(':') ? line.split(':').slice(1).join(':') : line;
        objExpr += ' ' + part;
        break;
      }
      case 'st': {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) continue;
        const cName = line.substring(0, colonIdx).trim();
        const rest = line.substring(colonIdx + 1).trim();
        let op, lhsStr, rhsVal;
        const leIdx = rest.indexOf('<=');
        const geIdx = rest.indexOf('>=');
        if (leIdx >= 0) {
          lhsStr = rest.substring(0, leIdx).trim();
          rhsVal = parseFloat(rest.substring(leIdx + 2).trim());
          op = GLP_UP;
        } else if (geIdx >= 0) {
          lhsStr = rest.substring(0, geIdx).trim();
          rhsVal = parseFloat(rest.substring(geIdx + 2).trim());
          op = GLP_LO;
        } else {
          const eqIdx = rest.indexOf('=');
          if (eqIdx < 0) continue;
          lhsStr = rest.substring(0, eqIdx).trim();
          rhsVal = parseFloat(rest.substring(eqIdx + 1).trim());
          op = GLP_FX;
        }
        if (isNaN(rhsVal)) continue;
        const vars = parseLPTerms(lhsStr);
        if (vars.length === 0) continue;
        const bnds = op === GLP_UP ? { type: op, ub: rhsVal, lb: 0 }
                   : op === GLP_LO ? { type: op, lb: rhsVal, ub: 0 }
                   : { type: op, lb: rhsVal, ub: rhsVal };
        subjectTo.push({ name: cName, vars, bnds });
        break;
      }
      case 'bounds': {
        const bMatch = line.match(/^\s*([\d.]+)\s*<=\s*([a-zA-Z_]\w*)\s*$/);
        if (bMatch) {
          modelBounds.push({ name: bMatch[2], type: GLP_LO, lb: parseFloat(bMatch[1]), ub: 0 });
        }
        break;
      }
      case 'bin':
        line.split(/\s+/).forEach(v => { if (v && /^[a-zA-Z_]/.test(v)) binaries.push(v); });
        break;
    }
  }

  objective.vars = parseLPTerms(objExpr);
  if (objective.vars.length === 0) return null;

  const model = { name: 'nurse_scheduling', objective, subjectTo, binaries };
  if (modelBounds.length > 0) model.bounds = modelBounds;
  return model;
}

/**
 * Solve a single MILP instance with GLPK.js.
 */
async function solveOneGLPK(glpk, ctx, perturbSeed, timeLimit) {
  const lp = buildLP(ctx, perturbSeed);
  const model = lpToGLPKModel(lp, glpk);
  if (!model) return null;

  try {
    let result = glpk.solve(model, {
      msglev: glpk.GLP_MSG_OFF,
      tmlim: Math.ceil(timeLimit),
      mipgap: 0.02,
    });
    // Handle both sync and async solve
    if (result && typeof result.then === 'function') {
      result = await result;
    }
    if (!result || !result.result) return null;
    const status = result.result.status;
    // GLP_OPT = 5, GLP_FEAS = 2
    if (status !== 5 && status !== 2) return null;
    return parseGLPKSolution(result.result.vars, ctx);
  } catch (_e) {
    return null;
  }
}

/**
 * Parse GLPK solution variables into schedule array.
 */
function parseGLPKSolution(vars, ctx) {
  const { numDays, numNurses, pinned } = ctx;
  const SHIFTS = ['M', 'P', 'N', 'S', 'R', 'D'];
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) schedule[n][d] = pinned[n][d];
    }
  }

  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith('x')) continue;
    if (Math.round(value) !== 1) continue;
    const parts = name.substring(1).split('_');
    const n = parseInt(parts[0]), d = parseInt(parts[1]), s = parseInt(parts[2]);
    if (n >= 0 && n < numNurses && d >= 0 && d < numDays && s >= 0 && s < SHIFTS.length) {
      schedule[n][d] = SHIFTS[s];
    }
  }

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === null) schedule[n][d] = 'R';
    }
  }

  return schedule;
}

// ---------------------------------------------------------------------------
// Main solver — async, with configurable algorithm selection
// ---------------------------------------------------------------------------

/**
 * Multi-solution solver with configurable algorithm: HiGHS MILP / GLPK.js / heuristic.
 * @param {object} config
 * @param {number} numSolutions
 * @param {number} timeBudget  – total seconds allocated; 0 or undefined = default 30s
 * @param {boolean} untilZeroViolations – keep generating until a 0-violation solution is found
 * @param {string} solverChoice – 'auto'|'milp'|'glpk'|'fallback'
 */
async function solve(config, numSolutions, timeBudget, untilZeroViolations, solverChoice) {
  solverChoice = solverChoice || 'auto';
  numSolutions = Math.max(1, Math.min(numSolutions || 1, 20));
  const totalBudget = (timeBudget && timeBudget > 0) ? timeBudget : MILP_DEFAULT_TOTAL_TIME_BUDGET;
  const ctx = buildContext(config);
  const solutions = [];

  // Load solvers based on user choice
  let highs = null, glpk = null;
  let milpAvailable = false, glpkAvailable = false;

  if (solverChoice === 'auto' || solverChoice === 'milp') {
    progress(1, 'Caricamento solver HiGHS MILP…');
    try {
      highs = await loadHiGHS();
      milpAvailable = highs && typeof highs.solve === 'function';
    } catch (_e) { milpAvailable = false; }
  }

  if (solverChoice === 'auto' || solverChoice === 'glpk') {
    progress(2, 'Caricamento solver GLPK…');
    try {
      glpk = await loadGLPK();
      glpkAvailable = glpk && typeof glpk.solve === 'function';
    } catch (_e) { glpkAvailable = false; }
  }

  // Determine which solvers to try
  const useHiGHS = milpAvailable && (solverChoice === 'auto' || solverChoice === 'milp');
  const useGLPK = glpkAvailable && (solverChoice === 'auto' || solverChoice === 'glpk');

  /** Generate one batch of solutions */
  async function generateBatch(batchSolutions, batchLabel, seedOffset) {
    const milpTimeLimitSec = Math.max(MILP_MIN_TIME_PER_SOLUTION,
      Math.min(MILP_MAX_TIME_PER_SOLUTION, Math.floor(totalBudget / numSolutions)));
    const perSolutionBudgetSec = Math.max(1, totalBudget / numSolutions);

    for (let i = 0; i < numSolutions; i++) {
      const pctBase = 5 + Math.floor(i * 80 / numSolutions);
      const seed = seedOffset + i;
      let solved = false;

      // Try HiGHS MILP
      if (useHiGHS && !solved) {
        progress(pctBase, `${batchLabel}HiGHS MILP: soluzione ${i + 1}/${numSolutions}…`);
        try {
          const milpStart = Date.now();
          const schedule = solveOneMILP(highs, ctx, seed, milpTimeLimitSec);
          const milpElapsed = (Date.now() - milpStart) / 1000;
          if (schedule) {
            const polishTimeSec = Math.max(1, perSolutionBudgetSec - milpElapsed);
            const polished = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, polishTimeSec);
            const violations = collectViolations(polished, ctx);
            const stats = computeStats(polished, ctx);
            const score = computeScore(polished, ctx);
            batchSolutions.push({ schedule: polished, violations, stats, score: score.total, solverMethod: 'milp' });
            solved = true;
          }
        } catch (_e) { /* fall through */ }
      }

      // Try GLPK
      if (useGLPK && !solved) {
        progress(pctBase, `${batchLabel}GLPK: soluzione ${i + 1}/${numSolutions}…`);
        try {
          const glpkStart = Date.now();
          const schedule = await solveOneGLPK(glpk, ctx, seed, milpTimeLimitSec);
          const glpkElapsed = (Date.now() - glpkStart) / 1000;
          if (schedule) {
            const polishTimeSec = Math.max(1, perSolutionBudgetSec - glpkElapsed);
            const polished = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, polishTimeSec);
            const violations = collectViolations(polished, ctx);
            const stats = computeStats(polished, ctx);
            const score = computeScore(polished, ctx);
            batchSolutions.push({ schedule: polished, violations, stats, score: score.total, solverMethod: 'glpk' });
            solved = true;
          }
        } catch (_e) { /* fall through */ }
      }

      // Greedy + SA fallback
      if (!solved) {
        const label = (useHiGHS || useGLPK) ? 'Fallback euristica' : 'Euristica';
        progress(pctBase, `${batchLabel}${label} ${i + 1}/${numSolutions}…`);
        const schedule = construct(ctx);
        const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, perSolutionBudgetSec);
        const violations = collectViolations(improved, ctx);
        const stats = computeStats(improved, ctx);
        const score = computeScore(improved, ctx);
        batchSolutions.push({ schedule: improved, violations, stats, score: score.total, solverMethod: 'fallback' });
      }
    }
  }

  // Status message
  const availSolvers = [];
  if (useHiGHS) availSolvers.push('HiGHS');
  if (useGLPK) availSolvers.push('GLPK');
  if (availSolvers.length > 0) {
    progress(5, `Solver disponibili: ${availSolvers.join(', ')}. Generazione soluzioni…`);
  } else {
    progress(5, solverChoice === 'fallback'
      ? 'Euristica selezionata manualmente…'
      : 'Nessun solver MILP disponibile, euristica classica…');
  }

  if (untilZeroViolations) {
    const startTime = Date.now();
    let round = 1;
    let foundZero = false;
    while (!foundZero) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed >= UNTIL_ZERO_MAX_TIME) {
        progress(90, `Tempo massimo raggiunto (${Math.round(elapsed)}s). Uso miglior soluzione trovata.`);
        break;
      }
      const prevLen = solutions.length;
      progress(5, `Tentativo #${round} — ricerca soluzione senza violazioni…`);
      await generateBatch(solutions, `[#${round}] `, (round - 1) * numSolutions);
      for (let j = prevLen; j < solutions.length; j++) {
        if (solutions[j].violations.length === 0) { foundZero = true; break; }
      }
      round++;
    }
  } else {
    await generateBatch(solutions, '', 0);
  }

  // Sort by score (best first)
  solutions.sort((a, b) => a.score - b.score);

  progress(95, 'Validazione…');
  progress(100, 'Fatto!');

  return solutions;
}

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

self.onmessage = async function (e) {
  if (e.data.type === 'solve') {
    try {
      const numSolutions = e.data.numSolutions || 1;
      const timeBudget = e.data.timeBudget || 0;
      const untilZeroViolations = !!e.data.untilZeroViolations;
      const solverChoice = e.data.solverChoice || 'auto';
      const solutions = await solve(e.data.config, numSolutions, timeBudget, untilZeroViolations, solverChoice);
      const best = solutions[0] || {};
      self.postMessage({
        type: 'result',
        schedule: best.schedule,
        violations: best.violations || [],
        stats: best.stats || [],
        solutions: solutions,
        solverMethod: best.solverMethod || 'fallback',
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

function progress(percent, message) {
  self.postMessage({ type: 'progress', percent, message });
}

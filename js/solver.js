/**
 * solver.js — Web Worker for nursing shift scheduling
 *
 * Shift codes:
 *   M  Mattina    08:00–14:12  (6.2h)
 *   P  Pomeriggio 14:00–20:12  (6.2h)
 *   D  Diurno     08:00–20:12  (12.2h)
 *   N  Notte      20:00–08:12  (12.2h)
 *   S  Smonto     (post-notte, 0h, non-rest)
 *   R  Riposo     (0h, real rest)
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0 };

// End-of-shift hour (24h, fractional minutes)
const SHIFT_END = { M: 14.2, P: 20.2, D: 20.2, N: 8.2 }; // next day for N
// Start-of-shift hour
const SHIFT_START = { M: 8, P: 14, D: 8, N: 20 };

// Forbidden next-day transitions (from → [forbidden nexts])
const FORBIDDEN_NEXT = {
  P: ['M', 'D'],
  D: ['M', 'P', 'D'],
  N: ['M', 'P', 'D', 'R', 'N'], // after N must be S
  S: ['M', 'P', 'D', 'N'],       // after S must be R (or at least not work)
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

function dayOfWeek(year, month, day) {
  // Returns 0=Sun,1=Mon,...,6=Sat
  return new Date(year, month, day).getDay();
}

function isWeekend(year, month, day) {
  const d = dayOfWeek(year, month, day);
  return d === 0 || d === 6;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// Gap in hours between end of 'prev' and start of 'next'
// Returns null if no constraint applies
function gapHours(prev, next, prevIsLastDay) {
  if (!SHIFT_END[prev] || !SHIFT_START[next]) return Infinity; // S/R → no gap issue
  let end = SHIFT_END[prev];
  let start = SHIFT_START[next];
  if (prev === 'N') {
    // N ends next morning; next shift starts that same next day
    // gap = start - end (both on same "next day" timeline, end=8.2)
    return start - end; // e.g., M(8) - 8.2 = -0.2 → violation
  }
  // Same-day end → next-day start
  return (24 - end) + start;
}

// ---------------------------------------------------------------------------
// Solver entry point
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

// ---------------------------------------------------------------------------
// Main solve function
// ---------------------------------------------------------------------------

function solve(config) {
  const { year, month, nurses, rules } = config;
  const numDays = daysInMonth(year, month);
  const numNurses = nurses.length;

  // schedule[n][d] = shift letter or null
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));

  progress(5, 'Costruzione vincoli...');

  // Pre-compute per-nurse properties
  const nurseProps = nurses.map(n => ({
    soloMattine: n.tags.includes('solo_mattine'),
    noNotti: n.tags.includes('no_notti'),
    noDiurni: n.tags.includes('no_diurni'),
  }));

  // Day-of-week array (0=Sun…6=Sat)
  const dows = [];
  for (let d = 0; d < numDays; d++) {
    dows.push(dayOfWeek(year, month, d + 1));
  }

  // -------------------------------------------------------------------------
  // Phase 1 — "Solo mattine feriali" nurses
  // -------------------------------------------------------------------------
  progress(10, 'Assegnazione turni speciali...');

  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].soloMattine) continue;
    for (let d = 0; d < numDays; d++) {
      const dow = dows[d];
      if (dow === 0 || dow === 6) {
        schedule[n][d] = 'R';
      } else {
        schedule[n][d] = 'M';
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Distribute night shifts (N-S-R blocks)
  // -------------------------------------------------------------------------
  progress(20, 'Distribuzione turni notturni...');

  const nightEligible = [];
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].soloMattine && !nurseProps[n].noNotti) nightEligible.push(n);
  }

  const targetNights = rules.targetNights ?? 4;
  const maxNights = rules.maxNights ?? 7;

  // Count how many nights each nurse gets
  const nightCount = new Array(numNurses).fill(0);

  // Build a list of candidate night-start days (avoiding last 2 days to fit S-R)
  // A night block occupies days: d (N), d+1 (S), d+2 (R)
  const nightStartCandidates = [];
  for (let d = 0; d < numDays - 2; d++) nightStartCandidates.push(d);

  // Shuffle nurses for fairness
  const nightOrder = shuffle([...nightEligible]);

  for (const n of nightOrder) {
    const target = targetNights;
    const candidates = shuffle([...nightStartCandidates]);

    for (const d of candidates) {
      if (nightCount[n] >= target) break;
      // Check the block days are free
      if (schedule[n][d] !== null || schedule[n][d + 1] !== null || schedule[n][d + 2] !== null) continue;
      // Don't put N right after N block's S/R tail of a previous block
      if (d > 0 && (schedule[n][d - 1] === 'S' || schedule[n][d - 1] === 'N')) continue;
      // Don't exceed per-nurse max
      if (nightCount[n] >= maxNights) break;

      schedule[n][d] = 'N';
      schedule[n][d + 1] = 'S';
      schedule[n][d + 2] = 'R';
      nightCount[n]++;
    }
  }

  // Handle last-day N blocks (can't fit full N-S-R)
  // We skip them for simplicity (no night on last 2 days)

  progress(40, 'Assegnazione turni diurni...');

  // -------------------------------------------------------------------------
  // Phase 3 — Assign day shifts (M, P, D) to meet coverage
  // -------------------------------------------------------------------------

  // Coverage targets
  const minCovM = rules.minCoverage ?? 6;
  const maxCovM = rules.maxCoverage ?? 7;
  const minCovP = minCovM;
  const maxCovP = maxCovM;
  const minCovN = Math.max(1, Math.floor(minCovM / 3));
  const maxCovN = Math.max(2, Math.ceil(maxCovM / 2));

  // Helper: count current coverage for day d
  function dayCoverage(d) {
    let M = 0, P = 0, N = 0;
    for (let n = 0; n < numNurses; n++) {
      const s = schedule[n][d];
      if (s === 'M' || s === 'D') M++;
      if (s === 'P' || s === 'D') P++;
      if (s === 'N') N++;
    }
    return { M, P, N };
  }

  // Helper: total hours assigned so far for nurse n
  function nurseHours(n) {
    let h = 0;
    for (let d = 0; d < numDays; d++) {
      const s = schedule[n][d];
      if (s) h += SHIFT_HOURS[s] || 0;
    }
    return h;
  }

  // Helper: is transition from prev to next allowed?
  function transitionOk(prev, next, rules) {
    if (!prev) return true; // first day
    const forbidden = FORBIDDEN_NEXT[prev] || [];
    if (forbidden.includes(next)) return false;
    if (rules.minGap11h && SHIFT_END[prev] !== undefined && SHIFT_START[next] !== undefined) {
      const gap = gapHours(prev, next);
      if (gap < 11) return false;
    }
    return true;
  }

  // Helper: is nurse eligible for shift s on day d?
  function nurseEligible(n, d, s) {
    if (schedule[n][d] !== null) return false; // already assigned
    if (nurseProps[n].soloMattine) return false;
    if (s === 'N' && nurseProps[n].noNotti) return false;
    if (s === 'D' && nurseProps[n].noDiurni) return false;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    if (!transitionOk(prev, s, rules)) return false;
    // Also check if assigning N here allows S the next day
    if (s === 'N') {
      if (d + 2 >= numDays) return false; // no room for S-R
      if (schedule[n][d + 1] !== null || schedule[n][d + 2] !== null) return false;
    }
    return true;
  }

  // For each day, greedily assign M, P, D
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(d);

    // Build sorted list of nurses by current hours (least hours first = equity)
    const nursesByHours = Array.from({ length: numNurses }, (_, i) => i)
      .filter(n => schedule[n][d] === null)
      .sort((a, b) => nurseHours(a) - nurseHours(b));

    // Try to meet M coverage
    for (const n of nursesByHours) {
      if (cov.M >= maxCovM) break;
      if (!nurseEligible(n, d, 'M')) continue;
      // Prefer D on certain days to stretch coverage? No — assign M first.
      schedule[n][d] = 'M';
      cov.M++;
    }

    // Re-sort after M assignments
    const nursesByHours2 = Array.from({ length: numNurses }, (_, i) => i)
      .filter(n => schedule[n][d] === null)
      .sort((a, b) => nurseHours(a) - nurseHours(b));

    // Try to meet P coverage
    for (const n of nursesByHours2) {
      if (cov.P >= maxCovP) break;
      if (!nurseEligible(n, d, 'P')) continue;
      schedule[n][d] = 'P';
      cov.P++;
    }

    // If still short on M, try promoting some nurses to D (covers both M+P slots)
    if (cov.M < minCovM || cov.P < minCovP) {
      const candidates = Array.from({ length: numNurses }, (_, i) => i)
        .filter(n => schedule[n][d] === null && !nurseProps[n].noDiurni && !nurseProps[n].soloMattine)
        .sort((a, b) => nurseHours(a) - nurseHours(b));

      for (const n of candidates) {
        if (cov.M >= maxCovM && cov.P >= maxCovP) break;
        if (!nurseEligible(n, d, 'D')) continue;
        schedule[n][d] = 'D';
        cov.M++;
        cov.P++;
      }
    }

    if (d % 5 === 0) {
      progress(40 + Math.floor((d / numDays) * 35), 'Ricerca soluzione...');
    }
  }

  progress(75, 'Ottimizzazione equità...');

  // -------------------------------------------------------------------------
  // Phase 4 — Fill remaining with R
  // -------------------------------------------------------------------------
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === null) {
        // Check if we should assign S (after N), but that's handled in Phase 2
        schedule[n][d] = 'R';
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5 — Equity pass: try to balance hours
  // -------------------------------------------------------------------------
  // Simple swap pass: if nurse A has much more hours than nurse B,
  // and both have an R on the same day, swap one R→M (or R→P)
  const maxPasses = 3;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;

    // Compute hours
    const hours = Array.from({ length: numNurses }, (_, n) => nurseHours(n));
    const avgHours = hours.reduce((s, h) => s + h, 0) / numNurses;

    for (let n = 0; n < numNurses; n++) {
      if (nurseProps[n].soloMattine) continue;
      if (hours[n] > avgHours + 8) {
        // Nurse has too many hours — convert some M/P to R if possible without violating coverage
        for (let d = 0; d < numDays; d++) {
          const s = schedule[n][d];
          if (s !== 'M' && s !== 'P') continue;
          const cov = dayCoverage(d);
          const slotMin = s === 'M' ? minCovM : minCovP;
          const slotCurrent = s === 'M' ? cov.M : cov.P;
          if (slotCurrent > slotMin) {
            // Check transition
            const prev = d > 0 ? schedule[n][d - 1] : null;
            const next = d < numDays - 1 ? schedule[n][d + 1] : null;
            if (transitionOk(prev, 'R', rules) && transitionOk('R', next, rules)) {
              schedule[n][d] = 'R';
              hours[n] -= SHIFT_HOURS[s];
              changed = true;
              if (hours[n] <= avgHours + 4) break;
            }
          }
        }
      } else if (hours[n] < avgHours - 8) {
        // Nurse has too few hours — try adding M shifts on R days
        for (let d = 0; d < numDays; d++) {
          if (schedule[n][d] !== 'R') continue;
          const cov = dayCoverage(d);
          if (cov.M >= maxCovM) continue;
          if (!nurseEligible(n, d, 'M')) continue;
          schedule[n][d] = 'M';
          hours[n] += SHIFT_HOURS['M'];
          changed = true;
          if (hours[n] >= avgHours - 4) break;
        }
      }
    }

    if (!changed) break;
  }

  progress(90, 'Validazione...');

  // -------------------------------------------------------------------------
  // Phase 6 — Validate and collect violations
  // -------------------------------------------------------------------------
  const violations = [];

  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(d);
    if (cov.M < minCovM) violations.push({ day: d, type: 'coverage_M', msg: `Giorno ${d + 1}: copertura mattina insufficiente (${cov.M}/${minCovM})` });
    if (cov.P < minCovP) violations.push({ day: d, type: 'coverage_P', msg: `Giorno ${d + 1}: copertura pomeriggio insufficiente (${cov.P}/${minCovP})` });
  }

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d];
      const nxt = schedule[n][d + 1];
      const forbidden = FORBIDDEN_NEXT[cur] || [];
      if (forbidden.includes(nxt)) {
        violations.push({ nurse: n, day: d, type: 'transition', msg: `Infermiere ${n + 1}, giorno ${d + 1}-${d + 2}: transizione vietata ${cur}→${nxt}` });
      }
    }
    // Check N must be followed by S
    for (let d = 0; d < numDays - 1; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d + 1] !== 'S') {
        violations.push({ nurse: n, day: d, type: 'N_no_S', msg: `Infermiere ${n + 1}, giorno ${d + 1}: N non seguito da S` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Compute stats
  // -------------------------------------------------------------------------
  const stats = nurses.map((_, n) => {
    let totalHours = 0, nights = 0, weekends = 0;
    for (let d = 0; d < numDays; d++) {
      const s = schedule[n][d];
      totalHours += SHIFT_HOURS[s] || 0;
      if (s === 'N') nights++;
      if (isWeekend(year, month, d + 1) && s && s !== 'R') weekends++;
    }
    return { totalHours: Math.round(totalHours * 10) / 10, nights, weekends };
  });

  progress(100, 'Fatto!');

  return { schedule, violations, stats };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function progress(percent, message) {
  self.postMessage({ type: 'progress', percent, message });
}

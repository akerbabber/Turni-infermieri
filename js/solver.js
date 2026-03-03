/**
 * solver.js — Web Worker for nursing shift scheduling
 *
 * Shift codes:
 *   M     Mattina    08:00–14:12  (6.2h)
 *   P     Pomeriggio 14:00–20:12  (6.2h)
 *   D     Diurno     08:00–20:12  (12.2h)
 *   N     Notte      20:00–08:12  (12.2h)
 *   S     Smonto     (post-notte, 0h, non-rest)
 *   R     Riposo     (0h, real rest)
 *   F     Ferie      (7.12h)
 *   MA    Malattia   (7.12h)
 *   L104  104        (7.12h)
 *   PR    Permesso Retribuito (7.12h)
 *   MT    Maternità  (7.12h)
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 7.12, MA: 7.12, L104: 7.12, PR: 7.12, MT: 7.12 };

// Absence type mapping
const ABSENCE_TAG_TO_SHIFT = {
  'ferie': 'F',
  'malattia': 'MA',
  '104': 'L104',
  'permesso_retribuito': 'PR',
  'maternita': 'MT'
};

// End-of-shift hour (24h, fractional minutes)
const SHIFT_END = { M: 14.2, P: 20.2, D: 20.2, N: 8.2 }; // next day for N
// Start-of-shift hour
const SHIFT_START = { M: 8, P: 14, D: 8, N: 20 };

// Forbidden next-day transitions (from → [forbidden nexts])
// Note: After N must come S (smonto), then 2x R (riposo) - N→S→R→R pattern
// S (smonto) is NOT a rest day - it's recovery after night
// After S must come R (first rest day)
// After R that follows S, must come another R (second rest day)
// After R, any shift is allowed including N (allows patterns like D→R→N)
const FORBIDDEN_NEXT = {
  P: ['M', 'D'],
  D: ['M', 'P', 'D'],
  N: ['M', 'P', 'D', 'R', 'N'], // after N must be S
  S: ['M', 'P', 'D', 'N', 'S'], // after S must be R (first rest day)
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
  
  // Pre-calculate week-related constants (used throughout the solver)
  const firstDow = dayOfWeek(year, month, 1); // 0=Sun, 1=Mon, ...
  const adjustedFirstDow = firstDow === 0 ? 6 : firstDow - 1; // Adjust so Monday = 0
  
  // Helper: get week index for a day (0-indexed day in month)
  function getWeekIndex(d) {
    return Math.floor((d + adjustedFirstDow) / 7);
  }
  
  // Helper: calculate required rest days for a week based on its length
  function calculateRequiredRest(weekDaysCount, minRPerWeek) {
    if (weekDaysCount >= 7) return minRPerWeek;
    if (weekDaysCount <= 2) return 0;
    return Math.max(1, Math.ceil(weekDaysCount * minRPerWeek / 7));
  }
  
  // Calculate number of weeks in the month
  const numWeeks = getWeekIndex(numDays - 1) + 1;

  // Helper to check if a date (day of month, 1-based) falls within an absence period
  function isDateInAbsencePeriod(day1Based, absencePeriod) {
    if (!absencePeriod || !absencePeriod.start || !absencePeriod.end) return false;
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day1Based).padStart(2, '0')}`;
    return dateStr >= absencePeriod.start && dateStr <= absencePeriod.end;
  }

  // Helper to get the absence shift code for a specific day
  function getAbsenceShiftForDay(nurse, day1Based) {
    if (!nurse.absencePeriods) return null;
    
    // Check each absence type with period
    for (const [tagKey, shiftCode] of Object.entries(ABSENCE_TAG_TO_SHIFT)) {
      if (nurse.tags.includes(tagKey)) {
        const period = nurse.absencePeriods[tagKey];
        if (period && period.start && period.end) {
          // If period is defined, check if day falls within
          if (isDateInAbsencePeriod(day1Based, period)) {
            return shiftCode;
          }
        } else {
          // If no period defined but tag is active, apply for whole month
          return shiftCode;
        }
      }
    }
    return null;
  }

  // Pre-compute per-nurse properties
  const nurseProps = nurses.map(n => ({
    soloMattine: n.tags.includes('solo_mattine'),
    noNotti: n.tags.includes('no_notti'),
    noDiurni: n.tags.includes('no_diurni'),
    hasAnyAbsence: n.tags.includes('ferie') || n.tags.includes('malattia') || 
             n.tags.includes('104') || n.tags.includes('permesso_retribuito') || 
             n.tags.includes('maternita'),
    absencePeriods: n.absencePeriods || {},
  }));

  // Day-of-week array (0=Sun…6=Sat)
  const dows = [];
  for (let d = 0; d < numDays; d++) {
    dows.push(dayOfWeek(year, month, d + 1));
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Handle absence periods and "Solo mattine feriali" nurses
  // -------------------------------------------------------------------------
  progress(10, 'Assegnazione turni speciali e assenze...');

  for (let n = 0; n < numNurses; n++) {
    const nurse = nurses[n];
    
    // First, assign absence shifts for days within absence periods
    for (let d = 0; d < numDays; d++) {
      const absenceShift = getAbsenceShiftForDay(nurse, d + 1);
      if (absenceShift) {
        schedule[n][d] = absenceShift;
      }
    }
    
    // Then handle "solo mattine feriali" for non-absence days
    if (nurseProps[n].soloMattine) {
      for (let d = 0; d < numDays; d++) {
        if (schedule[n][d] !== null) continue; // Skip if already assigned (absence)
        const dow = dows[d];
        if (dow === 0 || dow === 6) {
          schedule[n][d] = 'R';
        } else {
          schedule[n][d] = 'M';
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Distribute night shifts (N-S-R-R blocks)
  // The pattern is N-S-R-R where:
  //   N = Notte (night shift)
  //   S = Smonto (recovery day after night - NOT a rest day)
  //   R = Riposo (first rest day)
  //   R = Riposo (second rest day)
  // This ensures 2 REAL rest days after each night shift (S is NOT counted as rest)
  // -------------------------------------------------------------------------
  progress(20, 'Distribuzione turni notturni...');

  // Nurses eligible for nights (those without global restrictions)
  const nightEligible = [];
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].soloMattine && !nurseProps[n].noNotti) nightEligible.push(n);
  }

  const targetNights = rules.targetNights ?? 4;
  const maxNights = rules.maxNights ?? 7;
  const minCovN = rules.minCoverageN ?? 2;

  // Count how many nights each nurse gets
  const nightCount = new Array(numNurses).fill(0);
  
  // Helper: check if nurse can do night on day d
  function canDoNight(n, d) {
    if (schedule[n][d] !== null) return false;
    if (nightCount[n] >= maxNights) return false;
    
    // Check if S day (d+1) is free (if within month)
    if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
    
    // Check if first R day (d+2) is free (if within month)
    if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
    
    // Check if second R day (d+3) is free (if within month)
    if (d + 3 < numDays && schedule[n][d + 3] !== null) return false;
    
    // Don't put N right after S
    if (d > 0 && schedule[n][d - 1] === 'S') return false;
    
    // Don't put N right after first R (only 1 R after S)
    if (d > 1 && schedule[n][d - 1] === 'R' && schedule[n][d - 2] === 'S') return false;
    
    // Check we're not breaking an N-S-R-R pattern (need 2 R's after S before new N)
    if (d > 2 && schedule[n][d - 2] === 'R' && schedule[n][d - 3] === 'S') {
      // Only 1 R after S-R, need another R
      return false;
    }
    
    return true;
  }
  
  // Helper: assign night block to nurse n on day d
  function assignNightBlock(n, d) {
    schedule[n][d] = 'N';
    if (d + 1 < numDays) schedule[n][d + 1] = 'S';
    if (d + 2 < numDays) schedule[n][d + 2] = 'R';
    if (d + 3 < numDays) schedule[n][d + 3] = 'R';
    nightCount[n]++;
  }
  
  // Track how many N-S-R-R blocks start on each day (to avoid clustering)
  const nightStartsPerDay = new Array(numDays).fill(0);

  // STEP 1: Ensure minimum coverage on ALL days first (coverage-first approach)
  // Process days in an order that spreads out night blocks
  const dayOrder = [];
  for (let d = 0; d < numDays; d++) dayOrder.push(d);
  // Prioritize days with fewer existing night starts nearby
  dayOrder.sort((a, b) => {
    const nearbyA = (nightStartsPerDay[a] || 0) + (nightStartsPerDay[Math.max(0, a-1)] || 0) + (nightStartsPerDay[Math.min(numDays-1, a+1)] || 0);
    const nearbyB = (nightStartsPerDay[b] || 0) + (nightStartsPerDay[Math.max(0, b-1)] || 0) + (nightStartsPerDay[Math.min(numDays-1, b+1)] || 0);
    return nearbyA - nearbyB;
  });
  
  for (const d of dayOrder) {
    // Count current night coverage for this day
    let nightCov = 0;
    for (let n = 0; n < numNurses; n++) {
      if (schedule[n][d] === 'N') nightCov++;
    }
    
    // Assign nights until we reach minimum coverage
    while (nightCov < minCovN) {
      // Find eligible nurses sorted by night count (prefer nurses with fewer nights for fairness)
      const candidates = [...nightEligible]
        .filter(n => canDoNight(n, d))
        .sort((a, b) => nightCount[a] - nightCount[b]);
      
      if (candidates.length === 0) break; // No more eligible nurses
      
      // Assign to nurse with fewest nights
      assignNightBlock(candidates[0], d);
      nightStartsPerDay[d]++;
      nightCov++;
    }
  }

  // STEP 2: Distribute remaining nights fairly to reach target
  // But try to spread them out to avoid R-day clustering
  const nightOrder = shuffle([...nightEligible]);
  
  for (const n of nightOrder) {
    if (nightCount[n] >= targetNights) continue;
    
    // Find available days for this nurse
    const availableDays = [];
    for (let d = 0; d < numDays; d++) {
      if (canDoNight(n, d)) availableDays.push(d);
    }
    
    // Shuffle first for variety, then sort by preference
    shuffle(availableDays);
    
    // Sort by preference: days where fewer N blocks start (to spread R days)
    // Use stable sort by only sorting when values differ
    availableDays.sort((a, b) => {
      const startsA = nightStartsPerDay[a] || 0;
      const startsB = nightStartsPerDay[b] || 0;
      return startsA - startsB;
    });
    
    for (const d of availableDays) {
      if (nightCount[n] >= targetNights) break;
      if (!canDoNight(n, d)) continue; // Re-check in case state changed
      
      assignNightBlock(n, d);
      nightStartsPerDay[d]++;
    }
  }

  progress(40, 'Assegnazione turni diurni...');

  // -------------------------------------------------------------------------
  // Phase 3 — Assign day shifts (M, P, D) to meet coverage
  // -------------------------------------------------------------------------

  // Coverage targets
  const minCovM = rules.minCoverageM ?? 6;
  const maxCovM = rules.maxCoverageM ?? 7;
  const minCovP = rules.minCoverageP ?? 6;
  const maxCovP = rules.maxCoverageP ?? 7;
  const minCovD = rules.minCoverageD ?? 0;
  const maxCovD = rules.maxCoverageD ?? 4;
  // minCovN already declared in Phase 2
  const maxCovN = rules.maxCoverageN ?? 4;
  const preferDiurni = rules.preferDiurni ?? false;

  // Helper: count current coverage for day d
  // Note: D (Diurno) shifts count towards both M (Mattina) and P (Pomeriggio) coverage
  // because a Diurno shift covers the full day (08:00-20:12), spanning both time slots
  function dayCoverage(d) {
    let M = 0, P = 0, D = 0, N = 0;
    for (let n = 0; n < numNurses; n++) {
      const s = schedule[n][d];
      if (s === 'M') M++;
      if (s === 'P') P++;
      if (s === 'D') { D++; M++; P++; } // D covers both M and P slots
      if (s === 'N') N++;
    }
    return { M, P, D, N };
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
    if (schedule[n][d] !== null) return false; // already assigned (including absence shifts)
    if (nurseProps[n].soloMattine) return false;
    if (s === 'N' && nurseProps[n].noNotti) return false;
    if (s === 'D' && nurseProps[n].noDiurni) return false;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    if (!transitionOk(prev, s, rules)) return false;
    // For night shifts, check if we have room for the S-R-R sequence
    // N-S-R-R pattern requires checking d+1 (S), d+2 (R), d+3 (R)
    if (s === 'N') {
      // Check if d+1 is available for S (if within month)
      if (d + 1 < numDays && schedule[n][d + 1] !== null) return false;
      // Check if d+2 is available for first R (if within month)  
      if (d + 2 < numDays && schedule[n][d + 2] !== null) return false;
      // Check if d+3 is available for second R (if within month)
      if (d + 3 < numDays && schedule[n][d + 3] !== null) return false;
    }
    return true;
  }

  // For each day, greedily assign M, P, D
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(d);

    // Build sorted list of nurses by current hours (least hours first = equity)
    // Helper function to get available nurses sorted by hours
    // Only include nurses without absence/assignment on this day
    const getAvailableNurses = () => Array.from({ length: numNurses }, (_, i) => i)
      .filter(n => schedule[n][d] === null)
      .sort((a, b) => nurseHours(a) - nurseHours(b));

    let availableNurses = getAvailableNurses();

    // If preferDiurni mode, try D shifts first
    if (preferDiurni) {
      const dCandidates = availableNurses.filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine);
      for (const n of dCandidates) {
        if (cov.D >= maxCovD) break;
        if (cov.M >= maxCovM && cov.P >= maxCovP) break;
        if (!nurseEligible(n, d, 'D')) continue;
        schedule[n][d] = 'D';
        cov.D++;
        cov.M++;
        cov.P++;
      }
    }

    // Try to meet M coverage (refresh available nurses list after D assignments)
    availableNurses = getAvailableNurses();
    
    for (const n of availableNurses) {
      if (cov.M >= maxCovM) break;
      if (!nurseEligible(n, d, 'M')) continue;
      schedule[n][d] = 'M';
      cov.M++;
    }

    // Try to meet P coverage (refresh available nurses list after M assignments)
    availableNurses = getAvailableNurses();

    for (const n of availableNurses) {
      if (cov.P >= maxCovP) break;
      if (!nurseEligible(n, d, 'P')) continue;
      schedule[n][d] = 'P';
      cov.P++;
    }

    // If still short on M or P, try promoting some nurses to D (covers both M+P slots)
    if (cov.M < minCovM || cov.P < minCovP) {
      const candidates = getAvailableNurses()
        .filter(n => !nurseProps[n].noDiurni && !nurseProps[n].soloMattine);

      for (const n of candidates) {
        if (cov.M >= maxCovM && cov.P >= maxCovP) break;
        if (!nurseEligible(n, d, 'D')) continue;
        schedule[n][d] = 'D';
        cov.D++;
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
  // Phase 4.5 — Ensure minimum 2 rest days (R) per week for ALL nurses
  // For nurses with no_notti tag, they don't get S (smonto) days, so they need explicit R days
  // For nurses who do nights, the N-S-R-R pattern already provides rest days
  // For partial weeks at month boundaries, adjust requirement proportionally
  // -------------------------------------------------------------------------
  progress(78, 'Verifica riposi settimanali...');
  
  const minRPerWeek = rules.minRPerWeek ?? 2;
  
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      // For each week, count R days (real rest, not S which is smonto)
      for (let week = 0; week < numWeeks; week++) {
        let restCount = 0;
        const weekDays = [];
        
        for (let d = 0; d < numDays; d++) {
          if (getWeekIndex(d) === week) {
            weekDays.push(d);
            if (schedule[n][d] === 'R') restCount++;
          }
        }
        
        // Use shared helper for proportional rest calculation
        const requiredRest = calculateRequiredRest(weekDays.length, minRPerWeek);
        
        // If not enough rest days, try to convert some work days to R
        while (restCount < requiredRest && weekDays.length > 0) {
          let converted = false;
          
          // Try to convert M or P shifts to R (prefer days with excess coverage)
          for (const d of weekDays) {
            const s = schedule[n][d];
            if (s !== 'M' && s !== 'P') continue;
            
            const cov = dayCoverage(d);
            const slotMin = s === 'M' ? minCovM : minCovP;
            const slotCurrent = s === 'M' ? cov.M : cov.P;
            
            // Only convert if coverage remains above minimum
            if (slotCurrent > slotMin) {
              // Check transitions are valid
              const prev = d > 0 ? schedule[n][d - 1] : null;
              const next = d < numDays - 1 ? schedule[n][d + 1] : null;
              if (transitionOk(prev, 'R', rules) && transitionOk('R', next, rules)) {
                schedule[n][d] = 'R';
                restCount++;
                converted = true;
                break;
              }
            }
          }
          
          if (!converted) break; // No more conversions possible
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5 — Equity pass: try to balance hours
  // -------------------------------------------------------------------------
  // Simple swap pass: if nurse A has much more hours than nurse B,
  // and both have an R on the same day, swap one R→M (or R→P)
  // Now also respects minimum rest days per week
  
  // Helper to count R days in a week for a nurse (uses shared getWeekIndex)
  function countWeekRestDays(n, weekIdx) {
    let count = 0;
    for (let d = 0; d < numDays; d++) {
      if (getWeekIndex(d) === weekIdx && schedule[n][d] === 'R') {
        count++;
      }
    }
    return count;
  }
  
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
        // But respect minimum rest days per week
        for (let d = 0; d < numDays; d++) {
          if (schedule[n][d] !== 'R') continue;
          
          // Check if we can remove this R without going below minimum rest days per week
          const weekIdx = getWeekIndex(d);
          const weekRestCount = countWeekRestDays(n, weekIdx);
          if (minRPerWeek > 0 && weekRestCount <= minRPerWeek) continue; // Can't remove this R
          
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
    if (cov.N < minCovN) violations.push({ day: d, type: 'coverage_N', msg: `Giorno ${d + 1}: copertura notte insufficiente (${cov.N}/${minCovN})` });
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
    // Check N must be followed by S (except on last day of month)
    for (let d = 0; d < numDays - 1; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d + 1] !== 'S') {
        violations.push({ nurse: n, day: d, type: 'N_no_S', msg: `Infermiere ${n + 1}, giorno ${d + 1}: N non seguito da S` });
      }
    }
    // Check S must be followed by R (first rest day after smonto)
    for (let d = 0; d < numDays - 1; d++) {
      if (schedule[n][d] === 'S' && schedule[n][d + 1] !== 'R') {
        violations.push({ nurse: n, day: d, type: 'S_no_R', msg: `Infermiere ${n + 1}, giorno ${d + 1}: S non seguito da R (primo riposo dopo smonto)` });
      }
    }
    // Check that after N-S-R there must be another R (2 rest days after night, smonto doesn't count)
    for (let d = 0; d < numDays - 3; d++) {
      if (schedule[n][d] === 'N' && schedule[n][d + 1] === 'S' && schedule[n][d + 2] === 'R') {
        if (schedule[n][d + 3] !== 'R') {
          violations.push({ nurse: n, day: d, type: 'need_2R_after_night', msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo N-S-R serve un altro R (2 riposi dopo notte, S non conta)` });
        }
      }
    }
  }
  
  // Validate minimum rest days per week (with proportional adjustment for partial weeks)
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      for (let week = 0; week < numWeeks; week++) {
        let restCount = 0;
        let weekDaysCount = 0;
        for (let d = 0; d < numDays; d++) {
          if (getWeekIndex(d) === week) {
            weekDaysCount++;
            if (schedule[n][d] === 'R') restCount++;
          }
        }
        
        // Use shared helper for proportional rest calculation
        const requiredRest = calculateRequiredRest(weekDaysCount, minRPerWeek);
        
        if (restCount < requiredRest) {
          violations.push({ nurse: n, week, type: 'min_R_week', msg: `Infermiere ${n + 1}, settimana ${week + 1}: solo ${restCount} riposi (minimo ${requiredRest})` });
        }
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

/**
 * @file construct.js — Greedy construction heuristic
 * @description Builds an initial feasible schedule via multi-phase greedy assignment.
 *
 * Phases:
 *   1. Pin absences & solo_mattine
 *   2. Night blocks (N-S-R-R) with smart spreading
 *   3. Day shifts (M, P, D) with coverage balancing
 *   4. Fill remaining with R
 *   4.5. Weekly rest enforcement
 *   4.6. M/P balance for no_diurni nurses
 *   4.7. Nurse pairing
 *   4.8. D-D rest enforcement
 */

'use strict';

// ---------------------------------------------------------------------------
// Construction heuristic (one attempt)
// ---------------------------------------------------------------------------

function construct(ctx) {
  const {
    numDays,
    numNurses,
    nurses,
    rules,
    nurseProps,
    pinned,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovD,
    maxCovD,
    minCovN,
    maxCovN,
    targetNights,
    maxNights,
    preferDiurni,
    coppiaTurni,
    consente2D,
    minRPerWeek,
    weekDaysList,
  } = ctx;

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
    if (
      !nurseProps[n].soloMattine &&
      !nurseProps[n].soloDiurni &&
      !nurseProps[n].noNotti &&
      !nurseProps[n].diurniNoNotti &&
      !nurseProps[n].mattineEPomeriggi
    )
      nightEligible.push(n);
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

  const desiredNightLoads = new Array(numDays).fill(minCovN);
  const minTotalNightStarts = minCovN * numDays;
  const maxTotalNightStarts = maxCovN * numDays;
  const targetTotalNightStarts = Math.max(
    minTotalNightStarts,
    Math.min(maxTotalNightStarts, targetNights * nightEligible.length)
  );
  const extraNightStarts = Math.max(0, targetTotalNightStarts - minTotalNightStarts);
  const maxNightLoadBumps = Math.max(1, numDays * Math.max(1, maxCovN - minCovN));
  for (let i = 0; i < extraNightStarts; i++) {
    let d = Math.floor((i * numDays) / extraNightStarts);
    let guard = maxNightLoadBumps;
    while (desiredNightLoads[d] >= maxCovN && guard-- > 0) d = (d + 1) % numDays;
    if (guard <= 0) break;
    desiredNightLoads[d]++;
  }

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
          const aMatch = d % aCycle === nurseStartOffset.get(a) ? 0 : 1;
          const bMatch = d % bCycle === nurseStartOffset.get(b) ? 0 : 1;
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
        if (pinned[n][d + i]) {
          canClear = false;
          break;
        }
        if (slot !== null && slot !== 'R') {
          canClear = false;
          break;
        }
        // If it's R, check it's not mandatory post-night rest
        if (slot === 'R' && d + i > 0) {
          const prevSlot = schedule[n][d + i - 1];
          if (prevSlot === 'S') {
            canClear = false;
            break;
          }
          if (prevSlot === 'R' && d + i > 1 && schedule[n][d + i - 2] === 'S') {
            canClear = false;
            break;
          }
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
    const days = shuffle(
      Array.from({ length: numDays }, (_, i) => i).filter(d => canNight(n, d) && nightStarts[d] < desiredNightLoads[d])
    );
    days.sort((a, b) => {
      const aGap = desiredNightLoads[a] - (nightStarts[a] || 0);
      const bGap = desiredNightLoads[b] - (nightStarts[b] || 0);
      if (aGap !== bGap) return bGap - aGap;
      return (nightStarts[a] || 0) - (nightStarts[b] || 0);
    });
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
      if (schedule[n][d] === 'N') {
        cov++;
        nightNurses.push(n);
      }
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
    if (s === 'N' && (nurseProps[n].noNotti || nurseProps[n].diurniNoNotti || nurseProps[n].mattineEPomeriggi))
      return false;
    if (s === 'D' && (nurseProps[n].noDiurni || nurseProps[n].mattineEPomeriggi)) return false;
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
      const nurses = shuffle(Array.from({ length: numNurses }, (_, i) => i).filter(n => schedule[n][d] === null));
      // Primary sort: prefer nurses who still have weekly-rest budget for this day's week
      // Secondary sort: fewest adjusted hours first (equity + previous month compensation)
      const hd = ctx.hourDeltas;
      nurses.sort((a, b) => {
        const aOk = hasWeekBudget(a, d) ? 0 : 1;
        const bOk = hasWeekBudget(b, d) ? 0 : 1;
        if (aOk !== bOk) return aOk - bOk;
        const aH = nurseHours(schedule, a, numDays) - (hd ? hd[a] || 0 : 0);
        const bH = nurseHours(schedule, b, numDays) - (hd ? hd[b] || 0 : 0);
        return aH - bH;
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
      let haveRest = 0,
        freeSlots = 0;
      for (const wd of wDays) {
        if (schedule[n][wd] === 'R') haveRest++;
        else if (schedule[n][wd] === null && wd !== day) freeSlots++;
      }
      return haveRest + freeSlots >= need;
    }

    if (preferDiurni) {
      for (const n of avail().filter(
        n =>
          !nurseProps[n].noDiurni &&
          !nurseProps[n].mattineEPomeriggi &&
          !nurseProps[n].soloMattine &&
          !nurseProps[n].soloNotti
      )) {
        if (cov.D >= maxCovD || cov.M >= maxCovM || cov.P >= maxCovP) break;
        if (!eligible(n, d, 'D')) continue;
        schedule[n][d] = 'D';
        cov.D++;
        cov.M++;
        cov.P++;
      }
    }

    // Alternate M/P assignment: assign one at a time to the most-needed slot
    // Pre-compute M/P counts per nurse for balance sorting
    const mpCount = new Array(numNurses);
    for (let n = 0; n < numNurses; n++) {
      let mc = 0,
        pc = 0;
      for (let dd = 0; dd < numDays; dd++) {
        if (schedule[n][dd] === 'M') mc++;
        else if (schedule[n][dd] === 'P') pc++;
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
        const belowMin = s === 'M' ? cov.M < minCovM : cov.P < minCovP;
        const candidates = avail().filter(n => eligible(n, d, s) && (belowMin || hasWeekBudget(n, d)));
        // Sort candidates: prefer nurses who need this shift type for personal M/P balance
        candidates.sort((a, b) => {
          const aBal = s === 'M' ? mpCount[a].m - mpCount[a].p : mpCount[a].p - mpCount[a].m;
          const bBal = s === 'M' ? mpCount[b].m - mpCount[b].p : mpCount[b].p - mpCount[b].m;
          return aBal - bBal;
        });
        if (candidates.length > 0) {
          const n = candidates[0];
          schedule[n][d] = s;
          if (s === 'M') {
            cov.M++;
            mpCount[n].m++;
          } else {
            cov.P++;
            mpCount[n].p++;
          }
          assigned = true;
          break;
        }
      }
      if (!assigned) break;
    }

    // If still short on M or P, try promoting to D (covers both M+P slots)
    // Only if D won't push either M or P over their maximum
    if (cov.M < minCovM || cov.P < minCovP) {
      for (const n of avail().filter(
        n =>
          !nurseProps[n].noDiurni &&
          !nurseProps[n].mattineEPomeriggi &&
          !nurseProps[n].soloMattine &&
          !nurseProps[n].soloNotti
      )) {
        if (cov.M >= maxCovM || cov.P >= maxCovP) break;
        if (cov.D >= maxCovD) break;
        if (!eligible(n, d, 'D')) continue;
        schedule[n][d] = 'D';
        cov.D++;
        cov.M++;
        cov.P++;
      }
    }
  }

  // Phase 4 — Fill remaining with R
  for (let n = 0; n < numNurses; n++)
    for (let d = 0; d < numDays; d++) if (schedule[n][d] === null) schedule[n][d] = 'R';

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
              schedule[n][d] = 'R';
              rest++;
              converted = true;
              break;
            }
          }
          if (!converted) break;
        }
      }
    }
  }

  // Phase 4.6 — M/P balance for nurses limited to M/P-heavy workloads
  for (let n = 0; n < numNurses; n++) {
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].soloNotti ||
      nurseProps[n].diurniENotturni
    )
      continue;
    if (
      !nurseProps[n].noDiurni &&
      !nurseProps[n].mattineEPomeriggi &&
      !nurseProps[n].noNotti &&
      !nurseProps[n].diurniNoNotti
    )
      continue;
    function collectMPDays() {
      let mCount = 0,
        pCount = 0;
      const mDays = [],
        pDays = [];
      for (let d = 0; d < numDays; d++) {
        if (schedule[n][d] === 'M') {
          mCount++;
          mDays.push(d);
        }
        if (schedule[n][d] === 'P') {
          pCount++;
          pDays.push(d);
        }
      }
      return { mCount, pCount, mDays, pDays };
    }
    let { mCount, pCount, mDays, pDays } = collectMPDays();
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
      ({ mCount, pCount, mDays, pDays } = collectMPDays());
      let remainingDiff = mCount - pCount;
      // A half-month worth of swap attempts is enough to explore different pairings
      // without spending too long on a single nurse during constructive balancing.
      const maxBalanceAttempts = Math.floor(numDays / 2);
      let attempts = maxBalanceAttempts;
      while (Math.abs(remainingDiff) > 1 && attempts-- > 0) {
        const srcIsM = remainingDiff > 0;
        const prevDiff = remainingDiff;
        trySwapMP(schedule, n, srcIsM ? mDays : pDays, srcIsM ? pDays : mDays, Math.floor(numDays / 2), srcIsM, ctx);
        ({ mCount, pCount, mDays, pDays } = collectMPDays());
        remainingDiff = mCount - pCount;
        if (remainingDiff === prevDiff) break;
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
  const { numDays, numNurses, minCovM, maxCovM, minCovP, maxCovP } = ctx;
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
      const okS = srcIsM ? covS.M > minCovM && covS.P < maxCovP : covS.P > minCovP && covS.M < maxCovM;
      const okD = srcIsM ? covD.P > minCovP && covD.M < maxCovM : covD.M > minCovM && covD.P < maxCovP;
      if (okS && okD) {
        schedule[n][sDay] = newSrc;
        schedule[n][dDay] = newDst;
        return;
      }
    }
  }
}

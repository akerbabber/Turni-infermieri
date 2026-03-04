/**
 * @file lp-model.js — MILP LP formulation for nurse scheduling
 * @description Generates CPLEX LP format strings and parses solver solutions.
 * Used by both HiGHS and GLPK solver backends.
 */

'use strict';

// Seeded PRNG for reproducible random perturbations
function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Build a CPLEX LP format string for the nurse scheduling problem.
 * @param {object} ctx - build context from buildContext()
 * @param {number} perturbSeed - seed for objective perturbation (0 = no perturbation)
 * @returns {string} LP format problem
 */
function buildLP(ctx, perturbSeed) {
  const {
    numDays,
    numNurses,
    pinned,
    nurseProps,
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
    minRPerWeek,
    weekDaysList,
    weekOf,
    forbidden,
    consente2D,
    coppiaTurni,
    hourDeltas,
    prevTail,
  } = ctx;

  // Shift indices: M=0, P=1, N=2, S=3, R=4, D=5
  const SHIFTS = ['M', 'P', 'N', 'S', 'R', 'D'];
  const S_HRS = [6.2, 6.2, 12.2, 0, 0, 12.2];
  const V = (n, d, s) => `x${n}_${d}_${s}`;

  const lines = [];
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
          const w = rng() * 0.04 - 0.02;
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

  // --- Hour equity via minimax: minimize (hmax - hmin) of adjusted hours ---
  // When hourDeltas from previous month are available, each nurse's effective hours
  // are offset: adjusted = actual - delta, so nurses who should work more (positive delta)
  // appear to have fewer hours, driving the solver to assign them more work.
  const contVars = [];
  const controllable = [];
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloDiurni || nurseProps[n].soloMattine) continue;
    let hasFree = false;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) {
        hasFree = true;
        break;
      }
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
      const delta = hourDeltas ? hourDeltas[n] || 0 : 0;
      // adjusted_hours_n = pinnedHrs[n] + freeHrs_n - delta <= hmax
      eqConstraints.push(` eqMx${n}: ${hTerms.join(' + ')} - hmax <= ${(-(pinnedHrs[n] - delta)).toFixed(2)}`);
      // adjusted_hours_n = pinnedHrs[n] + freeHrs_n - delta >= hmin
      eqConstraints.push(` eqMn${n}: hmin - ${hTerms.join(' - ')} <= ${(pinnedHrs[n] - delta).toFixed(2)}`);
    }
  }

  // --- Night equity via minimax: minimize (nmax - nmin) of night counts ---
  const nightElig = [];
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloMattine || nurseProps[n].soloDiurni || nurseProps[n].noNotti || nurseProps[n].diurniNoNotti)
      continue;
    let hasFreeN = false;
    for (let d = 0; d < numDays; d++) {
      if (isFree(n, d)) {
        hasFreeN = true;
        break;
      }
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
      eqConstraints.push(` neqMx${n}: ${nTerms.join(' + ')} - nmax <= ${-pinnedNights[n]}`);
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
      if (isFree(n, d)) {
        hasFreeDay = true;
        break;
      }
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
      eqConstraints.push(` deqMx${n}: ${dTerms.join(' + ')} - dmax <= ${-pinnedDiurni[n]}`);
      eqConstraints.push(` deqMn${n}: dmin - ${dTerms.join(' - ')} <= ${pinnedDiurni[n]}`);
    }
  }

  // --- M/P balance for no_diurni nurses: penalize |M_count - P_count| ---
  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].noDiurni) continue;
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].soloNotti ||
      nurseProps[n].diurniENotturni
    )
      continue;
    const mTerms = [],
      pTerms = [];
    let pinnedM = 0,
      pinnedP = 0;
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
    const overVar = `mpOv${n}`,
      underVar = `mpUn${n}`;
    contVars.push(overVar, underVar);
    objTerms.push(`${MP_BALANCE_MILP_WEIGHT} ${overVar}`);
    objTerms.push(`${MP_BALANCE_MILP_WEIGHT} ${underVar}`);
    const posStr = mTerms.length > 0 ? mTerms.join(' + ') : '';
    const negStr = pTerms.length > 0 ? ' - ' + pTerms.join(' - ') : '';
    const rhs = pinnedP - pinnedM;
    eqConstraints.push(` mpBal${n}: ${posStr}${negStr} - ${overVar} + ${underVar} = ${rhs}`);
  }

  // --- LP model diagnostics ---
  {
    let freeCount = 0,
      pinnedCount = 0;
    for (let n = 0; n < numNurses; n++) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) freeCount++;
        else pinnedCount++;
      }
    }
    // Check feasibility: can we meet night coverage with available nurses?
    const nightEligibleCount = nurseProps.filter(
      p => !p.soloMattine && !p.soloDiurni && !p.noNotti && !p.diurniNoNotti
    ).length;
    // Each night nurse needs 4 days (N-S-R-R) per night block, so max nights per nurse ≈ numDays/4
    const theoreticalMaxNightSlots = nightEligibleCount * Math.floor(numDays / 4);
    const requiredNightSlots = minCovN * numDays;
    // Work-eligible nurses (can do M or P)
    const workEligibleCount = nurseProps.filter(p => !p.soloNotti).length;

    console.log(`[buildLP] Free cells: ${freeCount}, Pinned cells: ${pinnedCount}, Binary vars: ${binVars.length}`);
    console.log(
      `[buildLP] Night-eligible nurses: ${nightEligibleCount}, theoretical max night slots: ${theoreticalMaxNightSlots}, required: ${requiredNightSlots}`
    );
    console.log(`[buildLP] Work-eligible nurses (M/P/D): ${workEligibleCount}`);
    if (requiredNightSlots > theoreticalMaxNightSlots) {
      console.warn(
        `[buildLP] ⚠ INFEASIBILITY RISK: required night slots (${requiredNightSlots}) > theoretical max (${theoreticalMaxNightSlots})`
      );
    }
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
    const mFree = [],
      pFree = [],
      nFree = [],
      dFree = [];
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
        if (isPMForbidden) lines.push(` pm${n}_${d}: ${V(n, d, 1)} + ${V(n, d + 1, 0)} <= 1`);
        // D -> M forbidden
        if (isDMForbidden) lines.push(` dm${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 0)} <= 1`);
        // D -> P forbidden
        if (isDPForbidden) lines.push(` dp${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 1)} <= 1`);
        // P -> D forbidden (unless consentePomeriggioDiurno relaxed it)
        if (isPDForbidden) lines.push(` pd${n}_${d}: ${V(n, d, 1)} + ${V(n, d + 1, 5)} <= 1`);
        // D -> D forbidden (unless consente2DiurniConsecutivi)
        if (isDDForbidden) lines.push(` dd${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 5)} <= 1`);
        // N must be followed by S
        lines.push(` ns${n}_${d}: ${V(n, d, 2)} - ${V(n, d + 1, 3)} <= 0`);
        // S must be followed by R
        lines.push(` sr${n}_${d}: ${V(n, d, 3)} - ${V(n, d + 1, 4)} <= 0`);
        // No orphan S without preceding N
        lines.push(` sn${n}_${d}: ${V(n, d + 1, 3)} - ${V(n, d, 2)} <= 0`);
        // N cannot follow N, S, R (already handled by N->S->R chain but add safety)
        lines.push(` nn${n}_${d}: ${V(n, d, 2)} + ${V(n, d + 1, 2)} <= 1`);
      } else if (!free0 && free1) {
        // Pinned day d, free day d+1
        const p = pinned[n][d];
        if (p === 'P' && isPMForbidden) lines.push(` tpm${n}_${d}: ${V(n, d + 1, 0)} <= 0`);
        if (p === 'P' && isPDForbidden) lines.push(` tpd${n}_${d}: ${V(n, d + 1, 5)} <= 0`);
        if (p === 'D' && isDMForbidden) lines.push(` tdm${n}_${d}: ${V(n, d + 1, 0)} <= 0`);
        if (p === 'D' && isDPForbidden) lines.push(` tdp${n}_${d}: ${V(n, d + 1, 1)} <= 0`);
        if (p === 'D' && isDDForbidden) lines.push(` tdd${n}_${d}: ${V(n, d + 1, 5)} <= 0`);
        if (p === 'N') lines.push(` tns${n}_${d}: ${V(n, d + 1, 3)} = 1`); // force S after pinned N
        if (p === 'S') lines.push(` tsr${n}_${d}: ${V(n, d + 1, 4)} = 1`); // force R after pinned S
      } else if (free0 && !free1) {
        // Free day d, pinned day d+1
        const p1 = pinned[n][d + 1];
        // N on free day d must be followed by S — if d+1 is not S, ban N
        if (p1 !== 'S') lines.push(` fn${n}_${d}: ${V(n, d, 2)} <= 0`);
        // S on free day d must be followed by R — if d+1 is not R, ban S
        if (p1 !== 'R') lines.push(` fs${n}_${d}: ${V(n, d, 3)} <= 0`);
        // D transition: ban D if next day is M or P (D->M, D->P forbidden)
        if (p1 === 'M' && isDMForbidden) lines.push(` fdm${n}_${d}: ${V(n, d, 5)} <= 0`);
        if (p1 === 'P' && isDPForbidden) lines.push(` fdp${n}_${d}: ${V(n, d, 5)} <= 0`);
        if (p1 === 'D' && isDDForbidden) lines.push(` fdd${n}_${d}: ${V(n, d, 5)} <= 0`);
        if (p1 === 'D' && isPDForbidden) lines.push(` fpd${n}_${d}: ${V(n, d, 1)} <= 0`);
      }
    }
  }

  // --- Previous month tail: transition constraints for day 0 ---
  if (prevTail) {
    for (let n = 0; n < numNurses; n++) {
      if (!isFree(n, 0)) continue; // day 0 already pinned
      const tail = prevTail[n];
      if (!tail || tail.length === 0) continue;
      const last = tail[tail.length - 1];
      if (!last) continue;
      // Forbidden transitions from previous month's last shift to day 0
      if (last === 'P' && isPMForbidden) lines.push(` ptm${n}: ${V(n, 0, 0)} <= 0`);
      if (last === 'P' && isPDForbidden) lines.push(` ptd${n}: ${V(n, 0, 5)} <= 0`);
      if (last === 'D' && isDMForbidden) lines.push(` dtm${n}: ${V(n, 0, 0)} <= 0`);
      if (last === 'D' && isDPForbidden) lines.push(` dtp${n}: ${V(n, 0, 1)} <= 0`);
      if (last === 'D' && isDDForbidden) lines.push(` dtd${n}: ${V(n, 0, 5)} <= 0`);
      // N must be followed by S (already handled by pinning, but add safety)
      if (last === 'N') lines.push(` ptn${n}: ${V(n, 0, 3)} = 1`);
      // S must be followed by R
      if (last === 'S') lines.push(` pts${n}: ${V(n, 0, 4)} = 1`);
      // D-D boundary constraints (when consente2D enabled)
      // Note: D-D at end of prev month is handled by pinning (context.js pins R at day 0),
      // so isFree(n, 0) is false for that case. Here we handle the single-D case:
      // previous month ends with …D → if day 0 is D then day 1 must be R.
      if (consente2D && last === 'D') {
        if (isFree(n, 1)) {
          lines.push(` ptdd1${n}: ${V(n, 0, 5)} - ${V(n, 1, 4)} <= 0`);
        } else if (!isFree(n, 1) && pinned[n][1] !== 'R') {
          // day 1 pinned to non-R: D on day 0 forbidden (D-D needs R after)
          lines.push(` ptdd1p${n}: ${V(n, 0, 5)} <= 0`);
        }
      }
    }
  }

  // --- D-D rules when consente2D is enabled ---
  if (consente2D) {
    for (let n = 0; n < numNurses; n++) {
      for (let d = 0; d < numDays - 2; d++) {
        const f0 = isFree(n, d),
          f1 = isFree(n, d + 1),
          f2 = isFree(n, d + 2);
        // D-D-D forbidden: at most 2 consecutive D
        if (f0 && f1 && f2) {
          lines.push(` ddd${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 5)} + ${V(n, d + 2, 5)} <= 2`);
        }
        // D-D must be followed by R
        if (f0 && f1 && f2) {
          lines.push(` ddr${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 5)} - ${V(n, d + 2, 4)} <= 1`);
        } else if (f0 && f1 && !f2 && pinned[n][d + 2] !== 'R') {
          // Pinned d+2 is not R: D-D on d,d+1 forbidden
          lines.push(` ddrp${n}_${d}: ${V(n, d, 5)} + ${V(n, d + 1, 5)} <= 1`);
        }
        // Handle pinned D followed by free slots
        if (!f0 && pinned[n][d] === 'D' && f1 && f2) {
          lines.push(` pddr${n}_${d}: ${V(n, d + 1, 5)} - ${V(n, d + 2, 4)} <= 0`);
        }
        if (f0 && !f1 && pinned[n][d + 1] === 'D' && f2) {
          lines.push(` dpdr${n}_${d}: ${V(n, d, 5)} - ${V(n, d + 2, 4)} <= 0`);
        }
      }
    }
  }

  // --- Night block: N-S-R-R (second R for non-noDiurni) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noDiurni) continue; // noDiurni nurses only need N-S-R
    for (let d = 0; d < numDays - 3; d++) {
      if (isFree(n, d) && isFree(n, d + 3)) {
        lines.push(` rr${n}_${d}: ${V(n, d, 2)} - ${V(n, d + 3, 4)} <= 0`);
      } else if (isFree(n, d) && !isFree(n, d + 3)) {
        if (pinned[n][d + 3] !== 'R') lines.push(` rrp${n}_${d}: ${V(n, d, 2)} <= 0`);
      }
    }
  }

  // --- Max nights per nurse ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noNotti || nurseProps[n].diurniNoNotti || nurseProps[n].soloMattine || nurseProps[n].soloDiurni)
      continue;
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
    if (nurseProps[n].noNotti || nurseProps[n].diurniNoNotti) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) lines.push(` noN${n}_${d}: ${V(n, d, 2)} <= 0`);
      }
    }
  }

  // --- Nurse-specific: solo_diurni → only D or R allowed ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloDiurni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          // Ban M, P, N, S (indices 0, 1, 2, 3)
          lines.push(` sdM${n}_${d}: ${V(n, d, 0)} <= 0`);
          lines.push(` sdP${n}_${d}: ${V(n, d, 1)} <= 0`);
          lines.push(` sdN${n}_${d}: ${V(n, d, 2)} <= 0`);
          lines.push(` sdS${n}_${d}: ${V(n, d, 3)} <= 0`);
        }
      }
    }
  }

  // --- Nurse-specific: solo_notti → only N, S, R allowed (ban M, P, D) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].soloNotti) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          lines.push(` snM${n}_${d}: ${V(n, d, 0)} <= 0`);
          lines.push(` snP${n}_${d}: ${V(n, d, 1)} <= 0`);
          lines.push(` snD${n}_${d}: ${V(n, d, 5)} <= 0`);
        }
      }
    }
  }

  // --- Nurse-specific: no_diurni → ban D shift ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noDiurni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) lines.push(` ndD${n}_${d}: ${V(n, d, 5)} <= 0`);
      }
    }
  }

  // --- Nurse-specific: diurni_e_notturni → only D, N, S, R allowed (no M, P) ---
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].diurniENotturni) {
      for (let d = 0; d < numDays; d++) {
        if (isFree(n, d)) {
          // Ban M, P (indices 0, 1)
          lines.push(` denBanM${n}_${d}: ${V(n, d, 0)} <= 0`);
          lines.push(` denBanP${n}_${d}: ${V(n, d, 1)} <= 0`);
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
            lines.push(` cp${n1}_${n2}_${d}_${s}: ${V(n1, d, s)} - ${V(n2, d, s)} = 0`);
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
  let pinnedCells = 0;
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) {
        schedule[n][d] = pinned[n][d];
        pinnedCells++;
      }
    }
  }

  // Fill from MILP solution
  let assignedCells = 0,
    skippedFractional = 0;
  const shiftCounts = { M: 0, P: 0, N: 0, S: 0, R: 0, D: 0 };
  for (const [name, col] of Object.entries(result.Columns)) {
    if (!name.startsWith('x')) continue;
    if (Math.round(col.Primal) !== 1) {
      if (col.Primal > 0.1 && col.Primal < 0.9) skippedFractional++;
      continue;
    }
    const parts = name.substring(1).split('_');
    const n = parseInt(parts[0]),
      d = parseInt(parts[1]),
      s = parseInt(parts[2]);
    if (n >= 0 && n < numNurses && d >= 0 && d < numDays) {
      schedule[n][d] = SHIFTS[s];
      assignedCells++;
      if (shiftCounts[SHIFTS[s]] !== undefined) shiftCounts[SHIFTS[s]]++;
    }
  }

  // Fill any remaining nulls with R
  let filledWithR = 0;
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === null) {
        schedule[n][d] = 'R';
        filledWithR++;
      }
    }
  }

  console.log(
    `[HiGHS Parse] pinned=${pinnedCells}, assigned=${assignedCells}, filledR=${filledWithR}, fractional=${skippedFractional}`
  );
  console.log(
    `[HiGHS Parse] Shift distribution: M=${shiftCounts.M} P=${shiftCounts.P} N=${shiftCounts.N} S=${shiftCounts.S} R=${shiftCounts.R} D=${shiftCounts.D}`
  );

  return schedule;
}

/**
 * Parse LP-format linear expression into array of {name, coef} terms.
 */
function parseLPTerms(expr) {
  const terms = [];
  const s = expr
    .replace(/\+\s*-/g, '- ')
    .replace(/-\s*-/g, '+ ')
    .trim();
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
  const GLP_MIN = glpk.GLP_MIN,
    GLP_LO = glpk.GLP_LO,
    GLP_UP = glpk.GLP_UP,
    GLP_FX = glpk.GLP_FX;
  const objective = { direction: GLP_MIN, name: 'obj', vars: [] };
  const subjectTo = [];
  const modelBounds = [];
  const binaries = [];
  let objExpr = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower === 'minimize' || lower === 'min') {
      section = 'obj';
      continue;
    }
    if (lower === 'maximize' || lower === 'max') {
      section = 'obj';
      objective.direction = glpk.GLP_MAX;
      continue;
    }
    if (lower === 'subject to' || lower === 'st' || lower.startsWith('subject to')) {
      section = 'st';
      continue;
    }
    if (lower === 'bounds') {
      section = 'bounds';
      continue;
    }
    if (lower === 'binary' || lower === 'binaries' || lower === 'bin') {
      section = 'bin';
      continue;
    }
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
        const bnds =
          op === GLP_UP
            ? { type: op, ub: rhsVal, lb: 0 }
            : op === GLP_LO
              ? { type: op, lb: rhsVal, ub: 0 }
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
        line.split(/\s+/).forEach(v => {
          if (v && /^[a-zA-Z_]/.test(v)) binaries.push(v);
        });
        break;
    }
  }

  objective.vars = parseLPTerms(objExpr);
  if (objective.vars.length === 0) {
    console.error('[GLPK] LP-to-GLPK conversion: no objective variables parsed from LP');
    return null;
  }

  const model = { name: 'nurse_scheduling', objective, subjectTo, binaries };
  if (modelBounds.length > 0) model.bounds = modelBounds;
  console.log(
    `[GLPK] LP-to-GLPK conversion: obj_vars=${objective.vars.length}, constraints=${subjectTo.length}, binaries=${binaries.length}, bounds=${modelBounds.length}`
  );
  return model;
}

// GLPK status code names for logging
const GLPK_STATUS_NAMES = {
  1: 'GLP_UNDEF (undefined)',
  2: 'GLP_FEAS (feasible)',
  3: 'GLP_INFEAS (infeasible)',
  4: 'GLP_NOFEAS (no feasible)',
  5: 'GLP_OPT (optimal)',
  6: 'GLP_UNBND (unbounded)',
};

/**
 * Parse GLPK solution variables into schedule array.
 */
function parseGLPKSolution(vars, ctx) {
  const { numDays, numNurses, pinned } = ctx;
  const SHIFTS = ['M', 'P', 'N', 'S', 'R', 'D'];
  const schedule = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));

  let pinnedCells = 0;
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) {
        schedule[n][d] = pinned[n][d];
        pinnedCells++;
      }
    }
  }

  let assignedCells = 0,
    skippedFractional = 0;
  const shiftCounts = { M: 0, P: 0, N: 0, S: 0, R: 0, D: 0 };
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith('x')) continue;
    if (Math.round(value) !== 1) {
      if (value > 0.1 && value < 0.9) skippedFractional++;
      continue;
    }
    const parts = name.substring(1).split('_');
    const n = parseInt(parts[0]),
      d = parseInt(parts[1]),
      s = parseInt(parts[2]);
    if (n >= 0 && n < numNurses && d >= 0 && d < numDays && s >= 0 && s < SHIFTS.length) {
      schedule[n][d] = SHIFTS[s];
      assignedCells++;
      if (shiftCounts[SHIFTS[s]] !== undefined) shiftCounts[SHIFTS[s]]++;
    }
  }

  let filledWithR = 0;
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === null) {
        schedule[n][d] = 'R';
        filledWithR++;
      }
    }
  }

  console.log(
    `[GLPK Parse] pinned=${pinnedCells}, assigned=${assignedCells}, filledR=${filledWithR}, fractional=${skippedFractional}`
  );
  console.log(
    `[GLPK Parse] Shift distribution: M=${shiftCounts.M} P=${shiftCounts.P} N=${shiftCounts.N} S=${shiftCounts.S} R=${shiftCounts.R} D=${shiftCounts.D}`
  );

  return schedule;
}

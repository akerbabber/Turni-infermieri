/**
 * @file local-search.js — Simulated annealing local search + move functions
 * @description Improves a constructed schedule via adaptive simulated annealing
 * with four move types: swap, change, equity, and weekly rest.
 */

'use strict';

/* global D_NIGHT_PATTERNS, MP_NIGHT_PATTERNS, canAssignRestrictedNoDiurniRest, computeScore, countWeekRest, dayCoverage, deepCopy */
/* global getRestPromotionPriority, isForbiddenExtraNightRestDay, isForbiddenRestrictedNoDiurniRestDay */
/* global getNightPatternInfo, isMPCycleLimitedNurse, isMandatoryNightRestDay, isNightBlockRestDay, nightCount */
/* global isOptionalRestAfterNSR, isSplitRestDay, needsSecondNightRest, requiredRest, transitionOk, patternShiftAllowed */
/* global hasNightOnDay, findReperibile */

// ---------------------------------------------------------------------------
// Local search — simulated annealing
// ---------------------------------------------------------------------------

function localSearch(schedule, ctx, maxIter, timeLimitSec) {
  const { numDays, numNurses } = ctx;
  const current = deepCopy(schedule);
  let currentScore = computeScore(current, ctx);
  let best = deepCopy(current);
  let bestScore = currentScore;

  const changes = []; // reusable array for tracking cell changes

  // Cache nurse hours for fast equity lookups — avoids O(numNurses × numDays) per equity move
  const cachedHours = new Array(numNurses);
  for (let n = 0; n < numNurses; n++) cachedHours[n] = nurseHours(current, n, numDays);

  // Pre-allocate reusable index arrays to reduce GC pressure in hot paths
  const _dayIndices = Array.from({ length: numDays }, (_, i) => i);
  const _nurseIndices = Array.from({ length: numNurses }, (_, i) => i);

  // Adaptive move selection: track acceptance rates per move type
  const moveStats = [
    { attempts: 0, accepts: 0, weight: 0.15 }, // 0: swap
    { attempts: 0, accepts: 0, weight: 0.15 }, // 1: change
    { attempts: 0, accepts: 0, weight: 0.35 }, // 2: equity
    { attempts: 0, accepts: 0, weight: 0.2 }, // 3: weekly rest
    { attempts: 0, accepts: 0, weight: 0.08 }, // 4: coppia turni
    { attempts: 0, accepts: 0, weight: 0.07 }, // 5: night-block swap between nurses
  ];
  const ADAPT_INTERVAL = 1000; // recalculate weights every N iterations
  const MIN_WEIGHT = 0.05; // floor to prevent starving any move type

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
    const fraction = useTimeLimit ? Math.min(1, (now - startMs) / timeLimitMs) : iter / maxIter;
    const temp = useTimeLimit
      ? Math.max(0.1, 120 * Math.exp(-5 * fraction))
      : Math.max(0.1, 120 * Math.pow(0.9945, iter));

    // Periodic light repair: when hard violations persist, run the targeted
    // coverage repairs on the current state so the annealer keeps searching
    // from a cleaner basin instead of wasting budget on fixable deficits.
    if (iter > 0 && iter % 2000 === 0 && currentScore.hard > 0) {
      let fixedState = repairNightCoverage(current, ctx, 2);
      fixedState = repairDayCoverage(fixedState, ctx);
      const fixedScore = computeScore(fixedState, ctx);
      if (fixedScore.total < currentScore.total) {
        for (let n = 0; n < numNurses; n++) current[n] = fixedState[n];
        currentScore = fixedScore;
        for (let n = 0; n < numNurses; n++) cachedHours[n] = nurseHours(current, n, numDays);
        if (fixedScore.total < bestScore.total) {
          best = deepCopy(current);
          bestScore = fixedScore;
        }
      }
    }

    changes.length = 0;

    // Adaptive move selection with hard-violation priority
    let moveType;
    if (currentScore.hard > 0 && Math.random() < 0.3) {
      // Se la coppia è desincronizzata, prioritizza quella mossa
      if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
        const [n1, n2] = ctx.coppiaTurni;
        if (n1 < ctx.numNurses && n2 < ctx.numNurses) {
          let hasDivergence = false;
          for (let d = 0; d < ctx.numDays; d++) {
            if (current[n1][d] !== current[n2][d]) {
              hasDivergence = true;
              break;
            }
          }
          if (hasDivergence) {
            moveType = 4;
          } else {
            moveType = Math.random() < 0.5 ? 3 : 5;
          }
        } else {
          moveType = Math.random() < 0.5 ? 3 : 5;
        }
      } else {
        moveType = Math.random() < 0.5 ? 3 : 5;
      }
    } else {
      // Weighted random selection using adaptive weights
      const totalW = moveStats.reduce((s, m) => s + m.weight, 0);
      let r = Math.random() * totalW;
      moveType = 0;
      for (let i = 0; i < moveStats.length; i++) {
        r -= moveStats[i].weight;
        if (r <= 0) {
          moveType = i;
          break;
        }
      }
    }

    let moved = false;
    switch (moveType) {
      case 0:
        moved = trySwapMove(current, ctx, changes);
        break;
      case 1:
        moved = tryChangeMove(current, ctx, changes);
        break;
      case 2:
        moved = tryEquityMove(current, ctx, changes, cachedHours, _dayIndices);
        break;
      case 3:
        moved = tryWeeklyRestMove(current, ctx, changes, _nurseIndices);
        break;
      case 4:
        moved = tryCoppiaTurniMove(current, ctx, changes, cachedHours);
        break;
      case 5:
        moved = tryNightBlockSwapMove(current, ctx, changes);
        break;
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
      for (const ms of moveStats) {
        ms.attempts = 0;
        ms.accepts = 0;
      }
    }
  }
  // Sync finale coppia turni — forza n2 uguale a n1 prima della fase di repair.
  // Le celle pinnate di n2 (assenze, turni fissi) non vanno mai sovrascritte:
  // l'eventuale divergenza residua resta visibile come violazione coppia_divergente.
  if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [n1, n2] = ctx.coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        if (!ctx.pinned[n2][d]) best[n2][d] = best[n1][d];
      }
    }
  }
  let repaired = deepCopy(best);
  for (let pass = 0; pass < 6; pass++) {
    const beforePass = repaired.map(row => row.join('|')).join('\n');
    repaired = repairNightCoverage(repaired, ctx);
    repaired = repairNightLeadIns(repaired, ctx);
    repaired = repairForbiddenExtraNightRest(repaired, ctx);
    repaired = repairForbiddenRestrictedNoDiurniRest(repaired, ctx);
    repaired = repairSplitRestDays(repaired, ctx);
    repaired = repairDayCoverage(repaired, ctx);
    repaired = repairReperibile(repaired, ctx);
    repaired = repairWeeklyRestDeficits(repaired, ctx);
    repaired = repairRestExcess(repaired, ctx);
    if (repaired.map(row => row.join('|')).join('\n') === beforePass) break;
  }
  return repaired;
}

// Helper: record a cell change for undo
function setCell(schedule, n, d, val, changes) {
  if (changes) changes.push({ n, d, old: schedule[n][d] });
  schedule[n][d] = val;
}

function repairNightCoverage(schedule, ctx, maxPasses) {
  const { numDays, numNurses, minCovN, maxCovN } = ctx;
  if (minCovN === maxCovN && minCovN === 0) return schedule;

  let current = deepCopy(schedule);
  let currentScore = computeScore(current, ctx);
  const limit = Math.max(1, maxPasses || numDays);

  for (let pass = 0; pass < limit; pass++) {
    const currentPenalty = nightCoveragePenalty(current, ctx);
    if (currentPenalty === 0) break;

    const deficits = [];
    const excesses = [];
    for (let d = 0; d < numDays; d++) {
      const covN = dayCoverage(current, d, numNurses).N;
      if (covN < minCovN) deficits.push(d);
      if (covN > maxCovN) excesses.push(d);
    }
    let bestCandidate = null;

    // Relocation donor days: primarily days above the maximum; when there are
    // deficit days but no over-max days, any day above the *minimum* can donate a
    // night block (total nights stay constant and the donor never drops below min —
    // nightCoveragePenalty would otherwise not improve and the move is rejected).
    let donorDays = excesses;
    if (deficits.length > 0 && donorDays.length === 0) {
      donorDays = Array.from({ length: numDays }, (_, d) => d).filter(
        d => !deficits.includes(d) && dayCoverage(current, d, numNurses).N > minCovN
      );
    }

    if (donorDays.length > 0) {
      const targetDays = deficits.length
        ? deficits
        : Array.from({ length: numDays }, (_, d) => d).filter(
            d => !donorDays.includes(d) && dayCoverage(current, d, numNurses).N < maxCovN
          );

      for (const targetDay of targetDays) {
        const orderedExcesses = [...donorDays].sort((a, b) => Math.abs(a - targetDay) - Math.abs(b - targetDay));
        for (const excessDay of orderedExcesses) {
          for (let n = 0; n < numNurses; n++) {
            if (current[n][excessDay] !== 'N') continue;
            const candidateSchedule = relocateNightBlock(current, ctx, n, excessDay, targetDay);
            if (!candidateSchedule) continue;

            const candidatePenalty = nightCoveragePenalty(candidateSchedule, ctx);
            if (candidatePenalty >= currentPenalty) continue;

            const candidateScore = computeScore(candidateSchedule, ctx);
            if (
              !bestCandidate ||
              candidateScore.total < bestCandidate.score.total ||
              (candidateScore.total === bestCandidate.score.total && candidatePenalty < bestCandidate.penalty)
            ) {
              bestCandidate = {
                schedule: candidateSchedule,
                score: candidateScore,
                penalty: candidatePenalty,
              };
            }
          }
        }
      }
    }

    if (!bestCandidate && deficits.length > 0) {
      bestCandidate = buildAdditionalNightCoverageCandidate(current, ctx, deficits, currentPenalty);
    }

    if (
      !bestCandidate ||
      (bestCandidate.score.hard > currentScore.hard && bestCandidate.score.total >= currentScore.total)
    )
      break;
    current = bestCandidate.schedule;
    currentScore = bestCandidate.score;
  }

  return current;
}

function buildAdditionalNightCoverageCandidate(schedule, ctx, deficits, currentPenalty) {
  const { numDays, numNurses } = ctx;
  let bestCandidate = null;
  const targetDays = [...deficits].sort(
    (a, b) => dayCoverage(schedule, a, numNurses).N - dayCoverage(schedule, b, numNurses).N
  );

  for (const targetDay of targetDays) {
    const nurses = Array.from({ length: numNurses }, (_, i) => i)
      .filter(n => canAddNightBlockForNurse(schedule, ctx, n, targetDay))
      .sort((a, b) => {
        const aProps = ctx.nurseProps[a];
        const bProps = ctx.nurseProps[b];
        const aPriority = aProps.noDiurni ? 0 : aProps.soloNotti ? 1 : 2;
        const bPriority = bProps.noDiurni ? 0 : bProps.soloNotti ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return nightCount(schedule, a, numDays) - nightCount(schedule, b, numDays);
      });

    for (const n of nurses) {
      const candidateSchedule = addNightBlockCandidate(schedule, ctx, n, targetDay);
      if (!candidateSchedule) continue;
      const candidatePenalty = nightCoveragePenalty(candidateSchedule, ctx);
      if (candidatePenalty >= currentPenalty) continue;
      const candidateScore = computeScore(candidateSchedule, ctx);
      if (
        !bestCandidate ||
        candidateScore.hard < bestCandidate.score.hard ||
        (candidateScore.hard === bestCandidate.score.hard && candidateScore.total < bestCandidate.score.total) ||
        (candidateScore.total === bestCandidate.score.total && candidatePenalty < bestCandidate.penalty)
      ) {
        bestCandidate = {
          schedule: candidateSchedule,
          score: candidateScore,
          penalty: candidatePenalty,
        };
      }
    }
  }

  return bestCandidate;
}

function canAddNightBlockForNurse(schedule, ctx, nurseIdx, start) {
  const props = ctx.nurseProps[nurseIdx];
  if (
    props.soloMattine ||
    props.soloDiurni ||
    props.noNotti ||
    props.diurniNoNotti ||
    props.mattineEPomeriggi ||
    // Repair may exceed the soft cap (maxNights) up to the absolute limit
    // (hardMaxNights) when that is the only way to meet night coverage.
    nightCount(schedule, nurseIdx, ctx.numDays) >= ctx.hardMaxNights
  )
    return false;
  return !!addNightBlockCandidate(schedule, ctx, nurseIdx, start);
}

function addNightBlockCandidate(schedule, ctx, nurseIdx, start) {
  const { numDays, pinned, nurseProps } = ctx;
  const props = nurseProps[nurseIdx];
  if (start < 0 || start >= numDays || schedule[nurseIdx][start] === 'N') return null;

  const candidate = deepCopy(schedule);
  const blockDays = getNightBlockDays(start, props, numDays);
  for (const d of blockDays) {
    if (!canOverwriteForNightRepair(candidate, ctx, nurseIdx, d)) return null;
  }

  placeNightBlock(candidate, nurseIdx, start, props, numDays);

  if (props.noDiurni && !ensureNightLeadIn(candidate, ctx, nurseIdx, start, MP_NIGHT_PATTERNS)) return null;
  if (props.diurniENotturni && !ensureNightLeadIn(candidate, ctx, nurseIdx, start, D_NIGHT_PATTERNS)) return null;

  if (pinned[nurseIdx][start] && pinned[nurseIdx][start] !== 'N') return null;
  return candidate;
}

function ensureNightLeadIn(schedule, ctx, nurseIdx, nightDay, patterns) {
  const info = getNightPatternInfo(schedule, ctx, nurseIdx, nightDay);
  if (!info || info.validLead) return true;

  for (const pattern of patterns) {
    const startDay = nightDay - pattern.length;
    if (startDay < 0) continue;

    const candidate = deepCopy(schedule);
    let compatible = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      const d = startDay + offset;
      const shift = pattern[offset];
      if (!canOverwriteForNightRepair(candidate, ctx, nurseIdx, d, shift)) {
        compatible = false;
        break;
      }
      candidate[nurseIdx][d] = shift;
    }
    if (!compatible) continue;
    const updatedInfo = getNightPatternInfo(candidate, ctx, nurseIdx, nightDay);
    if (updatedInfo && updatedInfo.validLead) {
      for (let d = startDay; d < nightDay; d++) schedule[nurseIdx][d] = candidate[nurseIdx][d];
      return true;
    }
  }

  return false;
}

function canOverwriteForNightRepair(schedule, ctx, nurseIdx, dayIdx, shiftType) {
  const { numDays, pinned, nurseProps } = ctx;
  if (dayIdx < 0 || dayIdx >= numDays || pinned[nurseIdx][dayIdx]) return false;
  const current = schedule[nurseIdx][dayIdx];
  if (current === 'N' || current === 'S') return false;
  if (current === 'R' && isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx)) return false;
  if (current === 'R' && isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx)) return false;
  if (shiftType && !isRepairShiftAllowed(nurseProps[nurseIdx], shiftType)) return false;
  return true;
}

function nightCoveragePenalty(schedule, ctx) {
  const { numDays, numNurses, minCovN, maxCovN } = ctx;
  let penalty = 0;
  for (let d = 0; d < numDays; d++) {
    const covN = dayCoverage(schedule, d, numNurses).N;
    if (covN < minCovN) penalty += minCovN - covN;
    if (covN > maxCovN) penalty += (covN - maxCovN) * 3;
  }
  return penalty;
}

function relocateNightBlock(schedule, ctx, nurseIdx, oldStart, newStart) {
  const { numDays, pinned, nurseProps } = ctx;
  if (oldStart === newStart || schedule[nurseIdx][oldStart] !== 'N' || newStart < 0 || newStart >= numDays) return null;

  const props = nurseProps[nurseIdx];
  const oldDays = getNightBlockDays(oldStart, props, numDays);
  const oldDaySet = new Set(oldDays);
  const newDays = getNightBlockDays(newStart, props, numDays);
  for (const d of oldDays) {
    if (pinned[nurseIdx][d]) return null;
  }

  const candidate = deepCopy(schedule);
  for (const d of oldDays) candidate[nurseIdx][d] = 'R';

  for (const d of newDays) {
    if (!oldDaySet.has(d)) {
      if (!canOverwriteForNightRepair(candidate, ctx, nurseIdx, d)) return null;
    }
  }

  placeNightBlock(candidate, nurseIdx, newStart, props, numDays);
  if (props.noDiurni && !ensureNightLeadIn(candidate, ctx, nurseIdx, newStart, MP_NIGHT_PATTERNS)) return null;
  if (props.diurniENotturni && !ensureNightLeadIn(candidate, ctx, nurseIdx, newStart, D_NIGHT_PATTERNS)) return null;
  return candidate;
}

function getNightBlockDays(start, props, numDays) {
  // Every profile uses the 3-day N-S-R block; diurni_e_notturni follow the
  // rigid 4-day N-S-R-R block (matrix D-N-S-R-R, both rests mandatory).
  const len = props && props.diurniENotturni ? 4 : 3;
  const days = [];
  for (let i = 0; i < len && start + i < numDays; i++) days.push(start + i);
  return days;
}

function placeNightBlock(schedule, nurseIdx, start, props, numDays) {
  schedule[nurseIdx][start] = 'N';
  if (start + 1 < numDays) schedule[nurseIdx][start + 1] = 'S';
  if (start + 2 < numDays) schedule[nurseIdx][start + 2] = 'R';
  if (props && props.diurniENotturni && start + 3 < numDays) schedule[nurseIdx][start + 3] = 'R';
}

/**
 * Fix missing night on-calls (reperibile notturno): a day with nights needs a
 * nurse working the MORNING that day (regime without diurni — the on-call is
 * "dopo la mattina"). The repair flips a P into M (score-guided) so that the
 * day gains an eligible on-call.
 */
function repairReperibile(schedule, ctx) {
  if (!ctx.reperibileNotturno) return schedule;
  // With diurni in use the on-call is the nurse on smonto (S today): there is
  // nothing to repair by swapping M/P — the S cells follow the night blocks.
  if (ctx.maxCovD > 0) return schedule;
  const { numDays, numNurses } = ctx;
  const repaired = deepCopy(schedule);

  for (let d = 0; d < numDays; d++) {
    if (!hasNightOnDay(repaired, d, numNurses)) continue;
    if (findReperibile(repaired, d, numNurses, ctx) !== -1) continue;
    // Nobody works the morning today: promote a P (or a rest day) to M.
    let done = false;
    for (let x = 0; x < numNurses && !done; x++) {
      const s = repaired[x][d];
      if (s !== 'P' && s !== 'R') continue;
      if (!canRepairShiftChange(repaired, ctx, x, d, 'M')) continue;
      const currentScore = computeScore(repaired, ctx);
      const candidate = deepCopy(repaired);
      candidate[x][d] = 'M';
      const score = computeScore(candidate, ctx);
      if (score.hard < currentScore.hard || (score.hard === currentScore.hard && score.total <= currentScore.total)) {
        repaired[x][d] = 'M';
        done = true;
      }
    }
  }

  return repaired;
}

/**
 * Fix invalid night lead-ins: no_diurni nurses need an M/P sequence right before
 * each night (M-P, M-M, P-P, …) and diurni_e_notturni need a D (or D-R-D) block.
 * Reuses ensureNightLeadIn on a candidate copy and accepts score-improving fixes.
 */
function repairNightLeadIns(schedule, ctx) {
  const { numDays, numNurses, nurseProps } = ctx;
  let repaired = deepCopy(schedule);
  for (let n = 0; n < numNurses; n++) {
    const props = nurseProps[n];
    const patterns = props.noDiurni ? MP_NIGHT_PATTERNS : props.diurniENotturni ? D_NIGHT_PATTERNS : null;
    if (!patterns || props.soloNotti) continue;
    for (let d = 0; d < numDays; d++) {
      if (repaired[n][d] !== 'N') continue;
      const info = getNightPatternInfo(repaired, ctx, n, d);
      if (!info || info.validLead) continue;
      const candidate = deepCopy(repaired);
      if (!ensureNightLeadIn(candidate, ctx, n, d, patterns)) continue;
      const curScore = computeScore(repaired, ctx);
      const score = computeScore(candidate, ctx);
      if (score.hard < curScore.hard || (score.hard === curScore.hard && score.total < curScore.total)) {
        repaired = candidate;
      }
    }
  }
  return repaired;
}

function isRepairShiftAllowed(props, shiftType) {
  if (shiftType === 'R') return true;
  if (props.soloMattine) return shiftType === 'M';
  if (props.soloDiurni) return shiftType === 'D';
  if (props.soloNotti) return shiftType === 'N' || shiftType === 'S';
  if (props.diurniENotturni) return shiftType === 'D' || shiftType === 'N' || shiftType === 'S';
  if (shiftType === 'N' && (props.noNotti || props.diurniNoNotti || props.mattineEPomeriggi)) return false;
  if (shiftType === 'D' && (props.noDiurni || props.mattineEPomeriggi)) return false;
  return shiftType === 'M' || shiftType === 'P' || shiftType === 'D';
}

// True when assigning R at (n, d) would create a run of more than
// MAX_CONSECUTIVE_REST consecutive R days ("più di 2 riposi attaccati").
function createsRestRun(schedule, ctx, n, d) {
  let run = 1;
  for (let k = d - 1; k >= 0 && schedule[n][k] === 'R'; k--) run++;
  for (let k = d + 1; k < ctx.numDays && schedule[n][k] === 'R'; k++) run++;
  return run > MAX_CONSECUTIVE_REST;
}

function canRepairShiftChange(schedule, ctx, n, d, nextShift) {
  const { numDays, pinned, nurseProps } = ctx;
  if (pinned[n][d] || schedule[n][d] === nextShift) return false;
  if (isMPCycleLimitedNurse(nurseProps[n])) return false;
  if (!isRepairShiftAllowed(nurseProps[n], nextShift)) return false;
  if (nextShift === 'R' && createsRestRun(schedule, ctx, n, d)) return false;
  if (nextShift === 'R' && isForbiddenExtraNightRestDay(schedule, ctx, n, d)) return false;
  if (nextShift !== 'R' && schedule[n][d] === 'R' && isMandatoryNightRestDay(schedule, ctx, n, d)) return false;
  if (nextShift === 'R' && isOptionalRestAfterNSR(schedule, ctx, n, d)) return false;
  const prev = d > 0 ? schedule[n][d - 1] : null;
  const next = d < numDays - 1 ? schedule[n][d + 1] : null;
  if (!transitionOk(prev, nextShift, ctx, schedule, n, d)) return false;
  if (!transitionOk(nextShift, next, ctx, schedule, n, d + 1)) return false;
  // Never break a currently-valid night lead-in of an upcoming night (no_diurni
  // nurses need M/P work right before N, diurni_e_notturni need a D block).
  if (!keepsNightLeadIns(schedule, ctx, n, d, nextShift)) return false;
  return true;
}

function repairDayCoverage(schedule, ctx) {
  const {
    numDays,
    numNurses,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovD,
    maxCovD,
    pinned,
    nurseProps,
    minRPerWeek,
    weekDaysList,
    weekOf,
  } = ctx;
  const repaired = deepCopy(schedule);

  function hasSpareWeeklyRest(n, d) {
    if (minRPerWeek <= 0) return true;
    const wDays = weekDaysList[weekOf(d)];
    return countWeekRest(repaired, n, wDays) > requiredRest(wDays.length, minRPerWeek);
  }

  function canPromoteRest(n, d, shiftType, relaxWeeklyRest) {
    if (repaired[n][d] !== 'R' || pinned[n][d]) return false;
    if (isMandatoryNightRestDay(repaired, ctx, n, d)) return false;
    // Rigid-matrix M/P nurses are NEVER promoted, not even by the relaxed
    // (absolute-minimum) pass: eating one of their two weekly rests would turn
    // the mandatory 5+2 cycle into 6 work + 1 rest. Residual coverage deficits
    // stay visible as coverage violations instead.
    if (isMPCycleLimitedNurse(nurseProps[n])) return false;
    if (!relaxWeeklyRest && !hasSpareWeeklyRest(n, d)) return false;
    // Shift-aware tag check: e.g. solo_diurni/diurni_e_notturni may take D but not
    // M/P, while no_diurni may take M/P but not D.
    if (nurseProps[n].soloMattine || nurseProps[n].soloNotti) return false;
    if (!isRepairShiftAllowed(nurseProps[n], shiftType)) return false;
    const prev = d > 0 ? repaired[n][d - 1] : null;
    const next = d < numDays - 1 ? repaired[n][d + 1] : null;
    return transitionOk(prev, shiftType, ctx, repaired, n, d) && transitionOk(shiftType, next, ctx, repaired, n, d + 1);
  }

  function bestOverCoverageFix(d, focusShift) {
    const currentScore = computeScore(repaired, ctx);
    const candidates = [];
    for (let n = 0; n < numNurses; n++) {
      const currentShift = repaired[n][d];
      let options = [];
      if (focusShift === 'D') {
        if (currentShift === 'D') options = ['M', 'P', 'R'];
      } else if (focusShift === 'M') {
        if (currentShift === 'M' || currentShift === 'D') options = ['P', 'R'];
      } else if (currentShift === 'P' || currentShift === 'D') {
        options = ['M', 'R'];
      }
      for (const nextShift of options) {
        if (!canRepairShiftChange(repaired, ctx, n, d, nextShift)) continue;
        const candidate = deepCopy(repaired);
        candidate[n][d] = nextShift;
        const score = computeScore(candidate, ctx);
        if (score.hard > currentScore.hard || (score.hard === currentScore.hard && score.total >= currentScore.total))
          continue;
        candidates.push({ schedule: candidate, score });
      }
    }
    candidates.sort((a, b) => a.score.total - b.score.total);
    return candidates[0] || null;
  }

  function countMP(n) {
    let m = 0;
    let p = 0;
    for (let d = 0; d < numDays; d++) {
      if (repaired[n][d] === 'M') m++;
      else if (repaired[n][d] === 'P') p++;
    }
    return { m, p };
  }

  // Convert an M↔P on the same day to fix an under-minimum on `target` using
  // surplus of the opposite shift (score-guided, never worsens hard violations).
  function convertWithinDay(d, target) {
    const source = target === 'M' ? 'P' : 'M';
    const currentScore = computeScore(repaired, ctx);
    let bestFix = null;
    for (let n = 0; n < numNurses; n++) {
      if (repaired[n][d] !== source) continue;
      if (!canRepairShiftChange(repaired, ctx, n, d, target)) continue;
      const candidate = deepCopy(repaired);
      candidate[n][d] = target;
      const score = computeScore(candidate, ctx);
      if (score.hard < currentScore.hard || (score.hard === currentScore.hard && score.total < currentScore.total)) {
        if (!bestFix || score.total < bestFix.score.total) bestFix = { schedule: candidate, score };
      }
    }
    if (!bestFix) return false;
    for (let n = 0; n < numNurses; n++) repaired[n] = bestFix.schedule[n];
    return true;
  }

  function promoteRestDay(d, shiftType, relaxWeeklyRest) {
    const candidates = shuffle(Array.from({ length: numNurses }, (_, i) => i))
      .filter(n => canPromoteRest(n, d, shiftType, relaxWeeklyRest))
      .sort((a, b) => {
        const aPriority = getRestPromotionPriority(nurseProps[a]);
        const bPriority = getRestPromotionPriority(nurseProps[b]);
        if (aPriority !== bPriority) return aPriority - bPriority;
        const aMp = countMP(a);
        const bMp = countMP(b);
        const aDiff = Math.abs(aMp.m + (shiftType === 'M' ? 1 : 0) - (aMp.p + (shiftType === 'P' ? 1 : 0)));
        const bDiff = Math.abs(bMp.m + (shiftType === 'M' ? 1 : 0) - (bMp.p + (shiftType === 'P' ? 1 : 0)));
        if (aDiff !== bDiff) return aDiff - bDiff;
        // Prefer the nurse with the lowest monthly hours: extra shifts must go
        // to whoever is furthest below the monte ore target.
        return nurseHours(repaired, a, numDays) - nurseHours(repaired, b, numDays);
      });
    if (!candidates.length) return false;
    repaired[candidates[0]][d] = shiftType;
    return true;
  }

  for (let d = 0; d < numDays; d++) {
    let cov = dayCoverage(repaired, d, numNurses);
    while (cov.M > maxCovM) {
      const fix = bestOverCoverageFix(d, 'M');
      if (!fix) break;
      for (let n = 0; n < numNurses; n++) repaired[n] = fix.schedule[n];
      cov = dayCoverage(repaired, d, numNurses);
    }
    while (cov.P > maxCovP) {
      const fix = bestOverCoverageFix(d, 'P');
      if (!fix) break;
      for (let n = 0; n < numNurses; n++) repaired[n] = fix.schedule[n];
      cov = dayCoverage(repaired, d, numNurses);
    }
    while (cov.D > maxCovD) {
      const fix = bestOverCoverageFix(d, 'D');
      if (!fix) break;
      for (let n = 0; n < numNurses; n++) repaired[n] = fix.schedule[n];
      cov = dayCoverage(repaired, d, numNurses);
    }
    // D minimum: promote rest days to D (a D also raises M and P coverage, so it
    // must not push either above its maximum).
    while (cov.D < minCovD && cov.M < maxCovM && cov.P < maxCovP) {
      if (!promoteRestDay(d, 'D')) break;
      cov = dayCoverage(repaired, d, numNurses);
    }
    while (cov.M < minCovM || cov.P < minCovP) {
      const mGap = Math.max(0, minCovM - cov.M);
      const pGap = Math.max(0, minCovP - cov.P);
      const first = mGap >= pGap ? 'M' : 'P';
      const second = first === 'M' ? 'P' : 'M';
      if ((first === 'M' ? cov.M : cov.P) < (first === 'M' ? minCovM : minCovP) && promoteRestDay(d, first)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      if ((second === 'M' ? cov.M : cov.P) < (second === 'M' ? minCovM : minCovP) && promoteRestDay(d, second)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      if ((first === 'M' ? cov.M : cov.P) < (first === 'M' ? minCovM : minCovP) && convertWithinDay(d, first)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      if ((second === 'M' ? cov.M : cov.P) < (second === 'M' ? minCovM : minCovP) && convertWithinDay(d, second)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      break;
    }

    // Second pass — the daily MINIMUM is an absolute constraint: when the
    // normal promotions cannot reach it, relax the weekly-rest guard (the same
    // priority as solveFillMP: minimum coverage wins over the weekly rest
    // minimum; the residual deficit stays visible as a min_R_week violation).
    while (cov.D < minCovD && cov.M < maxCovM && cov.P < maxCovP) {
      if (!promoteRestDay(d, 'D', true)) break;
      cov = dayCoverage(repaired, d, numNurses);
    }
    while (cov.M < minCovM || cov.P < minCovP) {
      if (cov.M < minCovM && promoteRestDay(d, 'M', true)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      if (cov.P < minCovP && promoteRestDay(d, 'P', true)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      break;
    }

    // Saturation: convert surplus rests (above the weekly minimum — the guard is
    // inside canPromoteRest) into EXTRA SHIFTS up to the maximum coverage. The
    // solver must hand out extra work, never extra rest days: this is what keeps
    // the monthly monte ore on target. D first (12.2h, biggest hour gain), then
    // M/P toward whichever has more headroom.
    while (cov.D < maxCovD && cov.M < maxCovM && cov.P < maxCovP) {
      if (!promoteRestDay(d, 'D')) break;
      cov = dayCoverage(repaired, d, numNurses);
    }
    while (cov.M < maxCovM || cov.P < maxCovP) {
      const first = maxCovM - cov.M >= maxCovP - cov.P ? 'M' : 'P';
      const second = first === 'M' ? 'P' : 'M';
      if ((first === 'M' ? cov.M : cov.P) < (first === 'M' ? maxCovM : maxCovP) && promoteRestDay(d, first)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      if ((second === 'M' ? cov.M : cov.P) < (second === 'M' ? maxCovM : maxCovP) && promoteRestDay(d, second)) {
        cov = dayCoverage(repaired, d, numNurses);
        continue;
      }
      break;
    }
  }

  return repaired;
}

function repairSplitRestDays(schedule, ctx) {
  const { numDays, numNurses, nurseProps, maxCovM, maxCovP, maxCovD, minRPerWeek, weekDaysList, weekOf } = ctx;
  const repaired = deepCopy(schedule);

  function hasSpareWeeklyRest(n, d) {
    if (minRPerWeek <= 0) return true;
    const wDays = weekDaysList[weekOf(d)];
    return countWeekRest(repaired, n, wDays) > requiredRest(wDays.length, minRPerWeek);
  }

  function candidateShiftOrder(n, d) {
    const prev = d > 0 ? repaired[n][d - 1] : null;
    const next = d < numDays - 1 ? repaired[n][d + 1] : null;
    const ordered = [];
    const candidates = [prev, next, 'M', 'P', 'D'].filter(shift => shift === 'M' || shift === 'P' || shift === 'D');
    for (const shift of candidates) {
      if (!ordered.includes(shift)) ordered.push(shift);
    }
    return ordered;
  }

  for (let n = 0; n < numNurses; n++) {
    if (isMPCycleLimitedNurse(nurseProps[n])) continue;
    for (let d = 1; d < numDays - 1; d++) {
      if (!isSplitRestDay(repaired, ctx, n, d) || !hasSpareWeeklyRest(n, d)) continue;
      const cov = dayCoverage(repaired, d, numNurses);
      const currentScore = computeScore(repaired, ctx);
      let bestShift = null;
      let bestScore = currentScore;
      for (const shiftType of candidateShiftOrder(n, d)) {
        if (shiftType === 'M' && cov.M >= maxCovM) continue;
        if (shiftType === 'P' && cov.P >= maxCovP) continue;
        if (shiftType === 'D' && (cov.M >= maxCovM || cov.P >= maxCovP || cov.D >= maxCovD)) continue;
        if (!canRepairShiftChange(repaired, ctx, n, d, shiftType)) continue;
        const candidate = deepCopy(repaired);
        candidate[n][d] = shiftType;
        const score = computeScore(candidate, ctx);
        if (score.hard < bestScore.hard || (score.hard === bestScore.hard && score.total < bestScore.total)) {
          bestShift = shiftType;
          bestScore = score;
        }
      }
      if (bestShift) {
        repaired[n][d] = bestShift;
      }
    }
  }

  return repaired;
}

function repairForbiddenExtraNightRest(schedule, ctx) {
  const { numDays, numNurses, nurseProps, maxCovM, maxCovP, maxCovD } = ctx;
  const repaired = deepCopy(schedule);

  function candidateShiftOrder(n, d) {
    const props = nurseProps[n];
    if (props.soloDiurni || props.diurniENotturni) return ['D'];
    const prev = d > 0 ? repaired[n][d - 1] : null;
    const next = d < numDays - 1 ? repaired[n][d + 1] : null;
    const base = props.noDiurni ? [prev, next, 'M', 'P'] : [prev, next, 'D', 'M', 'P'];
    const ordered = [];
    for (const shift of base) {
      if ((shift === 'M' || shift === 'P' || shift === 'D') && !ordered.includes(shift)) ordered.push(shift);
    }
    return ordered;
  }

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (!isForbiddenExtraNightRestDay(repaired, ctx, n, d)) continue;
      const cov = dayCoverage(repaired, d, numNurses);
      const currentScore = computeScore(repaired, ctx);
      let bestShift = null;
      let bestScore = currentScore;
      for (const shiftType of candidateShiftOrder(n, d)) {
        if (shiftType === 'M' && cov.M >= maxCovM) continue;
        if (shiftType === 'P' && cov.P >= maxCovP) continue;
        if (shiftType === 'D' && (cov.M >= maxCovM || cov.P >= maxCovP || cov.D >= maxCovD)) continue;
        if (!canRepairShiftChange(repaired, ctx, n, d, shiftType)) continue;
        const candidate = deepCopy(repaired);
        candidate[n][d] = shiftType;
        const score = computeScore(candidate, ctx);
        if (score.hard < bestScore.hard || (score.hard === bestScore.hard && score.total < bestScore.total)) {
          bestShift = shiftType;
          bestScore = score;
        }
      }
      if (bestShift) repaired[n][d] = bestShift;
    }
  }

  return repaired;
}

function repairForbiddenRestrictedNoDiurniRest(schedule, ctx) {
  const { numDays, numNurses, nurseProps } = ctx;
  const repaired = deepCopy(schedule);

  function candidateShiftOrder(n, d) {
    const prev = d > 0 ? repaired[n][d - 1] : null;
    const next = d < numDays - 1 ? repaired[n][d + 1] : null;
    const ordered = [];
    for (const shift of [prev, next, 'M', 'P']) {
      if ((shift === 'M' || shift === 'P') && !ordered.includes(shift)) ordered.push(shift);
    }
    return ordered;
  }

  for (let n = 0; n < numNurses; n++) {
    if (!nurseProps[n].noDiurni) continue;
    for (let d = 0; d < numDays; d++) {
      if (!isForbiddenRestrictedNoDiurniRestDay(repaired, ctx, n, d)) continue;
      const currentScore = computeScore(repaired, ctx);
      let bestShift = null;
      let bestScore = currentScore;
      for (const shiftType of candidateShiftOrder(n, d)) {
        if (!canRepairShiftChange(repaired, ctx, n, d, shiftType)) continue;
        const candidate = deepCopy(repaired);
        candidate[n][d] = shiftType;
        const score = computeScore(candidate, ctx);
        if (score.hard < bestScore.hard || (score.hard === bestScore.hard && score.total < bestScore.total)) {
          bestShift = shiftType;
          bestScore = score;
        }
      }
      if (bestShift) repaired[n][d] = bestShift;
    }
  }

  return repaired;
}

function repairWeeklyRestDeficits(schedule, ctx) {
  const { numNurses, minRPerWeek, weekDaysList, pinned, nurseProps } = ctx;
  if (minRPerWeek <= 0) return schedule;

  const repaired = deepCopy(schedule);

  function hasSpareWeeklyRest(n, weekDays) {
    return countWeekRest(repaired, n, weekDays) > requiredRest(weekDays.length, minRPerWeek);
  }

  function canRestOnDay(n, d) {
    if (pinned[n][d] || isMPCycleLimitedNurse(nurseProps[n])) return false;
    // Note: the restricted-noDiurni "rest must follow a night block" rule is soft,
    // while the weekly rest minimum being repaired here is hard — so an unattached
    // rest day is allowed and the score comparison arbitrates the trade-off.
    const currentShift = repaired[n][d];
    if (currentShift !== 'M' && currentShift !== 'P' && currentShift !== 'D') return false;
    if (currentShift === 'D') {
      const cov = dayCoverage(repaired, d, numNurses);
      if (cov.M <= ctx.minCovM || cov.P <= ctx.minCovP) return false;
    } else {
      const cov = dayCoverage(repaired, d, numNurses);
      if ((currentShift === 'M' ? cov.M : cov.P) <= (currentShift === 'M' ? ctx.minCovM : ctx.minCovP)) return false;
    }
    return canRepairShiftChange(repaired, ctx, n, d, 'R');
  }

  // Budget for expensive compound candidates (night relocation + coverage repairs):
  // they are a last resort for structurally locked deficits, so cap them per call.
  let compoundBudget = 6;

  let changed = true;
  while (changed) {
    changed = false;
    const currentScore = computeScore(repaired, ctx);
    outer: for (let n = 0; n < numNurses; n++) {
      // Rigid-matrix M/P nurses are never repaired here: every full week of the
      // 5+2 cycle already carries its two rests, and partial boundary weeks are
      // exempt from the weekly minimum by design (see computeScore).
      if (isMPCycleLimitedNurse(nurseProps[n])) continue;
      for (const weekDays of weekDaysList) {
        const need = requiredRest(weekDays.length, minRPerWeek);
        if (countWeekRest(repaired, n, weekDays) >= need) continue;

        let best = null;
        for (const d of weekDays) {
          if (canRestOnDay(n, d)) {
            const candidate = deepCopy(repaired);
            candidate[n][d] = 'R';
            const score = computeScore(candidate, ctx);
            if (
              (score.hard < currentScore.hard || score.total < currentScore.total) &&
              (!best ||
                score.hard < best.score.hard ||
                (score.hard === best.score.hard && score.total < best.score.total))
            ) {
              best = { schedule: candidate, score };
            }
          }

          const shift = repaired[n][d];
          if (shift !== 'M' && shift !== 'P' && shift !== 'D') continue;

          // Cross-week self-swap: move one of the nurse's own surplus rest days
          // from a rest-rich week into this deficit week. Coverage shifts between
          // the two days, so acceptance is score-guided like every other repair.
          if (canRepairShiftChange(repaired, ctx, n, d, 'R')) {
            for (let d2 = 0; d2 < ctx.numDays; d2++) {
              if (repaired[n][d2] !== 'R' || pinned[n][d2]) continue;
              const w2 = weekDaysList.findIndex(days => days.includes(d2));
              if (w2 === -1 || weekDaysList[w2] === weekDays) continue;
              if (!hasSpareWeeklyRest(n, weekDaysList[w2])) continue;
              if (isMandatoryNightRestDay(repaired, ctx, n, d2)) continue;
              const candidate = deepCopy(repaired);
              candidate[n][d] = 'R';
              if (!canRepairShiftChange(candidate, ctx, n, d2, shift)) continue;
              candidate[n][d2] = shift;
              const score = computeScore(candidate, ctx);
              if (
                (score.hard < currentScore.hard || score.total < currentScore.total) &&
                (!best ||
                  score.hard < best.score.hard ||
                  (score.hard === best.score.hard && score.total < best.score.total))
              ) {
                best = { schedule: candidate, score };
              }
            }
          }

          for (let other = 0; other < numNurses; other++) {
            if (other === n || repaired[other][d] !== 'R' || pinned[other][d]) continue;
            if (!hasSpareWeeklyRest(other, weekDays)) continue;
            if (isMPCycleLimitedNurse(nurseProps[other])) continue;
            if (
              !canRepairShiftChange(repaired, ctx, n, d, 'R') ||
              !canRepairShiftChange(repaired, ctx, other, d, shift)
            )
              continue;
            const candidate = deepCopy(repaired);
            candidate[n][d] = 'R';
            candidate[other][d] = shift;
            const score = computeScore(candidate, ctx);
            if (
              (score.hard < currentScore.hard || score.total < currentScore.total) &&
              (!best ||
                score.hard < best.score.hard ||
                (score.hard === best.score.hard && score.total < best.score.total))
            ) {
              best = { schedule: candidate, score };
            }
          }
        }

        // Week-segment swap: exchange the deficit week between this nurse and a
        // nurse with spare rest in the same week. The window is extended at both
        // edges so that no night block (N-S-R-R with its lead-in) is cut in half.
        // Daily coverage of every shift is unchanged by construction; residual
        // structural damage is rejected by the score check.
        if (!best) {
          const weekStart = weekDays[0];
          const weekEnd = weekDays[weekDays.length - 1];
          for (let o = 0; o < numNurses; o++) {
            // The donor only needs some rest in this week — the score check decides
            // whether the exchange is a net improvement (window extension can bring
            // additional rest days in from the adjacent weeks). Rigid-matrix M/P
            // nurses never donate: swapping their window would eat the R-R pair
            // of the mandatory 5+2 cycle.
            if (o === n || countWeekRest(repaired, o, weekDays) === 0) continue;
            if (isMPCycleLimitedNurse(nurseProps[o])) continue;

            // Extend the window left past S / mandatory-R cells (block started
            // earlier) and one extra day past a leading N (its lead-in shifts).
            let a = weekStart;
            let guard = 12;
            while (guard-- > 0) {
              const before = a;
              const inBlock = x =>
                repaired[x][a] === 'S' || (repaired[x][a] === 'R' && isMandatoryNightRestDay(repaired, ctx, x, a));
              while (a > 0 && (inBlock(n) || inBlock(o))) a--;
              if (a > 0 && (repaired[n][a] === 'N' || repaired[o][a] === 'N')) a--;
              if (a === before) break;
            }
            // Extend the window right while a block continues past the edge.
            let b = weekEnd;
            while (b < ctx.numDays - 1) {
              const continues = x =>
                repaired[x][b + 1] === 'S' ||
                (repaired[x][b + 1] === 'R' && isMandatoryNightRestDay(repaired, ctx, x, b + 1));
              if (continues(n) || continues(o)) b++;
              else break;
            }

            let compatible = true;
            for (let d = a; d <= b; d++) {
              if (pinned[n][d] || pinned[o][d]) {
                compatible = false;
                break;
              }
              const sn = repaired[n][d];
              const so = repaired[o][d];
              if (sn !== so && (!patternShiftAllowed(nurseProps[o], sn) || !patternShiftAllowed(nurseProps[n], so))) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
            const candidate = deepCopy(repaired);
            for (let d = a; d <= b; d++) {
              candidate[n][d] = repaired[o][d];
              candidate[o][d] = repaired[n][d];
            }
            const score = computeScore(candidate, ctx);
            if (
              (score.hard < currentScore.hard || score.total < currentScore.total) &&
              (!best ||
                score.hard < best.score.hard ||
                (score.hard === best.score.hard && score.total < best.score.total))
            ) {
              best = { schedule: candidate, score };
            }
          }
        }

        // Last resort: move one of the nurse's own night blocks into the deficit
        // week (bringing its mandatory rest tail along) and immediately let the
        // coverage repairs absorb the holes left behind, scoring the compound
        // result as a single candidate.
        if (!best && compoundBudget > 0) {
          const nStarts = [];
          for (let dd = 0; dd < ctx.numDays; dd++) if (repaired[n][dd] === 'N') nStarts.push(dd);
          compound: for (const d of weekDays) {
            for (const dN of nStarts) {
              if (weekDays.includes(dN)) continue;
              const step1 = relocateNightBlock(repaired, ctx, n, dN, d);
              if (!step1) continue;
              if (--compoundBudget < 0) break compound;
              const step2 = repairDayCoverage(repairNightCoverage(step1, ctx, 4), ctx);
              const score = computeScore(step2, ctx);
              // Compound candidates must strictly reduce hard violations: total-only
              // improvements here just churn the schedule without fixing the deficit.
              if (score.hard < currentScore.hard) {
                best = { schedule: step2, score };
                break compound;
              }
            }
          }
        }

        // Deficit-transfer swap: when the nurse cannot take nights (or has none to
        // move), hand a work day to a donor whose rest we take — the donor then
        // absorbs the transferred deficit by pulling one of their own night blocks
        // (with its rest tail) into this same week.
        if (!best && compoundBudget > 0) {
          transfer: for (const d of weekDays) {
            const shift = repaired[n][d];
            if (shift !== 'M' && shift !== 'P' && shift !== 'D') continue;
            if (!canRepairShiftChange(repaired, ctx, n, d, 'R')) continue;
            for (let o = 0; o < numNurses; o++) {
              if (o === n || repaired[o][d] !== 'R' || pinned[o][d]) continue;
              if (isMPCycleLimitedNurse(nurseProps[o])) continue;
              if (isMandatoryNightRestDay(repaired, ctx, o, d)) continue;
              if (!canRepairShiftChange(repaired, ctx, o, d, shift)) continue;
              const oStarts = [];
              for (let dd = 0; dd < ctx.numDays; dd++) {
                if (repaired[o][dd] === 'N' && !weekDays.includes(dd)) oStarts.push(dd);
              }
              if (!oStarts.length) continue;
              const swapped = deepCopy(repaired);
              swapped[n][d] = 'R';
              swapped[o][d] = shift;
              for (const dN of oStarts) {
                for (const dT of weekDays) {
                  if (dT === d) continue;
                  const moved = relocateNightBlock(swapped, ctx, o, dN, dT);
                  if (!moved) continue;
                  if (--compoundBudget < 0) break transfer;
                  const repairedCand = repairDayCoverage(repairNightCoverage(moved, ctx, 4), ctx);
                  const score = computeScore(repairedCand, ctx);
                  if (score.hard < currentScore.hard) {
                    best = { schedule: repairedCand, score };
                    break transfer;
                  }
                }
              }
            }
          }
        }

        if (best) {
          for (let row = 0; row < numNurses; row++) repaired[row] = best.schedule[row];
          changed = true;
          break outer;
        }
      }
    }
  }

  return repaired;
}

/**
 * Fix rest EXCESS: weekly rests above the cap ("solo 2 riposi a settimana") and
 * runs of more than MAX_CONSECUTIVE_REST consecutive R days. Surplus rest days
 * are converted into shifts when the day has coverage headroom, otherwise handed
 * same-day to a nurse whose week can absorb one more rest. Score-guided.
 */
function repairRestExcess(schedule, ctx) {
  const { numDays, numNurses, nurseProps, minRPerWeek, weekDaysList, weekOf, maxCovM, maxCovP, maxCovD, pinned } = ctx;
  const repaired = deepCopy(schedule);

  function weekAllowed(wDays) {
    // One extra rest above the weekly minimum is tolerated (soft), two are hard:
    // the repair brings weeks back under the hard cap and, when it can do so at
    // no cost, down to the minimum via the score-guided acceptance.
    return requiredRest(wDays.length, minRPerWeek) + 1;
  }

  function runLenAt(n, d) {
    let run = 1;
    for (let k = d - 1; k >= 0 && repaired[n][k] === 'R'; k--) run++;
    for (let k = d + 1; k < numDays && repaired[n][k] === 'R'; k++) run++;
    return run;
  }

  function acceptCandidate(mutate) {
    const currentScore = computeScore(repaired, ctx);
    const candidate = deepCopy(repaired);
    mutate(candidate);
    const score = computeScore(candidate, ctx);
    if (score.hard < currentScore.hard || (score.hard === currentScore.hard && score.total < currentScore.total)) {
      for (let row = 0; row < numNurses; row++) repaired[row] = candidate[row];
      return true;
    }
    return false;
  }

  function tryConvert(n, d) {
    const cov = dayCoverage(repaired, d, numNurses);
    const options = [];
    if (cov.D < maxCovD && cov.M < maxCovM && cov.P < maxCovP) options.push('D');
    if (cov.M < maxCovM) options.push('M');
    if (cov.P < maxCovP) options.push('P');
    for (const s of options) {
      if (!canRepairShiftChange(repaired, ctx, n, d, s)) continue;
      if (acceptCandidate(c => (c[n][d] = s))) return true;
    }
    return false;
  }

  function trySwapSameDay(n, d) {
    const wDays = weekDaysList[weekOf(d)];
    for (let o = 0; o < numNurses; o++) {
      if (o === n || pinned[o][d]) continue;
      const shift = repaired[o][d];
      if (shift !== 'M' && shift !== 'P' && shift !== 'D') continue;
      if (countWeekRest(repaired, o, wDays) >= weekAllowed(wDays)) continue;
      if (!canRepairShiftChange(repaired, ctx, o, d, 'R')) continue;
      if (!canRepairShiftChange(repaired, ctx, n, d, shift)) continue;
      if (
        acceptCandidate(c => {
          c[o][d] = 'R';
          c[n][d] = shift;
        })
      )
        return true;
    }
    return false;
  }

  function fixableRestDay(n, d) {
    return repaired[n][d] === 'R' && !pinned[n][d] && !isMandatoryNightRestDay(repaired, ctx, n, d);
  }

  // Rests that count toward the weekly excess: mandatory night-block rests of
  // diurni_e_notturni nurses (rigid D-N-S-R-R matrix) are exempt, mirroring
  // computeScore/collectViolations.
  function countDiscretionaryWeekRest(n, wDays) {
    let c = 0;
    const exemptBlockRests = needsSecondNightRest(nurseProps[n]);
    for (const d of wDays) {
      if (repaired[n][d] !== 'R') continue;
      if (exemptBlockRests && isNightBlockRestDay(repaired, ctx, n, d)) continue;
      c++;
    }
    return c;
  }

  for (let n = 0; n < numNurses; n++) {
    if (isMPCycleLimitedNurse(nurseProps[n])) continue;

    // 1) Weekly excess: bring every week back to its rest cap, starting from the
    //    rest day inside the longest consecutive run.
    if (minRPerWeek > 0) {
      for (const wDays of weekDaysList) {
        const allowed = weekAllowed(wDays);
        let guard = wDays.length;
        while (countDiscretionaryWeekRest(n, wDays) > allowed && guard-- > 0) {
          const days = wDays.filter(d => fixableRestDay(n, d)).sort((a, b) => runLenAt(n, b) - runLenAt(n, a));
          let progressed = false;
          for (const d of days) {
            if (tryConvert(n, d) || trySwapSameDay(n, d)) {
              progressed = true;
              break;
            }
          }
          if (!progressed) break;
        }
      }
    }

    // 2) Residual runs of 3+ consecutive R (possibly spanning week boundaries).
    for (let d = 0; d < numDays; d++) {
      if (repaired[n][d] !== 'R') continue;
      let end = d;
      while (end + 1 < numDays && repaired[n][end + 1] === 'R') end++;
      let guard = end - d + 1;
      while (end - d + 1 > MAX_CONSECUTIVE_REST && guard-- > 0) {
        let progressed = false;
        for (let k = d; k <= end; k++) {
          if (!fixableRestDay(n, k)) continue;
          if (tryConvert(n, k) || trySwapSameDay(n, k)) {
            progressed = true;
            break;
          }
        }
        if (!progressed) break;
        while (d <= end && repaired[n][d] !== 'R') d++;
        end = d;
        while (end + 1 < numDays && repaired[n][end + 1] === 'R') end++;
      }
      d = end;
    }
  }

  return repaired;
}

function trySwapMove(schedule, ctx, changes) {
  const { numDays, numNurses, pinned, nurseProps } = ctx;
  const d = Math.floor(Math.random() * numDays);
  const n1 = Math.floor(Math.random() * numNurses);
  const n2 = Math.floor(Math.random() * numNurses);
  if (n1 === n2) return false;
  if (isMPCycleLimitedNurse(nurseProps[n1]) || isMPCycleLimitedNurse(nurseProps[n2])) return false;
  if (pinned[n1][d] || pinned[n2][d]) return false;
  const s1 = schedule[n1][d],
    s2 = schedule[n2][d];
  if (s1 === s2) return false;
  if (s1 === 'R' && isMandatoryNightRestDay(schedule, ctx, n1, d)) return false;
  if (s2 === 'R' && isMandatoryNightRestDay(schedule, ctx, n2, d)) return false;
  if (s2 === 'R' && isOptionalRestAfterNSR(schedule, ctx, n1, d)) return false;
  if (s1 === 'R' && isOptionalRestAfterNSR(schedule, ctx, n2, d)) return false;
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
  if (!canRepairShiftChange(schedule, ctx, n1, d, s2)) return false;
  if (!canRepairShiftChange(schedule, ctx, n2, d, s1)) return false;
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
  if (isMPCycleLimitedNurse(nurseProps[n])) return false;
  if (pinned[n][d]) return false;
  const old = schedule[n][d];
  if (old === 'R' && isMandatoryNightRestDay(schedule, ctx, n, d)) return false;
  if (old !== 'R' && isOptionalRestAfterNSR(schedule, ctx, n, d)) return false;
  if (old === 'N' || old === 'S') return false;
  if (nurseProps[n].soloMattine) return false;
  // solo_diurni: can only change to D or R
  if (nurseProps[n].soloDiurni) {
    const choices = ['D', 'R'].filter(s => s !== old);
    shuffle(choices);
    for (const s of choices) {
      if (s === 'D' && dayCoverage(schedule, d, numNurses).D >= ctx.maxCovD) continue;
      if (!canRepairShiftChange(schedule, ctx, n, d, s)) continue;
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
      if (s === 'D' && dayCoverage(schedule, d, numNurses).D >= ctx.maxCovD) continue;
      if (!canRepairShiftChange(schedule, ctx, n, d, s)) continue;
      setCell(schedule, n, d, s, changes);
      return true;
    }
    return false;
  }
  const choices = ['M', 'P', 'R'].filter(s => s !== old);
  if (!nurseProps[n].noDiurni && old !== 'D' && dayCoverage(schedule, d, numNurses).D < ctx.maxCovD) choices.push('D');
  shuffle(choices);
  for (const s of choices) {
    if (!canRepairShiftChange(schedule, ctx, n, d, s)) continue;
    setCell(schedule, n, d, s, changes);
    return true;
  }
  return false;
}

function tryEquityMove(schedule, ctx, changes, cachedHours, dayIndices) {
  const {
    numDays,
    numNurses,
    pinned,
    nurseProps,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minRPerWeek,
    weekDaysList,
    weekOf,
    consente2D,
    hourDeltas,
    monthlyTargetHours,
  } = ctx;
  const n = Math.floor(Math.random() * numNurses);
  if (isMPCycleLimitedNurse(nurseProps[n])) return false;
  if (nurseProps[n].soloMattine || nurseProps[n].soloNotti) return false;

  // Use cached hours: O(numNurses) instead of O(numNurses × numDays)
  const h = cachedHours ? cachedHours[n] : nurseHours(schedule, n, numDays);
  // Per-nurse target adjusted by previous month delta
  const target = monthlyTargetHours + (hourDeltas ? hourDeltas[n] || 0 : 0);

  const isDiurniOnly = nurseProps[n].soloDiurni || nurseProps[n].diurniENotturni;

  // Reuse pre-allocated day indices array instead of allocating new ones
  const days = dayIndices ? shuffle([...dayIndices]) : shuffle(Array.from({ length: numDays }, (_, i) => i));

  if (h > target + EQUITY_THRESHOLD_HOURS) {
    for (const d of days) {
      if (pinned[n][d]) continue;
      const s = schedule[n][d];
      if (isDiurniOnly) {
        if (s !== 'D') continue;
        const cov = dayCoverage(schedule, d, numNurses);
        if (cov.M <= minCovM || cov.P <= minCovP) continue;
      } else {
        if (s !== 'M' && s !== 'P') continue;
        if (isOptionalRestAfterNSR(schedule, ctx, n, d)) continue;
        const cov = dayCoverage(schedule, d, numNurses);
        if ((s === 'M' ? cov.M : cov.P) <= (s === 'M' ? ctx.minCovM : ctx.minCovP)) continue;
      }
      if (!canRepairShiftChange(schedule, ctx, n, d, 'R')) continue;
      setCell(schedule, n, d, 'R', changes);
      return true;
    }
  } else if (h < target - EQUITY_THRESHOLD_HOURS) {
    for (const d of days) {
      if (pinned[n][d] || schedule[n][d] !== 'R') continue;
      if (isMandatoryNightRestDay(schedule, ctx, n, d)) continue;
      if (minRPerWeek > 0) {
        const wIdx = weekOf(d);
        const wDays = weekDaysList[wIdx];
        if (countWeekRest(schedule, n, wDays) <= requiredRest(wDays.length, minRPerWeek)) continue;
      }
      const prev = d > 0 ? schedule[n][d - 1] : null;
      const next = d < numDays - 1 ? schedule[n][d + 1] : null;
      if (isDiurniOnly) {
        const covUp = dayCoverage(schedule, d, numNurses);
        if (covUp.D >= ctx.maxCovD || covUp.M >= maxCovM || covUp.P >= maxCovP) continue;
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
          if (!keepsNightLeadIns(schedule, ctx, n, d, s)) continue;
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
    if (isMPCycleLimitedNurse(nurseProps[n])) continue;
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
          if (isMPCycleLimitedNurse(nurseProps[o])) continue;
          if (pinned[o][d] || schedule[o][d] !== 'R') continue;
          if (isMandatoryNightRestDay(schedule, ctx, o, d)) continue;
          if (
            nurseProps[o].soloMattine ||
            nurseProps[o].soloDiurni ||
            nurseProps[o].soloNotti ||
            nurseProps[o].diurniENotturni
          )
            continue;
          // Check other nurse doesn't go below weekly rest minimum
          const oHave = countWeekRest(schedule, o, wDays);
          const oNeed = requiredRest(wDays.length, minRPerWeek);
          if (oHave <= oNeed) continue;
          // Check tag constraints
          if (sN === 'D' && nurseProps[o].noDiurni) continue;
          // Check transitions for both
          const prevN = d > 0 ? schedule[n][d - 1] : null,
            nextN = d < numDays - 1 ? schedule[n][d + 1] : null;
          const prevO = d > 0 ? schedule[o][d - 1] : null,
            nextO = d < numDays - 1 ? schedule[o][d + 1] : null;
          if (!transitionOk(prevN, 'R', ctx, schedule, n, d)) continue;
          if (!transitionOk('R', nextN, ctx, schedule, n, d + 1)) continue;
          if (!transitionOk(prevO, sN, ctx, schedule, o, d)) continue;
          if (!transitionOk(sN, nextO, ctx, schedule, o, d + 1)) continue;
          if (!keepsNightLeadIns(schedule, ctx, n, d, 'R')) continue;
          if (!keepsNightLeadIns(schedule, ctx, o, d, sN)) continue;
          setCell(schedule, n, d, 'R', changes);
          setCell(schedule, o, d, sN, changes);
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Swap the night blocks of two nurses (n1's block moves to n2's start day and
 * vice versa). Daily night coverage is unchanged, but the mandatory rest tails
 * move with the blocks — this is the only move that can shift N/S cells, and it
 * lets the annealer fix weekly-rest deficits and night fairness that the
 * cell-level moves cannot reach.
 */
function tryNightBlockSwapMove(schedule, ctx, changes) {
  const { numDays, numNurses } = ctx;
  const n1 = Math.floor(Math.random() * numNurses);
  const n2 = Math.floor(Math.random() * numNurses);
  if (n1 === n2) return false;
  const starts1 = [];
  const starts2 = [];
  for (let d = 0; d < numDays; d++) {
    if (schedule[n1][d] === 'N') starts1.push(d);
    if (schedule[n2][d] === 'N') starts2.push(d);
  }
  if (!starts1.length || !starts2.length) return false;
  const d1 = starts1[Math.floor(Math.random() * starts1.length)];
  const d2 = starts2[Math.floor(Math.random() * starts2.length)];
  if (d1 === d2) return false;
  const step1 = relocateNightBlock(schedule, ctx, n1, d1, d2);
  if (!step1) return false;
  const step2 = relocateNightBlock(step1, ctx, n2, d2, d1);
  if (!step2) return false;
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] !== step2[n][d]) setCell(schedule, n, d, step2[n][d], changes);
    }
  }
  return changes.length > 0;
}

function tryCoppiaTurniMove(schedule, ctx, changes, cachedHours) {
  const { numDays, numNurses, pinned, coppiaTurni, minCovM, minCovP } = ctx;
  if (!coppiaTurni || !Array.isArray(coppiaTurni) || coppiaTurni.length !== 2) return false;
  const [n1, n2] = coppiaTurni;
  if (n1 < 0 || n1 >= numNurses || n2 < 0 || n2 >= numNurses) return false;

  // Find a divergent day and bring n2 in sync with n1 (n1 is the master)
  const days = shuffle(Array.from({ length: numDays }, (_, i) => i));
  for (const d of days) {
    if (schedule[n1][d] === schedule[n2][d]) continue;
    if (pinned[n1][d] || pinned[n2][d]) continue;

    const s1 = schedule[n1][d];
    const s2 = schedule[n2][d];

    const prevN2 = d > 0 ? schedule[n2][d - 1] : null;
    const nextN2 = d < numDays - 1 ? schedule[n2][d + 1] : null;

    if (!transitionOk(prevN2, s1, ctx, schedule, n2, d)) continue;
    if (nextN2 !== null && !transitionOk(s1, nextN2, ctx, schedule, n2, d + 1)) continue;

    // Ensure removing s2 from n2 doesn't drop coverage below minimum
    const cov = dayCoverage(schedule, d, numNurses);
    if (s2 === 'M' && cov.M <= minCovM) continue;
    if (s2 === 'P' && cov.P <= minCovP) continue;
    if (s2 === 'N' && cov.N <= ctx.minCovN) continue;

    changes.push({ n: n2, d, old: s2 });
    schedule[n2][d] = s1;
    if (cachedHours) {
      cachedHours[n2] += (SHIFT_HOURS[s1] || 0) - (SHIFT_HOURS[s2] || 0);
    }
    return true;
  }
  return false;
}

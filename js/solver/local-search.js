/**
 * @file local-search.js — Simulated annealing local search + move functions
 * @description Improves a constructed schedule via adaptive simulated annealing
 * with four move types: swap, change, equity, and weekly rest.
 */

'use strict';

/* global canAssignRestrictedNoDiurniRest, computeScore, countWeekRest, dayCoverage, deepCopy */
/* global getRestPromotionPriority, isForbiddenExtraNightRestDay, isForbiddenRestrictedNoDiurniRestDay */
/* global isMPCycleLimitedNurse, isMandatoryNightRestDay */
/* global isOptionalRestAfterNSR, isSplitRestDay, requiredRest, transitionOk */

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
    { attempts: 0, accepts: 0, weight: 0.4 }, // 2: equity (aumentato)
    { attempts: 0, accepts: 0, weight: 0.2 }, // 3: weekly rest
    { attempts: 0, accepts: 0, weight: 0.1 }, // 4: coppia turni (NUOVO)
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
            moveType = 3;
          }
        } else {
          moveType = 3;
        }
      } else {
        moveType = 3;
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
  // Sync finale coppia turni — forza n2 uguale a n1 prima della fase di repair
  if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [n1, n2] = ctx.coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        best[n2][d] = best[n1][d];
      }
    }
  }
  let repaired = deepCopy(best);
  for (let pass = 0; pass < 2; pass++) {
    const beforePass = repaired.map(row => row.join('|')).join('\n');
    repaired = repairNightCoverage(repaired, ctx);
    repaired = repairNightRestContinuity(repaired, ctx);
    repaired = repairForbiddenExtraNightRest(repaired, ctx);
    repaired = repairForbiddenRestrictedNoDiurniRest(repaired, ctx);
    repaired = repairSplitRestDays(repaired, ctx);
    repaired = repairDayCoverage(repaired, ctx);
    repaired = repairWeeklyRestDeficits(repaired, ctx);
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
    if (!excesses.length) break;

    const targetDays = deficits.length
      ? deficits
      : Array.from({ length: numDays }, (_, d) => d).filter(
          d => !excesses.includes(d) && dayCoverage(current, d, numNurses).N < maxCovN
        );
    if (!targetDays.length) break;

    let bestCandidate = null;
    for (const targetDay of targetDays) {
      const orderedExcesses = [...excesses].sort((a, b) => Math.abs(a - targetDay) - Math.abs(b - targetDay));
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

  const noDiurni = nurseProps[nurseIdx].noDiurni;
  const oldDays = getNightBlockDays(oldStart, noDiurni, numDays);
  const oldDaySet = new Set(oldDays);
  const newDays = getNightBlockDays(newStart, noDiurni, numDays);
  for (const d of oldDays) {
    if (pinned[nurseIdx][d]) return null;
  }

  const candidate = deepCopy(schedule);
  for (const d of oldDays) candidate[nurseIdx][d] = 'R';

  for (const d of newDays) {
    if (pinned[nurseIdx][d] && !oldDaySet.has(d)) return null;
    if (!oldDaySet.has(d)) {
      const existing = candidate[nurseIdx][d];
      if (existing !== null && existing !== 'R') return null;
    }
  }

  placeNightBlock(candidate, nurseIdx, newStart, noDiurni, numDays);
  return candidate;
}

function getNightBlockDays(start, noDiurni, numDays) {
  const days = [start];
  if (start + 1 < numDays) days.push(start + 1);
  if (start + 2 < numDays) days.push(start + 2);
  if (!noDiurni && start + 3 < numDays) days.push(start + 3);
  return days;
}

function placeNightBlock(schedule, nurseIdx, start, noDiurni, numDays) {
  schedule[nurseIdx][start] = 'N';
  if (start + 1 < numDays) schedule[nurseIdx][start + 1] = 'S';
  if (start + 2 < numDays) schedule[nurseIdx][start + 2] = 'R';
  if (!noDiurni && start + 3 < numDays) schedule[nurseIdx][start + 3] = 'R';
}

function repairNightRestContinuity(schedule, ctx) {
  const { numDays, numNurses, pinned, nurseProps, minCovM, minCovP } = ctx;
  const repaired = deepCopy(schedule);

  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].noDiurni) continue;
    for (let d = 0; d < numDays - 3; d++) {
      if (repaired[n][d] !== 'N' || repaired[n][d + 1] !== 'S' || repaired[n][d + 2] !== 'R') continue;
      if (repaired[n][d + 3] === 'R' || pinned[n][d + 3]) continue;
      const shift = repaired[n][d + 3];
      const cov = dayCoverage(repaired, d + 3, numNurses);
      if (shift === 'M' && cov.M <= minCovM) continue;
      if (shift === 'P' && cov.P <= minCovP) continue;
      if (shift === 'D' && (cov.M <= minCovM || cov.P <= minCovP)) continue;
      if (!canRepairShiftChange(repaired, ctx, n, d + 3, 'R')) continue;
      repaired[n][d + 3] = 'R';
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

function canRepairShiftChange(schedule, ctx, n, d, nextShift) {
  const { numDays, pinned, nurseProps } = ctx;
  if (pinned[n][d] || schedule[n][d] === nextShift) return false;
  if (isMPCycleLimitedNurse(nurseProps[n])) return false;
  if (!isRepairShiftAllowed(nurseProps[n], nextShift)) return false;
  if (nextShift === 'R' && isForbiddenExtraNightRestDay(schedule, ctx, n, d)) return false;
  if (nextShift !== 'R' && schedule[n][d] === 'R' && isMandatoryNightRestDay(schedule, ctx, n, d)) return false;
  if (nextShift === 'R' && isOptionalRestAfterNSR(schedule, ctx, n, d)) return false;
  const prev = d > 0 ? schedule[n][d - 1] : null;
  const next = d < numDays - 1 ? schedule[n][d + 1] : null;
  if (!transitionOk(prev, nextShift, ctx, schedule, n, d)) return false;
  if (!transitionOk(nextShift, next, ctx, schedule, n, d + 1)) return false;
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

  function canPromoteRest(n, d, shiftType) {
    if (repaired[n][d] !== 'R' || pinned[n][d]) return false;
    if (isMandatoryNightRestDay(repaired, ctx, n, d)) return false;
    if (isMPCycleLimitedNurse(nurseProps[n])) return false;
    if (!hasSpareWeeklyRest(n, d)) return false;
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].soloNotti ||
      nurseProps[n].diurniENotturni
    )
      return false;
    const prev = d > 0 ? repaired[n][d - 1] : null;
    const next = d < numDays - 1 ? repaired[n][d + 1] : null;
    return transitionOk(prev, shiftType, ctx, repaired, n, d) && transitionOk(shiftType, next, ctx, repaired, n, d + 1);
  }

  function bestOverCoverageFix(d, focusShift) {
    const currentScore = computeScore(repaired, ctx);
    const candidates = [];
    for (let n = 0; n < numNurses; n++) {
      const currentShift = repaired[n][d];
      const options =
        focusShift === 'M'
          ? currentShift === 'M'
            ? ['P', 'R']
            : currentShift === 'D'
              ? ['P', 'R']
              : []
          : currentShift === 'P'
            ? ['M', 'R']
            : currentShift === 'D'
              ? ['M', 'R']
              : [];
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

  function promoteRestDay(d, shiftType) {
    const candidates = shuffle(Array.from({ length: numNurses }, (_, i) => i))
      .filter(n => canPromoteRest(n, d, shiftType))
      .sort((a, b) => {
        const aPriority = getRestPromotionPriority(nurseProps[a]);
        const bPriority = getRestPromotionPriority(nurseProps[b]);
        if (aPriority !== bPriority) return aPriority - bPriority;
        const aMp = countMP(a);
        const bMp = countMP(b);
        const aDiff = Math.abs(aMp.m + (shiftType === 'M' ? 1 : 0) - (aMp.p + (shiftType === 'P' ? 1 : 0)));
        const bDiff = Math.abs(bMp.m + (shiftType === 'M' ? 1 : 0) - (bMp.p + (shiftType === 'P' ? 1 : 0)));
        if (aDiff !== bDiff) return aDiff - bDiff;
        return (SHIFT_HOURS[repaired[a][d]] || 0) - (SHIFT_HOURS[repaired[b][d]] || 0);
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
    if (nurseProps[n].noDiurni && !canAssignRestrictedNoDiurniRest(repaired, ctx, n, d)) return false;
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

  let changed = true;
  while (changed) {
    changed = false;
    const currentScore = computeScore(repaired, ctx);
    outer: for (let n = 0; n < numNurses; n++) {
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
          for (let other = 0; other < numNurses; other++) {
            if (other === n || repaired[other][d] !== 'R' || pinned[other][d]) continue;
            if (!hasSpareWeeklyRest(other, weekDays)) continue;
            if (isMPCycleLimitedNurse(nurseProps[other])) continue;
            if (nurseProps[other].noDiurni && !canAssignRestrictedNoDiurniRest(repaired, ctx, other, d)) continue;
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
      if (!canRepairShiftChange(schedule, ctx, n, d, s)) continue;
      setCell(schedule, n, d, s, changes);
      return true;
    }
    return false;
  }
  const choices = ['M', 'P', 'R'].filter(s => s !== old);
  if (!nurseProps[n].noDiurni && old !== 'D') choices.push('D');
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
          setCell(schedule, n, d, 'R', changes);
          setCell(schedule, o, d, sN, changes);
          return true;
        }
      }
    }
  }
  return false;
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

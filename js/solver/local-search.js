/**
 * @file local-search.js — Simulated annealing local search + move functions
 * @description Improves a constructed schedule via adaptive simulated annealing
 * with four move types: swap, change, equity, and weekly rest.
 */

'use strict';

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
    { attempts: 0, accepts: 0, weight: 0.25 }, // 0: swap
    { attempts: 0, accepts: 0, weight: 0.2 }, // 1: change
    { attempts: 0, accepts: 0, weight: 0.3 }, // 2: equity
    { attempts: 0, accepts: 0, weight: 0.25 }, // 3: weekly rest
  ];
  const ADAPT_INTERVAL = 500; // recalculate weights every N iterations
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
    const temp = 2000 * (1 - fraction);

    changes.length = 0;

    // Adaptive move selection with hard-violation priority
    let moveType;
    if (currentScore.hard > 0 && Math.random() < 0.3) {
      moveType = 3; // weekly rest fix when hard violations exist
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
  const s1 = schedule[n1][d],
    s2 = schedule[n2][d];
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
  const prev1 = d > 0 ? schedule[n1][d - 1] : null,
    next1 = d < numDays - 1 ? schedule[n1][d + 1] : null;
  const prev2 = d > 0 ? schedule[n2][d - 1] : null,
    next2 = d < numDays - 1 ? schedule[n2][d + 1] : null;
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
  } = ctx;
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

  // Per-nurse target adjusted by previous month delta
  const target = avg + (hourDeltas ? hourDeltas[n] || 0 : 0);

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
  } else if (h < target - EQUITY_THRESHOLD_HOURS) {
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

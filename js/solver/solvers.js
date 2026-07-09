/**
 * @file solvers.js — heuristic / pattern solver orchestration
 * @description Runs the greedy + simulated-annealing heuristic and the pattern
 * planners, and orchestrates the multi-solution generation pipeline.
 *
 * The previous MILP back-ends (HiGHS WASM and GLPK.js) were removed: in practice
 * they were never used (the heuristic and pattern planners are what produce the
 * schedules), so the app now relies solely on the in-worker heuristics.
 */

'use strict';

// ---------------------------------------------------------------------------
// Standalone heuristic (greedy + simulated annealing)
// ---------------------------------------------------------------------------

function solveFallback(config) {
  const ctx = buildContext(config);

  let bestSchedule = null;
  let bestScore = { total: Infinity, hard: Infinity, soft: Infinity };

  for (let r = 0; r < NUM_RESTARTS; r++) {
    progress(5 + Math.floor(r * (80 / NUM_RESTARTS)), `Tentativo ${r + 1}/${NUM_RESTARTS}…`);

    const schedule = construct(ctx);
    // The standalone fallback path has no time-budgeted polish loop, so give local
    // search a deeper pass to converge more reliably toward 0 violations.
    const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS * 4);
    const score = computeScore(improved, ctx);

    if (score.total < bestScore.total) {
      bestSchedule = improved;
      bestScore = score;
    }

    // Early exit when no hard violations remain and soft penalty is low
    if (bestScore.hard === 0 && bestScore.soft < 40) break;
  }

  // Iterated local search: when hard violations remain, the best schedule is a
  // fixed point for the repair chain — kick it with a burst of random (structurally
  // legal, score-blind) moves, re-anneal, and keep the result only when better.
  for (let polish = 0; polish < 10 && bestScore.hard > 0; polish++) {
    progress(80 + polish, `Rifinitura ${polish + 1}/10…`);
    const kicked = deepCopy(bestSchedule);
    const kickChanges = [];
    // Night-block swaps shake the night alignment (the structure cell-level moves
    // can never reach); a few cell moves add small-scale diversity on top.
    for (let k = 0; k < 10; k++) {
      kickChanges.length = 0;
      tryNightBlockSwapMove(kicked, ctx, kickChanges);
    }
    for (let k = 0; k < 20; k++) {
      kickChanges.length = 0;
      if (Math.random() < 0.5) trySwapMove(kicked, ctx, kickChanges);
      else tryChangeMove(kicked, ctx, kickChanges);
    }
    const improved = localSearch(kicked, ctx, LOCAL_SEARCH_ITERS * 2);
    const score = computeScore(improved, ctx);
    if (score.total < bestScore.total) {
      bestSchedule = improved;
      bestScore = score;
    }
  }

  progress(90, 'Validazione…');

  const violations = collectViolations(bestSchedule, ctx);
  const stats = computeStats(bestSchedule, ctx);

  progress(100, 'Fatto!');
  return { schedule: bestSchedule, violations, stats, score: bestScore.total };
}

// ---------------------------------------------------------------------------
// Main solver — async, with configurable algorithm selection
// ---------------------------------------------------------------------------

/**
 * Multi-solution solver with configurable algorithm: Pattern Beam / night-first
 * Pattern Beam / night-only / heuristic (greedy + simulated annealing).
 * @param {object} config
 * @param {number} numSolutions
 * @param {number} timeBudget  – total seconds allocated; 0 or undefined = default
 * @param {boolean} untilZeroViolations – keep generating until a 0-violation solution is found
 * @param {string} solverChoice – 'auto'|'pattern'|'night_first_pattern'|'night_only'|'fallback'
 */
async function solve(config, numSolutions, timeBudget, untilZeroViolations, solverChoice) {
  solverChoice = solverChoice || 'auto';
  numSolutions = Math.max(1, Math.min(numSolutions || 1, 20));
  // Night-only mode is deterministic (no diversity seeds): a single grid is produced
  // and the user fills mornings/afternoons by hand, so looping for zero violations
  // would never terminate (M/P are intentionally left uncovered).
  if (solverChoice === 'night_only') {
    numSolutions = 1;
    untilZeroViolations = false;
  }
  const totalBudget = timeBudget && timeBudget > 0 ? timeBudget : MILP_DEFAULT_TOTAL_TIME_BUDGET;
  const ctx = buildContext(config);
  const solutions = [];
  // Diagnostics are still returned for API compatibility with the worker/UI, but the
  // pure-heuristic pipeline does not normally surface any.
  const diagnostics = [];

  console.log(
    `[Solver] Starting solve: solverChoice="${solverChoice}", numSolutions=${numSolutions}, timeBudget=${totalBudget}s, untilZeroViolations=${untilZeroViolations}`
  );
  console.log(
    `[Solver] Problem: ${ctx.numNurses} nurses, ${ctx.numDays} days, coverage M:${ctx.minCovM}-${ctx.maxCovM} P:${ctx.minCovP}-${ctx.maxCovP} N:${ctx.minCovN}-${ctx.maxCovN} D:${ctx.minCovD}-${ctx.maxCovD}`
  );

  /** Generate one batch of solutions */
  async function generateBatch(batchSolutions, batchLabel, seedOffset) {
    const perSolutionBudgetSec = Math.max(1, totalBudget / numSolutions);

    for (let i = 0; i < numSolutions; i++) {
      const pctBase = 5 + Math.floor((i * 80) / numSolutions);
      const seed = seedOffset + i;
      let solved = false;

      console.log(`[Solver] === Solution ${i + 1}/${numSolutions} (seed=${seed}) ===`);

      // Night-only manual mode: cover nights + fixed nurses, leave M/P blank
      if (solverChoice === 'night_only' && !solved) {
        progress(pctBase, `${batchLabel}Solo notti: copertura notturna (mattine/pomeriggi manuali)…`);
        const nightOnlyStart = Date.now();
        const result = solveNightOnly(config);
        const nightOnlyElapsed = (Date.now() - nightOnlyStart) / 1000;
        console.log(
          `[Solver] Night-only solution: score=${result.score}, violations=${result.violations.length}, elapsed=${nightOnlyElapsed.toFixed(2)}s`
        );
        batchSolutions.push({ ...result, solverMethod: 'night_only' });
        solved = true;
      }

      // Night-first Pattern Beam planner
      if (solverChoice === 'night_first_pattern' && !solved) {
        progress(pctBase, `${batchLabel}Night-first Pattern Beam: soluzione ${i + 1}/${numSolutions}…`);
        const nightFirstStart = Date.now();
        const result = solveNightFirstPattern(config, perSolutionBudgetSec);
        const nightFirstElapsed = (Date.now() - nightFirstStart) / 1000;
        console.log(
          `[Solver] Night-first Pattern Beam solution: score=${result.score}, violations=${result.violations.length}, elapsed=${nightFirstElapsed.toFixed(2)}s`
        );
        batchSolutions.push({ ...result, solverMethod: 'night_first_pattern' });
        solved = true;
      }

      // Pattern Beam planner
      if (solverChoice === 'pattern' && !solved) {
        progress(pctBase, `${batchLabel}Pattern Beam: soluzione ${i + 1}/${numSolutions}…`);
        const patternStart = Date.now();
        const result = solvePattern(config, perSolutionBudgetSec);
        const patternElapsed = (Date.now() - patternStart) / 1000;
        console.log(
          `[Solver] Pattern Beam solution: score=${result.score}, violations=${result.violations.length}, elapsed=${patternElapsed.toFixed(2)}s`
        );
        batchSolutions.push({ ...result, solverMethod: 'pattern' });
        solved = true;
      }

      // 'auto': portfolio — run the night-first Pattern Beam, the plain Pattern Beam
      // and the heuristic on a split budget, keep the best schedule (fewer hard
      // violations first, then total score). Each planner dominates on different
      // rosters: night-first on D/N-heavy ERs, the plain beam on M/P/N cyclic
      // rosters, the heuristic on small or unusual instances.
      if (solverChoice === 'auto' && !solved) {
        progress(pctBase, `${batchLabel}Auto (portfolio pattern + euristica): soluzione ${i + 1}/${numSolutions}…`);
        const autoStart = Date.now();
        const candidates = [];
        {
          const result = solveNightFirstPattern(config, perSolutionBudgetSec * 0.4);
          candidates.push({
            ...result,
            solverMethod: 'night_first_pattern',
            _score: computeScore(result.schedule, ctx),
          });
        }
        {
          const result = solvePattern(config, perSolutionBudgetSec * 0.3);
          candidates.push({ ...result, solverMethod: 'pattern', _score: computeScore(result.schedule, ctx) });
        }
        {
          const improved = localSearch(construct(ctx), ctx, LOCAL_SEARCH_ITERS, perSolutionBudgetSec * 0.3);
          const hScore = computeScore(improved, ctx);
          candidates.push({
            schedule: improved,
            violations: collectViolations(improved, ctx),
            stats: computeStats(improved, ctx),
            score: hScore.total,
            solverMethod: 'fallback',
            _score: hScore,
          });
        }
        candidates.sort((a, b) => a._score.hard - b._score.hard || a._score.total - b._score.total);
        const bestCandidate = candidates[0];
        const elapsed = (Date.now() - autoStart) / 1000;
        console.log(
          `[Solver] Auto portfolio (${elapsed.toFixed(1)}s): ` +
            candidates
              .map(c => `${c.solverMethod} hard=${c._score.hard} total=${Math.round(c._score.total)}`)
              .join(' | ')
        );
        delete bestCandidate._score;
        batchSolutions.push(bestCandidate);
        solved = true;
      }

      // Heuristic (greedy + simulated annealing) — used for 'fallback' and any
      // unrecognised choice (including legacy 'milp'/'glpk' values saved in localStorage).
      if (!solved) {
        progress(pctBase, `${batchLabel}Euristica: soluzione ${i + 1}/${numSolutions}…`);
        const schedule = construct(ctx);
        const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, perSolutionBudgetSec);
        const violations = collectViolations(improved, ctx);
        const stats = computeStats(improved, ctx);
        const score = computeScore(improved, ctx);
        console.log(
          `[Solver] Heuristic solution: score=${score.total} (hard=${score.hard}, soft=${score.soft}), violations=${violations.length}`
        );
        batchSolutions.push({ schedule: improved, violations, stats, score: score.total, solverMethod: 'fallback' });
      }
    }
  }

  // Status message
  if (solverChoice === 'pattern') {
    progress(5, 'Pattern Beam selezionato manualmente…');
  } else if (solverChoice === 'night_first_pattern') {
    progress(5, 'Night-first Pattern Beam selezionato manualmente…');
  } else if (solverChoice === 'night_only') {
    progress(5, 'Modalità solo notti: copertura notturna, mattine/pomeriggi manuali…');
  } else if (solverChoice === 'auto') {
    progress(5, `Auto (night-first Pattern Beam + euristica, vince la migliore): ${numSolutions} soluzioni…`);
  } else {
    progress(5, `Euristica (greedy + simulated annealing): ${numSolutions} soluzioni…`);
  }

  if (untilZeroViolations) {
    console.log('[Solver] Mode: untilZeroViolations — will loop until 0-violation solution found');
    const startTime = Date.now();
    let round = 1;
    let foundZero = false;
    while (!foundZero) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed >= UNTIL_ZERO_MAX_TIME) {
        console.warn(`[Solver] Max time reached (${Math.round(elapsed)}s / ${UNTIL_ZERO_MAX_TIME}s). Stopping.`);
        progress(90, `Tempo massimo raggiunto (${Math.round(elapsed)}s). Uso miglior soluzione trovata.`);
        break;
      }
      const prevLen = solutions.length;
      console.log(`[Solver] Round #${round}, elapsed=${elapsed.toFixed(1)}s, solutions so far=${solutions.length}`);
      progress(5, `Tentativo #${round} — ricerca soluzione senza violazioni…`);
      await generateBatch(solutions, `[#${round}] `, (round - 1) * numSolutions);
      for (let j = prevLen; j < solutions.length; j++) {
        if (solutions[j].violations.length === 0) {
          console.log(`[Solver] Found 0-violation solution at index ${j} (method: ${solutions[j].solverMethod})`);
          foundZero = true;
          break;
        }
      }
      round++;
    }
  } else {
    await generateBatch(solutions, '', 0);
  }

  // Sort by score (best first)
  solutions.sort((a, b) => a.score - b.score);

  console.log(`[Solver] Final results: ${solutions.length} solutions generated`);
  solutions.forEach((sol, idx) => {
    console.log(
      `[Solver]   #${idx + 1}: method=${sol.solverMethod}, score=${sol.score}, violations=${sol.violations.length}`
    );
  });

  progress(95, 'Validazione…');
  progress(100, 'Fatto!');

  return { solutions, diagnostics };
}

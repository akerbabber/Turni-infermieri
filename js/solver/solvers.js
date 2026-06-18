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
// Diagnostics helpers
// ---------------------------------------------------------------------------

/**
 * Build a structured diagnostic entry that can be propagated from the worker
 * to the main thread and rendered in the UI.
 * @param {string} source - Diagnostic origin ('solver', 'worker').
 * @param {string} phase - Pipeline stage ('solve', 'fallback', etc.).
 * @param {string} code - Stable machine-readable code for the failure/warning type.
 * @param {string} severity - 'info' | 'warning' | 'error'.
 * @param {string} userMessage - User-facing message shown in the UI.
 * @param {string} detail - Debug-oriented detail for logs and diagnostic panels.
 * @param {object} extra - Optional extra metadata merged into the diagnostic object.
 * @returns {object}
 */
function makeDiagnostic(source, phase, code, severity, userMessage, detail, extra) {
  return {
    source,
    phase,
    code,
    severity,
    userMessage,
    detail: detail || '',
    ...(extra || {}),
  };
}

function makeSolverError(message, diagnostics, code) {
  const err = new Error(message);
  err.code = code || 'solver_error';
  err.diagnostics = Array.isArray(diagnostics) ? diagnostics : [];
  return err;
}

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

      // Heuristic (greedy + simulated annealing) — used for 'auto', 'fallback' and any
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

  // Reference makeDiagnostic/makeSolverError so they remain part of the module's
  // public surface for the worker even though the heuristic path rarely fails.
  void makeDiagnostic;
  void makeSolverError;

  progress(95, 'Validazione…');
  progress(100, 'Fatto!');

  return { solutions, diagnostics };
}

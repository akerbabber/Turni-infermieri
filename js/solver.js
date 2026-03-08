/**
 * @file solver.js — Web Worker entry point for nursing shift scheduling
 * @description Runs in a Web Worker context (no DOM access).
 * @version 2.0.0
 *
 * Loads modular solver components via importScripts() and wires up
 * the Worker message interface. No build step required.
 *
 * Module load order (dependency chain):
 *   1. constants.js  — SHIFT_HOURS, utilities (shuffle, dayOfWeek, etc.)
 *   2. context.js    — buildContext, getAbsenceShift
 *   3. scoring.js    — transitionOk, dayCoverage, computeScore, collectViolations, computeStats
 *   4. construct.js  — construct (greedy heuristic), trySwapMP
 *   5. local-search.js — localSearch, move functions (setCell, trySwap/Change/Equity/WeeklyRest)
 *   6. lp-model.js   — buildLP, parseSolution, lpToGLPKModel, parseGLPKSolution
 *   7. solvers.js    — loadHiGHS, loadGLPK, solveOneMILP, solveOneGLPK, solveFallback, solve
 *
 * Communication with main thread via postMessage/onmessage:
 *   IN:  {type: 'solve', config, numSolutions, timeBudget, solverMethod}
 *   OUT: {type: 'progress'|'result'|'error', ...}
 */

'use strict';

// ---------------------------------------------------------------------------
// Progress helper (must be defined before modules that reference it)
// ---------------------------------------------------------------------------

function progress(percent, message) {
  self.postMessage({ type: 'progress', percent, message });
}

// ---------------------------------------------------------------------------
// Load solver modules in dependency order
// ---------------------------------------------------------------------------

importScripts(
  'solver/constants.js',
  'solver/context.js',
  'solver/scoring.js',
  'solver/construct.js',
  'solver/local-search.js',
  'solver/lp-model.js',
  'solver/solvers.js'
);

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

self.onmessage = async function (e) {
  if (e.data.type === 'solve') {
    console.log(
      '[Worker] Received solve message:',
      JSON.stringify({
        solverChoice: e.data.solverChoice,
        numSolutions: e.data.numSolutions,
        timeBudget: e.data.timeBudget,
        untilZeroViolations: e.data.untilZeroViolations,
        numNurses: e.data.config?.nurses?.length,
      })
    );
    try {
      const numSolutions = e.data.numSolutions || 1;
      const timeBudget = e.data.timeBudget || 0;
      const untilZeroViolations = !!e.data.untilZeroViolations;
      const solverChoice = e.data.solverChoice || 'auto';
      const solutions = await solve(e.data.config, numSolutions, timeBudget, untilZeroViolations, solverChoice);
      const best = solutions[0] || {};
      console.log(
        `[Worker] Solve complete: ${solutions.length} solutions, best method="${best.solverMethod}", best score=${best.score}`
      );
      self.postMessage({
        type: 'result',
        schedule: best.schedule,
        violations: best.violations || [],
        stats: best.stats || [],
        solutions: solutions,
        solverMethod: best.solverMethod || 'fallback',
      });
    } catch (err) {
      console.error('[Worker] Solve failed with uncaught exception:', err.message, err.stack);
      self.postMessage({ type: 'error', message: err.message });
    }
  } else if (e.data.type === 'rebalance') {
    // Rebalance: take existing schedule and optimise it via local search
    console.log('[Worker] Received rebalance message');
    try {
      progress(5, 'Riassegnazione turni in corso…');
      const ctx = buildContext(e.data.config);
      const schedule = e.data.schedule;
      const timeBudget = e.data.timeBudget || 15;

      progress(10, 'Ottimizzazione locale…');
      const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, timeBudget);

      progress(90, 'Validazione…');
      const violations = collectViolations(improved, ctx);
      const stats = computeStats(improved, ctx);
      const score = computeScore(improved, ctx);

      progress(100, 'Fatto!');
      self.postMessage({
        type: 'result',
        schedule: improved,
        violations: violations,
        stats: stats,
        solutions: [{ schedule: improved, violations, stats, score: score.total, solverMethod: 'rebalance' }],
        solverMethod: 'rebalance',
      });
    } catch (err) {
      console.error('[Worker] Rebalance failed:', err.message, err.stack);
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

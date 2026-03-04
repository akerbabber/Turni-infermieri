'use strict';

/**
 * @file benchmark.test.js — Benchmark: Heuristic (construct + local search) solver
 *
 * Runs the heuristic path across multiple realistic scenarios and reports:
 *   - construct() time
 *   - localSearch() time
 *   - Final score (hard + soft)
 *   - Violation count
 *   - Per-restart variance
 *
 * Usage:
 *   node --test test/benchmark.test.js
 *   node test/benchmark.test.js          # direct execution for raw output
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Helper: load solver modules into a sandboxed context
// ---------------------------------------------------------------------------

function loadSolver() {
  const moduleFiles = [
    'solver/constants.js',
    'solver/context.js',
    'solver/scoring.js',
    'solver/construct.js',
    'solver/local-search.js',
    'solver/lp-model.js',
    'solver/solvers.js',
  ];

  const context = {
    self: {},
    console,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Error,
    TypeError,
    RangeError,
    Infinity,
    NaN,
    undefined,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    importScripts: () => {},
    postMessage: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL: typeof URL !== 'undefined' ? URL : undefined,
  };

  vm.createContext(context);
  vm.runInContext('function progress() {}', context);

  const jsDir = path.join(__dirname, '..', 'js');
  for (const file of moduleFiles) {
    const code = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  return context;
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  const numNurses = overrides.numNurses ?? 37;
  const nurses = [];
  for (let i = 0; i < numNurses; i++) {
    const nurseOverride = (overrides.nurseOverrides && overrides.nurseOverrides[i]) || {};
    nurses.push({
      name: `Infermiere ${i + 1}`,
      tags: [],
      absencePeriods: {},
      ...nurseOverride,
    });
  }
  return {
    year: overrides.year ?? 2026,
    month: overrides.month ?? 2, // March 2026 (0-indexed)
    nurses,
    rules: {
      minCoverageM: 4,
      maxCoverageM: 6,
      minCoverageP: 4,
      maxCoverageP: 6,
      minCoverageD: 0,
      maxCoverageD: 2,
      minCoverageN: 2,
      maxCoverageN: 3,
      targetNights: 3,
      maxNights: 5,
      minRPerWeek: 2,
      preferDiurni: false,
      coppiaTurni: null,
      consente2DiurniConsecutivi: false,
      consentePomeriggioDiurno: false,
      minGap11h: false,
      ...(overrides.rules || {}),
    },
  };
}

const SCENARIOS = [
  {
    name: 'Small (8 nurses, Jan, no D)',
    config: makeConfig({
      numNurses: 8,
      month: 0, // January
      rules: {
        minCoverageM: 2,
        maxCoverageM: 3,
        minCoverageP: 2,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 2,
        targetNights: 3,
        maxNights: 5,
        minRPerWeek: 1,
      },
    }),
  },
  {
    name: 'Medium (20 nurses, Feb, with D)',
    config: makeConfig({
      numNurses: 20,
      month: 1, // February
      rules: {
        minCoverageM: 3,
        maxCoverageM: 5,
        minCoverageP: 3,
        maxCoverageP: 5,
        minCoverageD: 1,
        maxCoverageD: 2,
        minCoverageN: 2,
        maxCoverageN: 3,
        targetNights: 3,
        maxNights: 5,
        minRPerWeek: 2,
        preferDiurni: true,
      },
    }),
  },
  {
    name: 'Real-world (37 nurses, Mar, full constraints)',
    config: makeConfig({
      numNurses: 37,
      month: 2, // March
      nurseOverrides: {
        0: { tags: ['solo_mattine'] },
        1: { tags: ['solo_notti'] },
        2: { tags: ['no_notti'] },
        3: { tags: ['diurni_e_notturni'] },
        4: { tags: ['ferie'], absencePeriods: { ferie: { start: '2026-03-10', end: '2026-03-20' } } },
        5: { tags: ['malattia'], absencePeriods: { malattia: { start: '2026-03-01', end: '2026-03-07' } } },
      },
      rules: {
        minCoverageM: 4,
        maxCoverageM: 6,
        minCoverageP: 4,
        maxCoverageP: 6,
        minCoverageD: 1,
        maxCoverageD: 3,
        minCoverageN: 2,
        maxCoverageN: 3,
        targetNights: 3,
        maxNights: 5,
        minRPerWeek: 2,
        preferDiurni: true,
      },
    }),
  },
  {
    name: 'Real-world + D-D + P->D relaxed (37 nurses)',
    config: makeConfig({
      numNurses: 37,
      month: 2,
      nurseOverrides: {
        0: { tags: ['solo_mattine'] },
        1: { tags: ['solo_notti'] },
        2: { tags: ['no_notti'] },
        3: { tags: ['diurni_e_notturni'] },
        4: { tags: ['no_diurni'] },
      },
      rules: {
        minCoverageM: 4,
        maxCoverageM: 6,
        minCoverageP: 4,
        maxCoverageP: 6,
        minCoverageD: 1,
        maxCoverageD: 3,
        minCoverageN: 2,
        maxCoverageN: 3,
        targetNights: 3,
        maxNights: 5,
        minRPerWeek: 2,
        preferDiurni: true,
        consente2DiurniConsecutivi: true,
        consentePomeriggioDiurno: true,
      },
    }),
  },
  {
    name: 'Stress test (50 nurses, tight coverage)',
    config: makeConfig({
      numNurses: 50,
      month: 0, // January (31 days)
      rules: {
        minCoverageM: 6,
        maxCoverageM: 8,
        minCoverageP: 6,
        maxCoverageP: 8,
        minCoverageD: 2,
        maxCoverageD: 4,
        minCoverageN: 3,
        maxCoverageN: 4,
        targetNights: 3,
        maxNights: 5,
        minRPerWeek: 2,
        preferDiurni: true,
      },
    }),
  },
];

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

let solver; // solver sandbox context

before(() => {
  solver = loadSolver();
});

/**
 * Run a single benchmark iteration: construct + localSearch + score
 */
function runHeuristic(ctx, scenario, localSearchIters, timeLimitSec) {
  const t0construct = Date.now();
  const schedule = solver.construct(ctx);
  const constructMs = Date.now() - t0construct;

  const t0ls = Date.now();
  const improved = solver.localSearch(schedule, ctx, localSearchIters, timeLimitSec);
  const lsMs = Date.now() - t0ls;

  const score = solver.computeScore(improved, ctx);
  const violations = solver.collectViolations(improved, ctx);
  const stats = solver.computeStats(improved, ctx);

  // Compute hours spread
  const hours = [];
  for (let n = 0; n < ctx.numNurses; n++) {
    hours.push(solver.nurseHours(improved, n, ctx.numDays));
  }
  const avgHours = hours.reduce((a, b) => a + b, 0) / hours.length;
  const maxHourDev = Math.max(...hours.map(h => Math.abs(h - avgHours)));

  return {
    constructMs,
    lsMs,
    totalMs: constructMs + lsMs,
    hard: score.hard,
    soft: score.soft,
    total: score.total,
    violationCount: violations.length,
    avgHours: avgHours.toFixed(1),
    maxHourDev: maxHourDev.toFixed(1),
  };
}

/**
 * Run N restarts and aggregate results for a scenario
 */
function benchmarkScenario(scenario, restarts, localSearchIters, timeLimitSec) {
  const ctx = solver.buildContext(scenario.config);
  const results = [];

  for (let r = 0; r < restarts; r++) {
    results.push(runHeuristic(ctx, scenario, localSearchIters, timeLimitSec));
  }

  // Aggregate
  const best = results.reduce((a, b) => (a.total < b.total ? a : b));
  const worst = results.reduce((a, b) => (a.total > b.total ? a : b));
  const avgTotal = results.reduce((a, b) => a + b.total, 0) / results.length;
  const avgHard = results.reduce((a, b) => a + b.hard, 0) / results.length;
  const avgSoft = results.reduce((a, b) => a + b.soft, 0) / results.length;
  const avgTime = results.reduce((a, b) => a + b.totalMs, 0) / results.length;
  const avgConstructTime = results.reduce((a, b) => a + b.constructMs, 0) / results.length;
  const avgLsTime = results.reduce((a, b) => a + b.lsMs, 0) / results.length;
  const zeroViolationRuns = results.filter(r => r.violationCount === 0).length;

  return {
    scenario: scenario.name,
    nurses: scenario.config.nurses.length,
    days: ctx.numDays,
    restarts,
    localSearchIters,
    timeLimitSec,
    best,
    worst,
    avgTotal: avgTotal.toFixed(1),
    avgHard: avgHard.toFixed(2),
    avgSoft: avgSoft.toFixed(1),
    avgTimeMs: avgTime.toFixed(0),
    avgConstructMs: avgConstructTime.toFixed(0),
    avgLocalSearchMs: avgLsTime.toFixed(0),
    zeroViolationRuns,
    zeroViolationRate: `${zeroViolationRuns}/${restarts}`,
    allResults: results,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Benchmark: Heuristic solver (construct + localSearch)', () => {
  const ALL_RESULTS = [];

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}`, { timeout: 120000 }, () => {
      // Phase 1: construct only (no local search)
      const ctxOnly = solver.buildContext(scenario.config);
      const t0 = Date.now();
      const rawSchedule = solver.construct(ctxOnly);
      const constructOnlyMs = Date.now() - t0;
      const rawScore = solver.computeScore(rawSchedule, ctxOnly);
      const rawViolations = solver.collectViolations(rawSchedule, ctxOnly);

      // Phase 2: construct + localSearch (5 restarts, 4000 iters, 5s limit)
      const result = benchmarkScenario(scenario, 5, 4000, 5);

      ALL_RESULTS.push({
        ...result,
        constructOnly: {
          timeMs: constructOnlyMs,
          hard: rawScore.hard,
          soft: rawScore.soft,
          total: rawScore.total,
          violations: rawViolations.length,
        },
      });

      // Print results
      console.log(`\n${'='.repeat(70)}`);
      console.log(`  SCENARIO: ${scenario.name}`);
      console.log(`  ${scenario.config.nurses.length} nurses, ${ctxOnly.numDays} days`);
      console.log(`${'='.repeat(70)}`);
      console.log(`  CONSTRUCT ONLY:`);
      console.log(`    Time:       ${constructOnlyMs}ms`);
      console.log(`    Score:      ${rawScore.total} (hard=${rawScore.hard}, soft=${rawScore.soft})`);
      console.log(`    Violations: ${rawViolations.length}`);
      console.log(`  CONSTRUCT + LOCAL SEARCH (5 restarts, 4000 iters, 5s limit):`);
      console.log(
        `    Avg time:   ${result.avgTimeMs}ms (construct: ${result.avgConstructMs}ms, LS: ${result.avgLocalSearchMs}ms)`
      );
      console.log(`    Best score: ${result.best.total} (hard=${result.best.hard}, soft=${result.best.soft})`);
      console.log(`    Worst:      ${result.worst.total} (hard=${result.worst.hard}, soft=${result.worst.soft})`);
      console.log(`    Avg score:  ${result.avgTotal} (hard=${result.avgHard}, soft=${result.avgSoft})`);
      console.log(`    0-violation runs: ${result.zeroViolationRate}`);
      console.log(`    Best hours spread: avg=${result.best.avgHours}h, maxDev=±${result.best.maxHourDev}h`);
      console.log(`${'='.repeat(70)}\n`);

      // Basic sanity: construct + LS should improve over construct-only
      assert.ok(
        result.best.total <= rawScore.total,
        `Local search should improve or match construct-only score: ${result.best.total} <= ${rawScore.total}`
      );
    });
  }

  it('Summary table', { timeout: 5000 }, () => {
    if (ALL_RESULTS.length === 0) {
      console.log('No results collected (scenarios may have been skipped)');
      return;
    }

    console.log(`\n${'#'.repeat(80)}`);
    console.log('  BENCHMARK SUMMARY');
    console.log(`${'#'.repeat(80)}\n`);

    // Table header
    const header = [
      'Scenario'.padEnd(45),
      'Construct'.padStart(10),
      'C+LS Best'.padStart(10),
      'C+LS Avg'.padStart(10),
      'Avg ms'.padStart(8),
      '0-viol'.padStart(8),
    ].join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const r of ALL_RESULTS) {
      const row = [
        r.scenario.padEnd(45),
        String(r.constructOnly.total).padStart(10),
        String(r.best.total).padStart(10),
        String(r.avgTotal).padStart(10),
        String(r.avgTimeMs).padStart(8),
        r.zeroViolationRate.padStart(8),
      ].join(' | ');
      console.log(row);
    }

    console.log(`\n${'#'.repeat(80)}`);
    console.log('  INTERPRETATION GUIDE');
    console.log(`${'#'.repeat(80)}`);
    console.log('  Score = hard * 1000 + soft');
    console.log('  hard > 0 means constraint violations (coverage, transitions, rest)');
    console.log('  soft = equity penalties (hour fairness, night fairness, etc.)');
    console.log('  0-viol = runs where collectViolations() returned empty array');
    console.log('  Lower is better for all score metrics');
    console.log('');
    console.log('  Compare these heuristic results against HiGHS MILP in the browser');
    console.log('  benchmark (benchmark.html) to decide whether GLPK/fallback are needed.');
    console.log(`${'#'.repeat(80)}\n`);
  });
});

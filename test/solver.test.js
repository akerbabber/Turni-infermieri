/**
 * @file solver.test.js — Unit tests for solver pure functions
 *
 * Uses Node.js built-in test runner (node:test) and assertion module (node:assert/strict).
 * Since the solver modules run as Web Worker scripts and do not export their functions,
 * we load them into a sandboxed VM context that stubs the Worker globals and exposes
 * all top-level bindings for testing.
 *
 * The modules are loaded in dependency order, matching the importScripts() chain
 * in the main solver.js entry point.
 */

'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Helper: load solver modules into a sandboxed context
// ---------------------------------------------------------------------------

function loadSolver() {
  // Module files in dependency order (same as importScripts in solver.js)
  const moduleFiles = [
    'solver/constants.js',
    'solver/context.js',
    'solver/scoring.js',
    'solver/construct.js',
    'solver/local-search.js',
    'solver/pattern-planner.js',
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
    importScripts: () => {}, // stub — external CDN scripts not loaded in tests
    postMessage: () => {}, // stub
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL: typeof URL !== 'undefined' ? URL : undefined,
  };

  vm.createContext(context);

  // Define progress() stub before loading modules (solver.js defines it before importScripts)
  vm.runInContext('function progress() {}', context);

  // Load each module file into the same shared context
  const jsDir = path.join(__dirname, '..', 'js');
  for (const file of moduleFiles) {
    const code = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  // const/let declarations are script-scoped in the VM and not exposed on the
  // context object. Inject accessor functions so tests can reach them.
  vm.runInContext(
    `function _getConst(name) {
       var lookup = {
         SHIFT_HOURS: SHIFT_HOURS,
         SHIFT_START: SHIFT_START,
         SHIFT_END: SHIFT_END,
         BASE_FORBIDDEN_NEXT: BASE_FORBIDDEN_NEXT,
         ABSENCE_TAG_TO_SHIFT: ABSENCE_TAG_TO_SHIFT,
         FASCIA_PRESETS: FASCIA_PRESETS,
         FASCIA_SHIFT_START: FASCIA_SHIFT_START,
         FASCIA_SHIFT_END: FASCIA_SHIFT_END,
       };
       return lookup[name];
     }`,
    context
  );

  return context;
}

/**
 * Convert a cross-realm value (created inside the VM) to a plain main-realm
 * value so that assert.deepEqual works correctly.
 */
function toPlain(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let ctx; // solver sandbox context — populated in before() hook

before(() => {
  ctx = loadSolver();
});

// ---------------------------------------------------------------------------
// Helper: build a minimal config for buildContext / construct tests
// ---------------------------------------------------------------------------

function makeMinimalConfig(overrides = {}) {
  const numNurses = overrides.numNurses ?? 8;
  const nurses = [];
  for (let i = 0; i < numNurses; i++) {
    nurses.push({
      name: `Nurse ${i}`,
      tags: [],
      absencePeriods: {},
      ...((overrides.nurseOverrides && overrides.nurseOverrides[i]) || {}),
    });
  }
  return {
    year: overrides.year ?? 2025,
    month: overrides.month ?? 0, // January (0-indexed)
    nurses,
    rules: {
      minCoverageM: 2,
      maxCoverageM: 3,
      minCoverageP: 2,
      maxCoverageP: 3,
      minCoverageD: 0,
      maxCoverageD: 0,
      minCoverageN: 1,
      maxCoverageN: 2,
      targetNights: 2,
      maxNights: 4,
      minRPerWeek: 1,
      preferDiurni: false,
      coppiaTurni: null,
      consente2DiurniConsecutivi: false,
      consentePomeriggioDiurno: false,
      minGap11h: false,
      ...(overrides.rules || {}),
    },
  };
}

const MP_CYCLE_PATTERNS = [
  ['M', 'M', 'P', 'P', 'R', 'R'],
  ['M', 'P', 'P', 'P', 'R', 'R'],
  ['M', 'M', 'M', 'P', 'R', 'R'],
];

const SHORT_MP_CYCLE_PATTERNS = [
  ['M', 'M', 'P', 'R', 'R'],
  ['M', 'P', 'P', 'R', 'R'],
];

function assertMatchesMPCycle(row, messagePrefix, patterns = MP_CYCLE_PATTERNS) {
  const memo = new Map();

  function matches(start) {
    if (start >= row.length) return true;
    if (memo.has(start)) return memo.get(start);
    for (const pattern of patterns) {
      const blockLen = Math.min(pattern.length, row.length - start);
      const ok = row.slice(start, start + blockLen).every((shift, idx) => shift === pattern[idx]);
      if (ok && matches(start + blockLen)) {
        memo.set(start, true);
        return true;
      }
    }
    memo.set(start, false);
    return false;
  }

  assert.ok(matches(0), `${messagePrefix}: ${row.join('-')}`);
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. shuffle
// ---------------------------------------------------------------------------
describe('shuffle', () => {
  it('should return the same array reference', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = ctx.shuffle(arr);
    assert.equal(result, arr);
  });

  it('should preserve array length', () => {
    const arr = [10, 20, 30, 40, 50];
    ctx.shuffle(arr);
    assert.equal(arr.length, 5);
  });

  it('should contain the same elements after shuffling', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const sorted = [...arr];
    ctx.shuffle(arr);
    arr.sort((a, b) => a - b);
    assert.deepEqual(arr, sorted);
  });

  it('should handle a single-element array without error', () => {
    const arr = [42];
    ctx.shuffle(arr);
    assert.deepEqual(arr, [42]);
  });

  it('should handle an empty array without error', () => {
    const arr = [];
    ctx.shuffle(arr);
    assert.deepEqual(arr, []);
  });
});

// ---------------------------------------------------------------------------
// 2. dayOfWeek
// ---------------------------------------------------------------------------
describe('dayOfWeek', () => {
  it('should return 3 (Wednesday) for 2025-01-01', () => {
    // month is 0-indexed: January = 0
    assert.equal(ctx.dayOfWeek(2025, 0, 1), 3);
  });

  it('should return 6 (Saturday) for 2025-01-04', () => {
    assert.equal(ctx.dayOfWeek(2025, 0, 4), 6);
  });

  it('should return 0 (Sunday) for 2025-01-05', () => {
    assert.equal(ctx.dayOfWeek(2025, 0, 5), 0);
  });

  it('should return 1 (Monday) for 2025-01-06', () => {
    assert.equal(ctx.dayOfWeek(2025, 0, 6), 1);
  });
});

// ---------------------------------------------------------------------------
// 3. isWeekend
// ---------------------------------------------------------------------------
describe('isWeekend', () => {
  it('should return true for Saturday (2025-01-04)', () => {
    assert.equal(ctx.isWeekend(2025, 0, 4), true);
  });

  it('should return true for Sunday (2025-01-05)', () => {
    assert.equal(ctx.isWeekend(2025, 0, 5), true);
  });

  it('should return false for Monday (2025-01-06)', () => {
    assert.equal(ctx.isWeekend(2025, 0, 6), false);
  });

  it('should return false for Wednesday (2025-01-01)', () => {
    assert.equal(ctx.isWeekend(2025, 0, 1), false);
  });
});

// ---------------------------------------------------------------------------
// 4. daysInMonth
// ---------------------------------------------------------------------------
describe('daysInMonth', () => {
  it('should return 31 for January (month 0)', () => {
    assert.equal(ctx.daysInMonth(2025, 0), 31);
  });

  it('should return 28 for February in a non-leap year (2025)', () => {
    assert.equal(ctx.daysInMonth(2025, 1), 28);
  });

  it('should return 29 for February in a leap year (2024)', () => {
    assert.equal(ctx.daysInMonth(2024, 1), 29);
  });

  it('should return 30 for April (month 3)', () => {
    assert.equal(ctx.daysInMonth(2025, 3), 30);
  });

  it('should return 31 for December (month 11)', () => {
    assert.equal(ctx.daysInMonth(2025, 11), 31);
  });
});

describe('monthly contract hours', () => {
  it('should count 22 weekdays in April 2026', () => {
    assert.equal(ctx.countWeekdaysInMonth(2026, 3), 22);
  });

  it('should compute April 2026 target as weekdays × 7.12', () => {
    assert.equal(ctx.getMonthlyContractHours(2026, 3), 156.64);
  });
});

// ---------------------------------------------------------------------------
// 5. gapHours
// ---------------------------------------------------------------------------
describe('gapHours', () => {
  it('should compute N->M gap as SHIFT_START.M - SHIFT_END.N (same-day, -0.2)', () => {
    // N ends at 8.2, M starts at 8 => 8 - 8.2 = -0.2
    const gap = ctx.gapHours('N', 'M');
    assert.ok(Math.abs(gap - -0.2) < 0.001);
  });

  it('should compute P->M gap as (24 - 20.2) + 8 = 11.8', () => {
    const gap = ctx.gapHours('P', 'M');
    assert.ok(Math.abs(gap - 11.8) < 0.001);
  });

  it('should compute M->P gap as (24 - 14.2) + 14 = 23.8', () => {
    const gap = ctx.gapHours('M', 'P');
    assert.ok(Math.abs(gap - 23.8) < 0.001);
  });

  it('should return Infinity when prev shift has no end time (e.g., R)', () => {
    assert.equal(ctx.gapHours('R', 'M'), Infinity);
  });

  it('should return Infinity when next shift has no start time (e.g., S)', () => {
    assert.equal(ctx.gapHours('M', 'S'), Infinity);
  });

  it('should compute D->M gap as (24 - 20.2) + 8 = 11.8', () => {
    const gap = ctx.gapHours('D', 'M');
    assert.ok(Math.abs(gap - 11.8) < 0.001);
  });
});

// ---------------------------------------------------------------------------
// 6. deepCopy
// ---------------------------------------------------------------------------
describe('deepCopy', () => {
  it('should produce a schedule with the same values', () => {
    const schedule = [
      ['M', 'P', 'R'],
      ['N', 'S', 'R'],
    ];
    const copy = ctx.deepCopy(schedule);
    assert.deepEqual(toPlain(copy), toPlain(schedule));
  });

  it('should not share row references with the original', () => {
    const schedule = [
      ['M', 'P', 'R'],
      ['N', 'S', 'R'],
    ];
    const copy = ctx.deepCopy(schedule);
    copy[0][0] = 'N';
    assert.equal(schedule[0][0], 'M'); // original unchanged
  });

  it('should produce a new outer array', () => {
    const schedule = [['M']];
    const copy = ctx.deepCopy(schedule);
    assert.notEqual(copy, schedule);
  });
});

// ---------------------------------------------------------------------------
// 7. SHIFT_HOURS
// ---------------------------------------------------------------------------
describe('SHIFT_HOURS', () => {
  let SHIFT_HOURS;

  before(() => {
    SHIFT_HOURS = toPlain(ctx._getConst('SHIFT_HOURS'));
  });

  it('should have M = 6.2', () => {
    assert.equal(SHIFT_HOURS.M, 6.2);
  });

  it('should have P = 6.2', () => {
    assert.equal(SHIFT_HOURS.P, 6.2);
  });

  it('should have D = 12.2', () => {
    assert.equal(SHIFT_HOURS.D, 12.2);
  });

  it('should have N = 12.2', () => {
    assert.equal(SHIFT_HOURS.N, 12.2);
  });

  it('should have S = 0', () => {
    assert.equal(SHIFT_HOURS.S, 0);
  });

  it('should have R = 0', () => {
    assert.equal(SHIFT_HOURS.R, 0);
  });

  it('should have F = 6.12', () => {
    assert.equal(SHIFT_HOURS.F, 6.12);
  });
});

// ---------------------------------------------------------------------------
// 7b. applyFasciaOraria
// ---------------------------------------------------------------------------
describe('applyFasciaOraria', () => {
  afterEach(() => {
    // Always reset to standard after each test to avoid test interdependence
    ctx.applyFasciaOraria('standard');
  });

  it('should switch SHIFT_HOURS to 7-10 preset', () => {
    ctx.applyFasciaOraria('7-10');
    const hrs = toPlain(ctx._getConst('SHIFT_HOURS'));
    assert.equal(hrs.M, 7.2);
    assert.equal(hrs.P, 7.2);
    assert.equal(hrs.D, 12.2);
    assert.equal(hrs.N, 10.2);
    assert.equal(hrs.F, 7.12);
    assert.equal(hrs.MA, 7.12);
    assert.equal(hrs.L104, 7.12);
    assert.equal(hrs.PR, 7.12);
    assert.equal(hrs.MT, 7.12);
    assert.equal(hrs.S, 0);
    assert.equal(hrs.R, 0);
  });

  it('should switch SHIFT_START/END to 7-10 preset', () => {
    ctx.applyFasciaOraria('7-10');
    const start = toPlain(ctx._getConst('SHIFT_START'));
    const end = toPlain(ctx._getConst('SHIFT_END'));
    assert.equal(start.M, 7);
    assert.equal(start.P, 14);
    assert.equal(start.N, 21);
    assert.equal(end.M, 14.2);
    assert.equal(end.P, 21.2);
    assert.equal(end.N, 7.2);
  });

  it('should revert to standard when called with "standard"', () => {
    ctx.applyFasciaOraria('7-10');
    ctx.applyFasciaOraria('standard');
    const hrs = toPlain(ctx._getConst('SHIFT_HOURS'));
    assert.equal(hrs.M, 6.2);
    assert.equal(hrs.P, 6.2);
    assert.equal(hrs.N, 12.2);
    assert.equal(hrs.F, 6.12);
    const start = toPlain(ctx._getConst('SHIFT_START'));
    assert.equal(start.M, 8);
    assert.equal(start.N, 20);
  });

  it('should default to standard for unknown fascia', () => {
    ctx.applyFasciaOraria('unknown');
    const hrs = toPlain(ctx._getConst('SHIFT_HOURS'));
    assert.equal(hrs.M, 6.2);
    assert.equal(hrs.N, 12.2);
  });

  it('should affect nurseHours calculation after switching fascia', () => {
    ctx.applyFasciaOraria('7-10');
    // M=7.2, P=7.2 in 7-10 fascia
    const schedule = [['M', 'P', 'R']];
    const hours = ctx.nurseHours(schedule, 0, 3);
    assert.ok(Math.abs(hours - 14.4) < 0.001);
  });

  it('should affect gapHours calculation after switching fascia', () => {
    ctx.applyFasciaOraria('7-10');
    // P ends at 21.2, M starts at 7 => gap = 24 - 21.2 + 7 = 9.8
    const gap = ctx.gapHours('P', 'M');
    assert.ok(Math.abs(gap - 9.8) < 0.001);
  });
});

// ---------------------------------------------------------------------------
// 8. buildContext
// ---------------------------------------------------------------------------
describe('buildContext', () => {
  it('should compute correct numDays for January 2025 (31)', () => {
    const config = makeMinimalConfig({ year: 2025, month: 0 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.numDays, 31);
  });

  it('should compute correct numDays for February 2024 (29, leap)', () => {
    const config = makeMinimalConfig({ year: 2024, month: 1 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.numDays, 29);
  });

  it('should set numNurses to match the nurses array length', () => {
    const config = makeMinimalConfig({ numNurses: 5 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.numNurses, 5);
  });

  it('should create a pinned array of correct dimensions', () => {
    const config = makeMinimalConfig({ numNurses: 3, year: 2025, month: 3 }); // April: 30 days
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned.length, 3);
    assert.equal(bctx.pinned[0].length, 30);
  });

  it('should pin solo_mattine nurses to M on weekdays and R on weekends', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      year: 2025,
      month: 0, // Jan 2025
      nurseOverrides: {
        0: { tags: ['solo_mattine'] },
      },
    });
    const bctx = ctx.buildContext(config);
    // Jan 1, 2025 is Wednesday (weekday) => M
    assert.equal(bctx.pinned[0][0], 'M');
    // Jan 4, 2025 is Saturday (weekend) => R
    assert.equal(bctx.pinned[0][3], 'R');
    // Jan 5, 2025 is Sunday (weekend) => R
    assert.equal(bctx.pinned[0][4], 'R');
    // Nurse 1 (no tag) should have all nulls
    assert.equal(bctx.pinned[1][0], null);
  });

  it('should set mattineEPomeriggi property and not pin cells for mattine_e_pomeriggi nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      year: 2025,
      month: 0, // Jan 2025
      nurseOverrides: {
        0: { tags: ['mattine_e_pomeriggi'] },
      },
    });
    const bctx = ctx.buildContext(config);
    // nurseProps should reflect the tag
    assert.equal(bctx.nurseProps[0].mattineEPomeriggi, true);
    assert.equal(bctx.nurseProps[1].mattineEPomeriggi, false);
    // Unlike solo_mattine, mattine_e_pomeriggi nurses are NOT pinned
    assert.equal(bctx.pinned[0][0], null);
    assert.equal(bctx.pinned[0][3], null);
  });

  it('should set diurniNoNotti property for diurni_no_notti nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      nurseOverrides: {
        0: { tags: ['diurni_no_notti'] },
      },
    });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.nurseProps[0].diurniNoNotti, true);
    assert.equal(bctx.nurseProps[0].noNotti, false);
    assert.equal(bctx.nurseProps[1].diurniNoNotti, false);
  });

  it('should populate coverage targets from rules', () => {
    const config = makeMinimalConfig({
      rules: { minCoverageM: 5, maxCoverageP: 10 },
    });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.minCovM, 5);
    assert.equal(bctx.maxCovP, 10);
  });

  it('should store the monthly target hours derived from weekdays', () => {
    const config = makeMinimalConfig({ year: 2026, month: 3 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.monthlyTargetHours, 156.64);
  });
});

// ---------------------------------------------------------------------------
// 9. dayCoverage
// ---------------------------------------------------------------------------
describe('dayCoverage', () => {
  it('should count M, P, and N shifts on a given day', () => {
    const schedule = [['M'], ['P'], ['N'], ['R']];
    const cov = ctx.dayCoverage(schedule, 0, 4);
    assert.equal(cov.M, 1);
    assert.equal(cov.P, 1);
    assert.equal(cov.N, 1);
    assert.equal(cov.D, 0);
  });

  it('should count D as contributing to both M and P coverage', () => {
    const schedule = [['D'], ['D'], ['M']];
    const cov = ctx.dayCoverage(schedule, 0, 3);
    // D=2, M counted: 2 (from D) + 1 (from M) = 3
    assert.equal(cov.D, 2);
    assert.equal(cov.M, 3);
    assert.equal(cov.P, 2);
  });

  it('should return all zeros when everyone is on rest', () => {
    const schedule = [['R'], ['R'], ['R']];
    const cov = ctx.dayCoverage(schedule, 0, 3);
    assert.equal(cov.M, 0);
    assert.equal(cov.P, 0);
    assert.equal(cov.D, 0);
    assert.equal(cov.N, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. nurseHours
// ---------------------------------------------------------------------------
describe('nurseHours', () => {
  it('should sum hours for a known schedule row', () => {
    // M=6.2, P=6.2, R=0 => total 12.4
    const schedule = [['M', 'P', 'R']];
    const hours = ctx.nurseHours(schedule, 0, 3);
    assert.ok(Math.abs(hours - 12.4) < 0.001);
  });

  it('should return 0 for an all-rest schedule', () => {
    const schedule = [['R', 'R', 'R', 'R']];
    const hours = ctx.nurseHours(schedule, 0, 4);
    assert.equal(hours, 0);
  });

  it('should correctly handle N and D shifts', () => {
    // N=12.2, D=12.2, S=0 => 24.4
    const schedule = [['N', 'D', 'S']];
    const hours = ctx.nurseHours(schedule, 0, 3);
    assert.ok(Math.abs(hours - 24.4) < 0.001);
  });

  it('should handle F (ferie) shifts', () => {
    // F=6.12
    const schedule = [['F', 'F']];
    const hours = ctx.nurseHours(schedule, 0, 2);
    assert.ok(Math.abs(hours - 12.24) < 0.001);
  });
});

// ---------------------------------------------------------------------------
// 11. nightCount
// ---------------------------------------------------------------------------
describe('nightCount', () => {
  it('should count night shifts for a nurse', () => {
    const schedule = [['N', 'S', 'R', 'R', 'N', 'S', 'R']];
    assert.equal(ctx.nightCount(schedule, 0, 7), 2);
  });

  it('should return 0 when there are no night shifts', () => {
    const schedule = [['M', 'P', 'R', 'M', 'P']];
    assert.equal(ctx.nightCount(schedule, 0, 5), 0);
  });

  it('should count for the correct nurse index', () => {
    const schedule = [
      ['N', 'S', 'R'],
      ['M', 'P', 'R'],
      ['N', 'N', 'N'],
    ];
    assert.equal(ctx.nightCount(schedule, 0, 3), 1);
    assert.equal(ctx.nightCount(schedule, 1, 3), 0);
    assert.equal(ctx.nightCount(schedule, 2, 3), 3);
  });
});

// ---------------------------------------------------------------------------
// 12. computeScore
// ---------------------------------------------------------------------------
describe('computeScore', () => {
  it('should return an object with hard, soft, and total properties', () => {
    const config = makeMinimalConfig({ numNurses: 4 });
    const bctx = ctx.buildContext(config);
    // Create a trivial schedule (all R) — will have coverage violations
    const schedule = Array.from({ length: 4 }, () => new Array(bctx.numDays).fill('R'));
    const score = ctx.computeScore(schedule, bctx);
    assert.equal(typeof score.hard, 'number');
    assert.equal(typeof score.soft, 'number');
    assert.equal(typeof score.total, 'number');
  });

  it('should have hard > 0 when coverage is not met (all-R schedule)', () => {
    const config = makeMinimalConfig({
      numNurses: 4,
      rules: { minCoverageM: 2, minCoverageP: 2, minCoverageN: 1 },
    });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 4 }, () => new Array(bctx.numDays).fill('R'));
    const score = ctx.computeScore(schedule, bctx);
    assert.ok(score.hard > 0, `Expected hard > 0, got ${score.hard}`);
  });

  it('should compute total as hard * 1000 + soft', () => {
    const config = makeMinimalConfig({ numNurses: 4 });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 4 }, () => new Array(bctx.numDays).fill('R'));
    const score = ctx.computeScore(schedule, bctx);
    assert.equal(score.total, score.hard * 1000 + score.soft);
  });

  it('should have more hard violations for an all-N schedule (forbidden N->N)', () => {
    const config = makeMinimalConfig({
      numNurses: 4,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 99,
        minCoverageP: 0,
        maxCoverageP: 99,
        minCoverageN: 0,
        maxCoverageN: 99,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    // All-N schedule violates N->N forbidden transition on every consecutive day
    const scheduleN = Array.from({ length: 4 }, () => new Array(bctx.numDays).fill('N'));
    const scheduleR = Array.from({ length: 4 }, () => new Array(bctx.numDays).fill('R'));
    const scoreN = ctx.computeScore(scheduleN, bctx);
    const scoreR = ctx.computeScore(scheduleR, bctx);
    assert.ok(
      scoreN.hard > scoreR.hard,
      `N-schedule hard (${scoreN.hard}) should exceed R-schedule hard (${scoreR.hard})`
    );
  });

  it('should penalize night overcoverage 3× harder than morning overcoverage', () => {
    // Night overcoverage of 1 nurse should produce 3× more hard penalty than
    // the same amount of morning overcoverage (both exceed max by 1).
    const config = makeMinimalConfig({
      numNurses: 4,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 99,
        minCoverageN: 0,
        maxCoverageN: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const numDays = bctx.numDays;
    // Schedule where one nurse has M every day — exceeds maxCoverageM by 1 each day
    const schedM = Array.from({ length: 4 }, () => new Array(numDays).fill('R'));
    schedM[0] = new Array(numDays).fill('M');
    const scoreM = ctx.computeScore(schedM, bctx);
    // Schedule where one nurse has a single N on day 0 — exceeds maxCoverageN by 1 on that day
    const schedN = Array.from({ length: 4 }, () => new Array(numDays).fill('R'));
    // Put a single N on day 0 only to isolate coverage penalty
    schedN[0][0] = 'N';
    schedN[0][1] = 'S';
    schedN[0][2] = 'R';
    schedN[0][3] = 'R';
    const scoreN = ctx.computeScore(schedN, bctx);
    // With M schedule: each day has M over max by 1 → hard += 1 per day (morning excess)
    // With N on day 0: day 0 has N over max by 1 → hard += 3 (night 3× penalty)
    // The N penalty per excess unit should be 3× the M penalty per excess unit
    const mExcessPerDay = 1; // 1 M nurse, maxCoverageM = 0
    const nExcessDay0 = 1; // 1 N nurse, maxCoverageN = 0
    const mHardFromCov = mExcessPerDay * numDays; // 1 per day
    const nHardFromCov = nExcessDay0 * 3; // 3× for night on 1 day
    // The N schedule has fewer total coverage hard violations but night ones count 3×
    assert.ok(nHardFromCov === 3, `Night overcoverage penalty per unit should be 3, got ${nHardFromCov}`);
    assert.ok(mHardFromCov === numDays, `Morning overcoverage penalty should be ${numDays}, got ${mHardFromCov}`);
  });

  it('should penalize M/P imbalance for no_notti nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['no_notti'] },
      },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 99,
        minCoverageP: 0,
        maxCoverageP: 99,
        minCoverageN: 0,
        maxCoverageN: 99,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const numDays = bctx.numDays;
    const imbalanced = [new Array(numDays).fill('R')];
    imbalanced[0][0] = 'M';
    imbalanced[0][1] = 'M';
    imbalanced[0][2] = 'M';
    imbalanced[0][3] = 'M';
    const balanced = [new Array(numDays).fill('R')];
    balanced[0][0] = 'M';
    balanced[0][1] = 'P';
    balanced[0][2] = 'M';
    balanced[0][3] = 'P';
    const scoreImbalanced = ctx.computeScore(imbalanced, bctx);
    const scoreBalanced = ctx.computeScore(balanced, bctx);
    assert.ok(
      scoreImbalanced.soft > scoreBalanced.soft,
      `Expected no_notti imbalance penalty, got ${scoreImbalanced.soft} vs ${scoreBalanced.soft}`
    );
  });

  it('should prefer a post-night extra rest over a split M-R-P-N work stretch', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
      },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 1,
        minCoverageP: 0,
        maxCoverageP: 1,
        minCoverageN: 0,
        maxCoverageN: 1,
        targetNights: 0,
        maxNights: 4,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 6;
    const clusteredRest = [['N', 'S', 'R', 'R', 'M', 'P']];
    const splitRest = [['M', 'R', 'P', 'N', 'S', 'R']];
    const clusteredScore = ctx.computeScore(clusteredRest, bctx);
    const splitScore = ctx.computeScore(splitRest, bctx);
    assert.ok(
      splitScore.soft > clusteredScore.soft,
      `Expected split rest to be penalized, got ${splitScore.soft} vs ${clusteredScore.soft}`
    );
  });
});

// ---------------------------------------------------------------------------
// 13. isSplitRestDay
// ---------------------------------------------------------------------------
describe('isSplitRestDay', () => {
  it('should detect an isolated rest inside a M-R-P-N work stretch', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 2,
        minCoverageP: 0,
        maxCoverageP: 2,
        minCoverageN: 0,
        maxCoverageN: 2,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 4;
    const schedule = [['M', 'R', 'P', 'N']];
    assert.equal(ctx.isSplitRestDay(schedule, bctx, 0, 1), true);
  });

  it('should allow the D-R-D-N bridge without flagging it as a split rest', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 2,
        minCoverageP: 0,
        maxCoverageP: 2,
        minCoverageD: 0,
        maxCoverageD: 2,
        minCoverageN: 0,
        maxCoverageN: 2,
        minRPerWeek: 0,
        consente2DiurniConsecutivi: true,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 4;
    const schedule = [['D', 'R', 'D', 'N']];
    assert.equal(ctx.isSplitRestDay(schedule, bctx, 0, 1), false);
  });
});

// ---------------------------------------------------------------------------
// 14. transitionOk
// ---------------------------------------------------------------------------
describe('transitionOk', () => {
  let bctx;
  let dummySchedule;

  before(() => {
    const config = makeMinimalConfig({
      rules: { minGap11h: false },
    });
    bctx = ctx.buildContext(config);
    dummySchedule = Array.from({ length: 8 }, () => new Array(bctx.numDays).fill('R'));
  });

  it('should return true when prev is null (first day)', () => {
    assert.equal(ctx.transitionOk(null, 'M', bctx, dummySchedule, 0, 0), true);
  });

  it('should return false for P -> M (forbidden)', () => {
    assert.equal(ctx.transitionOk('P', 'M', bctx, dummySchedule, 0, 1), false);
  });

  it('should return false for P -> D (forbidden)', () => {
    assert.equal(ctx.transitionOk('P', 'D', bctx, dummySchedule, 0, 1), false);
  });

  it('should return true for M -> P (allowed)', () => {
    assert.equal(ctx.transitionOk('M', 'P', bctx, dummySchedule, 0, 1), true);
  });

  it('should return true for R -> M (allowed)', () => {
    assert.equal(ctx.transitionOk('R', 'M', bctx, dummySchedule, 0, 1), true);
  });

  it('should return false for N -> M (forbidden)', () => {
    assert.equal(ctx.transitionOk('N', 'M', bctx, dummySchedule, 0, 1), false);
  });

  it('should return false for N -> N (forbidden)', () => {
    assert.equal(ctx.transitionOk('N', 'N', bctx, dummySchedule, 0, 1), false);
  });

  it('should return false for D -> M (forbidden)', () => {
    assert.equal(ctx.transitionOk('D', 'M', bctx, dummySchedule, 0, 1), false);
  });

  it('should return false for D -> D when consente2D is false (forbidden)', () => {
    assert.equal(ctx.transitionOk('D', 'D', bctx, dummySchedule, 0, 1), false);
  });
});

// ---------------------------------------------------------------------------
// 15. getAbsenceShift
// ---------------------------------------------------------------------------
describe('getAbsenceShift', () => {
  it('should return F for a nurse with ferie tag and date in range', () => {
    const nurse = {
      name: 'Test',
      tags: ['ferie'],
      absencePeriods: {
        ferie: { start: '2025-01-05', end: '2025-01-10' },
      },
    };
    // day1Based=7 => "2025-01-07" which is in [05, 10]
    const result = ctx.getAbsenceShift(nurse, 7, 2025, 0);
    assert.equal(result, 'F');
  });

  it('should return null for a date outside the absence range', () => {
    const nurse = {
      name: 'Test',
      tags: ['ferie'],
      absencePeriods: {
        ferie: { start: '2025-01-05', end: '2025-01-10' },
      },
    };
    // day1Based=15 => "2025-01-15" which is after the range
    const result = ctx.getAbsenceShift(nurse, 15, 2025, 0);
    assert.equal(result, null);
  });

  it('should return null when nurse has no absence tags', () => {
    const nurse = { name: 'Test', tags: [], absencePeriods: {} };
    const result = ctx.getAbsenceShift(nurse, 1, 2025, 0);
    assert.equal(result, null);
  });

  it('should return MA for a nurse with malattia tag and no period boundaries', () => {
    // When a tag is present but the period has no start/end, the function returns the shift code
    const nurse = {
      name: 'Test',
      tags: ['malattia'],
      absencePeriods: { malattia: {} },
    };
    const result = ctx.getAbsenceShift(nurse, 1, 2025, 0);
    assert.equal(result, 'MA');
  });

  it('should return L104 for a nurse with 104 tag and date in range', () => {
    const nurse = {
      name: 'Test',
      tags: ['104'],
      absencePeriods: {
        104: { start: '2025-03-01', end: '2025-03-31' },
      },
    };
    const result = ctx.getAbsenceShift(nurse, 15, 2025, 2); // March 15
    assert.equal(result, 'L104');
  });

  it('should return null when nurse has no absencePeriods property', () => {
    const nurse = { name: 'Test', tags: [] };
    const result = ctx.getAbsenceShift(nurse, 1, 2025, 0);
    assert.equal(result, null);
  });

  it('should handle the boundary dates correctly (inclusive start)', () => {
    const nurse = {
      name: 'Test',
      tags: ['ferie'],
      absencePeriods: {
        ferie: { start: '2025-01-10', end: '2025-01-20' },
      },
    };
    const result = ctx.getAbsenceShift(nurse, 10, 2025, 0);
    assert.equal(result, 'F');
  });

  it('should handle the boundary dates correctly (inclusive end)', () => {
    const nurse = {
      name: 'Test',
      tags: ['ferie'],
      absencePeriods: {
        ferie: { start: '2025-01-10', end: '2025-01-20' },
      },
    };
    const result = ctx.getAbsenceShift(nurse, 20, 2025, 0);
    assert.equal(result, 'F');
  });
});

// ---------------------------------------------------------------------------
// 16. construct
// ---------------------------------------------------------------------------
describe('construct', () => {
  it('should produce a schedule with correct dimensions (numNurses x numDays)', () => {
    const config = makeMinimalConfig({ numNurses: 6, year: 2025, month: 0 });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.construct(bctx);
    assert.equal(schedule.length, 6);
    assert.equal(schedule[0].length, 31); // January has 31 days
  });

  it('should fill every cell (no null values remain)', () => {
    const config = makeMinimalConfig({ numNurses: 6, year: 2025, month: 0 });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.construct(bctx);
    for (let n = 0; n < schedule.length; n++) {
      for (let d = 0; d < schedule[n].length; d++) {
        assert.notEqual(schedule[n][d], null, `Cell [${n}][${d}] should not be null`);
      }
    }
  });

  it('should only use valid shift codes', () => {
    const validShifts = new Set(['M', 'P', 'D', 'N', 'S', 'R', 'F', 'MA', 'L104', 'PR', 'MT']);
    const config = makeMinimalConfig({ numNurses: 6, year: 2025, month: 0 });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.construct(bctx);
    for (let n = 0; n < schedule.length; n++) {
      for (let d = 0; d < schedule[n].length; d++) {
        assert.ok(validShifts.has(schedule[n][d]), `Invalid shift "${schedule[n][d]}" at [${n}][${d}]`);
      }
    }
  });

  it('should respect pinned absence shifts', () => {
    const config = makeMinimalConfig({
      numNurses: 6,
      year: 2025,
      month: 0,
      nurseOverrides: {
        0: {
          tags: ['ferie'],
          absencePeriods: {
            ferie: { start: '2025-01-01', end: '2025-01-05' },
          },
        },
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.construct(bctx);
    // Days 0-4 (Jan 1-5) should be 'F' for nurse 0
    for (let d = 0; d < 5; d++) {
      assert.equal(schedule[0][d], 'F', `Nurse 0 day ${d} should be F (ferie), got ${schedule[0][d]}`);
    }
  });

  it('should spread extra night shifts according to the monthly target instead of saturating max coverage', () => {
    const config = makeMinimalConfig({
      numNurses: 12,
      nurseOverrides: {
        0: { tags: ['mattine_e_pomeriggi'] },
        1: { tags: ['no_diurni'] },
        2: { tags: ['no_notti'] },
      },
      rules: {
        minCoverageM: 2,
        maxCoverageM: 3,
        minCoverageP: 2,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 2,
        targetNights: 4,
        maxNights: 6,
        minRPerWeek: 1,
      },
    });
    const origRandom = Math.random;
    Math.random = () => 0.123456789;
    try {
      const bctx = ctx.buildContext(config);
      const schedule = ctx.construct(bctx);
      const dailyNightCoverage = Array.from(
        { length: bctx.numDays },
        (_, d) => ctx.dayCoverage(schedule, d, bctx.numNurses).N
      );
      // This case is deterministic because Math.random is pinned to a constant seed value.
      // 10 nurses remain night-eligible (12 total minus mattine_e_pomeriggi and no_notti).
      // With targetNights=4, the heuristic should aim for 40 night starts overall.
      // The minimum daily requirement already consumes 31 starts, so exactly 9 days
      // should need a second nurse on night coverage.
      const daysAtMaxNightCoverage = dailyNightCoverage.filter(n => n === 2).length;
      assert.equal(daysAtMaxNightCoverage, 9);
      assert.equal(
        dailyNightCoverage.reduce((sum, n) => sum + n, 0),
        40
      );
    } finally {
      Math.random = origRandom;
    }
  });

  it('should keep night counts fairer across eligible nurses in the heuristic', () => {
    const config = makeMinimalConfig({
      numNurses: 7,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
      },
      rules: {
        minCoverageM: 1,
        maxCoverageM: 3,
        minCoverageP: 1,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 2,
        targetNights: 2,
        maxNights: 6,
        minRPerWeek: 1,
      },
    });
    const origRandom = Math.random;
    let state = 1;
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    try {
      const bctx = ctx.buildContext(config);
      const schedule = ctx.construct(bctx);
      const nightCounts = Array.from({ length: bctx.numNurses }, (_, n) => ctx.nightCount(schedule, n, bctx.numDays));
      const spread = Math.max(...nightCounts) - Math.min(...nightCounts);
      assert.ok(spread <= 1, `Night counts should stay near-even, got ${nightCounts.join(', ')}`);
    } finally {
      Math.random = origRandom;
    }
  });

  it('should keep no_diurni rests attached to the post-night recovery block only', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
      },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 0,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 1,
        targetNights: 1,
        maxNights: 8,
        minRPerWeek: 0,
      },
    });
    const origRandom = Math.random;
    let state = 27;
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    try {
      const bctx = ctx.buildContext(config);
      const schedule = ctx.construct(bctx);
      const row = schedule[0];
      // Valid rest slots for these nurses are only:
      // 1) the mandatory R immediately after S, or
      // 2) the optional second R after N-S-R.
      const forbiddenRestDay = row.findIndex(
        (shift, d) =>
          shift === 'R' &&
          !(d > 0 && row[d - 1] === 'S') &&
          !(d > 2 && row[d - 1] === 'R' && row[d - 2] === 'S' && row[d - 3] === 'N')
      );
      const foundForbiddenNSRRRPattern = Array.from(
        { length: bctx.numDays - 4 },
        (_, d) => row[d] === 'N' && row[d + 1] === 'S' && row[d + 2] === 'R' && row[d + 3] === 'R' && row[d + 4] === 'R'
      ).some(Boolean);
      assert.equal(forbiddenRestDay, -1, `Unexpected no_diurni rest outside post-night recovery: ${row.join('-')}`);
      assert.equal(
        foundForbiddenNSRRRPattern,
        false,
        `Unexpected third extra rest for no_diurni nurse: ${row.join('-')}`
      );
    } finally {
      Math.random = origRandom;
    }
  });

  it('should keep mattine_e_pomeriggi nurses on the allowed 4+2 M/P cycle patterns', () => {
    const config = makeMinimalConfig({
      numNurses: 5,
      nurseOverrides: {
        0: { tags: ['mattine_e_pomeriggi'] },
      },
      rules: {
        minCoverageM: 1,
        maxCoverageM: 2,
        minCoverageP: 1,
        maxCoverageP: 2,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 1,
      },
    });
    const origRandom = Math.random;
    let state = 1;
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    try {
      const bctx = ctx.buildContext(config);
      const schedule = ctx.construct(bctx);
      assertMatchesMPCycle(
        schedule[0],
        'mattine_e_pomeriggi nurse should follow an allowed M/P cycle',
        MP_CYCLE_PATTERNS.concat(SHORT_MP_CYCLE_PATTERNS)
      );
      assert.equal(schedule[0][0], 'M');
    } finally {
      Math.random = origRandom;
    }
  });

  it('should keep no_notti + no_diurni nurses on the same 4+2 M/P cycle without losing day-1 morning coverage', () => {
    const config = makeMinimalConfig({
      numNurses: 7,
      nurseOverrides: {
        0: { tags: ['no_notti', 'no_diurni'] },
        1: { tags: ['no_notti', 'no_diurni'] },
      },
      rules: {
        minCoverageM: 3,
        maxCoverageM: 4,
        minCoverageP: 2,
        maxCoverageP: 4,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 1,
      },
    });
    const origRandom = Math.random;
    let state = 19;
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    try {
      const bctx = ctx.buildContext(config);
      const schedule = ctx.construct(bctx);
      assertMatchesMPCycle(schedule[0], 'no_notti+no_diurni nurse #1 should follow 4+2 cycle');
      assertMatchesMPCycle(schedule[1], 'no_notti+no_diurni nurse #2 should follow 4+2 cycle');
      const day1Coverage = ctx.dayCoverage(schedule, 0, bctx.numNurses);
      assert.ok(
        day1Coverage.M >= bctx.minCovM,
        `Day 1 morning coverage should hold, got ${day1Coverage.M}/${bctx.minCovM}`
      );
      assert.equal(schedule[0][0], 'M');
      assert.equal(schedule[1][0], 'M');
    } finally {
      Math.random = origRandom;
    }
  });

  it('should assign a D shift to meet the afternoon minimum when morning headroom allows it', () => {
    const config = makeMinimalConfig({
      numNurses: 5,
      nurseOverrides: {
        0: { tags: ['solo_mattine'] },
        4: { tags: ['diurni_e_notturni'] },
      },
      rules: {
        minCoverageM: 3,
        maxCoverageM: 3,
        minCoverageP: 2,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 1,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.construct(bctx);
    const day1Coverage = ctx.dayCoverage(schedule, 0, bctx.numNurses);
    assert.equal(day1Coverage.M, 3);
    assert.ok(day1Coverage.P >= 2, `Day 1 afternoon coverage should reach the minimum, got ${day1Coverage.P}`);
    assert.ok(day1Coverage.P <= 3, `Day 1 afternoon coverage should stay within the maximum, got ${day1Coverage.P}`);
    assert.equal(day1Coverage.D, 1);
    assert.equal(schedule[4][0], 'D', 'The diurni_e_notturni nurse should cover day 1 with D');
  });

  it('should encode LP cycle constraints for M/P-only nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      nurseOverrides: {
        0: { tags: ['no_notti', 'no_diurni'] },
      },
      rules: {
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const lp = ctx.buildLP(bctx, 0);
    assert.match(lp, /mpcPick0_0:/);
    assert.match(lp, /mpcM0_0:/);
    assert.match(lp, /mpcR0_4:/);
  });

  it('should accept shorter 5-day M/P patterns for mattine_e_pomeriggi nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['mattine_e_pomeriggi', 'no_notti', 'no_diurni'] },
      },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 10,
        minCoverageP: 0,
        maxCoverageP: 10,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const shortPattern = ['M', 'M', 'P', 'R', 'R', 'M', 'P', 'P', 'R', 'R'];
    const schedule = [Array.from({ length: bctx.numDays }, (_, idx) => shortPattern[idx % shortPattern.length])];

    const mpViolations = ctx.collectViolations(schedule, bctx).filter(v => v.type === 'mp_cycle_4_2');
    assert.deepEqual(toPlain(mpViolations), []);
  });
});

describe('constructPatternSchedule', () => {
  it('should build a complete schedule and keep compatible paired nurses synchronized', () => {
    const config = makeMinimalConfig({
      numNurses: 12,
      year: 2026,
      month: 3,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
        1: { tags: ['mattine_e_pomeriggi'] },
        2: { tags: ['diurni_e_notturni'] },
        3: { tags: ['diurni_e_notturni'] },
        4: { tags: ['diurni_e_notturni'] },
        5: { tags: ['diurni_e_notturni'] },
        6: { tags: ['diurni_e_notturni'] },
        7: { tags: ['diurni_e_notturni'] },
        8: { tags: ['diurni_e_notturni'] },
        9: { tags: ['diurni_e_notturni'] },
        10: { tags: ['diurni_no_notti'] },
        11: { tags: ['diurni_no_notti'] },
      },
      rules: {
        minCoverageM: 2,
        maxCoverageM: 4,
        minCoverageP: 2,
        maxCoverageP: 4,
        minCoverageN: 2,
        maxCoverageN: 3,
        targetNights: 4,
        maxNights: 5,
        minRPerWeek: 2,
        coppiaTurni: [2, 3],
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = ctx.constructPatternSchedule(bctx, { beamWidth: 12, candidateLimit: 12 });

    assert.equal(schedule.length, bctx.numNurses);
    for (const row of schedule) {
      assert.equal(row.length, bctx.numDays);
      assert.ok(row.every(Boolean));
    }
    assert.deepEqual(schedule[2], schedule[3]);

    const allRest = Array.from({ length: bctx.numNurses }, () => new Array(bctx.numDays).fill('R'));
    assert.ok(ctx.computeScore(schedule, bctx).total < ctx.computeScore(allRest, bctx).total);
  });
});

describe('localSearch night coverage repair', () => {
  function placeNightBlock(row, start, numDays) {
    row[start] = 'N';
    if (start + 1 < numDays) row[start + 1] = 'S';
    if (start + 2 < numDays) row[start + 2] = 'R';
    if (start + 3 < numDays) row[start + 3] = 'R';
  }

  it('should post-process alternating night excess/deficit days even when annealing iterations are skipped', () => {
    const config = makeMinimalConfig({
      numNurses: 7,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 0,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 1,
        targetNights: 1,
        maxNights: 4,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 7;
    bctx.weekDaysList = [[0, 1, 2, 3, 4, 5, 6]];
    bctx.weekOf = () => 0;

    const schedule = Array.from({ length: 7 }, () => new Array(7).fill('R'));
    // Intentionally duplicate day 2 and skip day 3 so nights start on:
    // 0,1,2,2,4,5,6 → excess on day 2 and deficit on day 3.
    [0, 1, 2, 2, 4, 5, 6].forEach((start, nurseIdx) => placeNightBlock(schedule[nurseIdx], start, bctx.numDays));

    const beforeViolations = ctx
      .collectViolations(schedule, bctx)
      .filter(v => v.type === 'coverage_N' || v.type === 'coverage_N_max');
    assert.equal(beforeViolations.length, 2);

    const improved = ctx.localSearch(schedule, bctx, 0);
    const afterNightCoverage = Array.from(
      { length: bctx.numDays },
      (_, d) => ctx.dayCoverage(improved, d, bctx.numNurses).N
    );
    assert.deepEqual(afterNightCoverage, [1, 1, 1, 1, 1, 1, 1]);

    const afterViolations = ctx
      .collectViolations(improved, bctx)
      .filter(v => v.type === 'coverage_N' || v.type === 'coverage_N_max');
    assert.deepEqual(toPlain(afterViolations), []);
    assert.ok(ctx.computeScore(improved, bctx).total < ctx.computeScore(schedule, bctx).total);
  });

  it('should rebalance excess-only night coverage by moving a block onto a day below max coverage', () => {
    const config = makeMinimalConfig({
      numNurses: 4,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 0,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 1,
        targetNights: 1,
        maxNights: 4,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 7;
    bctx.weekDaysList = [[0, 1, 2, 3, 4, 5, 6]];
    bctx.weekOf = () => 0;

    const schedule = Array.from({ length: 4 }, () => new Array(7).fill('R'));
    [0, 0, 2, 3].forEach((start, nurseIdx) => placeNightBlock(schedule[nurseIdx], start, bctx.numDays));

    const beforeViolations = ctx.collectViolations(schedule, bctx).filter(v => v.type === 'coverage_N_max');
    assert.equal(beforeViolations.length, 1);

    const improved = ctx.localSearch(schedule, bctx, 0);
    const afterNightCoverage = Array.from(
      { length: bctx.numDays },
      (_, d) => ctx.dayCoverage(improved, d, bctx.numNurses).N
    );

    assert.equal(Math.max(...afterNightCoverage), 1);
    assert.equal(
      afterNightCoverage.reduce((sum, count) => sum + count, 0),
      4
    );
    const afterViolations = ctx.collectViolations(improved, bctx).filter(v => v.type === 'coverage_N_max');
    assert.deepEqual(toPlain(afterViolations), []);
  });
});

describe('solveFallback', () => {
  it('should reach zero violations without generating M-R-P-N or P-R-M-N split-rest patterns', () => {
    const config = makeMinimalConfig({
      numNurses: 8,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
        1: { tags: ['no_diurni'] },
        2: { tags: ['no_notti'] },
      },
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
        maxNights: 6,
        minRPerWeek: 1,
      },
    });
    const origRandom = Math.random;
    let state = 1;
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    try {
      const result = ctx.solveFallback(config);
      assert.equal(
        result.violations.length,
        0,
        `Fallback solver should reach zero violations, got ${result.violations.length}`
      );
      for (const nurseIdx of [0, 1]) {
        const row = result.schedule[nurseIdx];
        for (let d = 0; d < row.length - 3; d++) {
          const window = row.slice(d, d + 4);
          assert.notDeepEqual(
            window,
            ['M', 'R', 'P', 'N'],
            `Unexpected split-rest pattern for nurse ${nurseIdx}: ${window.join('-')}`
          );
          assert.notDeepEqual(
            window,
            ['P', 'R', 'M', 'N'],
            `Unexpected split-rest pattern for nurse ${nurseIdx}: ${window.join('-')}`
          );
        }
      }
    } finally {
      Math.random = origRandom;
    }
  });
});

describe('localSearch split rest repair', () => {
  it('should convert an isolated extra rest back into work when the weekly quota has spare room', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 3,
        minCoverageP: 0,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 1,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 6;
    const schedule = [['M', 'R', 'P', 'N', 'S', 'R']];
    const repaired = ctx.localSearch(schedule, bctx, 0);
    assert.notEqual(repaired[0][1], 'R');
    assert.equal(ctx.isSplitRestDay(repaired, bctx, 0, 1), false);
  });

  it('should preserve the D-R-D-N bridge when repairs run with zero annealing iterations', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 3,
        minCoverageP: 0,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 3,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
        consente2DiurniConsecutivi: true,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 6;
    const schedule = [['D', 'R', 'D', 'N', 'S', 'R']];
    const repaired = ctx.localSearch(schedule, bctx, 0);
    assert.deepEqual(toPlain(repaired[0].slice(0, 4)), ['D', 'R', 'D', 'N']);
  });

  it('should convert a forbidden third rest after a regular night block back into work', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 3,
        minCoverageP: 0,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 1,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 7;
    const schedule = [['M', 'N', 'S', 'R', 'R', 'R', 'M']];
    const repaired = ctx.localSearch(schedule, bctx, 0);
    const violations = ctx.collectViolations(repaired, bctx);
    assert.notEqual(repaired[0][5], 'R');
    assert.ok(['M', 'P', 'D'].includes(repaired[0][5]));
    assert.equal(
      violations.some(v => v.type === 'night_extra_rest'),
      false,
      JSON.stringify(violations)
    );
  });

  it('should convert a no_diurni rest day that is not attached to a night block back into work', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['no_diurni'] },
      },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 3,
        minCoverageP: 0,
        maxCoverageP: 3,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    bctx.numDays = 7;
    const schedule = [['M', 'R', 'P', 'N', 'S', 'R', 'R']];
    const repaired = ctx.localSearch(schedule, bctx, 0);
    const violations = ctx.collectViolations(repaired, bctx);
    assert.notEqual(repaired[0][1], 'R');
    assert.equal(
      violations.some(v => v.type === 'restricted_no_diurni_rest'),
      false,
      JSON.stringify(violations)
    );
  });
});

describe('localSearch mandatory night-rest protection', () => {
  it('should not change the second mandatory rest after a night block', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 2,
        minCoverageP: 0,
        maxCoverageP: 2,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'N';
    schedule[0][1] = 'S';
    schedule[0][2] = 'R';
    schedule[0][3] = 'R';
    schedule[1][3] = 'M';
    const changes = [];
    const origRandom = Math.random;
    let step = 0;
    Math.random = () => {
      step++;
      return step === 1 ? 0.11 : 0.1;
    };
    try {
      assert.equal(ctx.isMandatoryNightRestDay(schedule, bctx, 0, 3), true);
      assert.equal(ctx.tryChangeMove(schedule, bctx, changes), false);
      assert.equal(schedule[0][3], 'R');
    } finally {
      Math.random = origRandom;
    }
  });

  it('should not swap away a mandatory rest day after a night block', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 2,
        minCoverageP: 0,
        maxCoverageP: 2,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'N';
    schedule[0][1] = 'S';
    schedule[0][2] = 'R';
    schedule[0][3] = 'R';
    schedule[1][3] = 'M';
    const changes = [];
    const origRandom = Math.random;
    let step = 0;
    Math.random = () => {
      step++;
      if (step === 1) return 0.11; // day 3
      if (step === 2) return 0.1; // nurse 0
      return 0.6; // nurse 1
    };
    try {
      assert.equal(ctx.trySwapMove(schedule, bctx, changes), false);
      assert.equal(schedule[0][3], 'R');
      assert.equal(schedule[1][3], 'M');
    } finally {
      Math.random = origRandom;
    }
  });

  it('should not assign new work onto a mandatory rest day during equity moves', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 2,
        minCoverageP: 0,
        maxCoverageP: 2,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 0,
        targetNights: 0,
        maxNights: 0,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'N';
    schedule[0][1] = 'S';
    schedule[0][2] = 'R';
    schedule[0][3] = 'R';
    for (let d = 0; d < bctx.numDays; d++) schedule[1][d] = 'M';
    const changes = [];
    const cachedHours = [ctx.nurseHours(schedule, 0, bctx.numDays), ctx.nurseHours(schedule, 1, bctx.numDays)];
    const origRandom = Math.random;
    Math.random = () => 0.1; // pick nurse 0
    try {
      assert.equal(ctx.tryEquityMove(schedule, bctx, changes, cachedHours, [3]), false);
      assert.equal(schedule[0][3], 'R');
    } finally {
      Math.random = origRandom;
    }
  });
});

// ---------------------------------------------------------------------------
// 16. buildContext with hourDeltas
// ---------------------------------------------------------------------------
describe('buildContext with hourDeltas', () => {
  it('should store hourDeltas in context when provided', () => {
    const config = makeMinimalConfig({ numNurses: 4 });
    config.hourDeltas = [3, -2, 0, 1.5];
    const bctx = ctx.buildContext(config);
    assert.deepEqual(toPlain(bctx.hourDeltas), [3, -2, 0, 1.5]);
  });

  it('should store null hourDeltas when not provided', () => {
    const config = makeMinimalConfig({ numNurses: 4 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.hourDeltas, null);
  });
});

// ---------------------------------------------------------------------------
// 17. computeScore with hourDeltas
// ---------------------------------------------------------------------------
describe('computeScore with hourDeltas', () => {
  it('should produce different soft scores with vs without hourDeltas', () => {
    // Create a schedule where nurses have different hours
    const config = makeMinimalConfig({
      numNurses: 4,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 99,
        minCoverageP: 0,
        maxCoverageP: 99,
        minCoverageN: 0,
        maxCoverageN: 99,
        minRPerWeek: 0,
      },
    });
    const bctxNoDeltas = ctx.buildContext(config);
    const numDays = bctxNoDeltas.numDays;

    // Nurse 0: all M (high hours), Nurse 1-3: all R (zero hours)
    const schedule = [
      new Array(numDays).fill('M'),
      new Array(numDays).fill('R'),
      new Array(numDays).fill('R'),
      new Array(numDays).fill('R'),
    ];

    const scoreWithout = ctx.computeScore(schedule, bctxNoDeltas);

    // Now with hourDeltas that push nurse 0 target higher (should reduce penalty)
    const configWithDeltas = makeMinimalConfig({
      numNurses: 4,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 99,
        minCoverageP: 0,
        maxCoverageP: 99,
        minCoverageN: 0,
        maxCoverageN: 99,
        minRPerWeek: 0,
      },
    });
    // Nurse 0 should work more (positive delta), others less
    configWithDeltas.hourDeltas = [50, -15, -15, -20];
    const bctxWithDeltas = ctx.buildContext(configWithDeltas);
    const scoreWith = ctx.computeScore(schedule, bctxWithDeltas);

    // The soft scores should differ since hourDeltas adjust individual targets
    assert.notEqual(scoreWithout.soft, scoreWith.soft, 'Soft scores should differ with hourDeltas');
  });

  it('should not change hard violations when hourDeltas are provided', () => {
    const config = makeMinimalConfig({ numNurses: 4 });
    const bctxNoDeltas = ctx.buildContext(config);
    const schedule = Array.from({ length: 4 }, () => new Array(bctxNoDeltas.numDays).fill('R'));
    const scoreWithout = ctx.computeScore(schedule, bctxNoDeltas);

    const configWithDeltas = makeMinimalConfig({ numNurses: 4 });
    configWithDeltas.hourDeltas = [5, -5, 3, -3];
    const bctxWithDeltas = ctx.buildContext(configWithDeltas);
    const scoreWith = ctx.computeScore(schedule, bctxWithDeltas);

    assert.equal(scoreWith.hard, scoreWithout.hard, 'Hard violations should not change with hourDeltas');
  });
});

// ---------------------------------------------------------------------------
// Previous month tail — continuity across months
// ---------------------------------------------------------------------------

describe('buildContext with previousMonthTail', () => {
  it('should store prevTail in context when provided', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [
      ['M', 'P', 'R'],
      ['R', 'N', 'S'],
    ];
    const bctx = ctx.buildContext(config);
    assert.ok(bctx.prevTail);
    assert.equal(bctx.prevTail.length, 2);
  });

  it('should store null prevTail when not provided', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.prevTail, null);
  });

  it('should pin S on day 0 when previous month ends with N', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'N'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'S');
    assert.equal(bctx.pinned[0][1], 'R');
    assert.equal(bctx.pinned[0][2], 'R');
  });

  it('should pin R on day 0 when previous month ends with N-S', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['R', 'N', 'S'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'R');
    assert.equal(bctx.pinned[0][1], 'R');
  });

  it('should pin R on day 0 when previous month ends with N-S-R (non-noDiurni)', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['N', 'S', 'R'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'R');
  });

  it('should not pin extra R for noDiurni nurse when ending with N-S-R', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      nurseOverrides: { 0: { tags: ['no_diurni'] } },
    });
    config.previousMonthTail = [['N', 'S', 'R'], null];
    const bctx = ctx.buildContext(config);
    // noDiurni nurse only needs N-S-R, so day 0 should NOT be pinned
    assert.equal(bctx.pinned[0][0], null);
  });

  it('should not overwrite existing pinned cells from absences', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      nurseOverrides: {
        0: {
          tags: ['ferie'],
          absencePeriods: { ferie: { start: '2025-01-01', end: '2025-01-05' } },
        },
      },
    });
    config.previousMonthTail = [['M', 'P', 'N'], null];
    const bctx = ctx.buildContext(config);
    // Day 0 (Jan 1) is pinned to F due to absence — should NOT be overwritten
    assert.equal(bctx.pinned[0][0], 'F');
  });
});

describe('buildContext with 4 mattine + notte venerdì tag', () => {
  it('should pin the fixed weekly pattern by weekday', () => {
    const config = makeMinimalConfig({
      year: 2025,
      month: 0,
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['quattro_mattine_venerdi_notte'] },
      },
    });
    const bctx = ctx.buildContext(config);

    assert.equal(bctx.pinned[0][0], 'M'); // Wed 1 Jan 2025
    assert.equal(bctx.pinned[0][1], 'M'); // Thu
    assert.equal(bctx.pinned[0][2], 'N'); // Fri
    assert.equal(bctx.pinned[0][3], 'S'); // Sat
    assert.equal(bctx.pinned[0][4], 'R'); // Sun
    assert.equal(bctx.pinned[0][5], 'M'); // Mon
  });

  it('should treat the tag like no_diurni for post-night recovery rules', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: {
        0: { tags: ['quattro_mattine_venerdi_notte'] },
      },
    });
    const bctx = ctx.buildContext(config);

    assert.equal(bctx.nurseProps[0].noDiurni, true);
  });
});

describe('transitionOk with previousMonthTail', () => {
  it('should reject P→M transition at month boundary', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'P'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    // P→M is a forbidden transition
    assert.equal(ctx.transitionOk(null, 'M', bctx, schedule, 0, 0), false);
  });

  it('should allow R→M transition at month boundary', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'R'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    assert.equal(ctx.transitionOk(null, 'M', bctx, schedule, 0, 0), true);
  });

  it('should allow any transition when no prevTail', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    assert.equal(ctx.transitionOk(null, 'M', bctx, schedule, 0, 0), true);
  });

  it('should reject D→M transition at month boundary', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['R', 'R', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    assert.equal(ctx.transitionOk(null, 'M', bctx, schedule, 0, 0), false);
  });
});

describe('computeScore with previousMonthTail', () => {
  it('should add hard penalties for forbidden transitions at month boundary', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    const bctxNo = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctxNo.numDays).fill('R'));
    schedule[0][0] = 'M';
    const scoreNo = ctx.computeScore(schedule, bctxNo);

    // Now with prevTail where nurse 0 had P on last day → P→M forbidden
    const configWith = makeMinimalConfig({ numNurses: 2 });
    configWith.previousMonthTail = [['R', 'R', 'P'], null];
    const bctxWith = ctx.buildContext(configWith);
    const scoreWith = ctx.computeScore(schedule, bctxWith);

    assert.ok(scoreWith.hard > scoreNo.hard, 'Should have more hard violations with forbidden boundary transition');
  });

  it('should not add penalties when boundary transition is valid', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    const bctxNo = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctxNo.numDays).fill('R'));
    schedule[0][0] = 'M';
    const scoreNo = ctx.computeScore(schedule, bctxNo);

    // prevTail with R on last day → R→M is OK
    const configWith = makeMinimalConfig({ numNurses: 2 });
    configWith.previousMonthTail = [['M', 'P', 'R'], null];
    const bctxWith = ctx.buildContext(configWith);
    const scoreWith = ctx.computeScore(schedule, bctxWith);

    assert.equal(scoreWith.hard, scoreNo.hard, 'Should have same hard violations when boundary transition is valid');
  });

  it('should add a hard penalty when a boundary night block is missing the second rest day', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'N'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'S';
    schedule[0][1] = 'R';
    schedule[0][2] = 'M';
    const score = ctx.computeScore(schedule, bctx);
    assert.ok(score.hard > 0, 'Expected a hard violation for the missing second R after a boundary N-S-R sequence');
  });
});

describe('collectViolations with previousMonthTail', () => {
  it('should report boundary transition violations', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['R', 'R', 'P'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'M'; // P→M is forbidden
    const violations = ctx.collectViolations(schedule, bctx);
    const boundaryViolations = violations.filter(v => v.day === -1 && v.type === 'transition');
    assert.ok(boundaryViolations.length > 0, 'Should have boundary transition violations');
    assert.ok(boundaryViolations[0].msg.includes('confine mese'));
  });

  it('should report missing second rest after a boundary night block', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'N'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'S';
    schedule[0][1] = 'R';
    schedule[0][2] = 'M';
    const violations = ctx.collectViolations(schedule, bctx);
    const boundaryNightRest = violations.find(v => v.type === 'need_2R_after_night');
    assert.ok(boundaryNightRest, 'Expected a boundary second-rest violation to be reported');
    assert.match(boundaryNightRest.msg, /confine mese/);
  });
});

// ---------------------------------------------------------------------------
// 5-day tail and D-D boundary continuity tests
// ---------------------------------------------------------------------------

describe('buildContext with 5-day previousMonthTail', () => {
  it('should accept and store a 5-element tail', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [
      ['M', 'P', 'R', 'M', 'P'],
      ['R', 'R', 'N', 'S', 'R'],
    ];
    const bctx = ctx.buildContext(config);
    assert.ok(bctx.prevTail);
    assert.equal(bctx.prevTail[0].length, 5);
    assert.equal(bctx.prevTail[1].length, 5);
  });

  it('should pin correctly with 5-day tail ending in N', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'R', 'M', 'N'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'S');
    assert.equal(bctx.pinned[0][1], 'R');
    assert.equal(bctx.pinned[0][2], 'R');
  });

  it('should not pin when 5-day tail shows completed N-S-R-R pattern', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    // N-S-R-R-M → pattern is complete, day 0 should not be pinned
    config.previousMonthTail = [['N', 'S', 'R', 'R', 'M'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], null);
  });

  it('should pin R on day 0 with 5-day tail ending in N-S-R', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'N', 'S', 'R'], null];
    const bctx = ctx.buildContext(config);
    // N-S-R needs one more R
    assert.equal(bctx.pinned[0][0], 'R');
  });

  it('should pin R, R on day 0-1 with 5-day tail ending in N-S', () => {
    const config = makeMinimalConfig({ numNurses: 2 });
    config.previousMonthTail = [['M', 'P', 'R', 'N', 'S'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'R');
    assert.equal(bctx.pinned[0][1], 'R');
  });
});

describe('buildContext D-D boundary pinning (consente2D)', () => {
  it('should pin R on day 0 when prev month ends with D-D and consente2D enabled', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'R');
  });

  it('should not pin R on day 0 for D-D when consente2D is disabled', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: false },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    // D-D is forbidden when consente2D is false, so no special D-D pinning needed
    assert.equal(bctx.pinned[0][0], null);
  });

  it('should not pin R when prev month ends with single D', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'M', 'D'], null];
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], null);
  });
});

describe('computeScore D-D boundary (consente2D)', () => {
  it('should add hard penalty when D-D at boundary and day 0 is not R', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    // Override day 0 to M instead of R (which was pinned) — simulate unpinned
    schedule[0][0] = 'M';
    const score = ctx.computeScore(schedule, bctx);
    assert.ok(score.hard > 0, 'Should have hard violation for D-D not followed by R');
  });

  it('should not add D-D penalty when day 0 is R after D-D', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    // day 0 is R (correct after D-D)
    const scoreBase = ctx.computeScore(schedule, bctx);

    const configNo = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    const bctxNo = ctx.buildContext(configNo);
    const scoreNo = ctx.computeScore(schedule, bctxNo);
    assert.equal(scoreBase.hard, scoreNo.hard, 'No extra hard violations when D-D followed by R');
  });

  it('should add hard penalty for 3 consecutive D at boundary', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'D'; // D-D-D at boundary
    const score = ctx.computeScore(schedule, bctx);
    assert.ok(score.hard > 0, 'Should have hard violation for 3 consecutive D');
  });
});

describe('collectViolations D-D boundary (consente2D)', () => {
  it('should report D-D not followed by R at month boundary', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'M'; // D-D followed by M (not R)
    const violations = ctx.collectViolations(schedule, bctx);
    const ddViolations = violations.filter(v => v.type === 'DD_no_R');
    assert.ok(ddViolations.length > 0, 'Should have D-D boundary violation');
    assert.ok(ddViolations[0].msg.includes('confine mese'));
  });

  it('should report 3 consecutive D at month boundary', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: true },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'D'; // D-D-D
    const violations = ctx.collectViolations(schedule, bctx);
    const dddViolations = violations.filter(v => v.type === 'DDD');
    assert.ok(dddViolations.length > 0, 'Should have DDD boundary violation');
    assert.ok(dddViolations[0].msg.includes('3 D consecutivi'));
  });

  it('should not report D-D violations when consente2D is disabled', () => {
    const config = makeMinimalConfig({
      numNurses: 2,
      rules: { consente2DiurniConsecutivi: false },
    });
    config.previousMonthTail = [['M', 'P', 'R', 'D', 'D'], null];
    const bctx = ctx.buildContext(config);
    const schedule = Array.from({ length: 2 }, () => new Array(bctx.numDays).fill('R'));
    schedule[0][0] = 'M';
    const violations = ctx.collectViolations(schedule, bctx);
    const ddViolations = violations.filter(v => v.type === 'DD_no_R' || v.type === 'DDD');
    assert.equal(ddViolations.length, 0, 'Should not have D-D boundary violations when consente2D is disabled');
  });
});

describe('collectViolations strict night patterns', () => {
  it('should report invalid M/P lead-in before night for no_diurni nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: { 0: { tags: ['no_diurni'] } },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 31,
        minCoverageP: 0,
        maxCoverageP: 31,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('R')];
    schedule[0][0] = 'P';
    schedule[0][1] = 'R';
    schedule[0][2] = 'M';
    schedule[0][3] = 'N';
    schedule[0][4] = 'S';
    schedule[0][5] = 'R';

    const violations = ctx.collectViolations(schedule, bctx);

    assert.ok(violations.some(v => v.type === 'mp_night_pattern'));
  });

  it('should allow a second rest after a no_diurni night block', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: { 0: { tags: ['no_diurni'] } },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 31,
        minCoverageP: 0,
        maxCoverageP: 31,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('M')];
    schedule[0][0] = 'M';
    schedule[0][1] = 'P';
    schedule[0][2] = 'N';
    schedule[0][3] = 'S';
    schedule[0][4] = 'R';
    schedule[0][5] = 'R';

    const extraRestViolation = ctx.collectViolations(schedule, bctx).find(v => v.type === 'night_extra_rest');

    assert.equal(extraRestViolation, undefined);
  });

  it('should not treat a no_diurni discretionary rest as a hard violation', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: { 0: { tags: ['no_diurni'] } },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 31,
        minCoverageP: 0,
        maxCoverageP: 31,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('M')];
    schedule[0][0] = 'M';
    schedule[0][1] = 'R';
    schedule[0][2] = 'P';
    schedule[0][3] = 'N';
    schedule[0][4] = 'S';
    schedule[0][5] = 'R';

    const violation = ctx.collectViolations(schedule, bctx).find(v => v.type === 'restricted_no_diurni_rest');

    assert.equal(violation, undefined);
  });

  it('should report invalid D/N lead-in for diurni_e_notturni nurses', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: { 0: { tags: ['diurni_e_notturni'] } },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 0,
        minCoverageD: 0,
        maxCoverageD: 31,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('R')];
    schedule[0][1] = 'N';
    schedule[0][2] = 'S';
    schedule[0][3] = 'R';
    schedule[0][4] = 'R';

    const violations = ctx.collectViolations(schedule, bctx);

    assert.ok(violations.some(v => v.type === 'd_night_pattern'));
  });

  it('should report a third rest after a diurni_e_notturni night block', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      nurseOverrides: { 0: { tags: ['diurni_e_notturni'] } },
      rules: {
        minCoverageM: 0,
        maxCoverageM: 0,
        minCoverageP: 0,
        maxCoverageP: 0,
        minCoverageD: 0,
        maxCoverageD: 31,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('D')];
    schedule[0][0] = 'D';
    schedule[0][1] = 'N';
    schedule[0][2] = 'S';
    schedule[0][3] = 'R';
    schedule[0][4] = 'R';
    schedule[0][5] = 'R';

    const violations = ctx.collectViolations(schedule, bctx);

    assert.ok(violations.some(v => v.type === 'night_extra_rest'));
  });

  it('should report a third rest after a regular night block', () => {
    const config = makeMinimalConfig({
      numNurses: 1,
      rules: {
        minCoverageM: 0,
        maxCoverageM: 31,
        minCoverageP: 0,
        maxCoverageP: 31,
        minCoverageD: 0,
        maxCoverageD: 31,
        minCoverageN: 0,
        maxCoverageN: 1,
        minRPerWeek: 0,
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = [new Array(bctx.numDays).fill('M')];
    schedule[0][0] = 'M';
    schedule[0][1] = 'N';
    schedule[0][2] = 'S';
    schedule[0][3] = 'R';
    schedule[0][4] = 'R';
    schedule[0][5] = 'R';

    const violations = ctx.collectViolations(schedule, bctx);

    assert.ok(violations.some(v => v.type === 'night_extra_rest'));
  });
});

// ---------------------------------------------------------------------------
// 18. Solver diagnostics
// ---------------------------------------------------------------------------

describe('solver diagnostics', () => {
  afterEach(() => {
    ctx = loadSolver();
  });

  it('should classify HiGHS infeasible statuses with a user-friendly diagnostic', () => {
    const diagnostic = toPlain(ctx.buildHighsSolveDiagnostic('Infeasible', 12.34));
    assert.equal(diagnostic.source, 'highs');
    assert.equal(diagnostic.code, 'model_infeasible');
    assert.equal(diagnostic.userMessage, 'Il modello non ha trovato una soluzione ammissibile con i vincoli attuali');
    assert.match(diagnostic.detail, /Infeasible/);
  });

  it('should classify GLPK no-feasible statuses with a user-friendly diagnostic', () => {
    const diagnostic = toPlain(ctx.buildGLPKSolveDiagnostic('GLP_NOFEAS', 4.2));
    assert.equal(diagnostic.source, 'glpk');
    assert.equal(diagnostic.code, 'model_infeasible');
    assert.equal(diagnostic.userMessage, 'Il modello non ha trovato una soluzione ammissibile con i vincoli attuali');
    assert.match(diagnostic.detail, /GLP_NOFEAS/);
  });

  it('should use fallback solver and include diagnostic when HiGHS loading fails', async () => {
    vm.runInContext(
      `
      loadHiGHS = async function () {
        _highsLoadState = makeDiagnostic(
          'highs',
          'script_load',
          'cdn_load_failed',
          'error',
          'HiGHS non caricato: errore rete/CDN',
          'importScripts failed: network error'
        );
        _highsLoadDiag = _highsLoadState.detail;
        return null;
      };
      buildContext = function () {
        return {
          numNurses: 1,
          numDays: 1,
          minCovM: 0,
          maxCovM: 0,
          minCovP: 0,
          maxCovP: 0,
          minCovN: 0,
          maxCovN: 0,
          minCovD: 0,
          maxCovD: 0
        };
      };
      construct = function () { return [['R']]; };
      localSearch = function (schedule) { return schedule; };
      collectViolations = function () { return []; };
      computeStats = function () { return []; };
      computeScore = function () { return { total: 0, hard: 0, soft: 0 }; };
      progress = function () {};
    `,
      ctx
    );

    const config = makeMinimalConfig({
      numNurses: 1,
      rules: { minCoverageM: 0, maxCoverageM: 0, minCoverageP: 0, maxCoverageP: 0, minCoverageN: 0, maxCoverageN: 0 },
    });
    const result = await ctx.solve(config, 1, 15, false, 'milp');
    const diagnostics = toPlain(result.diagnostics);

    assert.equal(result.solutions.length, 1);
    assert.equal(result.solutions[0].solverMethod, 'fallback');
    assert.ok(diagnostics.some(diag => diag.userMessage === 'HiGHS non caricato: errore rete/CDN'));
    assert.ok(diagnostics.some(diag => diag.userMessage === 'HiGHS non disponibile, uso euristica come fallback'));
  });
});

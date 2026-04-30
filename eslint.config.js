'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Functions and constants shared across solver modules via importScripts().
// ESLint analyzes files individually, so cross-module references need to be
// declared as globals. Since each module defines some and uses others from
// the shared scope, they are marked 'writable' and no-redeclare is disabled.
const solverSharedGlobals = {
  // constants.js
  SHIFT_HOURS: 'writable',
  FASCIA_PRESETS: 'writable',
  FASCIA_SHIFT_START: 'writable',
  FASCIA_SHIFT_END: 'writable',
  DEBUG: 'writable',
  EQUITY_THRESHOLD_HOURS: 'writable',
  HOUR_EQUITY_MILP_WEIGHT: 'writable',
  NIGHT_EQUITY_MILP_WEIGHT: 'writable',
  DIURNI_EQUITY_MILP_WEIGHT: 'writable',
  MP_BALANCE_MILP_WEIGHT: 'writable',
  ABSENCE_TAG_TO_SHIFT: 'writable',
  SHIFT_END: 'writable',
  SHIFT_START: 'writable',
  BASE_FORBIDDEN_NEXT: 'writable',
  NUM_RESTARTS: 'writable',
  LOCAL_SEARCH_ITERS: 'writable',
  MILP_MIN_TIME_PER_SOLUTION: 'writable',
  MILP_DEFAULT_TOTAL_TIME_BUDGET: 'writable',
  UNTIL_ZERO_MAX_TIME: 'writable',
  shuffle: 'writable',
  dayOfWeek: 'writable',
  isWeekend: 'writable',
  daysInMonth: 'writable',
  gapHours: 'writable',
  deepCopy: 'writable',
  applyFasciaOraria: 'writable',
  // context.js
  buildContext: 'writable',
  getAbsenceShift: 'writable',
  // scoring.js
  transitionOk: 'writable',
  dayCoverage: 'writable',
  nurseHours: 'writable',
  nightCount: 'writable',
  diurniCount: 'writable',
  countWeekRest: 'writable',
  requiredRest: 'writable',
  computeScore: 'writable',
  collectViolations: 'writable',
  computeStats: 'writable',
  // construct.js
  construct: 'writable',
  trySwapMP: 'writable',
  // local-search.js
  localSearch: 'writable',
  setCell: 'writable',
  trySwapMove: 'writable',
  tryChangeMove: 'writable',
  tryEquityMove: 'writable',
  tryWeeklyRestMove: 'writable',
  // pattern-planner.js
  solvePattern: 'writable',
  constructPatternSchedule: 'writable',
  // lp-model.js
  seededRandom: 'writable',
  buildLP: 'writable',
  parseSolution: 'writable',
  parseLPTerms: 'writable',
  lpToGLPKModel: 'writable',
  GLPK_STATUS_NAMES: 'writable',
  parseGLPKSolution: 'writable',
  // solvers.js
  loadHiGHS: 'writable',
  solveOneMILP: 'writable',
  loadGLPK: 'writable',
  solveOneGLPK: 'writable',
  solveFallback: 'writable',
  solve: 'writable',
  // solver.js (entry point defines progress before importScripts)
  progress: 'writable',
};

module.exports = [
  js.configs.recommended,
  {
    files: ['js/app.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        tailwind: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['js/solver.js', 'js/solver/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.worker,
        ...solverSharedGlobals,
      },
    },
    rules: {
      // Modules define functions/constants that are also declared as globals
      // for cross-module visibility. This is expected with importScripts().
      'no-redeclare': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['js/**/*.js'],
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off',
      'semi': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': 'error',
    },
  },
];

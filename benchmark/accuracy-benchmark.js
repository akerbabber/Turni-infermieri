'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const MODULES = [
  'solver/constants.js',
  'solver/context.js',
  'solver/scoring.js',
  'solver/construct.js',
  'solver/local-search.js',
  'solver/pattern-planner.js',
  'solver/lp-model.js',
  'solver/solvers.js',
];

function parseArgs() {
  const args = { trials: 3, iters: 1800, details: false, raw: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--details') {
      args.details = true;
      continue;
    }
    if (arg === '--raw') {
      args.raw = true;
      continue;
    }
    const [key, value] = arg.replace(/^--/, '').split('=');
    const numeric = Number(value);
    if (key === 'trials' && Number.isFinite(numeric)) args.trials = Math.max(1, numeric);
    if (key === 'iters' && Number.isFinite(numeric)) args.iters = Math.max(0, numeric);
  }
  return args;
}

function loadSolver(seed) {
  const sandboxMath = Object.create(Math);
  const context = {
    self: {},
    console: {
      log() {},
      warn() {},
      error() {},
    },
    Math: sandboxMath,
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
    URL,
  };
  vm.createContext(context);
  vm.runInContext(
    `Math.random = (function () {
       var s = ${seed >>> 0};
       return function () {
         s = (1664525 * s + 1013904223) >>> 0;
         return s / 4294967296;
       };
     })();
     function progress() {}`,
    context
  );

  const jsDir = path.join(ROOT, 'js');
  for (const file of MODULES) {
    const code = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

function nurse(name, tags, absencePeriods) {
  return { name, tags, absencePeriods: absencePeriods || {} };
}

function baseRules(overrides) {
  return {
    minCoverageM: 6,
    maxCoverageM: 8,
    minCoverageP: 6,
    maxCoverageP: 8,
    minCoverageD: 4,
    maxCoverageD: 8,
    minCoverageN: 6,
    maxCoverageN: 7,
    targetNights: 6,
    maxNights: 6,
    minRPerWeek: 2,
    preferDiurni: false,
    coppiaTurni: [4, 5],
    consente2DiurniConsecutivi: false,
    consentePomeriggioDiurno: false,
    minGap11h: true,
    minHours: 130,
    ...(overrides || {}),
  };
}

function typicalErScenario(year, month, extra) {
  const nurses = [nurse('No Diurni', ['no_diurni']), nurse('M/P Only', ['mattine_e_pomeriggi'])];
  for (let i = 2; i < 35; i++) nurses.push(nurse(`D/N ${i + 1}`, ['diurni_e_notturni']));
  return {
    year,
    month,
    nurses,
    rules: baseRules(extra?.rules),
    hourDeltas: extra?.hourDeltas || null,
    previousMonthTail: extra?.previousMonthTail || null,
  };
}

function scenarioSet() {
  const tailCycle = ['D', 'N', 'S', 'R', 'R'];
  const previousMonthTail = Array.from({ length: 35 }, (_, i) => {
    const row = [];
    for (let d = 0; d < 5; d++) row.push(tailCycle[(i + d) % tailCycle.length]);
    return row;
  });
  const hourDeltas = Array.from({ length: 35 }, (_, i) => ((i % 5) - 2) * 3.5);

  const mixedNurses = [
    nurse('No Diurni A', ['no_diurni']),
    nurse('No Diurni B', ['no_diurni']),
    nurse('M/P Only', ['mattine_e_pomeriggi']),
    nurse('D No Night A', ['diurni_no_notti']),
    nurse('D No Night B', ['diurni_no_notti'], {
      ferie: { start: '2026-02-10', end: '2026-02-12' },
    }),
  ];
  for (let i = 5; i < 18; i++) mixedNurses.push(nurse(`D/N ${i + 1}`, ['diurni_e_notturni']));

  return [
    {
      name: 'ER-Apr-2026',
      config: typicalErScenario(2026, 3),
    },
    {
      name: 'ER-Oct-2026-continuity',
      config: typicalErScenario(2026, 9, { previousMonthTail, hourDeltas }),
    },
    {
      name: 'Mixed-Feb-2026',
      config: {
        year: 2026,
        month: 1,
        nurses: mixedNurses,
        rules: baseRules({
          minCoverageM: 3,
          maxCoverageM: 5,
          minCoverageP: 3,
          maxCoverageP: 5,
          minCoverageD: 1,
          maxCoverageD: 4,
          minCoverageN: 2,
          maxCoverageN: 3,
          targetNights: 4,
          maxNights: 5,
          minHours: 105,
          coppiaTurni: [8, 9],
        }),
      },
    },
  ];
}

function runAlgorithm(ctx, bctx, name, iters, raw) {
  if (name === 'legacy') {
    const initial = ctx.construct(bctx);
    if (raw) return initial;
    return ctx.localSearch(initial, bctx, iters);
  }
  const initial =
    name === 'night_first_pattern'
      ? ctx.constructNightFirstPatternSchedule(bctx, { beamWidth: 64, candidateLimit: 24 })
      : ctx.constructPatternSchedule(bctx, { beamWidth: 64, candidateLimit: 24 });
  if (raw) return initial;
  return ctx.localSearch(initial, bctx, iters);
}

function summarize(ctx, bctx, schedule, elapsedMs) {
  const score = ctx.computeScore(schedule, bctx);
  const violations = ctx.collectViolations(schedule, bctx);
  const stats = ctx.computeStats(schedule, bctx);
  const hours = stats.map(row => row.totalHours);
  const nights = stats.map(row => row.nights);
  const coverage = violations.filter(v => String(v.type || '').startsWith('coverage_')).length;
  const nightCoverage = violations.filter(v => v.type === 'coverage_N' || v.type === 'coverage_N_max').length;
  const nightPattern = violations.filter(
    v =>
      v.type === 'N_no_S' ||
      v.type === 'need_2R_after_night' ||
      v.type === 'mp_night_pattern' ||
      v.type === 'd_night_pattern'
  ).length;
  let pairDivergence = 0;
  const pair = bctx.coppiaTurni;
  if (pair && Array.isArray(pair) && pair.length === 2) {
    const [n1, n2] = pair;
    if (n1 >= 0 && n2 >= 0 && n1 < bctx.numNurses && n2 < bctx.numNurses) {
      for (let d = 0; d < bctx.numDays; d++) if (schedule[n1][d] !== schedule[n2][d]) pairDivergence++;
    }
  }
  return {
    hard: score.hard,
    soft: score.soft,
    total: score.total,
    violations: violations.length,
    coverage,
    nightCoverage,
    nightPattern,
    hourRange: Math.max(...hours) - Math.min(...hours),
    hourStd: stddev(hours),
    nightRange: Math.max(...nights) - Math.min(...nights),
    pairDivergence,
    elapsedMs,
    coverageSummary: summarizeCoverage(ctx, bctx, schedule),
  };
}

function summarizeCoverage(ctx, bctx, schedule) {
  const summary = { mMin: Infinity, mMax: -Infinity, pMin: Infinity, pMax: -Infinity, nMin: Infinity, nMax: -Infinity };
  for (let d = 0; d < bctx.numDays; d++) {
    const cov = ctx.dayCoverage(schedule, d, bctx.numNurses);
    summary.mMin = Math.min(summary.mMin, cov.M);
    summary.mMax = Math.max(summary.mMax, cov.M);
    summary.pMin = Math.min(summary.pMin, cov.P);
    summary.pMax = Math.max(summary.pMax, cov.P);
    summary.nMin = Math.min(summary.nMin, cov.N);
    summary.nMax = Math.max(summary.nMax, cov.N);
  }
  return summary;
}

function stddev(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmt(value, digits) {
  return Number(value).toFixed(digits ?? 1);
}

function main() {
  const args = parseArgs();
  const rows = [];
  const algorithms = [
    ['legacy', 'Legacy greedy+SA'],
    ['night_first_pattern', 'Night-first Pattern Beam'],
    ['pattern', 'Pattern Beam'],
  ];

  for (const scenario of scenarioSet()) {
    for (const [algorithm, label] of algorithms) {
      const samples = [];
      for (let trial = 0; trial < args.trials; trial++) {
        const seed =
          1009 +
          trial * 7919 +
          scenario.name.length * 17 +
          (algorithm === 'pattern' ? 53 : algorithm === 'night_first_pattern' ? 97 : 0);
        const ctx = loadSolver(seed);
        const bctx = ctx.buildContext(scenario.config);
        const start = performance.now();
        const schedule = runAlgorithm(ctx, bctx, algorithm, args.iters, args.raw);
        samples.push(summarize(ctx, bctx, schedule, performance.now() - start));
      }
      rows.push({ scenario: scenario.name, label, samples });
    }
  }

  console.log(
    `# Accuracy benchmark (${args.trials} trials, ${args.raw ? 'raw construction' : `${args.iters} local-search iterations`})`
  );
  console.log('');
  console.log(
    '| Scenario | Algorithm | Median violations | Median hard | Median score | Coverage violations | Night coverage | Night pattern | Hour range avg | Hour std avg | Night range avg | Pair div avg | Runtime avg |'
  );
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    const s = row.samples;
    console.log(
      `| ${row.scenario} | ${row.label} | ${median(s.map(x => x.violations))} | ${median(s.map(x => x.hard))} | ${fmt(
        median(s.map(x => x.total)),
        1
      )} | ${fmt(average(s.map(x => x.coverage)), 1)} | ${fmt(average(s.map(x => x.nightCoverage)), 1)} | ${fmt(
        average(s.map(x => x.nightPattern)),
        1
      )} | ${fmt(average(s.map(x => x.hourRange)), 1)} | ${fmt(
        average(s.map(x => x.hourStd)),
        1
      )} | ${fmt(average(s.map(x => x.nightRange)), 1)} | ${fmt(average(s.map(x => x.pairDivergence)), 1)} | ${fmt(
        average(s.map(x => x.elapsedMs)),
        0
      )} ms |`
    );
    if (args.details) {
      const first = row.samples[0].coverageSummary;
      console.log(
        `<!-- ${row.scenario} ${row.label}: M ${first.mMin}-${first.mMax}, P ${first.pMin}-${first.pMax}, N ${first.nMin}-${first.nMax} -->`
      );
    }
  }
}

main();

/**
 * @file solvers.js — HiGHS, GLPK, and fallback solver integrations
 * @description Loads solver libraries, runs MILP/heuristic solves, and orchestrates
 * the multi-solution generation pipeline.
 */

'use strict';

// ---------------------------------------------------------------------------
// HiGHS MILP solver
// ---------------------------------------------------------------------------

/**
 * Load HiGHS WASM solver. Returns the highs instance or null on failure.
 * Diagnostics are surfaced via progress() so the user can see what happened.
 */
/**
 * Patch highs.solve() to handle the "Unable to parse solution. Too few lines." bug.
 * The highs-js wrapper always calls parseResult() after solving, even when the model
 * is infeasible and HiGHS writes no solution output. This causes an unrecoverable throw
 * inside highs.solve(). We wrap it to catch the parse error and return a degraded result
 * that our code can handle gracefully (null schedule → actionable error message).
 */
function _patchHighsSolve(h) {
  const origSolve = h.solve.bind(h);
  h.solve = function (lp, opts) {
    try {
      return origSolve(lp, opts);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const isParseErr = msg.includes('parse solution') || msg.includes('Too few lines');
      // Mark instance as corrupted — WASM state may be inconsistent after any error
      _highsCorrupted = true;
      if (isParseErr) {
        console.warn('[HiGHS] Caught solution parse error (highs-js bug): ' + msg);
        console.warn('[HiGHS] Instance marked as corrupted — will reload for next attempt');
        return { Status: 'Infeasible (solution parse failed)', Columns: {} };
      }
      throw err;
    }
  };
  console.log('[HiGHS] Patched solve() to handle solution parse errors');
}

let _highsFactory = null; // saved Emscripten factory function (survives instance reloads)
let _highsPromise = null;
let _highsCorrupted = false; // set to true after any solve error (WASM state unreliable)
let _highsLoadDiag = ''; // diagnostic message from last load attempt
let _highsLoadState = null;
let _glpkLoadDiag = '';
let _glpkLoadState = null;

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

function rememberDiagnostic(target, diagnostic) {
  if (!diagnostic) return null;
  const summary = diagnostic.detail ? `${diagnostic.userMessage} — ${diagnostic.detail}` : diagnostic.userMessage;
  const logger = diagnostic.severity === 'error' ? console.error : diagnostic.severity === 'warning' ? console.warn : console.log;
  logger(`[${diagnostic.source.toUpperCase()}] ${summary}`);
  if (target === 'highs') {
    _highsLoadState = diagnostic;
    _highsLoadDiag = diagnostic.detail || diagnostic.userMessage;
  } else if (target === 'glpk') {
    _glpkLoadState = diagnostic;
    _glpkLoadDiag = diagnostic.detail || diagnostic.userMessage;
  }
  return diagnostic;
}

/**
 * Create a fresh HiGHS WASM instance from the saved factory.
 * Returns a promise that resolves to the highs object or null.
 */
function _createHighsInstance() {
  const t0 = Date.now();
  return new Promise(resolve => {
    try {
      if (typeof _highsFactory !== 'function') {
        const msg = `HiGHS factory is ${typeof _highsFactory}, not a function`;
        rememberDiagnostic(
          'highs',
          makeDiagnostic('highs', 'wasm_init', 'solver_unavailable', 'error', 'HiGHS non disponibile', msg)
        );
        resolve(null);
        return;
      }

      const inst = _highsFactory({
        locateFile: file => 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/' + file,
      });

      if (inst && typeof inst.then === 'function') {
        inst
          .then(h => {
            const elapsed = Date.now() - t0;
            const hasSolve = h && typeof h.solve === 'function';
            console.log(`[HiGHS] WASM initialized in ${elapsed}ms, solve=${typeof h?.solve}`);
            if (!hasSolve) {
              const keys = h ? Object.keys(h).slice(0, 20).join(', ') : 'null';
              rememberDiagnostic(
                'highs',
                makeDiagnostic(
                  'highs',
                  'wasm_init',
                  'wasm_unavailable',
                  'error',
                  'HiGHS inizializzato ma WASM non disponibile',
                  `WASM loaded but .solve() missing. Instance keys: [${keys}]`
                )
              );
            } else {
              rememberDiagnostic(
                'highs',
                makeDiagnostic('highs', 'wasm_init', 'ready', 'info', 'HiGHS pronto', `OK (${elapsed}ms)`)
              );
              _patchHighsSolve(h);
            }
            resolve(h);
          })
          .catch(err => {
            const msg = `WASM init rejected: ${err?.message || err}`;
            rememberDiagnostic(
              'highs',
              makeDiagnostic(
                'highs',
                'wasm_init',
                'wasm_init_failed',
                'error',
                'HiGHS inizializzato ma WASM non disponibile',
                msg
              )
            );
            resolve(null);
          });
      } else {
        const elapsed = Date.now() - t0;
        const hasSolve = inst && typeof inst.solve === 'function';
        console.log(`[HiGHS] Loaded (sync) in ${elapsed}ms, solve=${typeof inst?.solve}`);
        if (hasSolve) {
          rememberDiagnostic(
            'highs',
            makeDiagnostic('highs', 'wasm_init', 'ready', 'info', 'HiGHS pronto', `OK sync (${elapsed}ms)`)
          );
          _patchHighsSolve(inst);
        } else {
          rememberDiagnostic(
            'highs',
            makeDiagnostic(
              'highs',
              'wasm_init',
              'wasm_unavailable',
              'error',
              'HiGHS inizializzato ma WASM non disponibile',
              'Loaded sync but .solve() missing'
            )
          );
        }
        resolve(inst);
      }
    } catch (e) {
      const msg = `Instance creation failed: ${e.message || e}`;
      rememberDiagnostic(
        'highs',
        makeDiagnostic('highs', 'wasm_init', 'wasm_init_failed', 'error', 'HiGHS inizializzato ma WASM non disponibile', msg)
      );
      resolve(null);
    }
  });
}

function loadHiGHS() {
  // Return cached instance if valid
  if (_highsPromise && !_highsCorrupted) return _highsPromise;

  // If corrupted, discard old instance and create fresh one
  if (_highsCorrupted) {
    console.log('[HiGHS] Previous instance corrupted, creating fresh WASM instance...');
    _highsPromise = null;
    _highsCorrupted = false;
  }

  console.log('[HiGHS] Starting load...');
  const t0 = Date.now();
  _highsPromise = new Promise(resolve => {
    try {
      // Load the script only once; save the factory for re-instantiation
      if (!_highsFactory) {
        importScripts('https://cdn.jsdelivr.net/npm/highs@1.8.0/build/highs.js');
        console.log(`[HiGHS] importScripts completed in ${Date.now() - t0}ms`);

        // Emscripten MODULARIZE=1 sets the factory on self.Module (default EXPORT_NAME)
        _highsFactory = self.Module;
        if (typeof _highsFactory !== 'function') {
          const candidates = Object.keys(self).filter(
            k => /highs|module|solver/i.test(k) && typeof self[k] === 'function'
          );
          const msg = `self.Module is ${typeof _highsFactory}, not a function. Candidate globals: [${candidates.join(', ')}]`;
          rememberDiagnostic(
            'highs',
            makeDiagnostic('highs', 'script_load', 'solver_unavailable', 'error', 'HiGHS non disponibile', msg)
          );
          _highsFactory = null;
          resolve(null);
          return;
        }
      } else {
        console.log('[HiGHS] Script already loaded, creating fresh WASM instance...');
      }

      _createHighsInstance().then(resolve);
    } catch (e) {
      const msg = `importScripts failed: ${e.message || e}`;
      rememberDiagnostic(
        'highs',
        makeDiagnostic('highs', 'script_load', 'cdn_load_failed', 'error', 'HiGHS non caricato: errore rete/CDN', msg)
      );
      resolve(null);
    }
  });
  return _highsPromise;
}

/**
 * Solve a single MILP instance with HiGHS.
 */
let _lastHighsStatus = ''; // last HiGHS solver status for diagnostics
let _lastGLPKStatusName = '';

function buildHighsSolveDiagnostic(status, elapsedSec) {
  const normalizedStatus = String(status || '').toLowerCase();
  const infeasible = normalizedStatus.includes('infeasible');
  const detail = `Stato solver: ${status || 'sconosciuto'}${elapsedSec !== undefined ? ` · tempo ${elapsedSec.toFixed(2)}s` : ''}`;
  return makeDiagnostic(
    'highs',
    'solve',
    infeasible ? 'model_infeasible' : 'no_solution',
    'warning',
    infeasible
      ? 'Il modello non ha trovato una soluzione ammissibile con i vincoli attuali'
      : 'HiGHS non ha prodotto una soluzione utilizzabile',
    detail,
    { status: status || 'sconosciuto' }
  );
}

function buildGLPKSolveDiagnostic(statusName, elapsedSec) {
  const normalizedStatus = String(statusName || '').toLowerCase();
  const infeasible = normalizedStatus.includes('infeasible') || normalizedStatus.includes('nofeas');
  const detail = `Stato solver: ${statusName || 'sconosciuto'}${elapsedSec !== undefined ? ` · tempo ${elapsedSec.toFixed(2)}s` : ''}`;
  return makeDiagnostic(
    'glpk',
    'solve',
    infeasible ? 'model_infeasible' : 'no_solution',
    'warning',
    infeasible
      ? 'Il modello non ha trovato una soluzione ammissibile con i vincoli attuali'
      : 'GLPK non ha prodotto una soluzione utilizzabile',
    detail,
    { status: statusName || 'sconosciuto' }
  );
}

function solveOneMILP(highs, ctx, perturbSeed, timeLimit) {
  const lp = buildLP(ctx, perturbSeed);
  const lpLines = lp.split('\n');
  const binCount = lpLines.filter(l => l.trim().startsWith('x')).length;
  const constraintCount = lpLines.filter(l => l.includes(':')).length;
  console.log(
    `[HiGHS] Building LP: ~${constraintCount} constraints, ~${binCount} binary var lines, seed=${perturbSeed}, timeLimit=${timeLimit}s`
  );

  const opts = {
    time_limit: timeLimit,
    presolve: 'off', // avoid highs-js solution parse bug when presolve reduces the problem
    mip_rel_gap: 0.05, // relaxed from 0.02 to find feasible solutions faster
    mip_feasibility_tolerance: 1e-4,
    random_seed: perturbSeed * 137,
    output_flag: false,
    log_to_console: false,
  };
  const t0 = Date.now();
  const result = highs.solve(lp, opts);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  _lastHighsStatus = result.Status || 'Unknown';
  console.log(`[HiGHS] Solve completed in ${elapsed}s — Status: "${result.Status}"`);
  if (result.ObjectiveValue !== undefined) {
    console.log(`[HiGHS]   ObjectiveValue: ${result.ObjectiveValue}`);
  }
  if (result.Columns) {
    const colCount = Object.keys(result.Columns).length;
    const assignedCount = Object.values(result.Columns).filter(c => Math.round(c.Primal) === 1).length;
    console.log(`[HiGHS]   Columns: ${colCount} total, ${assignedCount} assigned (Primal≈1)`);
  } else {
    console.warn('[HiGHS]   No Columns in result — solver did not produce a solution');
  }
  // Log all result keys for diagnostics
  console.log(`[HiGHS]   Result keys: ${Object.keys(result).join(', ')}`);

  // Accept any status that has columns (a feasible or partial solution)
  const acceptedStatuses = ['Optimal', 'Time limit reached', 'Target for objective reached'];
  if (acceptedStatuses.includes(result.Status)) {
    console.log(`[HiGHS]   → Accepted (status: ${result.Status})`);
    return parseSolution(result, ctx);
  }

  // Even for non-standard statuses, try to extract a solution if columns exist
  if (result.Columns && Object.keys(result.Columns).length > 0) {
    const assignedCount = Object.values(result.Columns).filter(c => Math.round(c.Primal) === 1).length;
    if (assignedCount > 0) {
      console.warn(
        `[HiGHS]   → Status "${result.Status}" is non-standard, but found ${assignedCount} assigned columns — attempting to parse solution anyway`
      );
      return parseSolution(result, ctx);
    }
  }

  console.warn(`[HiGHS]   → Rejected: no usable solution (Status: "${result.Status}")`);
  return null;
}

// ---------------------------------------------------------------------------
// GLPK.js solver
// ---------------------------------------------------------------------------

let _glpkPromise = null;
function loadGLPK() {
  if (_glpkPromise) return _glpkPromise;
  console.log('[GLPK] Starting load...');
  const t0 = Date.now();
  _glpkPromise = new Promise(resolve => {
    try {
      importScripts('https://cdn.jsdelivr.net/npm/glpk.js/dist/glpk.min.js');
      const initGLPK = self.GLPK || self.glpk;
      if (typeof initGLPK === 'function') {
        const inst = initGLPK();
        if (inst && typeof inst.then === 'function') {
          inst
            .then(g => {
              console.log(`[GLPK] Loaded successfully in ${Date.now() - t0}ms, solve=${typeof g?.solve}`);
              if (!g || typeof g.solve !== 'function') {
                rememberDiagnostic(
                  'glpk',
                  makeDiagnostic(
                    'glpk',
                    'script_load',
                    'solver_unavailable',
                    'error',
                    'GLPK non disponibile',
                    'Inizializzazione completata ma .solve() non è disponibile'
                  )
                );
              } else {
                rememberDiagnostic(
                  'glpk',
                  makeDiagnostic('glpk', 'script_load', 'ready', 'info', 'GLPK pronto', `OK (${Date.now() - t0}ms)`)
                );
              }
              resolve(g);
            })
            .catch(err => {
              rememberDiagnostic(
                'glpk',
                makeDiagnostic(
                  'glpk',
                  'script_load',
                  'wasm_init_failed',
                  'error',
                  'GLPK non disponibile',
                  `Init promise rejected: ${err?.message || err}`
                )
              );
              resolve(null);
            });
        } else {
          console.log(`[GLPK] Loaded (sync) in ${Date.now() - t0}ms, solve=${typeof inst?.solve}`);
          if (!inst || typeof inst.solve !== 'function') {
            rememberDiagnostic(
              'glpk',
              makeDiagnostic(
                'glpk',
                'script_load',
                'solver_unavailable',
                'error',
                'GLPK non disponibile',
                'Caricato in modo sincrono ma .solve() non è disponibile'
              )
            );
          } else {
            rememberDiagnostic(
              'glpk',
              makeDiagnostic('glpk', 'script_load', 'ready', 'info', 'GLPK pronto', `OK sync (${Date.now() - t0}ms)`)
            );
          }
          resolve(inst);
        }
      } else {
        rememberDiagnostic(
          'glpk',
          makeDiagnostic(
            'glpk',
            'script_load',
            'solver_unavailable',
            'error',
            'GLPK non disponibile',
            `initGLPK is not a function: ${typeof initGLPK}`
          )
        );
        resolve(null);
      }
    } catch (e) {
      rememberDiagnostic(
        'glpk',
        makeDiagnostic('glpk', 'script_load', 'cdn_load_failed', 'error', 'GLPK non caricato: errore rete/CDN', `Load failed with exception: ${e.message || e}`)
      );
      resolve(null);
    }
  });
  return _glpkPromise;
}

/**
 * Solve a single MILP instance with GLPK.js.
 */
async function solveOneGLPK(glpk, ctx, perturbSeed, timeLimit) {
  const lp = buildLP(ctx, perturbSeed);
  const model = lpToGLPKModel(lp, glpk);
  if (!model) {
    console.error('[GLPK] LP-to-GLPK model conversion returned null');
    return null;
  }

  console.log(
    `[GLPK] Model built: ${model.subjectTo?.length || 0} constraints, ${model.binaries?.length || 0} binaries, seed=${perturbSeed}, timeLimit=${timeLimit}s`
  );

  try {
    const t0 = Date.now();
    let result = glpk.solve(model, {
      msglev: glpk.GLP_MSG_OFF,
      tmlim: Math.ceil(timeLimit),
      mipgap: 0.05,
    });
    // Handle both sync and async solve
    if (result && typeof result.then === 'function') {
      console.log('[GLPK] Solve returned a promise, awaiting...');
      result = await result;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    if (!result || !result.result) {
      console.error(`[GLPK] Solve completed in ${elapsed}s but returned no result object`);
      if (result) console.error('[GLPK]   result keys:', Object.keys(result).join(', '));
      return null;
    }

    const status = result.result.status;
    const statusName = GLPK_STATUS_NAMES[status] || `unknown(${status})`;
    _lastGLPKStatusName = statusName;
    const vars = result.result.vars;
    const varCount = vars ? Object.keys(vars).length : 0;
    const assignedCount = vars ? Object.values(vars).filter(v => Math.round(v) === 1).length : 0;

    console.log(`[GLPK] Solve completed in ${elapsed}s — Status: ${statusName}`);
    console.log(`[GLPK]   Variables: ${varCount} total, ${assignedCount} assigned (≈1)`);
    if (result.result.z !== undefined) console.log(`[GLPK]   Objective value: ${result.result.z}`);

    // GLP_OPT = 5, GLP_FEAS = 2 — ideal outcomes
    if (status === 5 || status === 2) {
      console.log(`[GLPK]   → Accepted (status: ${statusName})`);
      return parseGLPKSolution(vars, ctx);
    }

    // For other statuses, try to extract a solution if variables exist
    if (vars && assignedCount > 0) {
      console.warn(
        `[GLPK]   → Status "${statusName}" is non-optimal, but found ${assignedCount} assigned vars — attempting to parse solution anyway`
      );
      return parseGLPKSolution(vars, ctx);
    }

    console.warn(`[GLPK]   → Rejected: no usable solution (status: ${statusName})`);
    return null;
  } catch (err) {
    console.error('[GLPK] Solve threw exception:', err.message || err);
    if (err.stack) console.error('[GLPK]   Stack:', err.stack);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback solver — multi-restart heuristic
// ---------------------------------------------------------------------------

function solveFallback(config) {
  const ctx = buildContext(config);

  let bestSchedule = null;
  let bestScore = { total: Infinity, hard: Infinity, soft: Infinity };

  for (let r = 0; r < NUM_RESTARTS; r++) {
    progress(5 + Math.floor(r * (80 / NUM_RESTARTS)), `Tentativo ${r + 1}/${NUM_RESTARTS}…`);

    const schedule = construct(ctx);
    const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS);
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
 * Multi-solution solver with configurable algorithm: HiGHS MILP / GLPK.js / heuristic.
 * @param {object} config
 * @param {number} numSolutions
 * @param {number} timeBudget  – total seconds allocated; 0 or undefined = default 30s
 * @param {boolean} untilZeroViolations – keep generating until a 0-violation solution is found
 * @param {string} solverChoice – 'auto'|'milp'|'glpk'|'fallback'
 */
async function solve(config, numSolutions, timeBudget, untilZeroViolations, solverChoice) {
  solverChoice = solverChoice || 'auto';
  numSolutions = Math.max(1, Math.min(numSolutions || 1, 20));
  const totalBudget = timeBudget && timeBudget > 0 ? timeBudget : MILP_DEFAULT_TOTAL_TIME_BUDGET;
  const ctx = buildContext(config);
  const solutions = [];
  const diagnostics = [];

  function addDiagnostic(diagnostic) {
    if (!diagnostic || diagnostic.severity === 'info') return diagnostic;
    const key = [diagnostic.source, diagnostic.phase, diagnostic.code, diagnostic.userMessage, diagnostic.detail].join('|');
    if (!diagnostics.some(d => [d.source, d.phase, d.code, d.userMessage, d.detail].join('|') === key)) {
      diagnostics.push(diagnostic);
    }
    return diagnostic;
  }

  console.log(
    `[Solver] Starting solve: solverChoice="${solverChoice}", numSolutions=${numSolutions}, timeBudget=${totalBudget}s, untilZeroViolations=${untilZeroViolations}`
  );
  console.log(
    `[Solver] Problem: ${ctx.numNurses} nurses, ${ctx.numDays} days, coverage M:${ctx.minCovM}-${ctx.maxCovM} P:${ctx.minCovP}-${ctx.maxCovP} N:${ctx.minCovN}-${ctx.maxCovN} D:${ctx.minCovD}-${ctx.maxCovD}`
  );

  // Load solvers based on user choice
  let highs = null,
    glpk = null;
  let milpAvailable = false,
    glpkAvailable = false;

  if (solverChoice === 'auto' || solverChoice === 'milp' || solverChoice === 'milp_strict') {
    progress(1, 'Caricamento solver HiGHS MILP…');
    try {
      highs = await loadHiGHS();
      milpAvailable = highs && typeof highs.solve === 'function';
      console.log(`[Solver] HiGHS loaded: available=${milpAvailable}, diag=${_highsLoadDiag}`);
      if (!milpAvailable) {
        addDiagnostic(_highsLoadState);
        progress(2, _highsLoadState?.userMessage || `HiGHS non disponibile: ${_highsLoadDiag}`);
      }
    } catch (loadErr) {
      console.error('[Solver] HiGHS loading threw exception:', loadErr.message || loadErr);
      addDiagnostic(
        loadErr.diagnostics?.[0] ||
          makeDiagnostic('highs', 'script_load', 'load_error', 'error', 'HiGHS non disponibile', loadErr.message || String(loadErr))
      );
      progress(2, _highsLoadState?.userMessage || `Errore caricamento HiGHS: ${loadErr.message || loadErr}`);
      milpAvailable = false;
    }
  }

  // Load GLPK for auto, glpk, and milp_strict modes (strict uses GLPK as MILP fallback)
  if (solverChoice === 'auto' || solverChoice === 'glpk' || solverChoice === 'milp_strict') {
    progress(2, 'Caricamento solver GLPK…');
    try {
      glpk = await loadGLPK();
      glpkAvailable = glpk && typeof glpk.solve === 'function';
      console.log(`[Solver] GLPK loaded: available=${glpkAvailable}, diag=${_glpkLoadDiag}`);
      if (!glpkAvailable) {
        addDiagnostic(_glpkLoadState);
        progress(3, _glpkLoadState?.userMessage || `GLPK non disponibile: ${_glpkLoadDiag}`);
      }
    } catch (loadErr) {
      console.error('[Solver] GLPK loading threw exception:', loadErr.message || loadErr);
      addDiagnostic(
        loadErr.diagnostics?.[0] ||
          makeDiagnostic('glpk', 'script_load', 'load_error', 'error', 'GLPK non disponibile', loadErr.message || String(loadErr))
      );
      glpkAvailable = false;
    }
  }

  // In strict mode, at least one MILP solver must be available
  if (solverChoice === 'milp_strict' && !milpAvailable && !glpkAvailable) {
    const diagnostic = makeDiagnostic(
      'solver',
      'availability',
      'solver_unavailable',
      'error',
      'Nessun solver MILP disponibile',
      'Modalità strict richiede almeno un solver MILP funzionante. Verifica la connessione internet e riprova.'
    );
    addDiagnostic(diagnostic);
    throw makeSolverError(
      'Impossibile caricare nessun solver MILP (HiGHS e GLPK). Modalità strict richiede almeno un solver MILP funzionante.',
      diagnostics,
      'solver_unavailable'
    );
  }

  // Determine which solvers to try
  let useHiGHS =
    milpAvailable && (solverChoice === 'auto' || solverChoice === 'milp' || solverChoice === 'milp_strict');
  const useGLPK =
    glpkAvailable && (solverChoice === 'auto' || solverChoice === 'glpk' || solverChoice === 'milp_strict');
  const strictMode = solverChoice === 'milp_strict';
  console.log(
    `[Solver] Solver plan: useHiGHS=${useHiGHS}, useGLPK=${useGLPK}, strict=${strictMode}, fallback=${!strictMode ? 'available' : 'disabled'}`
  );

  /** Generate one batch of solutions */
  async function generateBatch(batchSolutions, batchLabel, seedOffset) {
    const milpTimeLimitSec = Math.max(MILP_MIN_TIME_PER_SOLUTION, Math.floor(totalBudget / numSolutions));
    const perSolutionBudgetSec = Math.max(1, totalBudget / numSolutions);

    for (let i = 0; i < numSolutions; i++) {
      const pctBase = 5 + Math.floor((i * 80) / numSolutions);
      const seed = seedOffset + i;
      let solved = false;
      let highsFailure = null;
      let glpkFailure = null;

      console.log(`[Solver] === Solution ${i + 1}/${numSolutions} (seed=${seed}) ===`);

      // Try HiGHS MILP
      if (useHiGHS && !solved) {
        progress(pctBase, `${batchLabel}HiGHS MILP: soluzione ${i + 1}/${numSolutions} (max ${milpTimeLimitSec}s)…`);
        try {
          console.log(`[Solver] Trying HiGHS MILP (timeLimit=${milpTimeLimitSec}s)...`);
          const milpStart = Date.now();
          const schedule = solveOneMILP(highs, ctx, seed, milpTimeLimitSec);
          const milpElapsed = (Date.now() - milpStart) / 1000;
          if (schedule) {
            console.log(`[Solver] HiGHS returned a schedule in ${milpElapsed.toFixed(2)}s, polishing...`);
            progress(pctBase + 2, `${batchLabel}HiGHS OK in ${milpElapsed.toFixed(0)}s, ottimizzazione locale…`);
            const polishTimeSec = Math.max(1, perSolutionBudgetSec - milpElapsed);
            const polished = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, polishTimeSec);
            const violations = collectViolations(polished, ctx);
            const stats = computeStats(polished, ctx);
            const score = computeScore(polished, ctx);
            console.log(
              `[Solver] HiGHS solution: score=${score.total} (hard=${score.hard}, soft=${score.soft}), violations=${violations.length}`
            );
            batchSolutions.push({ schedule: polished, violations, stats, score: score.total, solverMethod: 'milp' });
            solved = true;
          } else {
            const status = _lastHighsStatus || 'sconosciuto';
            const reason = `nessuna soluzione ammissibile in ${milpElapsed.toFixed(0)}s (stato: ${status})`;
            highsFailure = addDiagnostic(buildHighsSolveDiagnostic(status, milpElapsed));
            console.warn(
              `[Solver] HiGHS returned null (no feasible solution) after ${milpElapsed.toFixed(2)}s, status="${status}"`
            );
            progress(pctBase, `${batchLabel}HiGHS fallito: ${highsFailure?.userMessage || reason}`);
            // Reload corrupted instance for next attempt
            if (_highsCorrupted) {
              try {
                console.log('[Solver] Reloading corrupted HiGHS instance after parse failure...');
                highs = await loadHiGHS();
                if (!highs || typeof highs.solve !== 'function') {
                  console.error('[Solver] HiGHS reload failed after parse failure');
                  useHiGHS = false;
                }
              } catch (reloadErr) {
                console.error('[Solver] HiGHS reload exception:', reloadErr.message);
                useHiGHS = false;
              }
            }
          }
        } catch (highsErr) {
          console.error('[Solver] HiGHS solve threw exception:', highsErr.message || highsErr);
          if (highsErr.stack) console.error('[Solver]   Stack:', highsErr.stack);
          highsFailure = addDiagnostic(
            makeDiagnostic(
              'highs',
              'solve',
              'solve_error',
              'error',
              'Errore HiGHS durante la generazione',
              highsErr.message || String(highsErr)
            )
          );
          progress(pctBase, `${batchLabel}${highsFailure.userMessage}`);
        }

        // Reload HiGHS if corrupted (for next solution attempt)
        if (_highsCorrupted && !solved) {
          try {
            console.log('[Solver] Reloading corrupted HiGHS instance...');
            highs = await loadHiGHS();
            if (!highs || typeof highs.solve !== 'function') {
              console.error('[Solver] HiGHS reload failed, disabling for remaining solutions');
              useHiGHS = false;
            }
          } catch (reloadErr) {
            console.error('[Solver] HiGHS reload exception:', reloadErr.message);
            useHiGHS = false;
          }
        }
      }

      // Try GLPK
      if (useGLPK && !solved) {
        progress(pctBase, `${batchLabel}GLPK: soluzione ${i + 1}/${numSolutions}…`);
        try {
          console.log(`[Solver] Trying GLPK (timeLimit=${milpTimeLimitSec}s)...`);
          const glpkStart = Date.now();
          const schedule = await solveOneGLPK(glpk, ctx, seed, milpTimeLimitSec);
          const glpkElapsed = (Date.now() - glpkStart) / 1000;
          if (schedule) {
            console.log(`[Solver] GLPK returned a schedule in ${glpkElapsed.toFixed(2)}s, polishing...`);
            const polishTimeSec = Math.max(1, perSolutionBudgetSec - glpkElapsed);
            const polished = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, polishTimeSec);
            const violations = collectViolations(polished, ctx);
            const stats = computeStats(polished, ctx);
            const score = computeScore(polished, ctx);
            console.log(
              `[Solver] GLPK solution: score=${score.total} (hard=${score.hard}, soft=${score.soft}), violations=${violations.length}`
            );
            batchSolutions.push({ schedule: polished, violations, stats, score: score.total, solverMethod: 'glpk' });
            solved = true;
          } else {
            console.warn(`[Solver] GLPK returned null (no feasible solution) after ${glpkElapsed.toFixed(2)}s`);
            glpkFailure = addDiagnostic(buildGLPKSolveDiagnostic(_lastGLPKStatusName, glpkElapsed));
            progress(pctBase, `${batchLabel}GLPK fallito: ${glpkFailure?.userMessage || 'nessuna soluzione trovata'}`);
          }
        } catch (glpkErr) {
          console.error('[Solver] GLPK solve threw exception:', glpkErr.message || glpkErr);
          if (glpkErr.stack) console.error('[Solver]   Stack:', glpkErr.stack);
          glpkFailure = addDiagnostic(
            makeDiagnostic(
              'glpk',
              'solve',
              'solve_error',
              'error',
              'Errore GLPK durante la generazione',
              glpkErr.message || String(glpkErr)
            )
          );
        }
      }

      // Greedy + SA fallback (disabled in strict mode)
      if (!solved) {
        if (strictMode) {
          const attempted = [useHiGHS && 'HiGHS', useGLPK && 'GLPK'].filter(Boolean);
          addDiagnostic(
            makeDiagnostic(
              'solver',
              'solve',
              'solver_no_solution',
              'error',
              'Nessun solver MILP ha prodotto una soluzione utilizzabile',
              `Solver tentati: ${attempted.join(', ') || 'nessuno'}. Modalità strict non consente fallback euristico.`
            )
          );
          throw makeSolverError(
            `Nessun solver MILP ha prodotto una soluzione per la soluzione ${i + 1}/${numSolutions}. ` +
              `Solver tentati: ${attempted.join(', ') || 'nessuno'}. Modalità strict non consente fallback euristico. ` +
              'Prova ad aumentare il tempo di calcolo o rilassare i vincoli.',
            diagnostics,
            'solver_no_solution'
          );
        }
        const attempted = [useHiGHS && 'HiGHS', useGLPK && 'GLPK'].filter(Boolean);
        const label = attempted.length > 0 ? `Fallback euristica (${attempted.join('+')})` : 'Euristica';
        const fallbackReason =
          attempted.length === 1
            ? `${attempted[0]} fallito, uso euristica come fallback`
            : attempted.length > 1
              ? `${attempted.join(' e ')} falliti, uso euristica come fallback`
              : solverChoice === 'milp'
                ? 'HiGHS non disponibile, uso euristica come fallback'
                : solverChoice === 'glpk'
                  ? 'GLPK non disponibile, uso euristica come fallback'
                  : 'Solver MILP non disponibili, uso euristica come fallback';
        addDiagnostic(
          makeDiagnostic(
            'solver',
            'fallback',
            'fallback_used',
            'warning',
            fallbackReason,
            [highsFailure?.userMessage, glpkFailure?.userMessage, _highsLoadState?.userMessage, _glpkLoadState?.userMessage]
              .filter(Boolean)
              .join(' · ')
          )
        );
        console.log(`[Solver] MILP solvers failed/unavailable [${attempted.join(',')}], using fallback`);
        progress(pctBase, `${batchLabel}${fallbackReason}. ${label} ${i + 1}/${numSolutions}…`);
        const schedule = construct(ctx);
        const improved = localSearch(schedule, ctx, LOCAL_SEARCH_ITERS, perSolutionBudgetSec);
        const violations = collectViolations(improved, ctx);
        const stats = computeStats(improved, ctx);
        const score = computeScore(improved, ctx);
        console.log(
          `[Solver] Fallback solution: score=${score.total} (hard=${score.hard}, soft=${score.soft}), violations=${violations.length}`
        );
        batchSolutions.push({ schedule: improved, violations, stats, score: score.total, solverMethod: 'fallback' });
      }
    }
  }

  // Status message with diagnostic detail
  const availSolvers = [];
  if (useHiGHS) availSolvers.push('HiGHS');
  if (useGLPK) availSolvers.push('GLPK');
  if (availSolvers.length > 0) {
    const milpTime = Math.max(MILP_MIN_TIME_PER_SOLUTION, Math.floor(totalBudget / numSolutions));
    const strictLabel = strictMode ? ' [STRICT — nessun fallback]' : '';
    progress(5, `Solver: ${availSolvers.join(', ')}${strictLabel}. ${numSolutions} soluzioni, ${milpTime}s ciascuna…`);
  } else if (solverChoice === 'fallback') {
    progress(5, 'Euristica selezionata manualmente…');
  } else {
    // Tell the user why no MILP solver is available
    const reasons = [];
    if (solverChoice === 'auto' || solverChoice === 'milp' || solverChoice === 'milp_strict')
      reasons.push(`HiGHS: ${_highsLoadDiag || 'non caricato'}`);
    if (solverChoice === 'auto' || solverChoice === 'glpk' || solverChoice === 'milp_strict')
      reasons.push(`GLPK: ${_glpkLoadDiag || 'non caricato'}`);
    progress(5, `Nessun solver MILP disponibile (${reasons.join('; ')}). Uso euristica…`);
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

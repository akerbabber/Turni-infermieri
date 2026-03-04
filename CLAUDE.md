# CLAUDE.md — Turni Infermieri

## Project Overview

**Turni Infermieri** (Pronto Soccorso) is a browser-only Italian-language web application for scheduling nurse shifts in an emergency room. It solves the Nurse Scheduling Problem (NSP) using mathematical optimization (MILP) with heuristic fallback.

Zero dependencies. No server. No build step. Open `index.html` in a browser and it works.

The app is a 4-step wizard: configure staff (Organico) -> set rules (Regole) -> generate schedule (Genera) -> view/edit results (Risultati).

---

## Quick Start

```bash
# Option 1: Open directly in browser
open index.html        # macOS
xdg-open index.html    # Linux

# Option 2: Local server (needed for Web Worker in some browsers)
npx http-server -p 8080 -c-1
# or
python3 -m http.server 8080

# Option 3: npm serve script
npm run serve
```

For development with linting and testing:
```bash
npm install            # Install dev dependencies (eslint, prettier)
npm run validate       # Run lint + format check + tests (all-in-one)
```

---

## Architecture

```
/
├── index.html          # Single-page app: 4-step wizard UI (739 lines)
├── js/
│   ├── app.js          # Main thread: state, UI rendering, event handling (1309 lines)
│   └── solver.js       # Web Worker: MILP solver + heuristic fallback (2399 lines)
├── css/
│   └── custom.css      # Styles, dark mode vars, print styles (498 lines)
├── test/               # Node.js test files (node --test)
├── package.json        # Dev scripts only (lint, test, format)
├── eslint.config.js    # ESLint 9 flat config
├── .prettierrc.json    # Prettier config (2-space, single quotes, semicolons)
├── .editorconfig       # Editor settings (2-space indent, LF, UTF-8)
└── .github/
    └── workflows/
        ├── ci.yml      # Lint + format check + test on PRs
        └── deploy.yml  # Deploy to GitHub Pages on push to main
```

### How components relate

```
index.html
  └── loads js/app.js (main thread)
        ├── Manages global `state` object
        ├── Renders UI via innerHTML + template literals
        ├── Persists to localStorage
        └── Spawns js/solver.js as Web Worker
              ├── Receives: {type:'solve', config, numSolutions, timeBudget, solverChoice}
              ├── Sends:    {type:'progress', percent, message}
              ├── Sends:    {type:'result', schedule, violations, stats, solutions, solverMethod}
              └── Sends:    {type:'error', message}
```

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run tests via `node --test test/` |
| `npm run lint` | Lint `js/` with ESLint |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm run format` | Format JS, CSS, HTML with Prettier |
| `npm run format:check` | Check formatting (CI mode) |
| `npm run validate` | Run lint + format check + tests (all-in-one) |
| `npm run serve` | Start local dev server on port 8080 |

---

## Tech Stack

- **Pure HTML/CSS/JavaScript** -- no frameworks, no bundler
- **Tailwind CSS** via CDN (`cdn.tailwindcss.com`) with offline fallbacks in `custom.css`
- **HiGHS** MILP solver loaded as WASM inside the Web Worker
- **GLPK.js** as secondary MILP solver (loaded on demand)
- **Web Workers** for non-blocking solver execution
- **localStorage** for state persistence
- **Node.js built-in test runner** (`node --test`) for unit tests

---

## Key Domain Concepts

### Shift Codes

| Code | Italian Name | English | Hours | Color |
|------|-------------|---------|-------|-------|
| M | Mattina | Morning | 6.2 | Blue |
| P | Pomeriggio | Afternoon | 6.2 | Amber |
| D | Diurno | Day-long (covers M+P) | 12.2 | Purple |
| N | Notte | Night | 12.2 | Dark blue |
| S | Smonto | Post-night off | 0 | Gray |
| R | Riposo | Rest day | 0 | Green |
| F | Ferie | Holiday/vacation | 6.12 | Cyan |
| MA | Malattia | Sick leave | 6.12 | Red |
| L104 | Legge 104 | Disability law leave | 6.12 | Indigo |
| PR | Permesso Retribuito | Paid leave | 6.12 | Pink |
| MT | Maternita | Maternity leave | 6.12 | Light pink |

### Nurse Tags

Scheduling constraint tags applied per-nurse:
- `solo_mattine` -- Morning shifts only (pinned to M on weekdays, R on weekends)
- `solo_diurni` -- Day-long shifts only
- `solo_notti` -- Night shifts only
- `diurni_e_notturni` -- D and N shifts only
- `no_notti` -- No night shifts
- `no_diurni` -- No day-long shifts

Absence tags (with date ranges via `absencePeriods`):
- `ferie` -> F, `malattia` -> MA, `104` -> L104, `permesso_retribuito` -> PR, `maternita` -> MT

### Constraint Types

**Hard constraints** (must be satisfied):
- Daily coverage: min/max nurses per shift type (M, P, D, N)
- Forbidden transitions: P->M, P->D (unless relaxed), D->M, D->P, D->D (unless relaxed), N->S mandatory, S->R mandatory
- N-S-R-R pattern: night must be followed by smonto, then rest, then another rest
- 11-hour minimum gap between shifts
- Weekly rest minimums (default: 2 R per week)
- Night shift caps per nurse

**Soft objectives** (optimized):
- Hours equity across nurses (weight 3)
- Night-shift count fairness (weight 3)
- D-shift count fairness among eligible nurses (weight 3)
- M/P balance for `no_diurni` nurses (weight 2)

---

## Coding Conventions

- **Strict mode**: Every JS file starts with `'use strict';`
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `SHIFT_HOURS`, `DEFAULT_RULES`, `MILP_DEFAULT_TOTAL_TIME_BUDGET`)
- **Functions/variables**: `camelCase` (e.g., `buildContext`, `nurseHours`, `computeScore`)
- **UI text**: Italian (labels, button text, violation messages, progress messages)
- **Code comments**: English
- **HTML generation**: Template literals with `innerHTML`; always escape user input with `escHtml()`
- **Indentation**: 2 spaces (enforced by `.editorconfig` and Prettier)
- **Semicolons**: Required (enforced by ESLint `semi: 'error'` and Prettier `semi: true`)
- **Quotes**: Single quotes (Prettier `singleQuote: true`)
- **Line width**: 120 characters (Prettier `printWidth: 120`)
- **Variable declarations**: `const` preferred, `let` when needed, `var` is forbidden (`no-var: 'error'`)
- **Equality**: Strict equality only (`eqeqeq: 'error'`)
- **Trailing commas**: ES5-style (Prettier `trailingComma: 'es5'`)

---

## Architecture Decisions

### Why no build tools
Zero-dependency philosophy. The app is a static site for GitHub Pages. Users (hospital staff) open `index.html` directly. No npm install, no webpack, no transpilation. The only dev dependencies are ESLint and Prettier for code quality.

### Why Web Workers
The MILP solver can take 10-60+ seconds. Running it on the main thread would freeze the UI. The Web Worker (`js/solver.js`) runs the solver in a background thread, sending progress updates via `postMessage` so the UI can show a progress bar.

### Why MILP + heuristic fallback
MILP (via HiGHS WASM or GLPK.js) provides optimal or near-optimal solutions with mathematical guarantees. The greedy + simulated annealing fallback ensures the app always produces a schedule even if the WASM solvers fail to load (e.g., offline, CDN blocked, browser incompatibility).

### Why Tailwind via CDN
Keeps the zero-dependency promise. `custom.css` provides fallback classes (`.hidden`, `.flex`, etc.) so the app works offline when the CDN is unreachable.

---

## Common Tasks

### Adding a new shift type

1. **`js/app.js`**: Add to `SHIFT_COLORS`, `SHIFT_LABELS`, `SHIFT_HOURS`
2. **`js/solver.js`**: Add to `SHIFT_HOURS` (duplicated for Worker context), update `ABSENCE_TAG_TO_SHIFT` if it maps from an absence tag, add to `SHIFT_START`/`SHIFT_END` if it has specific times
3. **`css/custom.css`**: Add `.shift-XX` color class and a print-friendly version in `@media print`
4. **`index.html`**: Add the shift option to any dropdown/selector that lists shifts (Step 4 inline edit dropdown)

### Adding a new constraint

1. **`js/app.js`**: Add the rule to `DEFAULT_RULES` with a sensible default. Add UI controls in Step 2 (Regole) section of `index.html`, and wire them in `renderStep2()`
2. **`js/solver.js`**:
   - Add to `buildContext()` to extract the rule from config
   - Implement the constraint in `computeScore()` (hard penalty for hard constraints, soft penalty for soft)
   - Add to `construct()` if it affects initial schedule building
   - Add to `buildLP()` if the MILP formulation should enforce it
   - Add to `collectViolations()` so violations appear in the UI
   - Add to local search moves if relevant

### Modifying the solver

- The solver has three entry points: `solveOneMILP()` (HiGHS), `solveOneGLPK()` (GLPK.js), `solveFallback()` (greedy + SA)
- All strategies share: `buildContext()`, `computeScore()`, `collectViolations()`, `computeStats()`, `localSearch()`
- The MILP formulation is in `buildLP()` which generates CPLEX LP format strings
- After any MILP solution, `localSearch()` polishes the result
- Test changes by generating schedules and checking violation counts in the UI

### Modifying the UI

- UI is rendered by `renderStep1()` through `renderStep4()` in `app.js`
- All HTML is generated via template literals and set via `innerHTML`
- Event listeners are wired in `init()` for static elements, and inline in render functions for dynamic elements
- The schedule grid (Step 4) supports inline editing via click handlers on `.shift-cell` elements
- Always test dark mode (toggle the moon/sun button) and print layout (`Ctrl+P`)

---

## Testing

### Running tests

```bash
npm test               # Runs: node --test test/
```

Tests use the **Node.js built-in test runner** (`node:test` module). No additional test framework needed.

### What is tested

Solver pure functions that do not depend on DOM or Web Worker context:
- Utility functions (`daysInMonth`, `dayOfWeek`, `gapHours`, etc.)
- Constraint checking (`transitionOk`, `dayCoverage`, `computeScore`)
- Schedule helpers (`nurseHours`, `nightCount`, `diurniCount`)

### Adding a new test

1. Create a file in `test/` (e.g., `test/my-feature.test.js`)
2. Use Node.js built-in test API:
```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('myFeature', () => {
  it('should do something', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
```
3. To test solver functions, extract them or `require` the relevant module. Since `solver.js` is designed for Web Worker context, you may need to extract pure functions into a testable form.

---

## Critical Patterns

### State management
A single mutable global `state` object in `app.js` is the source of truth:
```js
let state = {
  step: 1,             // Current wizard step (1-4)
  month: 0,            // 0-indexed month
  year: 2026,
  totalNurses: 37,
  absentNurses: 2,
  nurses: [...],       // Array of {id, name, tags, absencePeriods}
  rules: {...},        // Scheduling rules/constraints
  schedule: null,      // 2D array [nurse][day] of shift codes
  violations: [],      // Array of violation objects
  stats: [],           // Per-nurse statistics
  solutions: [],       // Multiple solver solutions
  selectedSolution: 0,
  solverMethod: null,  // 'milp'|'glpk'|'fallback'
  solverChoice: 'auto', // 'auto'|'milp'|'glpk'|'fallback'
  darkMode: false,
  worker: null,        // Current Web Worker reference (not persisted)
};
```
State is persisted to `localStorage` via `saveState()` / `loadState()`. The `worker` field is excluded from serialization.

### Worker communication
```
Main thread (app.js)                    Worker (solver.js)
─────────────────                       ──────────────────
new Worker('js/solver.js')
worker.postMessage({type:'solve',...})  ──→  self.onmessage
                                             solve() runs...
worker.onmessage  ←──  self.postMessage({type:'progress',...})
worker.onmessage  ←──  self.postMessage({type:'result',...})
worker.terminate()
```

### Dark mode
- Toggled by adding/removing CSS class `dark` on `<html>` element
- CSS custom properties in `:root` (light) and `html.dark` (dark) drive all colors
- Tailwind's `dark:` prefix classes are also used throughout `index.html`
- Toggle button in header switches `state.darkMode` and calls `applyDarkMode()`

### Pinned cells
Before solving, `buildContext()` pre-computes a `pinned[nurse][day]` matrix. Cells are pinned when:
- A nurse has an active absence tag with a date range covering that day
- A nurse has `solo_mattine` tag (pinned to M on weekdays, R on weekends)

The solver never modifies pinned cells.

### Coverage counting
**D (Diurno) shifts count toward both M and P coverage.** This is implemented in `dayCoverage()`:
```js
if (s === 'D') { D++; M++; P++; }
```
This means if you need 6 morning nurses and 3 have D shifts, only 3 more M shifts are needed.

### Score system
Scores combine hard and soft penalties: `total = hard * 1000 + soft`. A score with `hard > 0` always ranks worse than any score with `hard === 0`. The solver minimizes total score.

---

## Gotchas

1. **`solver.js` runs in a Web Worker** -- no `document`, no `window`, no `localStorage`. Only `self`, `postMessage`, `importScripts`, and standard JS APIs are available.

2. **D shifts count toward M+P coverage** -- When computing coverage, a D shift increments M count, P count, AND D count. Forgetting this leads to incorrect coverage calculations.

3. **Absence hours are 6.12, not 6.2** -- Working shifts (M, P) are 6.2 hours, but absence shifts (F, MA, L104, PR, MT) are 6.12 hours. This is an intentional contractual distinction.

4. **Italian month names array is 0-indexed** -- `MONTHS_IT[0]` is `'Gennaio'` (January). The `state.month` field is also 0-indexed (0 = January, 11 = December), matching JavaScript's `Date.getMonth()`.

5. **N-S-R-R is a 4-day mandatory pattern** -- After a night shift, the sequence must be N -> S -> R -> R. The second R is enforced for most nurses (except those with `no_diurni` tag who only need N -> S -> R).

6. **`SHIFT_HOURS` is duplicated** -- Both `app.js` and `solver.js` define their own `SHIFT_HOURS` constant because the Worker cannot share variables with the main thread. If you change shift hours, update both files.

7. **The solver generates multiple solutions** -- By default `numSolutions: 3`. Each uses a different random seed for MILP objective perturbation to produce diverse schedules. The UI lets users pick between them.

8. **`escHtml()` is critical for security** -- All user-provided text (nurse names) inserted into HTML must go through `escHtml()` to prevent XSS. Never use raw string interpolation for user input in innerHTML.

9. **`state.timeBudget` has three modes** -- `0` means auto (estimated from constraints), `> 0` means user-specified seconds, `-1` means keep trying until zero violations.

10. **The `forbidden` transition table is mutable** -- `buildContext()` copies `BASE_FORBIDDEN_NEXT` and then conditionally removes entries based on rule flags (`consentePomeriggioDiurno`, `consente2DiurniConsecutivi`). Always modify the copy, never the base.

---

## CI/CD

### CI Pipeline (`.github/workflows/ci.yml`)
Runs on every push to `main`/`master` and on all pull requests:
1. Checkout code
2. Setup Node.js 20
3. `npm ci` (install dependencies)
4. `npm run lint` (ESLint)
5. `npm run format:check` (Prettier)
6. `npm test` (Node.js test runner)

### Deployment (`.github/workflows/deploy.yml`)
Runs on push to `main`/`master` when `index.html`, `js/**`, or `css/**` change:
1. Copies `index.html`, `js/`, `css/` into `_site/`
2. Uploads as GitHub Pages artifact
3. Deploys to GitHub Pages

Only static assets are deployed -- no `node_modules`, no dev tooling, no test files.

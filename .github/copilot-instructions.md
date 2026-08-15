# Copilot Instructions — Turni Infermieri

## Project Overview

**Turni Infermieri** is a browser-only Italian-language web application for scheduling nurse shifts in an emergency room (Pronto Soccorso). It has no server, no build step, and no package manager — open `index.html` directly in a browser.

## Repository Structure

```
index.html        — Single-page UI: 5-step wizard (Organico → Regole → Continuità → Genera → Risultati)
js/app.js         — Main application logic: state management, UI rendering, event wiring
js/solver.js      — Web Worker entry point; js/solver/*.js — modular solver (Pattern Beam + greedy/simulated-annealing)
css/custom.css    — Custom CSS with CSS variables for light/dark themes
README.md         — Architecture analysis of the solver approach
```

## Tech Stack

- **Pure HTML / CSS / JavaScript** — no frameworks, no bundler, no npm
- **Tailwind CSS** via CDN (`cdn.tailwindcss.com`) with offline fallbacks in `css/custom.css`
- **In-worker heuristics**: cyclic Pattern Beam planner + greedy construction + simulated annealing (the MILP back-ends were removed)
- State is persisted in `localStorage`

## Key Domain Concepts

This is a **Nurse Scheduling Problem (NSP)** application. Key shift codes:

| Code | Name                | Hours |
|------|---------------------|-------|
| M    | Mattina (Morning)   | 6.2   |
| P    | Pomeriggio (Afternoon) | 6.2 |
| D    | Diurno (Day-long)   | 12.2  |
| N    | Notte (Night)       | 12.2  |
| S    | Smonto (Post-night) | 0     |
| R    | Riposo (Rest)       | 0     |
| F    | Ferie (Holiday)     | 6.12  |
| MA   | Malattia (Sick)     | 6.12  |
| L104 | Legge 104           | 6.12  |
| PR   | Permesso Retribuito | 6.12  |
| MT   | Maternità           | 6.12  |

Nurse tags: `solo_mattine`, `solo_diurni`, `solo_notti`, `no_notti`, `no_diurni`, and absence tags (`ferie`, `malattia`, `104`, `permesso_retribuito`, `maternita`).

## Solver Architecture (`js/solver.js`)

The solver runs in a **Web Worker** and uses a dual strategy:

1. **Pattern Beam planner** (`js/solver/pattern-planner.js`) — Builds whole-month rows from rigid per-profile cycles (M/P 5 work + 2 rest, D-N-S-R-R for diurni/notturni, N-S-R…) with coverage-aware beam search; a night-first variant pins a balanced night skeleton first.
2. **Greedy + Simulated Annealing** — Construction heuristic followed by local search (6 move types) plus 9 targeted repair passes; the `auto` choice runs a portfolio and keeps the best result. Each solution runs under a seeded RNG for reproducible diversity.

Hard constraints include:
- Minimum/maximum daily coverage per shift type
- Forbidden transitions (e.g., P→M; N must be followed by S→R, plus a second R for diurni_e_notturni)
- On-call rules: reperibile notturno (smonto/morning nurse) and reperibile diurno on Sundays/Italian holidays (night nurse)
- 11-hour minimum gap between shifts
- Weekly rest minimums
- Night-shift caps per nurse

Soft objectives: hours equity, night-shift fairness, weekend fairness.

## Application Flow (`js/app.js`)

The UI is a 5-step wizard:

1. **Step 1 — Organico**: Configure month/year (2025–2099), nurse roster (names, tags, absence periods). Reordering via drag-and-drop or ▲▼ buttons (the order is the results-grid row order).
2. **Step 2 — Regole**: Coverage ranges, fascia oraria, hour targets, night limits, constraint toggles, on-call rules, nurse pairing, previous-month import.
3. **Step 3 — Continuità**: Manual previous-month tail (last 3 days) per nurse.
4. **Step 4 — Genera**: Summary, feasibility pre-check, solver options + generate button. Launches the Web Worker solver.
5. **Step 5 — Risultati**: Interactive schedule grid with inline shift editing, coverage and on-call rows, violation display, solution picker, CSV export, print.

## Coding Conventions

- All code uses `'use strict'` mode
- Constants are `UPPER_SNAKE_CASE`; functions and variables are `camelCase`
- The UI is in Italian (labels, messages, violation texts)
- HTML is generated via template literals and `innerHTML` — escape user text with `escHtml()`
- Tests use the Node.js built-in runner (`npm test` — explicit file list in package.json)
- The solver communicates with the main thread via `postMessage` / `onmessage` (standard Web Worker API)

## How to Run / Test

1. Open `index.html` in any modern browser — no build step required
2. To test the solver in isolation, the Web Worker can be loaded directly
3. Run automated tests: `npm test` (Node.js test runner, tests solver pure functions)
4. Lint: `npm run lint` / Format: `npm run format:check`
5. Run all checks: `npm run validate`

## Important Patterns

- **State management**: A single global `state` object in `app.js` is the source of truth. Saved to/loaded from `localStorage`.
- **Solver ↔ UI communication**: The solver runs in a Web Worker (`new Worker('js/solver.js')`). Messages: `{type: 'solve', config, numSolutions}` → worker → `{type: 'progress'|'result'|'error', ...}`.
- **Dark mode**: Toggled via a CSS class `dark` on `<html>`, using CSS custom properties defined in `:root` / `html.dark`.
- **Pinned cells**: Absences and `solo_mattine` nurses have pre-assigned (pinned) shifts that the solver does not modify.
- **Coverage counting**: D (Diurno) shifts count toward both M and P coverage.

## When Making Changes

- Keep the application self-contained (no server, no npm, no build tools)
- UI text should be in Italian
- Preserve dark mode compatibility when modifying CSS
- When modifying `solver.js`, remember it runs in a Web Worker context (no DOM access)
- Test coverage changes by running the solver and checking violation counts
- The schedule grid supports inline editing — maintain click handlers on `.shift-cell` elements

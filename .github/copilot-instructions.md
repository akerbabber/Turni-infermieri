# Copilot Instructions — Turni Infermieri

## Project Overview

**Turni Infermieri** is a browser-only Italian-language web application for scheduling nurse shifts in an emergency room (Pronto Soccorso). It has no server, no build step, and no package manager — open `index.html` directly in a browser.

## Repository Structure

```
index.html        — Single-page UI: 4-step wizard (Organico → Regole → Genera → Risultati)
js/app.js         — Main application logic: state management, UI rendering, event wiring
js/solver.js      — Web Worker: scheduling solver (HiGHS MILP + greedy/simulated-annealing fallback)
css/custom.css    — Custom CSS with CSS variables for light/dark themes
README.md         — Architecture analysis of the solver approach
```

## Tech Stack

- **Pure HTML / CSS / JavaScript** — no frameworks, no bundler, no npm
- **Tailwind CSS** via CDN (`cdn.tailwindcss.com`) with offline fallbacks in `css/custom.css`
- **HiGHS** MILP solver loaded from CDN as WASM inside the Web Worker (`js/solver.js`)
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

1. **HiGHS MILP** (primary) — Builds a CPLEX LP formulation with binary decision variables `x[nurse][day][shift]`, hard constraints (coverage, transitions, night blocks), and a fairness objective. Uses multiple seeds with objective perturbation for diverse solutions.
2. **Greedy + Simulated Annealing** (fallback) — Multi-restart construction heuristic followed by local search (swap, change, equity, weekly-rest moves) with simulated annealing acceptance.

Hard constraints include:
- Minimum/maximum daily coverage per shift type
- Forbidden transitions (e.g., P→M, N must be followed by S→R→R)
- 11-hour minimum gap between shifts
- Weekly rest minimums
- Night-shift caps per nurse

Soft objectives: hours equity, night-shift fairness, weekend fairness.

## Application Flow (`js/app.js`)

The UI is a 4-step wizard:

1. **Step 1 — Organico**: Configure month/year, nurse roster (names, tags, absence periods). Supports drag-and-drop reordering.
2. **Step 2 — Regole**: Configure coverage ranges, hour targets, night limits, constraint toggles, nurse pairing.
3. **Step 3 — Genera**: Summary + generate button. Launches the Web Worker solver.
4. **Step 4 — Risultati**: Interactive schedule grid with inline shift editing, violation display, solution picker, CSV export, JSON config save/load, print.

## Coding Conventions

- All code uses `'use strict'` mode
- Constants are `UPPER_SNAKE_CASE`; functions and variables are `camelCase`
- The UI is in Italian (labels, messages, violation texts)
- HTML is generated via template literals and `innerHTML` — escape user text with `escHtml()`
- No test framework is present — validate changes by opening `index.html` in a browser
- The solver communicates with the main thread via `postMessage` / `onmessage` (standard Web Worker API)

## How to Run / Test

1. Open `index.html` in any modern browser — no build step required
2. To test the solver in isolation, the Web Worker can be loaded directly
3. There is no automated test suite; manual browser testing is the norm

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

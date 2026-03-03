# Turni-infermieri

## Architecture Analysis: Solver Approach

### Current approach — Hand-rolled greedy/heuristic solver

The scheduling engine (`js/solver.js`, ~960 lines) uses a **multi-phase greedy
algorithm** running inside a Web Worker:

| Phase | What it does |
|-------|-------------|
| 1 | Pins absences (ferie, malattia, 104, maternità, permesso) and "solo mattine" nurses |
| 2 | Distributes night-shift blocks (N → S → R → R) to meet min coverage, then tries to reach target per nurse |
| 3 | Greedy day-shift assignment (M, P, D) sorted by fewest hours → most hours for equity |
| 4 | Fills remaining cells with R (rest) |
| 4.5–4.8 | Patch-up passes: weekly rest enforcement, M/P balance for no_diurni nurses, nurse pairing, D-D rest enforcement |
| 5 | Equity swap pass (up to 3 iterations) converting R↔M/P when a nurse is ±8 h from average |
| 6 | Validation — collects all remaining violations and computes stats |

#### Where this struggles

* **No backtracking.** Once a shift is placed it is never reconsidered (except
  the limited equity swap in Phase 5). A poor early decision can cascade into
  coverage violations that later phases cannot fix.
* **Random seeding with no restart.** The single `shuffle()` call decides nurse
  ordering; running the solver twice may give very different quality, with no
  mechanism to pick the best.
* **Hard to extend.** Every new constraint (e.g. "max 2 weekends in a row",
  "nurse X never with nurse Y") requires weaving more `if` blocks into the
  existing phases. The 960-line file is already hard to follow.
* **No optimality guarantee.** There is no scoring function that the algorithm
  tries to minimise/maximise globally; each phase locally satisfies its own
  concerns and hopes the result is good enough.

---

### Alternative: Constraint-satisfaction / operations-research libraries

Nurse rostering is a well-known **Nurse Scheduling Problem (NSP)** — a type of
constraint-satisfaction / combinatorial-optimisation problem that has been
studied for decades. Proven library approaches include:

| Library | Language | How it helps |
|---------|----------|-------------|
| **[Google OR-Tools (CP-SAT)](https://developers.google.com/optimization)** | C++ / Python / JS (WASM) | Mixed-integer / CP solver. Define variables, constraints, and an objective; the solver handles backtracking, pruning, and optimisation automatically. |
| **[OptaPlanner / Timefold](https://timefold.ai/)** | Java / Kotlin (REST API) | Domain-specific solver for employee rostering with a nurse-scheduling quick-start. |
| **[python-constraint](https://pypi.org/project/python-constraint/)** | Python | Lightweight CSP solver good for prototyping. |
| **[MiniZinc](https://www.minizinc.org/)** | MiniZinc → any solver | Modelling language that can target CP, MIP, or SAT solvers. |

For a **browser-only** project like this one, the most practical option is
**OR-Tools compiled to WebAssembly** (official JS/WASM build available via npm
`ortools`). The entire solver could be replaced with:

1. **Decision variables** — `schedule[nurse][day]` ∈ {M, P, D, N, S, R, …}
2. **Hard constraints** (must be satisfied)
   * Forbidden transitions (P→M, D→D, N must be followed by S→R→R, etc.)
   * Minimum/maximum daily coverage per shift type
   * Absence periods pinned
   * 11-hour minimum gap
3. **Soft constraints / objectives** (optimise toward)
   * Hours equity across nurses (minimise max deviation from average)
   * Night-shift fairness
   * Weekend fairness
   * Target number of nights per nurse

The CP-SAT solver would explore the full search space with intelligent
backtracking and branch-and-bound, dramatically improving the chance of finding
a **feasible** schedule (zero violations) and allowing true **optimisation** of
fairness.

---

### Verdict

> **Yes, the current solver is re-inventing the wheel.** The problem being
> solved is a textbook constraint-satisfaction / integer-programming problem.
> Using a library like OR-Tools CP-SAT would:
>
> 1. **Find feasible schedules far more reliably** — the solver backtracks
>    automatically instead of hoping a single greedy pass works.
> 2. **Produce provably optimal (or near-optimal) solutions** — you define
>    what "good" means (equity, coverage) and the solver maximises it.
> 3. **Make new constraints trivial to add** — each rule is an independent
>    constraint declaration, not spaghetti `if`-chains spread across phases.
> 4. **Reduce code dramatically** — the ~960-line `solver.js` could shrink to
>    ~200–300 lines of declarative constraint definitions.
>
> The main trade-off is a **~4 MB WASM bundle** for OR-Tools and a learning
> curve for the CP-SAT API, but the payoff in correctness, maintainability, and
> schedule quality is substantial.
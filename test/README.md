# Tests

```bash
npm install
npm test            # everything (~3 min)
npm run test:unit   # calculation engines only, no browser (~0.2 s)
npm run test:app    # end-to-end in headless Chromium
```

CI runs `npm test` on every push to `main` and every pull request
(`.github/workflows/test.yml`), pinned to `TZ=Asia/Bangkok` because the app's day
boundary is 04:00 local and several date helpers are timezone-sensitive.

## Why this exists

`index.html` is one ~12,000-line file with no build step and no module boundaries. A
renamed or deleted variable produces a **runtime** `ReferenceError` that a syntax check
cannot see. Two such regressions reached production:

- **`todayD is not defined`** — a variable was removed while refactoring date handling,
  but a line ~130 further down still referenced it. `renderTargetDashboard` threw before
  painting, so the Fitness Target tab fell back to its "ยังไม่มี Fitness Target" empty
  state and looked like it had lost the user's data.
- **stale analysis cache** — `saveFitnessTarget` never invalidated the per-day cache of
  the weight-analysis card, so changing the target weight and refreshing kept showing the
  card built against the old target.

Both are covered by `app.test.js`, and both were verified to fail the suite when
reintroduced.

## Layout

| Path | What it does |
|---|---|
| `unit.test.js` | Calculation engines — MET, step NEAT, protein, sleep scoring, macro reconciliation, feasibility, date windows |
| `app.test.js` | Drives the real `index.html` in headless Chromium: navigation, saving, reloading |
| `helpers/extract.js` | Pulls function bodies out of `index.html` for unit testing |
| `helpers/browser.js` | Chromium resolution + page harness |
| `fixtures/seed.js` | Three weeks of realistic logs, relative to today |

## Conventions worth keeping

**Unit tests read the real source.** `helpers/extract.js` brace-matches the function out
of `index.html` and evaluates it in a `vm` sandbox. Nothing is copy-pasted, so the tests
cannot drift away from the implementation — and if a function is renamed, extraction
throws instead of silently passing against a stale copy.

**Assertions are tied to reference formulas, not snapshots.** `calcBurnKcal` is checked
against `MET × 3.5 × kg / 200`, step NEAT against the same equation minus the resting
1 MET, protein against g/kg lean mass. A failure should mean the physiology changed, not
that a recorded number went stale.

**The fixture is seeded once per context, not per navigation.** A test that changes a
setting and reloads must see its own change survive; an unguarded `addInitScript` would
overwrite it on the way back in. This bit the first version of these tests.

**Network errors are ignored, everything else fails.** Firebase and the CDN are
unreachable in CI and the app falls back to `localStorage` by design, so those console
errors are filtered (`IGNORABLE` in `helpers/browser.js`). Any other console error or
uncaught exception fails the run, as does the app's own visible `JS error` toast.

**Navigation goes through the app's functions, not DOM clicks.** Clicking re-renders the
container and invalidates element handles taken beforehand, which made the tab walk
silently skip tabs and under-report coverage.

## Adding a test for a bug

Reproduce it first, watch it fail, then fix it. If a regression test does not fail
against the broken code, it is not testing what you think it is.

# Working on Kindee

Context for anyone — human or agent — changing this codebase. The rules below are not
style preferences; each one is here because ignoring it has already shipped a bug.

## What this is

`index.html` is the entire app: ~12,000 lines, one file, no build step, no modules, no
framework. Everything shares one global scope at runtime across a few `<script>` blocks.
`worker/worker.js` is a Cloudflare Worker that proxies Gemini and holds the API keys.

State lives in `localStorage` under `gd_*` keys, mirrored to Firebase when signed in.

## Before you push

```bash
npm test        # lint + 20 tests, ~3 min
npm run lint    # ~1 s — run this constantly while editing
```

Do not push without a green run. Both production bugs listed below would have been caught
by these, and both were instead found by the user in the running app.

## The failure modes that have actually happened

**1. Changing a class of thing and only fixing what was on screen.**

This caused both production bugs.

- `todayD` was deleted while refactoring date handling. A reference ~130 lines below
  survived, `renderTargetDashboard` threw before painting, and the Fitness Target tab fell
  back to its empty state — it looked like the app had lost the user's data.
- Cache invalidation was added to `saveGoals` and `handleSaveWeight` but not to
  `saveFitnessTarget` or `resetTargetStartDate`, so editing the target and refreshing kept
  showing the old analysis.

**Rule: when a change is of the form "everywhere that does X", enumerate every site with
grep first, list them, then fix the list.** Do not work outward from the code you happen to
have open. `npm run lint` now catches the deleted-variable half of this in a second; the
enumeration habit is what catches the rest.

**2. Asserting state instead of checking it.**

Claimed twice that a PR still contained unpushed work when it had already been merged.
Checking costs one API call. Check.

**3. Shipping configuration that was never executed.**

The first CI config set `cache: npm` while `.gitignore` excluded `package-lock.json`. It
failed in six seconds. Run it before committing it.

## Invariants worth knowing

**Dates.** `localDateStr()` uses an **04:00 local** day boundary, not midnight. Anything
comparing dates must go through it. `new Date('YYYY-MM-DD')` parses as **UTC midnight**
while `new Date()` is local — mixing them made the program week roll over at 07:00 in
Bangkok. Anchor at local noon (`new Date(str + 'T12:00:00')`) or use `elapsedDaysSince()`.

**One goal, many readers.** `getEffectiveGoalToday()` is the single source of truth for
*today's* target (recovery adjustment > rest-day carb cut > saved goal). The dashboard
ring, the over-goal alert, the AI daily coach and the chat context must all read it.
`getOfficialCalorieContext()` is the engine's view, for Settings and AI prompts.

**Gross vs net calories.** The calorie goal is `TDEE − deficit` where TDEE already contains
workouts and NEAT. **Never compare `netCal` (intake − burn − NEAT) against the goal** —
that double-counts activity and invents a deficit. Compare gross intake against the goal;
Net Cal is informational only.

**Macros must reconcile.** Every stored meal satisfies `P×4 + C×4 + F×9 ≈ kcal` within 10%,
enforced by `reconcileMealMacros()`. Any new logging path must call it.

**Cached analysis.** `gd_wt_analysis`, `gd_wt_analysis_data`, `gd_daily_summary` and
`gd_wt_ai_result` are keyed by date and must be cleared whenever the goal, the weight log,
or the Fitness Target changes. Grep for `gd_wt_analysis` before adding a new writer of any
of those inputs.

**AI output is never trusted for numbers the app can compute.** The sleep score is
recomputed and overwrites whatever the model returned. Prompts must not ask the model to
re-derive a figure the app already produces deterministically, or two contradicting numbers
end up on one screen.

**Physiology has references, not vibes.** Protein scales with lean mass (2.3–3.1 g/kg FFM
in a deficit), MET burn is `MET × 3.5 × kg / 200 × min`, step NEAT is net of the resting
1 MET. If you change one of these, change the test that cites the formula too.

## Testing

See `test/README.md`. Two things to preserve:

- Unit tests extract the real function bodies out of `index.html` rather than copying
  formulas, so they cannot drift from the implementation.
- A regression test must be shown to **fail** against the broken code before it counts.

## Docs

`AUDIT-2026-07-25.md` is a full calculation-consistency audit of the app — every finding
traced to source with a worked numeric example, plus what was checked and found correct.
Read the relevant section before changing a calculation engine.

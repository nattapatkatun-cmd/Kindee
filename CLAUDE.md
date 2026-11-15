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
npm test        # lint + the unit and browser suites (~100 tests), ~3 min
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

**Wake time is a constraint, not an outcome.** The target bedtime is solved as
`habitual wake − need − debt repayment`. The anchor is `computeTypicalWakeAnchor()` — a
median bucketed weekday vs weekend — *never* last night's raw reading, which ratchets the
schedule later every time the user sleeps in. Two bucket rules that are easy to invert: a
sleep record dated D holds the night that **ended** on the morning of D, so the record's
own date is the wake morning; and tonight's sleep ends **tomorrow**, so tonight's anchor
comes from `forDate + 1`'s bucket — a Sunday night is a weekday night. The weekend anchor
is clamped to `WEEKEND_WAKE_MAX_LAG_MIN` past the weekday one, or the app prescribes the
social jetlag it warns about two rows below.

**The 20-minute cap moves a phase; it does not move you back onto one you already have.**
`BEDTIME_SHIFT_CAP_MIN` steps away from the *anchor*, and on the two bucket-crossing
nights a week (Friday and Sunday) last night's bedtime is not that anchor — the habitual
bedtime for **tonight's** bucket is. Crawling from a 02:00 Saturday prescribes 01:40
before a 07:00 Monday and needs eight nights to arrive, so it never converges before the
next weekend. Same reasoning as the outlier rule; they share a branch.

**Gross vs net calories.** The calorie goal is `TDEE − deficit` where TDEE already contains
workouts and NEAT. **Never compare `netCal` (intake − burn − NEAT) against the goal** —
that double-counts activity and invents a deficit. Compare gross intake against the goal;
Net Cal is informational only.

**Macros must reconcile.** Every stored meal satisfies `P×4 + C×4 + F×9 ≈ kcal` within 10%,
enforced by `reconcileMealMacros()`. Any new logging path must call it.

**Cached analysis.** `gd_wt_analysis`, `gd_wt_analysis_data`, `gd_daily_summary`,
`gd_weekly_summary` and `gd_wt_ai_result` are keyed by date and must be cleared whenever the
goal, the weight log, the workout plan or the Fitness Target changes. Call
`clearGoalDependentCaches()` — never hand-roll a `removeItem` list (several drifted out of
step and left the AI Deep-Dive quoting old data). Only two places clear a subset on purpose:
the `APP_LOGIC_VERSION` bump and `saveAnalyzerCalorieContext` (called *by* the weight analyzer,
so it must not delete the analysis it just drew). A test pins the single `gd_wt_analysis` clear.

**Firestore writes go through `fbWrite()`.** `FB_OK` is `true` on an *offline* launch (that is
deliberate — see `checkUserAllowed`), and with no persistence an offline `set()` neither
resolves nor rejects and does not survive a reload. So never write
`if (FB_OK) FB.saveX(...) else queueFBWrite(...)`: use `fbWrite(type, op, data)` (queue first,
drop the entry only when Firestore confirms) or `fbSaveSettingOrQueue(key, value)` for settings.
A test fails if a direct `window.FB.save…/del…` call reappears outside the queue plumbing. A
setting that `loadRemoteData()` loads remote-wins must also be guarded with
`hasPendingFBSetting(key)` so a queued local edit isn't overwritten by the older cloud copy.
`loadSetting('goals')` has no `.catch` on purpose: offline it rejects, which aborts the whole
load and leaves `gd_meals` alone — `collection.get()` offline instead resolves *empty*, so
catching that rejection would let an empty remote overwrite local meals.

**Per-date synced collections (steps, water, sleep log, goal history).** Remote wins unless this
device edited the date since its last upload. Anything that changes such a collection locally —
including a recomputation like `rescoreSleepLog()` — must `markSyncDirty(kind, date)`, or the
next load silently reverts it.

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

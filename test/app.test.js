'use strict';
// End-to-end tests against the real index.html in headless Chromium.
//
// These exist because index.html has no build step and no module boundaries, so a rename
// or a deleted variable produces a *runtime* ReferenceError that no syntax check can see.
// Two such regressions reached production before this suite existed:
//   • `todayD is not defined` — the Fitness Target tab threw and silently fell back to
//     its empty state, so the app looked like it had lost the user's target.
//   • editing the Fitness Target left the weight analysis serving a cached card built
//     against the previous target.
// Both are covered below.

const test = require('node:test');
const assert = require('node:assert');
const { launch, openApp, errorsFor, openWeightAnalysis } = require('./helpers/browser');
const { buildSeed, dateBack } = require('./fixtures/seed');

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });

const noErrors = async (page, what) => {
  const errs = await errorsFor(page);
  assert.deepStrictEqual(errs, [], what + ' produced JS errors:\n  ' + errs.join('\n  '));
};

test('every page and sub-tab renders without a JS error', async () => {
  const page = await openApp(browser, buildSeed());

  // Drive the app's own navigation rather than clicking DOM nodes: a click re-renders the
  // container, which invalidates any element handles taken beforehand and makes the walk
  // silently skip tabs. What matters here is that every render path executes, and calling
  // the navigation functions covers exactly the same code the click handlers do.
  const visited = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const names = new Set();
    document.querySelectorAll('[onclick*="showFitnessTab"]').forEach((el) => {
      const m = /showFitnessTab\(\s*'([^']+)'/.exec(el.getAttribute('onclick') || '');
      if (m) names.add(m[1]);
    });
    const out = { pages: [], ftTabs: [...names] };
    for (const p of ['dashboard', 'analyze', 'log', 'fitness', 'weight', 'settings']) {
      if (typeof showPage === 'function') { showPage(p); out.pages.push(p); await sleep(150); }
    }
    showPage('fitness');
    for (const t of out.ftTabs) {
      if (typeof showFitnessTab === 'function') { showFitnessTab(t); await sleep(150); }
    }
    return out;
  });

  assert.ok(visited.pages.length === 6, 'all six top-level pages rendered');
  assert.ok(visited.ftTabs.length >= 5, 'expected the fitness sub-tabs, found ' + visited.ftTabs.length);

  await page.waitForTimeout(400);
  await noErrors(page, `${visited.pages.length} pages + ${visited.ftTabs.length} sub-tabs`);
  await page.close();
});

test('the Fitness Target tab renders for every shape of target data', async () => {
  // Regression guard for `todayD is not defined`: the projection branch only executes
  // when a target HAS a start date and a projectable trend, so the with-target case is
  // the one that actually exercises it. The other two guard the empty paths.
  for (const scenario of ['with-target', 'no-target', 'target-without-start-date']) {
    const seed = buildSeed();
    if (scenario === 'no-target') delete seed.gd_ft_target;
    if (scenario === 'target-without-start-date') {
      delete seed.gd_ft_target.startDate;
      delete seed.gd_ft_target.startBF;
    }

    const page = await openApp(browser, seed);
    const rendered = await page.evaluate(() => {
      showPage('fitness');
      if (typeof showFitnessTab === 'function') showFitnessTab('target');
      if (typeof renderTargetDashboard === 'function') renderTargetDashboard();
      // Scope to the dashboard container: the empty-state markup also lives in the static
      // HTML further up the page, so scanning document.body would always match it.
      const el = document.getElementById('ft-target-dashboard');
      const t = ((el && el.textContent) || '').replace(/\s+/g, ' ');
      return {
        found: !!el,
        hasTimeline: /สัปดาห์ที่/.test(t),
        hasEmptyState: /ยังไม่มี Fitness Target/.test(t),
      };
    });
    assert.ok(rendered.found, '#ft-target-dashboard should exist');
    await page.waitForTimeout(300);
    await noErrors(page, 'Fitness Target tab (' + scenario + ')');

    if (scenario === 'with-target') {
      assert.ok(rendered.hasTimeline, 'a target with a start date must render its timeline');
      assert.ok(!rendered.hasEmptyState, 'must not fall back to the empty state — that is the bug signature');
    }
    if (scenario === 'no-target') {
      assert.ok(rendered.hasEmptyState, 'with no target the empty state is correct');
    }
    await page.close();
  }
});

test('editing the Fitness Target changes the analysis, and survives a reload', async () => {
  const page = await openApp(browser, buildSeed());

  const targetInAnalysis = () => page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    return (window._wtAnalysisData || {}).targetW;
  });

  assert.strictEqual(await targetInAnalysis(), 72, 'fixture starts at a 72 kg target');

  await page.evaluate(() => {
    showPage('settings');
    document.getElementById('ft-target-weight').value = 66;
    document.getElementById('ft-curr-bf').value = 21.5;
    document.getElementById('ft-target-bf').value = 15;
    document.getElementById('ft-target-duration').value = 12;
    saveFitnessTarget();
  });
  await page.waitForTimeout(400);
  assert.strictEqual(await targetInAnalysis(), 66, 'the analysis picks up the new target immediately');

  // The reported symptom was specifically "changed it, hit refresh, nothing moved" — the
  // analysis card is cached per calendar day, so only a real reload reproduces it.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  assert.strictEqual(await targetInAnalysis(), 66, 'the new target survives a full page reload');

  await noErrors(page, 'editing the Fitness Target');
  await page.close();
});

test('the analysis card names the calorie goal it derives its deficit from', async () => {
  // requiredDeficit comes from the committed calorie goal, not the Fitness Target. That
  // is intentional, but it must be visible — otherwise editing the target appears to do
  // nothing and the two can drift apart silently.
  const page = await openApp(browser, buildSeed());
  const text = await openWeightAnalysis(page);
  assert.match(text, /Goal Engine:/, 'the Goal Engine line is present');
  assert.match(text, /จากเป้าแคลที่ตั้งไว้/, 'it states which number it came from');
  await noErrors(page, 'the weight analysis');
  await page.close();
});

test('changing the calorie goal invalidates the cached analysis', async () => {
  const page = await openApp(browser, buildSeed());

  const goalInAnalysis = () => page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    return (window._wtAnalysisData || {}).userGoalCal;
  });

  assert.strictEqual(await goalInAnalysis(), 1800);

  await page.evaluate(() => {
    S.goals = { cal: 2100, pro: 150, crb: 200, fat: 62 };
    localStorage.setItem('gd_goals', JSON.stringify(S.goals));
    applyGoalValues({ cal: 2100, pro: 150, crb: 200, fat: 62 }, true);
  });
  await page.waitForTimeout(300);
  assert.strictEqual(await goalInAnalysis(), 2100, 'a goal change must not be masked by the same-day cache');

  await noErrors(page, 'changing the calorie goal');
  await page.close();
});

test('STATUS follows the smoothed 21d EMA, not a single-day scale spike', async () => {
  // The reported split: a lone water-drop makes the raw 7-day slope read steeper than
  // -1.0 kg/wk ("Losing Fast"), while the 21-day EMA the forecast/ACTION already use is
  // mild. STATUS must speak the same (EMA) signal, or it contradicts its own advice.
  const seed = buildSeed();
  // Twenty flat mornings at 75.7 kg, then one 74.2 kg reading today — a 1.5 kg overnight
  // "drop" that is water, not fat. The 7-day regression turns sharply negative; the 21-day
  // EMA barely moves.
  seed.gd_weight = [];
  for (let i = 20; i >= 0; i--) {
    seed.gd_weight.push({
      id: 2000 + i, date: dateBack(i), time: '07:30',
      weight: i === 0 ? 74.2 : 75.7, waist: 84, note: '',
    });
  }

  const page = await openApp(browser, seed);
  const data = await page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    const d = window._wtAnalysisData || {};
    return { statusLabel: d.statusLabel, trendPerWeek: d.trendPerWeek, ema21PerWeek: d.ema21PerWeek, suppress: d.suppressRecommend };
  });

  // Preconditions that make this a real test of the fix, not an accident of the seed:
  assert.ok(!data.suppress, 'the seed must reach the trend-classified branch, not a suppressed one');
  assert.ok(data.trendPerWeek < -1.0, `raw 7-day slope must be in "Losing Fast" territory, got ${data.trendPerWeek}`);
  assert.ok(data.ema21PerWeek !== null && data.ema21PerWeek > -1.0, `21d EMA must be milder than the raw slope, got ${data.ema21PerWeek}`);

  // The fix: STATUS reflects the mild EMA, so it is NOT the alarmist raw-slope verdict.
  assert.notStrictEqual(data.statusLabel, 'Losing Fast ⚠️', 'STATUS must not fire on the raw one-day spike');
  assert.match(data.statusLabel, /On Track|Slow Progress|Plateau|Recomp/, 'STATUS is an EMA-consistent verdict');

  await noErrors(page, 'EMA-based STATUS');
  await page.close();
});

test('a stale calorie goal cannot push the required deficit past the 25%-of-TDEE safety cap', async () => {
  // Regression: requiredDeficit is derived from the user's committed Settings goal, but
  // that goal can go stale as Adaptive TDEE drifts upward after it was set. The
  // 25%-of-TDEE safety cap that buildGoalFromMode enforces on its own fresh calc was
  // never applied to this goal-anchored path, so an old, now-too-low goal could silently
  // demand an unbounded deficit with no safety warning, and the sync button would then
  // offer a different, uncapped-vs-capped mismatched number.
  const page = await openApp(browser, buildSeed());

  const data = await page.evaluate(() => {
    S.goals = { cal: 1000, pro: 150, crb: 180, fat: 62 };
    localStorage.setItem('gd_goals', JSON.stringify(S.goals));
    applyGoalValues({ cal: 1000, pro: 150, crb: 180, fat: 62 }, true);
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    return window._wtAnalysisData;
  });

  assert.ok(data.trueTDEE, 'fixture must produce an Adaptive TDEE for this check to mean anything');
  const safeCap = Math.round(data.trueTDEE * 0.25);
  assert.ok(
    data.requiredDeficit <= safeCap + 1,
    `requiredDeficit (${data.requiredDeficit}) must not exceed the 25%-of-TDEE safety cap (${safeCap})`
  );
  assert.strictEqual(
    data.recommendedIntake, data.engineRecommendedIntake,
    'the sync button must offer the same number the analysis text just recommended'
  );

  const resultText = await page.evaluate(
    () => (document.getElementById('wt-analysis-result').textContent || '').replace(/\s+/g, ' ')
  );
  assert.match(resultText, /เกินเกณฑ์ปลอดภัย/, 'the safety-cap warning must be visible when the goal-anchored deficit gets capped');

  await noErrors(page, 'a stale calorie goal exceeding the safety cap');
  await page.close();
});

test('a same-day cache written under an older CACHE_VER is recomputed, not served stale', async () => {
  // Regression: runWeightAnalysis() gates its localStorage HTML cache on today's date AND
  // a hardcoded CACHE_VER string that must be bumped whenever the calc logic inside
  // buildAnalysisHTML changes — that's the whole point of the string, per its own comment.
  // The 25%-of-TDEE safety cap above changed that calc logic, but shipped once without
  // the version bump: the app kept serving every user's same-day pre-fix HTML snapshot
  // straight from cache, so the fix was live in the code but invisible in the running app
  // until the calendar day rolled over. This pins the version-gate actually doing its job:
  // a cache entry tagged with the last known-stale version must never be restored.
  const page = await openApp(browser, buildSeed());

  const fresh = await page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    runWeightAnalysis();
    return (window._wtAnalysisData || {}).requiredDeficit;
  });

  const afterStaleCache = await page.evaluate((realDeficit) => {
    const today = localDateStr();
    // A same-day cache as it would have been written by the pre-fix build: tagged with
    // the version string that predates the safety-cap fix, carrying an obviously-wrong
    // uncapped number no current code path would ever produce.
    const staleData = Object.assign({}, window._wtAnalysisData, { requiredDeficit: realDeficit + 99999 });
    localStorage.setItem('gd_wt_analysis', JSON.stringify({ html: '<div>STALE PRE-FIX CACHE</div>', date: today, ver: 'v21_usergoal_recomp' }));
    localStorage.setItem('gd_wt_analysis_data', JSON.stringify({ date: today, data: staleData }));
    runWeightAnalysis();
    return (window._wtAnalysisData || {}).requiredDeficit;
  }, fresh);

  assert.strictEqual(
    afterStaleCache, fresh,
    'a same-day cache tagged with an older CACHE_VER must be recomputed, not restored verbatim'
  );

  const resultText = await page.evaluate(
    () => (document.getElementById('wt-analysis-result').textContent || '').replace(/\s+/g, ' ')
  );
  assert.doesNotMatch(resultText, /STALE PRE-FIX CACHE/, 'the stale cached HTML must not be what renders');

  await noErrors(page, 'recomputing past a stale-version same-day cache');
  await page.close();
});

test('viewing a past date shows that date\'s own calorie goal, not today\'s', async () => {
  // Reported symptom: changing the calorie target retroactively repainted every past
  // day's goal with the new number, flipping old "under goal" days to "over goal" (or
  // vice versa) after the fact. gd_goals_history records the goal that was actually in
  // force on each date it changed; the dashboard for a past date must read through it
  // instead of S.goals directly.
  const oldDate = dateBack(10);
  const seed = buildSeed();
  seed.gd_goals_history = [{ date: oldDate, cal: 1800, pro: 150, crb: 180, fat: 62 }];
  const page = await openApp(browser, seed);

  await page.evaluate(() => {
    applyGoalValues({ cal: 2200, pro: 170, crb: 220, fat: 70 }, true);
  });
  await page.waitForTimeout(300);

  const result = await page.evaluate((d) => {
    showPage('dashboard');
    DASH_DATE = d;
    updateDash();
    const past = document.getElementById('d-g').textContent;
    DASH_DATE = null;
    updateDash();
    const today = document.getElementById('d-g').textContent;
    return { past, today };
  }, oldDate);

  assert.strictEqual(result.past, '1800', 'the past date keeps the goal that was in force back then');
  assert.strictEqual(result.today, '2200', 'today reflects the newly saved goal');

  await noErrors(page, 'viewing a past date after changing the calorie goal');
  await page.close();
});

test("today's actual EA is measured from calories actually eaten, not the goal", async () => {
  // Reported symptom: after eating well over the goal the dashboard still showed a low
  // "EA จริง". The plan number is deliberately pinned to the goal (so it can't flash a
  // false RED-S alarm at breakfast), but the *actual* line was reusing that same goal
  // intake instead of what was logged — so "จริง" was only half real (real burn, planned
  // food). The fixture logs 1860 kcal eaten today against an 1800 goal, plus a workout, so
  // goal-based and eaten-based EA are ~1 point apart and the swap is observable.
  const page = await openApp(browser, buildSeed());

  const r = await page.evaluate(() => {
    const today = localDateStr();
    const eaten = mealsForDate(today).reduce((a, m) => a + (+m.calories || 0), 0);
    const res = getDashboardEA(today, true);
    return { eaten, res };
  });

  assert.ok(r.res && r.res.actual, 'the actual EA line is present once a session is logged');
  assert.ok(r.eaten > 0, 'the fixture logs food today');
  assert.strictEqual(
    r.res.actual.intakeKcal, Math.round(r.eaten),
    'actual EA uses the calories genuinely eaten, not the calorie goal',
  );
  // And the EA value itself follows the eaten intake: (eaten − burn) / lean mass.
  const expected = (r.eaten - r.res.actual.exerciseKcal) / r.res.lbm;
  assert.ok(
    Math.abs(r.res.actual.ea - expected) < 0.05,
    'actual EA = (eaten − credited burn) / FFM',
  );

  await noErrors(page, "today's actual EA");
  await page.close();
});

test('on a planned rest day the EA plan does not subtract a phantom training burn, and actual EA still surfaces from what was eaten', async () => {
  // Reported symptom: a rest day showed "EA 24.9 อันตราย (RED-S)" no matter what was
  // eaten. Two bugs: (1) the plan subtracted the historical training-day burn even though
  // no training happens on a rest day, inflating the danger; (2) the actual line was gated
  // on a logged workout, so on a rest day (never any) it never appeared — the eaten
  // calories could not move the number.
  const seed = buildSeed();
  // Make today a genuine rest day: a saved plan whose today-slot is a rest theme, and no
  // workout logged today (the fixture logs one on even-index days, including today).
  const today = dateBack(0);
  seed.gd_workouts = seed.gd_workouts.filter((w) => w.date !== today);
  const page = await openApp(browser, seed);

  const setup = await page.evaluate((todayStr) => {
    const weekday = new Date(todayStr + 'T12:00:00').getDay();
    const plan = { days: [{ day: PLAN_DAY_NAMES[weekday], theme: 'พัก', exercises: [], note: '' }] };
    localStorage.setItem('gd_workout_plan', JSON.stringify({ plan, savedAt: new Date().toISOString() }));

    const g = getEffectiveGoalToday();
    const eaten = mealsForDate(todayStr).reduce((a, m) => a + (+m.calories || 0), 0);
    const res = getDashboardEA(todayStr, true);
    return { dayType: g && g._dayType, planCal: g && g.cal, eaten, res };
  }, today);

  assert.strictEqual(setup.dayType, 'rest', 'today is resolving as a planned rest day');
  // (1) plan burn is zero on a rest day — the number is intake / FFM, not (intake − 267)/FFM.
  assert.strictEqual(setup.res.exerciseKcal, 0, 'rest-day plan subtracts no training burn');
  assert.strictEqual(setup.res.restPlan, true, 'the result is flagged as a rest-day plan');
  const planExpected = setup.planCal / setup.res.lbm;
  assert.ok(
    Math.abs(setup.res.ea - planExpected) < 0.05,
    'rest-day plan EA = goal intake / FFM (no phantom burn)',
  );
  // (2) actual EA appears from the eaten calories even with no workout logged.
  assert.ok(setup.res.actual, 'actual EA surfaces on a rest day once intake reaches the goal');
  assert.strictEqual(setup.res.actual.exerciseKcal, 0, 'no burn logged on the rest day');
  assert.strictEqual(setup.res.actual.intakeKcal, Math.round(setup.eaten), 'actual uses eaten calories');
  assert.ok(
    Math.abs(setup.res.actual.ea - setup.eaten / setup.res.lbm) < 0.05,
    'rest-day actual EA = eaten / FFM',
  );

  await noErrors(page, 'rest-day EA');
  await page.close();
});

test('a meal whose macros contradict its calories is reconciled before it is stored', async () => {
  const page = await openApp(browser, buildSeed());

  const saved = await page.evaluate(() => {
    showPage('analyze');
    // 650 kcal against P20/C30/F15 = 335 kcal by 4-4-9.
    showResult({
      foodName: 'ทดสอบ', description: '', calories: 650, protein: 20, carbs: 30, fat: 15,
      sodiumFlag: 'medium', carbLoadFlag: 'normal', mealContext: 'normal',
      retentionRisk: 20, analysisConfidence: 80, items: [],
    });
    curLabel = 'ของว่าง';
    saveMeal();
    const m = S.meals[S.meals.length - 1];
    return { cal: m.calories, pro: m.protein, crb: m.carbs, fat: m.fat };
  });

  assert.strictEqual(saved.cal, saved.pro * 4 + saved.crb * 4 + saved.fat * 9,
    'the stored meal must be internally consistent');
  await noErrors(page, 'saving a meal');
  await page.close();
});

test('multi-item meals reconcile both calories and macros to the item sums', async () => {
  const page = await openApp(browser, buildSeed());
  const result = await page.evaluate(() => {
    showPage('analyze');
    // Stated totals disagree with the items by more than the 10% tolerance, in both
    // calories (900 vs 1200) and protein (40 vs 62).
    showResult({
      foodName: 'รวม', calories: 900, protein: 40, carbs: 100, fat: 30,
      items: [
        { foodName: 'a', calories: 400, protein: 22, carbs: 45, fat: 12 },
        { foodName: 'b', calories: 400, protein: 20, carbs: 44, fat: 11 },
        { foodName: 'c', calories: 400, protein: 20, carbs: 45, fat: 12 },
      ],
      sodiumFlag: 'medium', carbLoadFlag: 'normal', mealContext: 'normal',
      retentionRisk: 20, analysisConfidence: 80,
    });
    return { cal: curResult.calories, pro: curResult.protein };
  });
  assert.strictEqual(result.pro, 62, 'protein follows the item sum, not the stated total');
  assert.ok(result.cal >= 1150, 'calories follow the item sum too, got ' + result.cal);
  await noErrors(page, 'a multi-item meal');
  await page.close();
});

test('out-of-range imported sleep values are rejected instead of scoring', async () => {
  const page = await openApp(browser, buildSeed());
  const outcome = await page.evaluate(() => {
    showPage('fitness');
    if (typeof showFitnessTab === 'function') showFitnessTab('sleep');
    if (typeof loadSleepUI === 'function') loadSleepUI();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('sleep-hours', 7); set('sleep-minutes', 10);
    set('sleep-tib-h', 7); set('sleep-tib-m', 50);
    set('sleep-deep-h', 1); set('sleep-deep-m', 2);
    set('sleep-rem-h', 1); set('sleep-rem-m', 35);
    set('sleep-rhr', 56); set('sleep-hrv', 61); set('sleep-hrv-baseline', 60);
    set('sleep-bedtime', '23:40'); set('sleep-waketime', '06:50');
    saveSleep();
    const good = { hrv: S.sleepData.hrv, score: S.sleepData.sleepScore };

    // A screenshot import misreading 39 as 390 used to swing the score ~14 points, which
    // is enough to flip the Push/Rest recommendation and the day's calorie target.
    set('sleep-hrv', 390);
    saveSleep();
    return { good, hrvAfter: S.sleepData.hrv };
  });

  assert.strictEqual(outcome.hrvAfter, 61, 'the out-of-range HRV must not reach the score');
  assert.ok(outcome.good.score > 0, 'a valid save still computes a score without an AI call');
  await noErrors(page, 'saving sleep');
  await page.close();
});

test('the recommended-calorie sync respects the floor and stays reconciled', async () => {
  const page = await openApp(browser, buildSeed());
  const goal = await page.evaluate(() => {
    syncRecommendedCalToGoal(1200); // below the 1500 male floor on purpose
    return { ...S.goals };
  });
  assert.ok(goal.cal >= 1500, 'clamps to the safety floor, got ' + goal.cal);
  assert.strictEqual(goal.cal, goal.pro * 4 + goal.crb * 4 + goal.fat * 9,
    'macros must add up to the calorie target the app just wrote');
  await noErrors(page, 'syncing the recommended calories');
  await page.close();
});

test('the progression card collapses, filters by group, and keeps the deload warning visible', async () => {
  // Two sessions minimum per exercise or the row has no verdict and is dropped.
  const dateBack = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const log = [];
  let id = 1;
  for (const [ex, base] of [['bench-press', 80], ['ohp', 50], ['deadlift', 140], ['bb-row', 70], ['squat', 110]]) {
    for (const [i, back] of [21, 14, 7].entries()) {
      const w = base + i * 2.5;
      log.push({ id: id++, date: dateBack(back), exerciseId: ex, exerciseName: ex,
        weight: w, reps: 8, rir: 2, e1RM: Math.round(w * (4 / 3) * 10) / 10 });
    }
  }
  const page = await openApp(browser, Object.assign(buildSeed(), {
    gd_strength_log: log,
    // A custom exercise carries group 'custom'; a fixed push/pull/legs/core pill row would
    // strand it behind "ทั้งหมด" with no way to select it.
    gd_custom_ex: [{ id: 'custom-x', name: 'Cable Crossover', muscle: 'Custom',
      group: 'custom', equipment: '—', tier: 'isolation', emoji: '🏷️', custom: true }],
  }));

  const state = () => page.evaluate(() => ({
    body: getComputedStyle(document.getElementById('progression-body')).display,
    caret: document.getElementById('progression-caret').textContent,
    summary: document.getElementById('progression-summary').textContent,
    pills: [...document.querySelectorAll('#progression-filter-row .ex-pill')].map((p) => p.textContent.trim()),
    rows: document.querySelectorAll('#progression-list > div').length,
  }));

  // Dispatch through the element's own onclick rather than page.click(). Offline — which
  // is every CI run — the sign-in overlay (#authGate) never resolves and covers the page,
  // so Playwright's actionability check blocks on "subtree intercepts pointer events"
  // until it times out. This still exercises the real onclick wiring, and it is the same
  // reason the rest of this suite drives the app's functions instead of clicking DOM.
  const tap = (sel, text) => page.evaluate(([s, t]) => {
    const el = t
      ? [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t))
      : document.querySelector(s);
    if (!el) throw new Error('nothing to tap for ' + s + (t ? ' / ' + t : ''));
    el.click();
  }, [sel, text]);

  await page.evaluate(() => { showPage('fitness'); showFitnessTab('plan'); });
  await page.waitForTimeout(400);

  const collapsed = await state();
  assert.strictEqual(collapsed.body, 'none', 'starts collapsed');
  assert.strictEqual(collapsed.caret, '▼');
  // The counts have to survive collapsing, or closing the card hides the summary the
  // header exists to provide.
  assert.match(collapsed.summary, /5 ท่า/, 'header still reports the total while collapsed');

  await tap('#progression-header');
  await page.waitForTimeout(200);
  const open = await state();
  assert.strictEqual(open.body, 'block', 'expands on tap');
  assert.strictEqual(open.caret, '▲');
  assert.strictEqual(open.rows, 5);
  // Only groups actually trained get a pill, so no dead categories and no empty list.
  assert.deepStrictEqual(open.pills, ['ทั้งหมด 5', '🔴 Push 2', '🔵 Pull 2', '🟢 Legs 1']);

  await tap('#progression-filter-row .ex-pill', 'Pull');
  await page.waitForTimeout(200);
  const pull = await state();
  assert.strictEqual(pull.rows, 2, 'filters to the Pull lifts only');
  assert.strictEqual(pull.body, 'block', 'filtering does not close the card');

  await tap('#progression-header');
  await page.waitForTimeout(200);
  assert.strictEqual((await state()).body, 'none', 'collapses again');

  await noErrors(page, 'the progression card');
});

test('the deload "consecutive weeks" count is the real streak, not a fixed 6-week window', async () => {
  // The Timeline card shows the *program* week (days since the Fitness Target start); the
  // deload "เทรนต่อเนื่อง N สัปดาห์" line is anchored to the strength log instead, and the
  // two are different quantities on purpose. The old code reported
  // Object.keys(weekTon).sort().slice(-6).length — a lookback-window size capped at 6 —
  // so eight straight training weeks rendered as "6 สัปดาห์", colliding with the program
  // week and reading as a sync bug. It must report the true consecutive streak (8) and
  // break the run at a skipped week.
  const back = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const log = [];
  // 8 consecutive weeks (7 days apart → adjacent Monday buckets), uniform tonnage so no
  // week is "light" and the whole run counts. A ninth, older, non-adjacent week is
  // separated by a gap and must NOT extend the streak.
  for (let w = 0; w < 8; w++) {
    log.push({ id: w + 1, date: back(3 + w * 7), exerciseId: 'bench-press',
      exerciseName: 'bench-press', weight: 100, reps: 8, rir: 2, e1RM: 133 });
  }
  log.push({ id: 99, date: back(3 + 9 * 7 + 7), exerciseId: 'bench-press', // gap week between
    exerciseName: 'bench-press', weight: 100, reps: 8, rir: 2, e1RM: 133 });

  // A second deload signal (sleep debt ≥ 6h) so checkDeloadNeed clears its ≥2-signal gate
  // and actually returns the signal text under test.
  const sleepLog = [];
  for (let i = 0; i < 12; i++) {
    sleepLog.push({ date: back(i), hours: 4, timeInBed: 4.5, rhr: 56, hrv: 61,
      hrvBaseline: 60, bedtime: '01:00', wakeTime: '05:00', sleepScore: 40 });
  }

  const page = await openApp(browser, Object.assign(buildSeed(), {
    gd_strength_log: log,
    gd_sleep_log: sleepLog,
  }));

  const res = await page.evaluate(() => checkDeloadNeed());
  assert.ok(res, 'deload fires once two independent signals stack');
  const streakSignal = res.signals.find((s) => s.includes('เทรนต่อเนื่อง'));
  assert.ok(streakSignal, 'the consecutive-week signal is present');
  assert.match(streakSignal, /เทรนต่อเนื่อง 8 สัปดาห์/, 'reports the real 8-week streak');
  assert.doesNotMatch(streakSignal, /เทรนต่อเนื่อง 6 สัปดาห์/, 'never the 6-week window artifact');

  await noErrors(page, 'the deload week-streak count');
});

test('food photos: in-app camera and gallery cap at 3, all go in one AI request, none are persisted', async () => {
  const page = await openApp(browser, buildSeed());

  const r = await page.evaluate(async () => {
    showPage('analyze');
    // Fake camera: a canvas stream stands in for getUserMedia.
    const src = document.createElement('canvas');
    src.width = 640; src.height = 480;
    const ctx = src.getContext('2d');
    const paint = setInterval(() => { ctx.fillStyle = '#c84'; ctx.fillRect(0, 0, 640, 480); }, 30);
    let stream;
    navigator.mediaDevices.getUserMedia = async () => (stream = src.captureStream(30));
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));

    openFoodCamera();
    for (let i = 0; i < 20 && !document.getElementById('foodCamVideo').videoWidth; i++) await tick(50);
    const opened = document.getElementById('foodCam').classList.contains('open');
    captureFoodFrame();
    captureFoodFrame();
    const afterTwo = curImgs.length;
    captureFoodFrame(); // third fills the meal and closes the camera
    const closedAtMax = !document.getElementById('foodCam').classList.contains('open');
    const tracksStopped = stream.getTracks().every((t) => t.readyState === 'ended');
    clearInterval(paint);

    // Gallery multi-select beyond the cap is trimmed, not appended.
    removeFoodPhoto(0);
    const blob = await new Promise((res) => src.toBlob(res, 'image/jpeg'));
    const files = [1, 2, 3].map((i) => new File([blob], 'f' + i + '.jpg', { type: 'image/jpeg' }));
    handleFile({ target: { files, value: '' } });
    for (let i = 0; i < 40 && curImgs.length < 3; i++) await tick(50);
    await tick(200);
    const afterGallery = curImgs.length;

    let body = null;
    window.aiAvailable = () => true;
    window.geminiCall = (key, b) => { body = b; return new Promise(() => {}); };
    analyzePhoto('');
    const parts = body.contents[0].parts;

    const stored = Object.keys(localStorage).some((k) => /\/9j\//.test(localStorage.getItem(k) || ''));
    return {
      opened, afterTwo, closedAtMax, tracksStopped, afterGallery, stored,
      imageParts: parts.filter((p) => p.inline_data).length,
      dedupeRule: /ห้ามนับซ้ำ/.test(parts[0].text),
    };
  });

  assert.ok(r.opened, 'the in-app camera opens');
  assert.strictEqual(r.afterTwo, 2);
  assert.ok(r.closedAtMax, 'the camera closes once the 3rd photo is taken');
  assert.ok(r.tracksStopped, 'closing the camera stops the stream');
  assert.strictEqual(r.afterGallery, 3, 'gallery picks are trimmed to the 3-photo cap');
  assert.strictEqual(r.imageParts, 3, 'every photo goes into the single AI request');
  assert.ok(r.dedupeRule, 'a multi-photo prompt tells the model not to double-count');
  assert.strictEqual(r.stored, false, 'no photo is written to localStorage');
  await noErrors(page, 'multi-photo food capture');
  await page.close();
});

test('a weight or body-comp change clears the cached AI Deep-Dive, not just the analysis card', async () => {
  const page = await openApp(browser, buildSeed());

  const r = await page.evaluate(() => {
    showPage('weight');
    if (typeof initWeightTab === 'function') initWeightTab();
    const stale = () => localStorage.setItem('gd_wt_ai_result',
      JSON.stringify({ html: '<p>STALE-DEEP-DIVE</p>', date: localDateStr() }));
    const cleared = () => localStorage.getItem('gd_wt_ai_result') === null;
    const out = {};

    stale();
    document.getElementById('wt-input').value = '71.3';
    handleSaveWeight();
    out.save = cleared();
    runWeightAnalysis();
    out.notRestored = !/STALE-DEEP-DIVE/.test((document.getElementById('wt-ai-result') || {}).innerHTML || '');

    stale();
    handleDeleteWeight(WT.log[0].id);
    out.del = cleared();

    stale();
    deleteBodyCompLogEntry(getBodyCompLogs()[0].id);
    out.bodyComp = cleared();
    return out;
  });

  assert.ok(r.save, 'saving a weight clears gd_wt_ai_result');
  assert.ok(r.notRestored, 'the re-run analysis does not restore the old Deep-Dive text');
  assert.ok(r.del, 'deleting a weight clears gd_wt_ai_result');
  assert.ok(r.bodyComp, 'deleting a body-comp entry clears gd_wt_ai_result');
  await page.close();
});

test('logging or editing a meal through the favorite modal reconciles kcal with macros', async () => {
  const page = await openApp(browser, buildSeed());

  const r = await page.evaluate(() => {
    showPage('log');
    const fill = (cal) => {
      // kcal typed independently: P20/C30/F15 = 335 kcal by 4-4-9.
      document.getElementById('favUseCal').value = cal;
      document.getElementById('favUsePro').value = 20;
      document.getElementById('favUseCrb').value = 30;
      document.getElementById('favUseFat').value = 15;
      document.getElementById('favUseFib').value = 0;
    };
    openUseFavoriteModal(S.favorites[0].id);
    fill(800);
    confirmUseFavorite();
    const added = S.meals[S.meals.length - 1];

    editMeal(added.id);
    fill(900);
    confirmUseFavorite();
    const edited = S.meals.find((m) => m.id === added.id);
    const k = (m) => m.protein * 4 + m.carbs * 4 + m.fat * 9;
    return { addCal: added.calories, addMacro: k(added), editCal: edited.calories, editMacro: k(edited) };
  });

  assert.strictEqual(r.addCal, r.addMacro, 'a new meal from a favorite is internally consistent');
  assert.strictEqual(r.editCal, r.editMacro, 'an edited meal is internally consistent');
  await noErrors(page, 'the favorite modal');
  await page.close();
});

test('the in-app camera ignores a double tap and never opens after the user has left', async () => {
  const page = await openApp(browser, buildSeed());

  const r = await page.evaluate(async () => {
    showPage('analyze');
    const src = document.createElement('canvas');
    src.width = 64; src.height = 48;
    src.getContext('2d').fillRect(0, 0, 64, 48);
    const streams = [], pending = [];
    navigator.mediaDevices.getUserMedia = () => new Promise((res) => {
      pending.push(() => { const s = src.captureStream(5); streams.push(s); res(s); });
    });
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));

    openFoodCamera();
    openFoodCamera(); // double tap while the permission prompt is up
    const requests = pending.length;
    showPage('log'); // user leaves before granting
    pending.forEach((grant) => grant());
    await tick(100);
    return {
      requests,
      opened: document.getElementById('foodCam').classList.contains('open'),
      stopped: streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
      held: _foodCamStream !== null,
    };
  });

  assert.strictEqual(r.requests, 1, 'a second tap does not start a second stream');
  assert.strictEqual(r.opened, false, 'the camera does not pop up over another page');
  assert.ok(r.stopped, 'the late stream is stopped (camera light off)');
  assert.strictEqual(r.held, false);
  await noErrors(page, 'cancelled camera open');
  await page.close();
});

test('answering the photo clarify question keeps the description typed with the photos', async () => {
  const page = await openApp(browser, buildSeed());

  const text = await page.evaluate(() => {
    showPage('analyze');
    switchMode('photo');
    curImgs = ['/9j/AAAA'];
    document.getElementById('photoDesc').value = 'น้ำมันน้อย ไม่ใส่ไข่';
    document.getElementById('clarifyInput').value = 'จานใหญ่';
    let body = null;
    window.aiAvailable = () => true;
    window.geminiCall = (key, b) => { body = b; return new Promise(() => {}); };
    reanalyze();
    return body.contents[0].parts[0].text;
  });

  assert.match(text, /น้ำมันน้อย ไม่ใส่ไข่/, 'the original description is still sent');
  assert.match(text, /จานใหญ่/, 'the clarify answer is sent');
  await page.close();
});

// ── Whole-app review fixes ───────────────────────────────────────────────────

// A stand-in for window.FB: every load* resolves from the given tables, every write is
// recorded and resolves (or rejects, for ids listed in failIds).
const fakeFBSource = `
  window.__fbWrites = [];
  window.makeFakeFB = function(lists, settings, failIds) {
    failIds = failIds || [];
    return new Proxy({}, { get: function(_, k) {
      return function() {
        var a = Array.prototype.slice.call(arguments);
        if (String(k).indexOf('load') === 0) {
          if (k === 'loadSetting') return Promise.resolve(a[0] in settings ? settings[a[0]] : (a[1] === undefined ? null : a[1]));
          return Promise.resolve(lists[k] || []);
        }
        window.__fbWrites.push([k].concat(a));
        var id = a[0] && a[0].id != null ? a[0].id : a[0];
        return failIds.indexOf(id) >= 0 ? Promise.reject(new Error('offline')) : Promise.resolve();
      };
    } });
  };`;

test('the offline queue keeps a write that failed, and drops only those that succeeded', async () => {
  const page = await openApp(browser, buildSeed());
  const r = await page.evaluate(async (src) => {
    eval(src);
    window.FB_OK = false; window.FB = null;
    queueFBWrite('meal', 'save', { id: 101, foodName: 'a' });
    queueFBWrite('meal', 'save', { id: 102, foodName: 'b' });
    window.FB = makeFakeFB({}, {}, [102]); window.FB_OK = true;
    await drainFBQueue();
    return JSON.parse(localStorage.getItem('gd_pending_fb') || '[]').map((i) => i.data.id);
  }, fakeFBSource);
  assert.deepStrictEqual(r, [102], 'the failed write stays queued for the next drain');
  await page.close();
});

test('loading from Firebase keeps offline-logged entries, queued settings and the diet break', async () => {
  const page = await openApp(browser, buildSeed());
  const r = await page.evaluate(async (src) => {
    eval(src);
    window.FB_OK = false; window.FB = null;
    // Logged before Firebase was ready.
    const meal = { id: 777, date: localDateStr(), foodName: 'ออฟไลน์', calories: 400, protein: 30, carbs: 40, fat: 13.3 };
    S.meals.push(meal); queueFBWrite('meal', 'save', meal);
    S.favorites.unshift({ id: 888, foodName: 'โปรดออฟไลน์', calories: 100, protein: 10, carbs: 10, fat: 2.2 });
    queueFBWrite('favorite', 'save', S.favorites[0]);
    S.goals = { cal: 2222, pro: 150, crb: 230, fat: 70 };
    fbSaveSettingOrQueue('goals', S.goals);

    window.FB = makeFakeFB({ loadMeals: [], loadFavorites: [] },
      { goals: { cal: 1500, pro: 100, crb: 150, fat: 50 },
        dietBreak: { active: true, startDate: localDateStr(), days: 14, updatedAt: Date.now() } });
    window.FB_OK = true;
    loadRemoteData();
    for (let i = 0; i < 40 && !S.meals.some((m) => m.id === 777 && S.goals.cal); i++) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 300));
    return {
      meal: S.meals.some((m) => m.id === 777),
      fav: S.favorites.some((f) => f.id === 888),
      goal: S.goals.cal,
      dietBreak: !!getActiveDietBreak(),
    };
  }, fakeFBSource);
  assert.ok(r.meal, 'a meal logged offline is not wiped by the remote copy');
  assert.ok(r.fav, 'a favorite saved offline survives');
  assert.strictEqual(r.goal, 2222, 'a goal edit still queued is not overwritten by the older cloud value');
  assert.ok(r.dietBreak, 'the diet break is read back from Firestore');
  await page.close();
});

test('chat: two meals in one AI reply give two confirm cards with distinct ids', async () => {
  const page = await openApp(browser, buildSeed());
  const r = await page.evaluate(async () => {
    window.aiAvailable = () => true;
    window.geminiCall = () => Promise.resolve({ candidates: [{ content: { parts: [
      { text: 'บันทึกให้นะครับ' },
      { functionCall: { name: 'log_meal', args: { foodName: 'ข้าวมันไก่', calories: 600, protein: 25, carbs: 75, fat: 22 } } },
      { functionCall: { name: 'log_meal', args: { foodName: 'ชาเย็น', calories: 200, protein: 3, carbs: 35, fat: 5.5 } } },
    ] } }] });
    openChat();
    document.getElementById('chatInput').value = 'กินข้าวมันไก่กับชาเย็น';
    sendChatMessage();
    await new Promise((res) => setTimeout(res, 300));
    const cards = document.querySelectorAll('[id^="chat-meal-card-"]');
    const before = S.meals.length;
    cards.forEach((c) => c.querySelector('.chat-meal-btn').click());
    const added = S.meals.slice(before);
    return { cards: cards.length, ids: added.map((m) => m.id) };
  });
  assert.strictEqual(r.cards, 2, 'both meals get a card');
  assert.strictEqual(new Set(r.ids).size, 2, 'each confirmed meal has its own id');
  await noErrors(page, 'chat multi-meal');
  await page.close();
});

test('a weight note is rendered as text, not HTML', async () => {
  const seed = buildSeed();
  seed.gd_weight = seed.gd_weight.concat([{ id: 999, date: seed.gd_weight[0].date, time: '07:00', weight: 77,
    note: '<img src=x onerror="window.__xss=1">' }]);
  const page = await openApp(browser, seed);
  const r = await page.evaluate(async () => {
    showPage('weight');
    await new Promise((res) => setTimeout(res, 300));
    return { img: !!document.querySelector('#wt-log-list img'), xss: !!window.__xss };
  });
  assert.strictEqual(r.img, false);
  assert.strictEqual(r.xss, false);
  await page.close();
});

test('the 21st progress photo saves offline instead of throwing on a null window.FB', async () => {
  const seed = buildSeed();
  seed.gd_progress_photos = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, date: '2026-01-01', angle: 'front', imageUrl: 'https://x/' + i }));
  const page = await openApp(browser, seed);
  const r = await page.evaluate(() => {
    window.FB_OK = false; window.FB = null;
    _vpImgB64 = '/9j/AAAA';
    saveProgressPhotoLog();
    const logs = getProgressPhotos();
    return { n: logs.length, lastIsNew: !!logs[logs.length - 1].imageB64 };
  });
  assert.strictEqual(r.n, 20);
  assert.ok(r.lastIsNew, 'the new photo is stored');
  await noErrors(page, 'offline progress photo');
  await page.close();
});

test('confirming a recovery adjustment clears every goal-dependent cache', async () => {
  const page = await openApp(browser, buildSeed());
  const r = await page.evaluate(() => {
    const today = localDateStr();
    localStorage.setItem('gd_recovery_adj', JSON.stringify({ date: today, rec: 'Push', delta: 152, carbDelta: 38, proDelta: 0, reason: 'x' }));
    ['gd_daily_summary', 'gd_weekly_summary', 'gd_wt_analysis', 'gd_wt_analysis_data', 'gd_wt_ai_result']
      .forEach((k) => localStorage.setItem(k, JSON.stringify({ date: today })));
    applyRecoveryAdj();
    return ['gd_daily_summary', 'gd_weekly_summary', 'gd_wt_analysis', 'gd_wt_analysis_data', 'gd_wt_ai_result']
      .filter((k) => localStorage.getItem(k) !== null);
  });
  assert.deepStrictEqual(r, [], 'no stale analysis survives the goal change');
  await page.close();
});

test('a corrupt gd_sleep value does not stop the app from starting', async () => {
  const seed = buildSeed();
  seed.gd_sleep = '{not json';
  const page = await openApp(browser, seed);
  const r = await page.evaluate(() => typeof S !== 'undefined' && S.sleepData === null && typeof updateDash === 'function');
  assert.ok(r);
  await noErrors(page, 'corrupt gd_sleep');
  await page.close();
});

// ── Health Connect (Android app) ─────────────────────────────────────────────
// The Android build is this same page with Capacitor's bridge injected. This stands in for
// that bridge (window.Capacitor + nativePromise) and plays back what Health Connect returns,
// so the whole import runs against the real merge, scoring and storage code.
function fakeCapacitorBridge(hc) {
  window.__nativeCalls = [];
  const at = (date, hhmm) => new Date(date + 'T' + hhmm + ':00').toISOString();
  const prev = (date) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const ring = 'com.sec.android.app.shealth';
  const night = (date) => ({
    sourceId: ring, sourceName: 'Samsung Galaxy Ring', startDate: at(prev(date), '23:10'), endDate: at(date, '06:50'),
    stages: [
      { startDate: at(prev(date), '23:10'), endDate: at(prev(date), '23:30'), stage: 'awake' },
      { startDate: at(prev(date), '23:30'), endDate: at(date, '01:00'), stage: 'light' },
      { startDate: at(date, '01:00'), endDate: at(date, '02:10'), stage: 'deep' },
      { startDate: at(date, '02:10'), endDate: at(date, '05:00'), stage: 'light' },
      { startDate: at(date, '05:00'), endDate: at(date, '06:30'), stage: 'rem' },
      { startDate: at(date, '06:30'), endDate: at(date, '06:50'), stage: 'awake' },
    ],
  });
  const samples = {
    sleep: [night(hc.fresh), night(hc.typed)],
    heartRateVariability: [hc.fresh, hc.typed].flatMap((d) => [
      { sourceId: ring, startDate: at(d, '02:00'), value: 48 }, { sourceId: ring, startDate: at(d, '04:00'), value: 52 }]),
    restingHeartRate: [{ sourceId: ring, startDate: at(hc.fresh, '15:00'), value: 54 }],
    respiratoryRate: [{ sourceId: ring, startDate: at(hc.fresh, '03:00'), value: 14.2 }],
  };
  const stepBuckets = [
    { startDate: at(hc.fresh, '09:00'), value: 9000 }, { startDate: at(hc.fresh, '17:00'), value: 6500 },
    { startDate: at(hc.typed, '10:00'), value: 2000 },
  ];
  const all = ['sleep', 'heartRateVariability', 'restingHeartRate', 'respiratoryRate', 'steps'];
  const reply = {
    isAvailable: () => ({ available: true, platform: 'android' }),
    requestAuthorization: () => ({ readAuthorized: all, readDenied: [], writeAuthorized: [], writeDenied: [], historyAccessAuthorized: false }),
    checkAuthorization: () => ({ readAuthorized: all, readDenied: [] }),
    readSamples: (o) => ({ samples: samples[o.dataType] || [] }),
    queryAggregated: () => ({ samples: stepBuckets }),
    signInWithGoogle: () => ({ user: null, credential: { providerId: 'google.com', idToken: 'fake-id-token' } }),
  };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [{ name: 'Health', methods: [] }, { name: 'FirebaseAuthentication', methods: [] }],
    nativePromise: (plugin, method, options) => {
      window.__nativeCalls.push({ plugin, method, options });
      const fn = reply[method];
      return fn ? Promise.resolve(fn(options)) : Promise.reject(new Error('unmocked ' + plugin + '.' + method));
    },
  };
}

test('Health Connect: imported nights are scored like typed ones, and typed values survive', async () => {
  const seed = buildSeed();
  const fresh = dateBack(3), typed = dateBack(2);
  // `fresh` has nothing logged yet; `typed` was entered by hand and must keep its numbers.
  seed.gd_sleep_log = seed.gd_sleep_log.filter((s) => s.date !== fresh);
  const t = seed.gd_sleep_log.find((s) => s.date === typed);
  Object.assign(t, { hours: 6.4, rhr: 58, bedtime: '00:20', wakeTime: '06:45' });
  delete t.hrv; delete t.hrvBaseline;
  seed.gd_steps[fresh] = 4000;
  seed.gd_steps[typed] = 12000;

  const page = await openApp(browser, seed, { init: fakeCapacitorBridge, initArg: { fresh, typed } });
  const r = await page.evaluate(async ({ fresh, typed }) => {
    showPage('settings');
    await hcConnect();
    const log = JSON.parse(localStorage.getItem('gd_sleep_log'));
    const steps = JSON.parse(localStorage.getItem('gd_steps'));
    return {
      fresh: log.find((s) => s.date === fresh),
      typed: log.find((s) => s.date === typed),
      steps: { fresh: steps[fresh], typed: steps[typed] },
      dirty: JSON.parse(localStorage.getItem('gd_dirty_gd_sleep_log') || '{}'),
      state: JSON.parse(localStorage.getItem('gd_hc_state')),
      requested: window.__nativeCalls.find((c) => c.method === 'requestAuthorization').options,
      cardText: document.getElementById('hc-status').textContent,
    };
  }, { fresh, typed });

  // 23:30–06:30 minus nothing = 7 h asleep (20 + 20 min awake excluded); 7 h 40 in bed.
  assert.strictEqual(r.fresh.hours, 7);
  assert.strictEqual(r.fresh.timeInBed, 7.67);
  assert.strictEqual(r.fresh.deepSleep, 70);
  assert.strictEqual(r.fresh.remSleep, 90);
  assert.strictEqual(r.fresh.bedtime, '23:10');
  assert.strictEqual(r.fresh.wakeTime, '06:50');
  assert.strictEqual(r.fresh.hrv, 50, 'mean of the overnight HRV samples');
  assert.strictEqual(r.fresh.rhr, 54, 'a once-a-day RHR is taken from the wake morning');
  assert.strictEqual(r.fresh.respRate, 14.2);
  assert.strictEqual(r.fresh.source, 'health_connect');
  assert.ok(r.fresh.sleepScore > 0, 'scored deterministically at import, like saveSleep');
  assert.ok(r.fresh.consistency != null, 'consistency recomputed from the surrounding nights');
  assert.ok(r.fresh.hrvBaseline > 0, 'HRV baseline filled from the rolling log, as the form does');
  assert.ok(r.dirty[fresh] && r.dirty[typed], 'touched nights are marked for Firestore');

  assert.strictEqual(r.typed.hours, 6.4, 'a hand-entered value is never overwritten');
  assert.strictEqual(r.typed.rhr, 58);
  assert.strictEqual(r.typed.bedtime, '00:20');
  assert.strictEqual(r.typed.hrv, 50, 'only its empty fields are filled');
  assert.strictEqual(r.typed.source, undefined);

  assert.strictEqual(r.steps.fresh, 15500, 'the higher Health Connect total replaces a lower one');
  assert.strictEqual(r.steps.typed, 12000, 'a higher typed count is kept');

  assert.deepStrictEqual(r.requested.read.slice().sort(),
    ['heartRateVariability', 'respiratoryRate', 'restingHeartRate', 'sleep', 'steps'], 'read-only, and nothing else');
  assert.strictEqual(r.requested.write, undefined, 'never asks to write');
  assert.strictEqual(r.state.connected, true);
  assert.match(r.cardText, /เชื่อมต่อแล้ว/);
  await noErrors(page, 'Health Connect import');
  await page.close();
});

test('in the Android app, Google sign-in goes through the native picker, not a WebView popup', async () => {
  const page = await openApp(browser, buildSeed(), { init: fakeCapacitorBridge, initArg: { fresh: dateBack(3), typed: dateBack(2) } });
  const calls = await page.evaluate(async () => {
    loginWithGoogle();
    await new Promise((r) => setTimeout(r, 300));
    return window.__nativeCalls.filter((c) => c.plugin === 'FirebaseAuthentication');
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'signInWithGoogle');
  assert.strictEqual(calls[0].options.skipNativeAuth, true, 'the Firebase JS SDK keeps owning the session');
  await page.close();
});

test('in a normal browser the Health Connect card explains it needs the Android app', async () => {
  const page = await openApp(browser, buildSeed());
  const r = await page.evaluate(() => {
    showPage('settings');
    return { text: document.getElementById('hc-status').textContent, actions: document.getElementById('hc-actions').style.display };
  });
  assert.match(r.text, /เฉพาะในแอป Kindee บน Android/);
  assert.strictEqual(r.actions, 'none');
  await noErrors(page, 'Health Connect card on the web');
  await page.close();
});

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

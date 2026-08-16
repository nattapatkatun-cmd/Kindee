'use strict';
// Unit tests for the calculation engines, run against the real function bodies extracted
// from index.html. No browser, no DOM — these are fast and should stay that way.
//
// Every assertion here is tied to a reference formula or a documented invariant, not to
// whatever the code happened to return when the test was written. If a number changes,
// the test should be telling you the physiology changed, not that a snapshot went stale.

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helpers/extract');

// ── Activity expenditure ──────────────────────────────────────────────────────
test('calcBurnKcal matches the standard MET equation', () => {
  const ctx = load(['calcBurnKcal'], {
    prelude: 'var S = { profile: { weight: 70 } };\nfunction getLatestCheckinWeight(){ return S.profile.weight; }',
  });
  // kcal = MET × 3.5 mL O2/kg/min × kg / 200
  const textbook = (met, kg, min) => (met * 3.5 * kg * min) / 200;

  assert.strictEqual(ctx.calcBurnKcal(8.5, 45), Math.round(textbook(8.5, 70, 45)), '8.5 MET / 45 min / 70 kg');
  assert.strictEqual(ctx.calcBurnKcal(3.5, 60), Math.round(textbook(3.5, 70, 60)), 'walking, 1 h');
  assert.strictEqual(ctx.calcBurnKcal(0, 45), 0, 'zero MET burns nothing');
  assert.strictEqual(ctx.calcBurnKcal(8.5, 0), 0, 'zero minutes burns nothing');

  // Regression: the 1.05 factor was missing, running ~4.8% under every published table.
  assert.ok(ctx.calcBurnKcal(8.5, 45) > 8.5 * 70 * 0.75, 'must not drop the 3.5/200 conversion');
});

test('calcStepCalories is NET of resting metabolism', () => {
  const ctx = load(['calcStepCalories'], {
    consts: ['STEP_KCAL_NET_PER_STEP_AT_70KG'],
    prelude: 'var S = { profile: { weight: 70 } };\nfunction getLatestCheckinWeight(){ return S.profile.weight; }',
  });
  // Walking ≈ 3.5 METs at ~110 steps/min. NET subtracts the 1 MET resting cost, which
  // BMR/TDEE already accounts for — using the gross figure as a deduction double-counts it.
  const netPerMin = ((3.5 - 1) * 3.5 * 70) / 200;
  const expected10k = (netPerMin / 110) * 10000;

  assert.ok(Math.abs(ctx.calcStepCalories(10000) - expected10k) <= 6,
    `10k steps @70kg should be ~${Math.round(expected10k)} net, got ${ctx.calcStepCalories(10000)}`);
  assert.ok(ctx.calcStepCalories(10000) < 340, 'must be below the ~370 kcal GROSS figure');
  assert.strictEqual(ctx.calcStepCalories(0), 0);

  ctx.S.profile.weight = 140;
  assert.ok(Math.abs(ctx.calcStepCalories(10000) - 2 * expected10k) <= 12, 'scales linearly with bodyweight');
});

// ── Protein ───────────────────────────────────────────────────────────────────
test('protein tracks lean mass continuously across the whole %BF range', () => {
  const ctx = load(
    ['buildGoalFromMode', 'getGoalModeConfig', 'normalizeGoalMode', 'calcBMRFromProfile', 'getActivityMultiplier', 'calcFormulaTDEE'],
    {
      prelude: `
        var MOCK = { weight: 70, bf: null };
        var S = { profile: {}, goals: { cal: 2000 } };
        function getLatestCheckinWeight(){ return MOCK.weight; }
        function safeJSON(k, d){ return d; }
        function getLatestBodyCompBySource(){ return MOCK.bf != null ? { bf: MOCK.bf } : null; }
        function readAnalyzerContext(){ return null; }`,
    }
  );
  const profile = { age: 30, weight: 70, height: 175, gender: 'male', activity: 1.55, goalType: 'fat_loss' };

  let prev = null;
  for (let bf = 15; bf <= 35; bf += 0.5) {
    ctx.MOCK.bf = bf;
    const g = ctx.buildGoalFromMode('fat_loss', profile, 2500);
    const perLbm = g.pro / (70 * (1 - bf / 100));

    // Requirement scales with fat-free mass; 2.4 g/kg LBM sits inside the 2.3–3.1 g/kg
    // FFM band recommended for athletes in an energy deficit.
    assert.ok(Math.abs(perLbm - 2.4) < 0.05, `${bf}%BF should hold ~2.4 g/kg LBM, got ${perLbm.toFixed(2)}`);

    if (prev !== null) {
      // The old code switched bases at a %BF threshold, so the target FELL ~13 g the
      // moment body fat rose past 25% — and jumped back when it dipped under.
      assert.ok(g.pro <= prev, `protein must not RISE as %BF rises (at ${bf}%)`);
      assert.ok(prev - g.pro <= 2, `no discontinuity at ${bf}%BF (${prev} → ${g.pro})`);
    }
    prev = g.pro;
  }

  ctx.MOCK.bf = 20;
  assert.strictEqual(ctx.buildGoalFromMode('fat_loss', profile, 2500).proteinBasis, 'lbm', 'basis is reported honestly');
});

test('buildGoalFromMode keeps calories and macros reconciled', () => {
  const ctx = load(
    ['buildGoalFromMode', 'getGoalModeConfig', 'normalizeGoalMode', 'calcBMRFromProfile', 'getActivityMultiplier', 'calcFormulaTDEE'],
    {
      prelude: `
        var MOCK = { weight: 70, bf: null };
        var S = { profile: {}, goals: { cal: 2000 } };
        function getLatestCheckinWeight(){ return MOCK.weight; }
        function safeJSON(k, d){ return d; }
        function getLatestBodyCompBySource(){ return MOCK.bf != null ? { bf: MOCK.bf } : null; }
        function readAnalyzerContext(){ return null; }`,
    }
  );
  for (const [gender, weight, bf, tdee] of [['male', 70, 20, 2500], ['female', 55, 28, 1900], ['male', 100, 35, 2000]]) {
    ctx.MOCK.weight = weight;
    ctx.MOCK.bf = bf;
    const g = ctx.buildGoalFromMode('fat_loss', { age: 30, weight, height: 175, gender, activity: 1.55 }, tdee);
    const macroKcal = g.pro * 4 + g.crb * 4 + g.fat * 9;
    // The app's own Settings validator flags a gap > 15 kcal in red; a goal the engine
    // generates must never fail that check.
    assert.ok(Math.abs(macroKcal - g.cal) <= 15, `${gender} ${weight}kg ${bf}%BF: cal ${g.cal} vs macros ${macroKcal}`);
    assert.ok(g.cal >= (gender === 'female' ? 1200 : 1500), 'respects the gender calorie floor');
  }
});

// ── Sleep ─────────────────────────────────────────────────────────────────────
test('scoreDuration ranks oversleep below a solid night and grades short nights', () => {
  const { scoreDuration } = load(['scoreDuration']);
  assert.ok(scoreDuration(12) < scoreDuration(8.5), '12 h must score below 8.5 h');
  assert.ok(scoreDuration(10) < scoreDuration(9.2), 'past the optimal band the score declines');
  assert.ok(scoreDuration(2) < scoreDuration(5.9), 'a 2 h night must score below a 5.9 h night');
  assert.ok(scoreDuration(9.2) >= scoreDuration(8.5), '9–9.5 h is the peak band');
  assert.strictEqual(scoreDuration(0), 0);
});

test('unmeasured sleep pillars are dropped, never filled with a placeholder', () => {
  const ctx = load(['calculateSleepScoreFromData', 'scoreDuration', 'scoreEfficiency', 'scoreStages', 'scorePhysio']);

  const phoneOnly = ctx.calculateSleepScoreFromData({ hours: 4.0 });
  assert.strictEqual(phoneOnly.pillars.stages, null, 'no stage data → null, not 50');
  assert.strictEqual(phoneOnly.pillars.physio, null, 'no HRV/RHR → null, not 50');
  // With only Duration measured, the score IS the duration score. A hard-coded 50 at
  // 20% weight each used to drag a 4 h night up to 37 ("Fair").
  assert.strictEqual(phoneOnly.sleepScore, ctx.scoreDuration(4.0));
  assert.strictEqual(phoneOnly.scoreLabel, 'Poor');

  const full = ctx.calculateSleepScoreFromData({
    hours: 7.5, timeInBed: 8, deepSleep: 70, remSleep: 100, hrv: 65, hrvBaseline: 60, consistency: 80,
  });
  assert.ok(full.sleepScore > 0 && full.sleepScore <= 100, 'stays in range with every pillar present');
  for (const v of Object.values(full.pillars)) assert.ok(v !== null, 'all pillars measured');
});

test('sleep efficiency cannot exceed 100%', () => {
  const { scoreEfficiency } = load(['scoreEfficiency']);
  // A misread screenshot import used to yield >100% and land in the TOP band.
  assert.strictEqual(scoreEfficiency(7.83, 7.33), null, 'more sleep than time in bed is not a top score');
  assert.strictEqual(scoreEfficiency(6.67, 6.83), 95, '97.6% is legitimately excellent');
  assert.strictEqual(scoreEfficiency(7, 0), null);
  assert.strictEqual(scoreEfficiency(0, 8), null);
});

// ── Meal data ─────────────────────────────────────────────────────────────────
test('reconcileMealMacros keeps calories and macros consistent', () => {
  const { reconcileMealMacros } = load(['reconcileMealMacros']);

  const wrong = reconcileMealMacros({ calories: 650, protein: 20, carbs: 30, fat: 15 });
  assert.strictEqual(wrong.calories, 20 * 4 + 30 * 4 + 15 * 9, 'macros win when the gap is large');
  assert.strictEqual(wrong._calAdjustedFrom, 650, 'the correction is disclosed, not silent');

  const ok = reconcileMealMacros({ calories: 520, protein: 40, carbs: 60, fat: 12 });
  assert.strictEqual(ok.calories, 520, 'within 10% the stated calories are kept');
  assert.strictEqual(ok._calAdjustedFrom, undefined);

  // An AI returning prose where a number belongs used to put NaN on the dashboard ring.
  const junk = reconcileMealMacros({ calories: 'ประมาณ 550', protein: 20, carbs: 30, fat: 15 });
  assert.ok(Number.isFinite(junk.calories), 'never emits NaN');
  assert.strictEqual(junk.calories, 335, 'unparseable calories are derived from macros');

  const noMacros = reconcileMealMacros({ calories: 300, protein: null, carbs: undefined, fat: 'x' });
  assert.deepStrictEqual(
    [noMacros.calories, noMacros.protein, noMacros.carbs, noMacros.fat],
    [300, 0, 0, 0],
    'with no macros the calorie figure stands'
  );
  assert.strictEqual(noMacros.fiber, 0, 'missing fiber defaults to 0, never NaN/undefined');

  // Fiber is a subset of carbs, not a fifth term in the 4/4/9 calorie check — it must
  // survive reconciliation unchanged and never trigger a _calAdjustedFrom correction.
  const withFiber = reconcileMealMacros({ calories: 520, protein: 40, carbs: 60, fat: 12, fiber: 8.456 });
  assert.strictEqual(withFiber.fiber, 8.46, 'fiber is sanitized/rounded like the other macros');
  assert.strictEqual(withFiber._calAdjustedFrom, undefined, 'fiber does not factor into the calorie reconciliation');
});

// ── Fitness target ────────────────────────────────────────────────────────────
test('calcTargetFeasibility rejects targets needing impossible lean gain', () => {
  const ctx = load(['calcTargetFeasibility', 'elapsedDaysSince', 'calcBMRFromProfile', 'getActivityMultiplier', 'calcFormulaTDEE'], {
    prelude: `
      var MOCK = { weight: 75 };
      var S = { goals: { cal: 2000 } };
      function getLatestCheckinWeight(){ return MOCK.weight; }
      function profileSafe(){ return {}; }
      function localDateStr(){ return '2026-07-25'; }
      function readAnalyzerContext(){ return null; }`,
  });
  const profile = { gender: 'male', weight: 75, age: 30, height: 175, activity: 1.55 };

  // Same weight, far lower %BF ⇒ must BUILD muscle while running a deficit.
  const impossible = ctx.calcTargetFeasibility({ currBF: 22, bf: 12, weight: 75, duration: 12 }, profile);
  assert.ok(impossible.leanGainUnrealistic, 'flags the contradiction');
  assert.strictEqual(impossible.status, 'unrealistic');
  assert.ok(impossible.impliedLeanGainPerMonth > 0.25, 'exceeds the realistic in-deficit rate');

  // A straight cut holding lean mass is fine.
  const fine = ctx.calcTargetFeasibility({ currBF: 22, bf: 15, weight: 69, duration: 12 }, profile);
  assert.ok(!fine.leanGainUnrealistic, 'a legitimate cut is not flagged');
});

// ── Date handling ─────────────────────────────────────────────────────────────
test('elapsedDaysSince counts whole days regardless of timezone', () => {
  const ctx = load(['elapsedDaysSince'], { prelude: "function localDateStr(){ return '2026-08-01'; }" });
  // 'YYYY-MM-DD' parses as UTC midnight while new Date() is local; anchoring both ends at
  // local noon is what stops the program week rolling over at 07:00 in Bangkok.
  assert.strictEqual(ctx.elapsedDaysSince('2026-07-25'), 7);
  assert.strictEqual(ctx.elapsedDaysSince('2026-08-01'), 0);
  assert.strictEqual(ctx.elapsedDaysSince('2026-09-01'), 0, 'future start dates clamp at zero');
  assert.strictEqual(ctx.elapsedDaysSince(null), 0);
  assert.strictEqual(ctx.elapsedDaysSince(''), 0);
});

test('entriesWithinDays uses a day window, not a row count', () => {
  const ctx = load(['entriesWithinDays'], { prelude: "function localDateStr(){ return '2026-07-25'; }" });

  // 21 weekly weigh-ins span ~147 days. slice(-21) would hand all of them to something
  // labelled "21d trend" — a five-month slope diluting a real recent cut.
  const weekly = [];
  for (let i = 20; i >= 0; i--) {
    const d = new Date('2026-07-25T12:00:00');
    d.setDate(d.getDate() - i * 7);
    weekly.push({ date: d.toISOString().slice(0, 10), weight: 80 - i * 0.1 });
  }
  assert.ok(ctx.entriesWithinDays(weekly, 21).length <= 4, 'a weekly logger has ≤4 points in 21 days');

  const daily = [];
  for (let i = 19; i >= 0; i--) {
    const d = new Date('2026-07-25T12:00:00');
    d.setDate(d.getDate() - i);
    daily.push({ date: d.toISOString().slice(0, 10), weight: 80 - i * 0.05 });
  }
  assert.strictEqual(ctx.entriesWithinDays(daily, 21).length, 20, 'a daily logger keeps every point');

  const mixed = [
    { date: '2026-01-01', weight: 90 },
    { date: '2026-07-24', weight: 79 },
    { date: '2026-07-20', weight: 80 },
    { date: '2026-07-22', weight: null },
  ];
  const win = ctx.entriesWithinDays(mixed, 21);
  assert.deepStrictEqual(win.map((e) => e.date), ['2026-07-20', '2026-07-24'], 'filters, drops nulls, sorts oldest-first');
});

// ── Bedtime target / habitual schedule anchors ────────────────────────────────
// The target bedtime is solved as `habitual wake − need − debt repayment`. Deriving it
// from THIS MORNING's single wake reading instead ratchets the schedule later every
// time the user sleeps in: late wake → later target → later wake. These tests pin the
// anchor to a bucketed median and pin the weekday/weekend split that sits on top of it.

const SCHEDULE_PRELUDE = `
  var LS = {};
  var localStorage = { getItem: function(k){ return LS[k] || null; } };
  var DEBT = null;
  function computeSleepDebt(){ return DEBT; }
`;
const SCHEDULE_FNS = [
  'localDateStr', '_timeToMin', '_isWeekendDateStr', '_shiftDateStr', '_medianOf',
  '_fmtClockMin', '_scheduleMinsInWindow', '_typicalScheduleMin',
  'computeTypicalBedtimeMin', 'computeTypicalWakeAnchor', 'computeGradualBedtimeTarget',
];
const SCHEDULE_CONSTS = [
  'BEDTIME_SHIFT_CAP_MIN', 'BEDTIME_OUTLIER_MIN', 'SCHEDULE_WINDOW_DAYS',
  'SCHEDULE_WINDOW_WIDE_DAYS', 'SCHEDULE_MIN_NIGHTS', 'WEEKEND_WAKE_MAX_LAG_MIN',
];
const loadSchedule = () => load(SCHEDULE_FNS, { consts: SCHEDULE_CONSTS, prelude: SCHEDULE_PRELUDE });

/** `nights` days of history ending on `endDate`, wake/bed chosen per weekday vs weekend. */
function buildSleepLog(endDate, nights, pick) {
  const log = [];
  for (let i = nights - 1; i >= 0; i--) {
    const d = new Date(endDate + 'T12:00:00');
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const { bedtime, wakeTime, hours = 7.5 } = pick(date, isWeekend);
    log.push({ date, bedtime, wakeTime, hours });
  }
  return log;
}

test('a single lie-in cannot push the target bedtime later (oversleep ratchet)', () => {
  const ctx = loadSchedule();
  // Habitual 00:30 → 08:00. One morning the user wakes at 10:00 with no sleep debt at all,
  // so nothing but the anchor itself stands between them and a later recommended bedtime.
  const endDate = '2026-07-27'; // Monday morning; tonight ends Tuesday ⇒ weekday bucket
  const log = buildSleepLog(endDate, 28, (date) => ({
    bedtime: '00:30',
    wakeTime: date === endDate ? '10:00' : '08:00',
  }));
  ctx.LS['gd_sleep_log'] = JSON.stringify(log);
  ctx.DEBT = null;

  const g = ctx.computeGradualBedtimeTarget('10:00', endDate, 8, '00:30');
  assert.strictEqual(g.wakeAnchorHHMM, '08:00', 'one lie-in does not move a 28-night median');
  assert.strictEqual(g.wakeAnchorBucket, 'weekday');
  // Solved against 08:00 the target can only hold or move earlier. Solved against the raw
  // 10:00 reading it lands at 00:50 — twenty minutes LATER than the habit it should defend.
  assert.ok(
    ctx._timeToMin(g.hhmm, true) <= ctx._timeToMin('00:30', true),
    `target ${g.hhmm} must not be later than the habitual 00:30`,
  );
});

test('wake anchor buckets by tomorrow morning, not today', () => {
  const ctx = loadSchedule();
  // Weekday mornings 07:00, weekend mornings 07:45 — a 45min lag, inside the cap.
  const pick = (date, isWeekend) => ({ bedtime: isWeekend ? '00:00' : '23:15', wakeTime: isWeekend ? '07:45' : '07:00' });

  // Sunday morning. Tonight is Sunday NIGHT, which ends on Monday ⇒ weekday anchor,
  // even though "today" is a weekend day. Bucketing off forDate would get this backwards.
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-26', 42, pick));
  const sunday = ctx.computeGradualBedtimeTarget('07:45', '2026-07-26', 8, '00:00');
  assert.strictEqual(sunday.wakeAnchorBucket, 'weekday');
  assert.strictEqual(sunday.wakeAnchorHHMM, '07:00');

  // Friday morning. Tonight ends on Saturday ⇒ weekend anchor.
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-24', 42, pick));
  const friday = ctx.computeGradualBedtimeTarget('07:00', '2026-07-24', 8, '23:15');
  assert.strictEqual(friday.wakeAnchorBucket, 'weekend');
  assert.strictEqual(friday.wakeAnchorHHMM, '07:45');

  // The split has to actually reach the recommendation, not just the metadata.
  assert.strictEqual(sunday.desiredHHMM, '23:00');
  assert.strictEqual(friday.desiredHHMM, '23:45');
});

test('weekend wake anchor is capped near the weekday anchor (social jetlag)', () => {
  const ctx = loadSchedule();
  // A real 3.5h social-jetlag pattern: 07:00 weekdays, 10:30 weekends.
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-24', 42, (date, isWeekend) => ({
    bedtime: isWeekend ? '02:00' : '23:15',
    wakeTime: isWeekend ? '10:30' : '07:00',
  })));

  const friday = ctx.computeGradualBedtimeTarget('07:00', '2026-07-24', 8, '23:15');
  assert.strictEqual(friday.wakeAnchorCapped, true);
  // Uncapped this anchors at 10:30 and prescribes a 02:30 bedtime — the app endorsing the
  // very weekend phase shift buildDebtPlanText() warns about one row below it.
  assert.strictEqual(friday.wakeAnchorHHMM, '08:00', 'clamped to weekday + WEEKEND_WAKE_MAX_LAG_MIN');
  assert.strictEqual(
    friday.wakeAnchorHHMM,
    ctx._fmtClockMin(ctx._timeToMin('07:00', false) + ctx.WEEKEND_WAKE_MAX_LAG_MIN),
  );
});

test('sparse history falls back down the ladder instead of giving up', () => {
  const ctx = loadSchedule();
  // Four nights logged, all weekday mornings: the weekend bucket can never reach
  // SCHEDULE_MIN_NIGHTS, so a Friday night has to fall through to the pooled median
  // rather than dropping back to the raw reading.
  ctx.LS['gd_sleep_log'] = JSON.stringify([
    { date: '2026-07-21', bedtime: '23:30', wakeTime: '07:00', hours: 7.5 },
    { date: '2026-07-22', bedtime: '23:40', wakeTime: '07:10', hours: 7.5 },
    { date: '2026-07-23', bedtime: '23:20', wakeTime: '07:00', hours: 7.6 },
    { date: '2026-07-24', bedtime: '23:35', wakeTime: '07:05', hours: 7.5 },
  ]);
  const friday = ctx.computeGradualBedtimeTarget('07:05', '2026-07-24', 8, '23:35');
  assert.strictEqual(friday.wakeAnchorBucket, 'pooled');
  assert.strictEqual(friday.wakeAnchorNights, 4);
  // 07:00, 07:00, 07:05, 07:10 ⇒ mean of the middle pair.
  assert.strictEqual(friday.wakeAnchorHHMM, '07:03', 'median of the four logged mornings');

  // One night is not a median of anything — fall back to the raw wake time, and say so.
  ctx.LS['gd_sleep_log'] = JSON.stringify([{ date: '2026-07-24', bedtime: '23:35', wakeTime: '07:05', hours: 7.5 }]);
  const firstNight = ctx.computeGradualBedtimeTarget('07:05', '2026-07-24', 8, '23:35');
  assert.strictEqual(firstNight.wakeAnchorHHMM, null);
  assert.strictEqual(firstNight.wakeFallbackHHMM, '07:05');
  assert.strictEqual(firstNight.desiredHHMM, '23:05', 'still produces a usable target');
});

test('bedtime outlier test buckets weekday vs weekend', () => {
  const ctx = loadSchedule();
  // Bedtime is habitually 23:15 on weeknights and 02:00 at weekends. A 02:00 Saturday
  // bedtime is normal FOR A SATURDAY; judged against a weekday-dominated median it looks
  // like a 165-minute aberration and the target gets anchored on the wrong time.
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-25', 42, (date, isWeekend) => ({
    bedtime: isWeekend ? '02:00' : '23:15',
    wakeTime: isWeekend ? '07:45' : '07:00',
  })));
  // 2026-07-25 is a Saturday morning ⇒ last night was Friday night, a weekend night.
  const g = ctx.computeGradualBedtimeTarget('07:45', '2026-07-25', 8, '02:00');
  assert.strictEqual(g.outlier, false, '02:00 is the weekend habit, not an outlier');
  assert.strictEqual(ctx._fmtClockMin(ctx.computeTypicalBedtimeMin('2026-07-25', true)), '02:00');
  assert.strictEqual(ctx._fmtClockMin(ctx.computeTypicalBedtimeMin('2026-07-25', false)), '23:15');
});

test('a weekend night is not crawled back to the weekday schedule 20 minutes at a time', () => {
  const ctx = loadSchedule();
  // Weekday 23:15 → 07:00, weekend 02:00 → 09:00.
  const pick = (date, isWeekend) => ({
    bedtime: isWeekend ? '02:00' : '23:15',
    wakeTime: isWeekend ? '09:00' : '07:00',
    hours: isWeekend ? 7 : 7.75,
  });
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-26', 42, pick));

  // Sunday morning: last night was Saturday night (02:00), tonight ends Monday at 07:00.
  // Stepping 20min/night from 02:00 prescribes 01:40 before a 07:00 alarm — 5h20 of sleep —
  // and would need eight nights to reach 23:00, by which point it is the weekend again.
  // The 20-minute cap moves a phase to a NEW one; 23:15 is a phase this user already has.
  const sunday = ctx.computeGradualBedtimeTarget('09:00', '2026-07-26', 8, '02:00');
  assert.strictEqual(sunday.wakeAnchorBucket, 'weekday');
  assert.strictEqual(sunday.desiredHHMM, '23:00');
  assert.strictEqual(sunday.hhmm, '23:00', 'returns to the weekday bedtime in one step');
  assert.strictEqual(sunday.anchorIsTypical, true, 'anchored on the habitual time, not last night');
  assert.strictEqual(sunday.anchorHHMM, '23:15');
  assert.strictEqual(sunday.returnedToSchedule, true);
  assert.ok(
    ctx._timeToMin(sunday.hhmm, true) + 8 * 60 <= ctx._timeToMin('07:00', false) + 1440,
    'the target must actually leave room for the need before the weekday alarm',
  );

  // Saturday morning — still inside the weekend bucket, so nothing special happens.
  const saturday = ctx.computeGradualBedtimeTarget('09:00', '2026-07-25', 8, '02:00');
  assert.strictEqual(saturday.anchorIsTypical, false, 'same bucket ⇒ anchor stays on last night');
  assert.strictEqual(saturday.returnedToSchedule, false);
});

test('the 20-minute phase-shift cap still governs shifts inside one bucket', () => {
  const ctx = loadSchedule();
  // Habit 00:50 → 08:20 every night. Wanting 8h against an 08:20 anchor means a 00:20
  // bedtime — a real 30-minute phase shift, which is exactly what the cap is for.
  ctx.LS['gd_sleep_log'] = JSON.stringify(buildSleepLog('2026-07-27', 28, () => ({
    bedtime: '00:50', wakeTime: '08:20', hours: 7.2,
  })));
  const g = ctx.computeGradualBedtimeTarget('08:20', '2026-07-27', 8, '00:50');
  assert.strictEqual(g.desiredHHMM, '00:20');
  assert.strictEqual(g.hhmm, '00:30', 'capped to BEDTIME_SHIFT_CAP_MIN from the anchor');
  assert.strictEqual(g.shifted, true);
  assert.strictEqual(g.anchorIsTypical, false);
  assert.strictEqual(
    ctx._timeToMin('00:50', true) - ctx._timeToMin(g.hhmm, true),
    ctx.BEDTIME_SHIFT_CAP_MIN,
  );
});

// ── Energy Availability (EA) ────────────────────────────────────────────────────
test('calcEnergyAvailability matches (intake − exercise) / fat-free mass', () => {
  const ctx = load(['calcEnergyAvailability'], { consts: ['EA_DANGER', 'EA_OPTIMAL'] });

  // Reference: EA = (energy intake − exercise energy expenditure) / lean body mass, in
  // kcal per kg FFM per day (Loucks 2004). NEAT/steps are deliberately NOT subtracted.
  const ref = (intake, exercise, kg, bf) => (intake - exercise) / (kg * (1 - bf / 100));

  const r = ctx.calcEnergyAvailability(1596, 400, 60, 28);
  assert.strictEqual(r.status, 'ok');
  assert.ok(Math.abs(r.lbm - 43.2) < 1e-9, 'LBM = weight × (1 − bf/100)');
  assert.ok(Math.abs(r.ea - ref(1596, 400, 60, 28)) < 1e-9, 'EA formula matches the reference');

  // Exercise is subtracted; two days with equal intake but more training yield lower EA.
  assert.ok(
    ctx.calcEnergyAvailability(1600, 500, 60, 28).ea < ctx.calcEnergyAvailability(1600, 100, 60, 28).ea,
    'more exercise ⇒ lower EA at equal intake',
  );
});

test('EA zones are pinned to the RED-S constants (30 / 45)', () => {
  const ctx = load(['calcEnergyAvailability'], { consts: ['EA_DANGER', 'EA_OPTIMAL'] });
  const lbm = 50, kg = 62.5, bf = 20; // 62.5 × 0.8 = exactly 50 kg FFM
  const atEA = (target) => ctx.calcEnergyAvailability(target * lbm, 0, kg, bf);

  assert.strictEqual(atEA(ctx.EA_DANGER - 1).zone, 'danger', 'below 30 ⇒ danger');
  assert.strictEqual(atEA(ctx.EA_DANGER + 1).zone, 'low', 'between 30 and 45 ⇒ low');
  assert.strictEqual(atEA(ctx.EA_OPTIMAL + 1).zone, 'optimal', '45+ ⇒ optimal');
  // Inclusive-low boundaries: exactly 30 is no longer danger, exactly 45 is optimal.
  assert.strictEqual(atEA(ctx.EA_DANGER).zone, 'low');
  assert.strictEqual(atEA(ctx.EA_OPTIMAL).zone, 'optimal');
});

test('EA catches the RED-S danger the raw calorie floor misses', () => {
  const ctx = load(['calcEnergyAvailability'], { consts: ['EA_DANGER', 'EA_OPTIMAL'] });
  // A lean woman eating 1596 kcal — comfortably ABOVE the 1200 female floor buildGoalFromMode
  // enforces — still drops into the danger zone once a 400 kcal session is paid for. The
  // intake floor never subtracts exercise nor scales by lean mass, so only EA sees this.
  const floorFemale = 1200, intake = 1596;
  assert.ok(intake > floorFemale, 'precondition: intake clears the raw floor');

  const trained = ctx.calcEnergyAvailability(intake, 400, 60, 28);
  assert.strictEqual(trained.zone, 'danger', 'yet EA is in the danger zone');
  assert.ok(trained.ea < ctx.EA_DANGER);

  // The same intake with no training is NOT in danger — it's the training load, not the
  // intake alone, that tips her over.
  assert.notStrictEqual(ctx.calcEnergyAvailability(intake, 0, 60, 28).zone, 'danger');
});

test('calcEnergyAvailability needs a lean-mass basis to compute', () => {
  const ctx = load(['calcEnergyAvailability'], { consts: ['EA_DANGER', 'EA_OPTIMAL'] });
  assert.strictEqual(ctx.calcEnergyAvailability(1800, 300, 0, 25).status, 'insufficient', 'no weight');
  assert.strictEqual(ctx.calcEnergyAvailability(1800, 300, 60, null).status, 'insufficient', 'no %BF');
  assert.strictEqual(ctx.calcEnergyAvailability(1800, 300, 60, 2).status, 'insufficient', 'implausible %BF rejected');
});

// ── EA: typical training-day burn (for the forward-looking plan number) ─────────
test('getAvgTrainingDayCreditedBurn averages TRAINING days only, within the window, excluding today', () => {
  const ctx = load(['getAvgTrainingDayCreditedBurn'], {
    consts: ['EA_AVG_WINDOW_DAYS', 'EA_AVG_MIN_TRAIN_DAYS'],
    prelude: `
      var BURN = {};
      function creditedBurnSum(list){ return list.reduce(function(a,b){ return a + b; }, 0); }
      function workoutsForDate(ds){ return BURN[ds] ? [BURN[ds]] : []; }
      function localDateStr(){ return '2026-08-16'; }`,
  });
  const dayBefore = (n) => {
    const d = new Date('2026-08-16T12:00:00'); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  // Four training days at 400 kcal; the other days are rest days (no entry at all).
  [1, 3, 5, 7].forEach((n) => { ctx.BURN[dayBefore(n)] = 400; });
  const r = ctx.getAvgTrainingDayCreditedBurn('2026-08-16');
  assert.ok(r, 'enough training days ⇒ returns a result');
  assert.strictEqual(r.days, 4, 'counts training days only, not calendar days');
  assert.ok(Math.abs(r.burn - 400) < 1e-9, 'averages over training days (rest days must not drag it to ~114)');

  // Today is what we plan FOR, so it is excluded from its own average.
  ctx.BURN['2026-08-16'] = 9999;
  assert.ok(Math.abs(ctx.getAvgTrainingDayCreditedBurn('2026-08-16').burn - 400) < 1e-9, "today's own session is not counted");
});

test('getAvgTrainingDayCreditedBurn needs a minimum sample and respects the window', () => {
  const ctx = load(['getAvgTrainingDayCreditedBurn'], {
    consts: ['EA_AVG_WINDOW_DAYS', 'EA_AVG_MIN_TRAIN_DAYS'],
    prelude: `
      var BURN = {};
      function creditedBurnSum(list){ return list.reduce(function(a,b){ return a + b; }, 0); }
      function workoutsForDate(ds){ return BURN[ds] ? [BURN[ds]] : []; }
      function localDateStr(){ return '2026-08-16'; }`,
  });
  const dayBefore = (n) => {
    const d = new Date('2026-08-16T12:00:00'); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  ctx.BURN[dayBefore(2)] = 300; ctx.BURN[dayBefore(4)] = 300; // only 2 < min 3
  assert.strictEqual(ctx.getAvgTrainingDayCreditedBurn('2026-08-16'), null, 'below the minimum ⇒ null (fall back to same-day logic)');

  ctx.BURN[dayBefore(6)] = 300; // now 3 within window
  assert.ok(ctx.getAvgTrainingDayCreditedBurn('2026-08-16'), 'exactly the minimum ⇒ result');

  // A session older than the window does not rescue the count.
  delete ctx.BURN[dayBefore(6)];
  ctx.BURN[dayBefore(40)] = 300; // outside the 28-day window
  assert.strictEqual(ctx.getAvgTrainingDayCreditedBurn('2026-08-16'), null, 'outside the window is not counted');
});

// ── EA: training-day plan detection & day-specific expected burn ─────────────────
test('isTrainingDayByPlan is true only for a planned training weekday', () => {
  const ctx = load(['isTrainingDayByPlan'], {
    prelude: `
      var PLAN = null;
      var PLAN_DAY_NAMES = ['วันอาทิตย์','วันจันทร์','วันอังคาร','วันพุธ','วันพฤหัสบดี','วันศุกร์','วันเสาร์'];
      function getSavedPlanObj(){ return PLAN; }
      function appTodayWeekday(){ return 1; }`, // Monday
  });
  // No plan → false. This is the whole point of the stricter check: without a plan we must
  // NOT treat "not a rest day" as a training day, or the bump would fire every day.
  assert.strictEqual(ctx.isTrainingDayByPlan(), false, 'no plan ⇒ false');

  ctx.PLAN = { days: [{ day: 'วันจันทร์', exercises: [{}], theme: 'Upper' }] };
  assert.strictEqual(ctx.isTrainingDayByPlan(), true, 'weekday has exercises ⇒ training day');

  ctx.PLAN = { days: [{ day: 'วันจันทร์', exercises: [{}], theme: 'วันพัก' }] };
  assert.strictEqual(ctx.isTrainingDayByPlan(), false, 'rest theme ⇒ not a training day');

  ctx.PLAN = { days: [{ day: 'วันจันทร์', exercises: [], theme: 'Upper' }] };
  assert.strictEqual(ctx.isTrainingDayByPlan(), false, 'no exercises ⇒ not a training day');
});

test('getExpectedTrainingBurnForDay prefers the same weekday, then falls back to overall', () => {
  const ctx = load(['getExpectedTrainingBurnForDay', 'getAvgTrainingDayCreditedBurn'], {
    consts: ['EA_AVG_WINDOW_DAYS', 'EA_AVG_MIN_TRAIN_DAYS', 'EA_WEEKDAY_MIN_SAMPLE'],
    prelude: `
      var BURN = {};
      function creditedBurnSum(list){ return list.reduce(function(a,b){ return a + b; }, 0); }
      function workoutsForDate(ds){ return BURN[ds] ? [BURN[ds]] : []; }
      function localDateStr(){ return '2026-08-16'; }`,
  });
  const before = (n) => {
    const d = new Date('2026-08-16T12:00:00'); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  // 7 and 14 days back are the SAME weekday as the reference date.
  ctx.BURN[before(7)] = 500;
  ctx.BURN[before(14)] = 300;
  ctx.BURN[before(1)] = 999; // different weekday
  ctx.BURN[before(3)] = 999; // different weekday
  let r = ctx.getExpectedTrainingBurnForDay('2026-08-16');
  assert.strictEqual(r.basis, 'weekday', 'enough same-weekday sessions ⇒ weekday basis');
  assert.strictEqual(r.days, 2);
  assert.ok(Math.abs(r.burn - 400) < 1e-9, 'weekday average uses only the same-weekday sessions');

  // Drop to a single same-weekday session → below EA_WEEKDAY_MIN_SAMPLE → fall back to the
  // overall training-day average (which now has 3 training days: 7, 1, 3 days back).
  delete ctx.BURN[before(14)];
  r = ctx.getExpectedTrainingBurnForDay('2026-08-16');
  assert.strictEqual(r.basis, 'overall', 'too few same-weekday sessions ⇒ overall basis');
  assert.ok(Math.abs(r.burn - (500 + 999 + 999) / 3) < 1e-9);
});

// ── EA: training-day calorie floor (the goal-engine adjustment) ──────────────────
function loadEAAdj() {
  return load(['getEATrainingDayAdjGoal'], {
    consts: ['EA_ADJ_TRIGGER', 'EA_ADJ_TARGET', 'EA_ADJ_MIN_KCAL'],
    prelude: `
      var MOCK = { train:true, weight:65, bf:20, expected:{burn:400,basis:'weekday'}, tdee:2200 };
      var S = { profile:{}, goals:{ cal:1600, pro:140, crb:161, fat:44 } };
      function isTrainingDayByPlan(){ return MOCK.train; }
      function getLatestCheckinWeight(){ return MOCK.weight; }
      function getCurrentBodyFatPct(){ return MOCK.bf; }
      function getExpectedTrainingBurnForDay(){ return MOCK.expected; }
      function creditedBurnSum(){ return 0; }
      function workoutsForDate(){ return []; }
      function getGoalForDate(){ return S.goals; }
      function safeJSON(k,d){ return d; }
      function readAnalyzerContext(){ return null; }
      function calcFormulaTDEE(){ return MOCK.tdee; }
      function localDateStr(){ return '2026-08-16'; }`,
  });
}

test('EA training-day bump clears the floor with a margin and keeps macros reconciled', () => {
  const ctx = loadEAAdj();
  // LBM = 65 × 0.8 = 52. eaBefore = (1600 − 400)/52 = 23.1 < 30 → must bump.
  const g = ctx.getEATrainingDayAdjGoal();
  assert.ok(g, 'a deep-deficit training day is adjusted');
  assert.strictEqual(g._dayType, 'training_ea');
  // Lands just ABOVE 30 (target 31) so carb-gram rounding can't leave it re-flagged as
  // danger — but still well inside the amber band, not over-fed.
  assert.ok(g._eaAfter >= 30, `EA must clear the RED-S floor, got ${g._eaAfter.toFixed(2)}`);
  assert.ok(g._eaAfter < 32, `EA stays a small margin above the floor, got ${g._eaAfter.toFixed(2)}`);
  assert.strictEqual(g.pro, 140, 'protein unchanged');
  assert.strictEqual(g.fat, 44, 'fat unchanged');
  assert.ok(g.crb > 161, 'the raise is funded with carbs');
  // Macros must still reconcile to the shown calories (CLAUDE.md invariant).
  assert.ok(Math.abs((g.pro * 4 + g.crb * 4 + g.fat * 9) - g.cal) <= g.cal * 0.1, 'P×4+C×4+F×9 ≈ kcal');
});

test('EA training-day bump leaves an already-safe day on the full deficit', () => {
  const ctx = loadEAAdj();
  ctx.S.goals = { cal: 2000, pro: 140, crb: 261, fat: 44 }; // eaBefore = (2000−400)/52 = 30.8 ≥ 30
  assert.strictEqual(ctx.getEATrainingDayAdjGoal(), null, 'no bump when EA is already ≥ 30');
});

test('EA training-day bump only fires on a planned training day with a lean-mass basis', () => {
  const ctx = loadEAAdj();
  ctx.MOCK.train = false;
  assert.strictEqual(ctx.getEATrainingDayAdjGoal(), null, 'rest day / no plan ⇒ null');
  ctx.MOCK.train = true;
  ctx.MOCK.bf = null;
  assert.strictEqual(ctx.getEATrainingDayAdjGoal(), null, 'no %BF ⇒ null');
});

test('EA training-day bump never pushes a cutting day into surplus (caps at maintenance)', () => {
  const ctx = loadEAAdj();
  ctx.MOCK.weight = 75; ctx.MOCK.bf = 20;              // LBM = 60
  ctx.MOCK.expected = { burn: 600, basis: 'weekday' };
  ctx.MOCK.tdee = 1900;
  ctx.S.goals = { cal: 1400, pro: 150, crb: 111, fat: 44 }; // eaBefore = (1400−600)/60 = 13.3
  const g = ctx.getEATrainingDayAdjGoal();
  assert.ok(g, 'still adjusts');
  assert.ok(g.cal <= 1900 + 4, 'capped at maintenance TDEE, not the full EA-30 requirement');
  assert.ok(g._eaAfter < 30, 'when the base deficit is too deep the cap leaves EA below floor (a real signal, not a surplus)');
});

// ── EA: feasibility guard (training-day EA at the prescribed deficit) ────────────
test('calcTargetFeasibility flags a deficit that starves training days (low EA)', () => {
  const ctx = load(['calcTargetFeasibility', 'elapsedDaysSince', 'calcBMRFromProfile', 'getActivityMultiplier', 'calcFormulaTDEE'], {
    prelude: `
      var MOCK = { weight: 75, expected: { burn: 700, basis: 'overall' } };
      var S = { goals: { cal: 2000 } };
      function getLatestCheckinWeight(){ return MOCK.weight; }
      function profileSafe(){ return {}; }
      function localDateStr(){ return '2026-07-25'; }
      function readAnalyzerContext(){ return null; }
      function getExpectedTrainingBurnForDay(){ return MOCK.expected; }`,
  });
  const profile = { gender: 'male', weight: 75, age: 30, height: 175, activity: 1.55 };
  const target = { currBF: 22, bf: 18, weight: 72, duration: 12 };

  // ~700 kcal typical session against a ~2300 intake and 58.5 kg FFM → EA < 30.
  const low = ctx.calcTargetFeasibility(target, profile);
  assert.strictEqual(low.eaExpectedBurn, 700, 'reports the burn it subtracted');
  assert.ok(low.eaLow, 'training-day EA below 30 is flagged');
  assert.ok(low.eaTrainingDay < low.eaRestDay, 'training day EA is lower than the rest-day figure');

  // A lighter typical session clears the floor → not flagged.
  ctx.MOCK.expected = { burn: 300, basis: 'overall' };
  const ok = ctx.calcTargetFeasibility(target, profile);
  assert.ok(!ok.eaLow, 'a lighter training load is not flagged');
  assert.ok(ok.eaTrainingDay != null, 'EA is still reported when history exists');

  // No training history → the guard stays silent instead of guessing.
  ctx.MOCK.expected = null;
  const noHist = ctx.calcTargetFeasibility(target, profile);
  assert.strictEqual(noHist.eaTrainingDay, null, 'no history ⇒ no EA verdict');
  assert.strictEqual(noHist.eaLow, false);
});

// ── Diet Break (planned maintenance phase) ──────────────────────────────────────
function loadDietBreak() {
  return load(['getActiveDietBreak', 'getDietBreakAdjGoal'], {
    prelude: `
      var MOCK = { db:null, tdee:2350 };
      var S = { profile:{ goalType:'fat_loss' }, goals:{ cal:1600, pro:140, crb:161, fat:44 } };
      function safeJSON(k, d){ return k === 'gd_diet_break' ? MOCK.db : d; }
      function localDateStr(){ return '2026-08-16'; }
      function getGoalForDate(){ return S.goals; }
      function readAnalyzerContext(){ return null; }
      function calcFormulaTDEE(){ return MOCK.tdee; }`,
  });
}

test('getActiveDietBreak is windowed by date and reports the day number', () => {
  const ctx = loadDietBreak();
  ctx.MOCK.db = { active: true, startDate: '2026-08-10', days: 14 }; // window [08-10, 08-24)

  const a = ctx.getActiveDietBreak(); // today = 2026-08-16
  assert.ok(a, 'inside the window ⇒ active');
  assert.strictEqual(a.totalDays, 14);
  assert.strictEqual(a.dayNum, 7, '08-10 is day 1, so 08-16 is day 7');
  assert.strictEqual(a.endStr, '2026-08-24');

  assert.strictEqual(ctx.getActiveDietBreak('2026-08-24'), null, 'the end date is exclusive (break over)');
  assert.strictEqual(ctx.getActiveDietBreak('2026-08-09'), null, 'before the start ⇒ inactive');

  ctx.MOCK.db = { active: false, startDate: '2026-08-10', days: 14 };
  assert.strictEqual(ctx.getActiveDietBreak(), null, 'cancelled break ⇒ inactive');
});

test('getDietBreakAdjGoal lifts intake to maintenance, keeping protein and reconciling macros', () => {
  const ctx = loadDietBreak();
  ctx.MOCK.db = { active: true, startDate: '2026-08-10', days: 14 };

  const g = ctx.getDietBreakAdjGoal();
  assert.ok(g, 'active break ⇒ adjusted goal');
  assert.strictEqual(g._dayType, 'diet_break');
  assert.ok(Math.abs(g.cal - 2350) <= 4, `calories lifted to ~maintenance TDEE, got ${g.cal}`);
  assert.ok(g.cal > 1600, 'deficit removed (above the base cutting goal)');
  assert.strictEqual(g.pro, 140, 'protein held (muscle protection)');
  assert.strictEqual(g.fat, 44, 'fat held; the surplus goes to carbs');
  assert.ok(g.crb > 161, 'extra energy funded with carbs');
  assert.ok(Math.abs((g.pro * 4 + g.crb * 4 + g.fat * 9) - g.cal) <= 4, 'macros reconcile to calories');
});

test('getDietBreakAdjGoal is null when inactive or already at/above maintenance', () => {
  const ctx = loadDietBreak();
  assert.strictEqual(ctx.getDietBreakAdjGoal(), null, 'no break record ⇒ null');

  ctx.MOCK.db = { active: true, startDate: '2026-08-10', days: 14 };
  ctx.MOCK.tdee = 1500; // below the base goal — nothing to raise
  assert.strictEqual(ctx.getDietBreakAdjGoal(), null, 'TDEE ≤ base goal ⇒ no-op');
});

// ── Diet Break auto-suggestion (Phase 2) ────────────────────────────────────────
function loadDBSuggest() {
  return load(['evaluateDietBreakSuggestion', '_daysBetweenStr'], {
    consts: ['DIET_BREAK_SUGGEST_LOSS_PCT', 'DIET_BREAK_SUGGEST_WEEKS', 'DIET_BREAK_STALL_MIN_WEEKS'],
    prelude: `
      var MOCK = { db:null, target:null, weight:[], wa:null };
      var window = { get _wtAnalysisData(){ return MOCK.wa; } };
      var S = { profile:{ goalType:'fat_loss' } };
      function safeJSON(k, d){ if (k === 'gd_diet_break') return MOCK.db; if (k === 'gd_ft_target') return MOCK.target; if (k === 'gd_weight') return MOCK.weight; return d; }
      function localDateStr(){ return '2026-08-16'; }
      function normalizeGoalMode(m){ return m; }
      function getActiveDietBreak(){ return MOCK.db && MOCK.db.active ? { dayNum:1 } : null; }`,
  });
}

test('diet-break suggestion fires on ≥5% cumulative loss', () => {
  const ctx = loadDBSuggest();
  ctx.MOCK.target = { startDate: '2026-07-20' };
  // 70 → 66 kg = 5.7% lost.
  ctx.MOCK.weight = [
    { date: '2026-07-20', weight: 70 },
    { date: '2026-08-16', weight: 66 },
  ];
  const s = ctx.evaluateDietBreakSuggestion();
  assert.ok(s, 'suggestion returned');
  assert.ok(s.reasons.some((r) => r.key === 'loss'), 'flags the cumulative loss');
  assert.ok(s.lossPct >= 5);
});

test('diet-break suggestion fires after a long continuous deficit', () => {
  const ctx = loadDBSuggest();
  ctx.MOCK.target = { startDate: '2026-05-01' }; // ~15 weeks before 08-16
  ctx.MOCK.weight = [
    { date: '2026-05-01', weight: 70 },
    { date: '2026-08-16', weight: 68.5 }, // only ~2% lost — time is the trigger, not loss
  ];
  const s = ctx.evaluateDietBreakSuggestion();
  assert.ok(s, 'suggestion returned');
  assert.ok(s.reasons.some((r) => r.key === 'time'), 'flags the long stint');
  assert.ok(!s.reasons.some((r) => r.key === 'loss'), 'loss alone did not trip it');
});

test('diet-break suggestion stays quiet early, on maintenance mode, and during a break', () => {
  const ctx = loadDBSuggest();
  // Recent, small loss, short stint → nothing to suggest.
  ctx.MOCK.target = { startDate: '2026-08-02' }; // 2 weeks
  ctx.MOCK.weight = [
    { date: '2026-08-02', weight: 70 },
    { date: '2026-08-16', weight: 69.3 }, // 1% in 2 weeks
  ];
  assert.strictEqual(ctx.evaluateDietBreakSuggestion(), null, 'too early / too little ⇒ no nag');

  // Not a cutting goal → never suggested.
  ctx.MOCK.target = { startDate: '2026-05-01' };
  ctx.MOCK.weight = [{ date: '2026-05-01', weight: 70 }, { date: '2026-08-16', weight: 66 }];
  ctx.S.profile.goalType = 'maintain';
  assert.strictEqual(ctx.evaluateDietBreakSuggestion(), null, 'maintenance goal ⇒ no suggestion');

  // Already on a break → not suggested.
  ctx.S.profile.goalType = 'fat_loss';
  ctx.MOCK.db = { active: true, startDate: '2026-08-14', days: 14 };
  assert.strictEqual(ctx.evaluateDietBreakSuggestion(), null, 'already resting ⇒ no suggestion');
});

test('diet-break anchor resets after a finished break (no immediate re-nag)', () => {
  const ctx = loadDBSuggest();
  ctx.MOCK.target = { startDate: '2026-05-01' };
  // A break ran 07-25 → 08-08; the fresh cut since then is short and small.
  ctx.MOCK.db = { active: false, startDate: '2026-07-25', days: 14 }; // ends 2026-08-08
  ctx.MOCK.weight = [
    { date: '2026-05-01', weight: 72 },
    { date: '2026-08-08', weight: 68 }, // most loss happened BEFORE the break
    { date: '2026-08-16', weight: 67.8 }, // since the break: ~0.3% over ~1 week
  ];
  assert.strictEqual(ctx.evaluateDietBreakSuggestion(), null, 'clock restarts at the break end, so no instant re-suggestion');
});

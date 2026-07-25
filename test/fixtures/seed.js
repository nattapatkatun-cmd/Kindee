'use strict';
// A realistic account: three weeks of logs for a 76 kg male on a fat-loss program,
// mid-way through a 12-week Fitness Target, with body-comp readings from two different
// devices (InBody and a BIA scale) so source-mixing bugs have something to bite on.
//
// Dates are relative to "today" so the fixture never expires. The app's own day boundary
// is 04:00 local (localDateStr), which is why dates are built from local components
// rather than toISOString().

function dateBack(days) {
  const x = new Date();
  x.setDate(x.getDate() - days);
  return (
    x.getFullYear() +
    '-' +
    String(x.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(x.getDate()).padStart(2, '0')
  );
}

function buildSeed() {
  const weights = [];
  const meals = [];
  const workouts = [];
  const steps = {};
  const water = {};
  const sleepLog = [];

  for (let i = 20; i >= 0; i--) {
    const date = dateBack(i);
    // Steady ~0.08 kg/day downward drift → about -0.55 kg/week, a clean "losing" trend.
    weights.push({
      id: 1000 + i, date, time: '07:30',
      weight: +(78 - (20 - i) * 0.08).toFixed(1),
      waist: +(84 - (20 - i) * 0.05).toFixed(2), note: '',
    });
    steps[date] = 9000 + (i % 5) * 700;
    water[date] = 2000;
    sleepLog.push({
      date, hours: +(7.1 + (i % 3) * 0.3).toFixed(2), timeInBed: 7.8,
      deepSleep: 62, remSleep: 95, rhr: 56, hrv: 61, hrvBaseline: 60,
      bedtime: '23:40', wakeTime: '06:50', consistency: 75,
      sleepScore: 74, displayStr: '7h 6min',
    });
    ['มื้อเช้า', 'มื้อกลางวัน', 'มื้อเย็น'].forEach((label, k) => {
      // 620 kcal with P42/C60/F18 = 630 kcal by 4-4-9: inside the 10% tolerance, so the
      // fixture is internally consistent and won't trip reconcileMealMacros on load.
      meals.push({
        id: 5000 + i * 10 + k, date, time: '08:00', label,
        foodName: 'อาหาร ' + label, description: '',
        calories: 620, protein: 42, carbs: 60, fat: 18,
        sodiumFlag: 'medium', carbLoadFlag: 'normal', mealContext: 'normal',
        retentionRisk: 30, analysisConfidence: 80, items: [],
      });
    });
    if (i % 2 === 0) {
      workouts.push({
        id: 7000 + i, date, type: 'Strength', duration_min: 45,
        calories_burned: 400, cal_source: 'met', session_steps: 0,
        exercises: [{ name: 'Bench' }],
      });
    }
  }

  return {
    gd_profile: {
      age: 34, weight: 76.4, height: 176, gender: 'male', activity: 1.55,
      goalType: 'fat_loss', trainingFocus: 'hybrid', recoveryPriority: 'normal', weeklyFrequency: '4',
    },
    gd_goals: { cal: 1800, pro: 150, crb: 180, fat: 62 },
    gd_weight: weights,
    gd_meals: meals,
    gd_workouts: workouts,
    gd_steps: steps,
    gd_water_log: water,
    gd_sleep_log: sleepLog,
    gd_sleep: sleepLog[sleepLog.length - 1],
    gd_ft_target: {
      weight: 72, bf: 15, currBF: 21.5, currMuscle: 34, currVisceral: 8,
      muscle: 36, visceral: 6, duration: 12, startDate: dateBack(45),
      startBF: 23, startWeight: 79, startMuscle: 33,
    },
    // Deliberately mixed sources: the BIA row reads ~3 points lower than InBody on the
    // same body. Regressing across both would manufacture a %BF trend that isn't there.
    gd_body_comp_logs: [
      { id: 1, date: dateBack(45), source: 'inbody', weight: 79, bf: 23, smmPct: 33, visceral: 9 },
      { id: 2, date: dateBack(20), source: 'eufy', weight: 77.5, bf: 19.4, smmPct: 34, visceral: 8 },
      { id: 3, date: dateBack(5), source: 'inbody', weight: 76.6, bf: 21.5, smmPct: 34, visceral: 8 },
    ],
    gd_favorites: [{
      id: 9, savedAt: new Date().toISOString(), foodName: 'อกไก่ย่าง 150g', description: '',
      calories: 248, protein: 46, carbs: 0, fat: 5,
      sodiumFlag: 'low', carbLoadFlag: 'low', mealContext: 'normal',
      retentionRisk: 5, analysisConfidence: 90, items: [],
    }],
    // Skip the onboarding gate so tests land straight on the dashboard.
    gd_onboarded_v3: '1',
    gd_onboarded: '1',
  };
}

module.exports = { buildSeed, dateBack };

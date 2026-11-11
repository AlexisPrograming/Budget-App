import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// smart-plan-calc.js is a classic browser script; load it in an isolated context.
const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { self: {} };
vm.runInNewContext(readFileSync(join(here, '..', 'smart-plan-calc.js'), 'utf8'), sandbox);
const C = sandbox.self.SmartPlanCalc;
const plain = o => JSON.parse(JSON.stringify(o));   // objects from the isolated context have another prototype

test('module loads and exposes the API', () => {
  assert.ok(C);
  for (const fn of ['monthlyFromPay', 'buildPlan', 'validateInput', 'spendStatus', 'startOfWeek'])
    assert.equal(typeof C[fn], 'function');
});

test('monthlyFromPay normalizes every frequency', () => {
  assert.equal(C.monthlyFromPay(500, 'weekly'), 2166.67);        // 500 * 52 / 12
  assert.equal(C.monthlyFromPay(1000, 'biweekly'), 2166.67);     // 1000 * 26 / 12
  assert.equal(C.monthlyFromPay(1000, 'semimonthly'), 2000);     // x 2
  assert.equal(C.monthlyFromPay(3000, 'monthly'), 3000);         // x 1
  assert.equal(C.monthlyFromPay(999, 'irregular', 2500), 2500);  // uses the estimate, ignores the pay
});

test('monthlyFromPay handles invalid input as 0', () => {
  assert.equal(C.monthlyFromPay(0, 'monthly'), 0);
  assert.equal(C.monthlyFromPay(-50, 'weekly'), 0);
  assert.equal(C.monthlyFromPay('abc', 'monthly'), 0);
  assert.equal(C.monthlyFromPay(1000, 'yearly'), 0);
  assert.equal(C.monthlyFromPay(1000, 'irregular', 0), 0);
  assert.equal(C.monthlyFromPay(1000, 'irregular'), 0);
  assert.equal(C.monthlyFromPay(NaN, 'monthly'), 0);
});

test('50/30/20 split', () => {
  assert.deepEqual(plain(C.splitFiftyThirtyTwenty(3000)), { needs: 1500, wants: 900, savings: 600 });
  assert.deepEqual(plain(C.splitFiftyThirtyTwenty(0)), { needs: 0, wants: 0, savings: 0 });
  assert.deepEqual(plain(C.splitFiftyThirtyTwenty(-10)), { needs: 0, wants: 0, savings: 0 });
});

test('buildPlan: healthy plan', () => {
  const p = C.buildPlan({ monthlyIncome: 3000, fixedTotal: 1200, savingsPercent: 20, daysInMonth: 30 });
  assert.equal(p.status, 'ok');
  assert.equal(p.savingsMonthly, 600);
  assert.equal(p.flexibleMonthly, 1200);
  assert.equal(p.flexibleDaily, 40);
  assert.equal(p.flexibleWeekly, 276.92);   // 1200 * 12 / 52
  assert.equal(p.fixedPercent, 40);
});

test('buildPlan: fixed expenses over 50% of income', () => {
  const p = C.buildPlan({ monthlyIncome: 2000, fixedTotal: 1400, savingsPercent: 5, daysInMonth: 30 });
  assert.equal(p.status, 'fixed_over_50');
  assert.equal(p.flexibleMonthly, 500);
  assert.equal(p.fixedPercent, 70);
});

test('buildPlan: fixed + savings above income is overcommitted and spends nothing', () => {
  const p = C.buildPlan({ monthlyIncome: 2000, fixedTotal: 1900, savingsPercent: 20, daysInMonth: 30 });
  assert.equal(p.status, 'overcommitted');
  assert.equal(p.flexibleMonthly, -300);
  assert.equal(p.flexibleDaily, 0);
  assert.equal(p.flexibleWeekly, 0);
});

test('buildPlan: fixed exactly equal to income with no savings is not overcommitted', () => {
  const p = C.buildPlan({ monthlyIncome: 2000, fixedTotal: 2000, savingsPercent: 0, daysInMonth: 30 });
  assert.equal(p.flexibleMonthly, 0);
  assert.equal(p.status, 'fixed_over_50');
});

test('buildPlan: fixed bigger than income', () => {
  const p = C.buildPlan({ monthlyIncome: 1000, fixedTotal: 1500, savingsPercent: 0, daysInMonth: 31 });
  assert.equal(p.status, 'overcommitted');
  assert.equal(p.flexibleMonthly, -500);
  assert.equal(p.flexibleDaily, 0);
});

test('buildPlan: no income and bad inputs', () => {
  assert.equal(C.buildPlan({ monthlyIncome: 0, fixedTotal: 100, savingsPercent: 20, daysInMonth: 30 }).status, 'no_income');
  const p = C.buildPlan({ monthlyIncome: 1000, fixedTotal: 0, savingsPercent: 500, daysInMonth: 0 });
  assert.equal(p.savingsPercent, 100);       // clamped
  assert.equal(p.daysInMonth, 30);           // invalid days fall back to 30
  assert.equal(C.buildPlan({ monthlyIncome: 3000, fixedTotal: 0, savingsPercent: 0, daysInMonth: -5 }).flexibleDaily, 100);   // never divide by a negative
  assert.equal(C.buildPlan({ monthlyIncome: 'x', fixedTotal: null, savingsPercent: undefined, daysInMonth: 30 }).status, 'no_income');
});

test('buildPlan: daily budget follows the real number of days in the month', () => {
  const feb = C.buildPlan({ monthlyIncome: 2800, fixedTotal: 0, savingsPercent: 0, daysInMonth: 28 });
  const jan = C.buildPlan({ monthlyIncome: 3100, fixedTotal: 0, savingsPercent: 0, daysInMonth: 31 });
  assert.equal(feb.flexibleDaily, 100);
  assert.equal(jan.flexibleDaily, 100);
  assert.equal(C.daysInMonthOf(2026, 1), 28);
  assert.equal(C.daysInMonthOf(2028, 1), 29);   // leap year
  assert.equal(C.daysInMonthOf(2026, 10), 30);
});

test('suggestSavingsPercent', () => {
  assert.equal(C.suggestSavingsPercent(3000, 1000), 20);   // 33% fixed -> classic 20
  assert.equal(C.suggestSavingsPercent(3000, 1500), 20);   // exactly 50% -> still 20
  assert.equal(C.suggestSavingsPercent(2000, 1400), 7);    // 70% fixed -> 30% left -> 7
  assert.equal(C.suggestSavingsPercent(2000, 1900), 1);    // 95% fixed -> 5% left -> 1
  assert.equal(C.suggestSavingsPercent(2000, 2000), 0);
  assert.equal(C.suggestSavingsPercent(2000, 3000), 0);
  assert.equal(C.suggestSavingsPercent(0, 100), 0);
});

test('maxSavingsPercent never lets the plan go negative', () => {
  assert.equal(C.maxSavingsPercent(2000, 1400), 30);
  assert.equal(C.maxSavingsPercent(2000, 2000), 0);
  assert.equal(C.maxSavingsPercent(2000, 5000), 0);
  assert.equal(C.maxSavingsPercent(0, 0), 0);
  assert.equal(C.maxSavingsPercent(1000, 0), 100);
  const max = C.maxSavingsPercent(2000, 1400);
  assert.notEqual(C.buildPlan({ monthlyIncome: 2000, fixedTotal: 1400, savingsPercent: max, daysInMonth: 30 }).status, 'overcommitted');
  assert.equal(C.buildPlan({ monthlyIncome: 2000, fixedTotal: 1400, savingsPercent: max + 1, daysInMonth: 30 }).status, 'overcommitted');
});

test('validateInput', () => {
  const ok = { payAmount: 1000, frequency: 'biweekly', savingsPercent: 20, basis: 'net' };
  assert.equal(C.validateInput(ok).ok, true);
  assert.ok(C.validateInput({ ...ok, payAmount: 0 }).errors.payAmount);
  assert.ok(C.validateInput({ ...ok, payAmount: -5 }).errors.payAmount);
  assert.ok(C.validateInput({ ...ok, payAmount: NaN }).errors.payAmount);
  assert.ok(C.validateInput({ ...ok, payAmount: 1e9 }).errors.payAmount);
  assert.ok(C.validateInput({ ...ok, frequency: 'daily' }).errors.frequency);
  assert.ok(C.validateInput({ ...ok, savingsPercent: -1 }).errors.savingsPercent);
  assert.ok(C.validateInput({ ...ok, savingsPercent: 101 }).errors.savingsPercent);
  assert.equal(C.validateInput({ ...ok, savingsPercent: 0 }).ok, true);
  assert.equal(C.validateInput({ ...ok, savingsPercent: 100 }).ok, true);
  assert.ok(C.validateInput({ ...ok, basis: 'maybe' }).errors.basis);
  // irregular needs the monthly average
  assert.ok(C.validateInput({ ...ok, frequency: 'irregular' }).errors.irregularMonthly);
  assert.equal(C.validateInput({ ...ok, frequency: 'irregular', irregularMonthly: 1800 }).ok, true);
  assert.equal(C.validateInput(null).ok, false);
});

test('spendStatus thresholds', () => {
  assert.equal(C.spendStatus(0, 40), 'green');
  assert.equal(C.spendStatus(29.99, 40), 'green');
  assert.equal(C.spendStatus(30, 40), 'amber');   // exactly 75%
  assert.equal(C.spendStatus(40, 40), 'amber');   // exactly 100%
  assert.equal(C.spendStatus(40.01, 40), 'red');
  assert.equal(C.spendStatus(0, 0), 'green');
  assert.equal(C.spendStatus(5, 0), 'red');
});

test('startOfWeek is the Monday of the week, across month and year boundaries', () => {
  assert.equal(C.startOfWeek('2026-11-11'), '2026-11-09');   // Wednesday
  assert.equal(C.startOfWeek('2026-11-09'), '2026-11-09');   // Monday itself
  assert.equal(C.startOfWeek('2026-11-15'), '2026-11-09');   // Sunday belongs to the week that started Monday
  assert.equal(C.startOfWeek('2026-12-02'), '2026-11-30');   // crosses into the previous month
  assert.equal(C.startOfWeek('2027-01-01'), '2026-12-28');   // crosses into the previous year
  assert.equal(C.startOfWeek('2026-11-15', 0), '2026-11-15'); // weeks that start on Sunday
});

test('sumBetween and sumAmounts', () => {
  const ex = [
    { date: '2026-11-08', amount: 10 }, { date: '2026-11-09', amount: 5.5 },
    { date: '2026-11-11', amount: 4.25 }, { date: '2026-11-16', amount: 99 },
  ];
  assert.equal(C.sumBetween(ex, '2026-11-09', '2026-11-15'), 9.75);
  assert.equal(C.sumBetween(ex, '2026-11-09', '2026-11-09'), 5.5);
  assert.equal(C.sumBetween([], '2026-11-01', '2026-11-30'), 0);
  assert.equal(C.sumBetween(null, 'a', 'b'), 0);
  assert.equal(C.sumAmounts([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);   // no floating-point drift
  assert.equal(C.sumAmounts(null), 0);
  assert.equal(C.sumAmounts([{ amount: 'x' }, {}]), 0);
});

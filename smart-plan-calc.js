// Smart Spending Plan — pure calculations (no DOM, no storage).
// Works as a classic <script> (exposes window.SmartPlanCalc) and can be loaded in Node for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmartPlanCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'irregular'];
  const AMT_MAX = 9999999.99;

  const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const isMoney = n => typeof n === 'number' && Number.isFinite(n);
  const sumAmounts = list => round2((list || []).reduce((s, x) => s + (Number(x && x.amount) || 0), 0));

  // Pay actually received per period: gross pay minus an estimated tax percent, or the net amount as is.
  function netPay(amount, basis, taxPercent) {
    const a = Number(amount);
    if (!isMoney(a) || a <= 0) return 0;
    if (basis !== 'gross') return round2(a);
    const t = Math.min(90, Math.max(0, Number(taxPercent) || 0));
    return round2(a * (1 - t / 100));
  }

  // Pay per period -> normalized monthly income.
  function monthlyFromPay(amount, frequency, irregularMonthly) {
    const a = Number(amount);
    if (frequency === 'irregular') {
      const m = Number(irregularMonthly);
      return isMoney(m) && m > 0 ? round2(m) : 0;
    }
    if (!isMoney(a) || a <= 0) return 0;
    switch (frequency) {
      case 'weekly': return round2(a * 52 / 12);
      case 'biweekly': return round2(a * 26 / 12);
      case 'semimonthly': return round2(a * 2);
      case 'monthly': return round2(a);
      default: return 0;
    }
  }

  // 50 / 30 / 20 split of a monthly income.
  function splitFiftyThirtyTwenty(monthlyIncome) {
    const i = Math.max(0, Number(monthlyIncome) || 0);
    return { needs: round2(i * 0.5), wants: round2(i * 0.3), savings: round2(i * 0.2) };
  }

  // Savings share that is still realistic when fixed expenses are already high.
  // <=50% fixed: the classic 20%. Above that: a quarter of what is left, never above 20%.
  function suggestSavingsPercent(monthlyIncome, fixedTotal) {
    const income = Number(monthlyIncome) || 0;
    if (income <= 0) return 0;
    const fixedPct = (Number(fixedTotal) || 0) / income * 100;
    if (fixedPct <= 50) return 20;
    const available = 100 - fixedPct;
    if (available <= 0) return 0;
    return Math.min(20, Math.floor(available * 0.25));
  }

  // Highest savings percent that still leaves flexible money >= 0.
  function maxSavingsPercent(monthlyIncome, fixedTotal) {
    const income = Number(monthlyIncome) || 0;
    if (income <= 0) return 0;
    const left = income - (Number(fixedTotal) || 0);
    if (left <= 0) return 0;
    return Math.max(0, Math.min(100, Math.floor(left / income * 100)));
  }

  function daysInMonthOf(year, month0) {
    return new Date(year, month0 + 1, 0).getDate();
  }

  // The plan itself.
  // status: 'no_income' | 'overcommitted' | 'fixed_over_50' | 'ok'
  function buildPlan(o) {
    const income = round2(Math.max(0, Number(o.monthlyIncome) || 0));
    const fixed = round2(Math.max(0, Number(o.fixedTotal) || 0));
    const pct = Math.min(100, Math.max(0, Number(o.savingsPercent) || 0));
    const dRaw = Math.floor(Number(o.daysInMonth));
    const days = dRaw >= 1 ? dRaw : 30;   // invalid or missing -> 30, never divide by 0 or a negative

    const savingsMonthly = round2(income * pct / 100);
    const flexibleMonthly = round2(income - fixed - savingsMonthly);
    const spendable = Math.max(0, flexibleMonthly);

    let status = 'ok';
    if (income <= 0) status = 'no_income';
    else if (flexibleMonthly < 0) status = 'overcommitted';
    else if (fixed / income > 0.5) status = 'fixed_over_50';

    return {
      status,
      monthlyIncome: income,
      fixedTotal: fixed,
      fixedPercent: income > 0 ? Math.round(fixed / income * 1000) / 10 : null,
      savingsPercent: pct,
      savingsMonthly,
      flexibleMonthly,
      flexibleWeekly: round2(spendable * 12 / 52),
      flexibleDaily: round2(spendable / days),
      daysInMonth: days,
    };
  }

  // Validation shared by the UI and the saving code. Returns { ok, errors: { field: message } }.
  function validateInput(i) {
    const errors = {};
    const amount = Number(i && i.payAmount);
    if (!(isMoney(amount) && amount > 0 && amount <= AMT_MAX)) errors.payAmount = 'Enter an amount greater than 0.';
    if (!FREQUENCIES.includes(i && i.frequency)) errors.frequency = 'Choose how often you are paid.';
    if (i && i.frequency === 'irregular') {
      const m = Number(i.irregularMonthly);
      if (!(isMoney(m) && m > 0 && m <= AMT_MAX)) errors.irregularMonthly = 'Enter your average monthly income.';
    }
    const pct = Number(i && i.savingsPercent);
    if (!(isMoney(pct) && pct >= 0 && pct <= 100)) errors.savingsPercent = 'Savings must be between 0 and 100%.';
    if (i && i.basis && !['net', 'gross'].includes(i.basis)) errors.basis = 'Choose net or gross.';
    if (i && i.basis === 'gross' && i.taxPercent !== '' && i.taxPercent != null) {
      const t = Number(i.taxPercent);
      if (!(isMoney(t) && t >= 0 && t <= 90)) errors.taxPercent = 'Taxes must be between 0 and 90%.';
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  // green: on track, amber: close to the limit (75% to 100%), red: over.
  function spendStatus(spent, budget) {
    const s = Number(spent) || 0, b = Number(budget) || 0;
    if (b <= 0) return s > 0 ? 'red' : 'green';
    const r = s / b;
    if (r < 0.75) return 'green';
    if (r <= 1) return 'amber';
    return 'red';
  }

  // Monday of the week containing a YYYY-MM-DD date (local, no timezone surprises).
  function startOfWeek(dateStr, weekStartsOn) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    const start = weekStartsOn == null ? 1 : weekStartsOn;
    dt.setDate(dt.getDate() - ((dow - start + 7) % 7));
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  // How the month is going against the plan. Savings are only at risk when spending goes above the
  // flexible budget, so the projection follows the current pace (needs a few days of data to be fair).
  //   spentVar: variable spending so far this month, dayOfMonth: 1..daysInMonth
  function monthProgress(o) {
    const days = Math.max(1, Math.floor(Number(o.daysInMonth)) || 30);
    const day = Math.min(days, Math.max(1, Math.floor(Number(o.dayOfMonth)) || 1));
    const savings = Math.max(0, Number(o.savingsMonthly) || 0);
    const flexible = Math.max(0, Number(o.flexibleMonthly) || 0);
    const spent = Math.max(0, Number(o.spentVar) || 0);
    const elapsed = day / days;
    const enoughData = day >= 3;                                     // day 1 or 2 would mislead the projection
    const projectedSpend = enoughData ? round2(spent / elapsed) : round2(Math.min(spent, flexible));
    const overspend = Math.max(0, (enoughData ? projectedSpend : spent) - flexible);
    const projectedSavings = round2(Math.max(0, savings - overspend));
    const ratio = savings > 0 ? Math.min(1, projectedSavings / savings) : 1;
    const status = ratio >= 0.999 ? 'green' : ratio >= 0.5 ? 'amber' : 'red';
    return { elapsed, enoughData, projectedSpend, projectedSavings, savingsTarget: round2(savings), ratio, status,
      expectedSpendByNow: round2(flexible * elapsed) };
  }

  // Brings the logged income entries in line with the plan's monthly income. Pure: returns new entries.
  // mode 'keep' touches nothing. mode 'match':
  //   - no entries of the user: one marked entry with the plan's income
  //   - exactly one entry of the user: that entry becomes the plan's income
  //   - several entries: only ever raised through one marked top-up; never lowered automatically
  function reconcileIncome(entries, target, mode, ctx) {
    const list = (entries || []).map(e => ({ ...e }));
    const t = round2(target);
    if (mode === 'keep' || !(t > 0)) return { entries: list, note: null, changed: false };
    const mine = list.filter(e => !e.planManaged), marked = list.find(e => e.planManaged);
    const fresh = amount => ({ id: ctx.id, date: ctx.first, source: 'Salary (plan)', amount, planManaged: true });
    let out, note = null;
    if (mine.length === 0) {
      out = [marked ? { ...marked, amount: t } : fresh(t)];
    } else if (mine.length === 1) {
      out = [{ ...mine[0], amount: t }];
    } else {
      const diff = round2(t - sumAmounts(mine));
      out = mine;
      if (diff > 0.004) out = [...mine, marked ? { ...marked, amount: diff } : fresh(diff)];
      else if (diff < -0.004) note = 'logged_income_higher';
    }
    return { entries: out, note, changed: JSON.stringify(out) !== JSON.stringify(list) };
  }

  // Sum of expense amounts with from <= date <= to (inclusive, YYYY-MM-DD strings).
  function sumBetween(expenses, from, to) {
    return round2((expenses || []).reduce((s, e) => (e.date >= from && e.date <= to ? s + (Number(e.amount) || 0) : s), 0));
  }

  return {
    FREQUENCIES, AMT_MAX, round2, sumAmounts, netPay, monthlyFromPay, splitFiftyThirtyTwenty,
    suggestSavingsPercent, maxSavingsPercent, daysInMonthOf, buildPlan, validateInput,
    spendStatus, startOfWeek, sumBetween, reconcileIncome, monthProgress,
  };
});

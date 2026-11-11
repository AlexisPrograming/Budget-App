// Smart Spending Plan — data layer (Phase 1: no screens yet).
// Reads and writes through the app's own Store, state (S) and save helpers, and adds exactly two
// storage keys: budget:plan (the plan) and budget:onboarding (progress and flags).
// Income, bills and the daily limit stay in their existing keys; nothing is copied.
const SmartPlan = (() => {
  const C = window.SmartPlanCalc;
  const KEY_PLAN = 'budget:plan', KEY_OB = 'budget:onboarding';
  const pad = n => String(n).padStart(2, '0');
  const defaults = () => ({ v: 1, completed: false, completed_at: null, skipped_at: null, step: 0, draft: null });
  const parse = (r, fallback) => { try { return r ? JSON.parse(r.value) : fallback; } catch { return fallback; } };
  const iso = () => new Date().toISOString();

  // Called from the app's load(). Never throws: a broken record just means "no plan yet".
  async function load() {
    S.plan = parse(await Store.cget(KEY_PLAN), null);
    S.onboarding = { ...defaults(), ...(parse(await Store.cget(KEY_OB), null) || {}) };
  }
  const saveOnboarding = () => Store.cset(KEY_OB, JSON.stringify(S.onboarding));

  // 'new' = never finished or skipped, 'skipped' = chose "later", 'done' = plan saved.
  function state() {
    const o = S.onboarding || defaults();
    return o.completed ? 'done' : o.skipped_at ? 'skipped' : 'new';
  }

  // Progress survives closing the app: the screens call this after every step.
  async function saveDraft(step, draft) {
    S.onboarding = { ...(S.onboarding || defaults()), step: Math.max(0, step | 0), draft: { ...((S.onboarding && S.onboarding.draft) || {}), ...draft } };
    await saveOnboarding();
  }
  async function skip() {
    S.onboarding = { ...(S.onboarding || defaults()), skipped_at: iso() };
    await saveOnboarding();
  }

  // What the user already has, so existing users only confirm instead of typing everything again.
  function prefill() {
    const bills = S.bills || [];
    const monthly = S.data ? C.sumAmounts(S.data.income) : 0;
    const fixed = C.sumAmounts(bills);
    const p = S.plan;
    return {
      hasIncome: monthly > 0, monthlyIncome: monthly,
      hasBills: bills.length > 0, fixedTotal: fixed, bills,
      dailyLimit: S.dailyLimit || 0,
      plan: p,
      input: p
        ? { payAmount: p.pay_amount, frequency: p.pay_frequency, basis: p.pay_basis, irregularMonthly: p.irregular_monthly, nextPayDate: p.next_pay_date || '', savingsPercent: p.savings_goal_percent }
        : { payAmount: monthly > 0 ? monthly : '', frequency: 'monthly', basis: 'net', irregularMonthly: '', nextPayDate: '', savingsPercent: C.suggestSavingsPercent(monthly, fixed) },
    };
  }

  // Live numbers for the summary screen, from the answers so far and the data that already exists.
  function compute(input) {
    const monthly = C.monthlyFromPay(input.payAmount, input.frequency, input.irregularMonthly);
    const fixed = C.sumAmounts(S.bills);
    const days = C.daysInMonthOf(S.data.year, S.data.month);
    return { monthly, fixed, days, plan: C.buildPlan({ monthlyIncome: monthly, fixedTotal: fixed, savingsPercent: input.savingsPercent, daysInMonth: days }) };
  }

  // Saves the plan and connects it to the existing systems. Returns { ok, errors? , plan?, incomeNote? }.
  async function apply(input) {
    const v = C.validateInput(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    if (!S.data) return { ok: false, errors: { general: 'Your data has not loaded yet. Try again in a moment.' } };

    const { monthly, fixed, plan: built } = compute(input);
    if (built.status === 'overcommitted') return { ok: false, errors: { savingsPercent: 'Fixed expenses plus savings are more than your income. Lower the savings percent.' } };

    // Income: reuse what is already logged. Never delete or reduce the user's own entries; only top up the
    // difference with one marked entry (kept by the month-close carry-over because it copies every field).
    const first = `${S.data.year}-${pad(S.data.month + 1)}-01`;
    const entries = S.data.income;
    const logged = C.sumAmounts(entries.filter(e => !e.planManaged));
    const managedIdx = entries.findIndex(e => e.planManaged);
    const diff = C.round2(monthly - logged);
    let incomeNote = null;
    if (diff > 0.004) {
      if (managedIdx >= 0) entries[managedIdx].amount = diff;
      else entries.push({ id: Date.now(), date: first, source: 'Salary (plan)', amount: diff, planManaged: true });
    } else {
      if (managedIdx >= 0) entries.splice(managedIdx, 1);
      if (diff < -0.004) incomeNote = 'logged_income_higher';
    }
    await saveData();

    // Daily limit: one number for the whole app. Only written when there is money to spend.
    if (built.flexibleDaily > 0) { S.dailyLimit = built.flexibleDaily; await saveDailyLimit(); }

    const now = iso();
    const next = /^\d{4}-\d{2}-\d{2}$/.test(input.nextPayDate || '') ? input.nextPayDate : null;
    const plan = {
      v: 1,
      savings_goal_percent: built.savingsPercent,
      plan_method: input.method || (built.savingsPercent === 20 ? '50/30/20' : 'custom'),
      pay_amount: Number(input.payAmount),
      pay_basis: input.basis || 'net',
      pay_frequency: input.frequency,
      next_pay_date: next,
      irregular_monthly: input.frequency === 'irregular' ? Number(input.irregularMonthly) : null,
      monthly_net_income_calculated: built.monthlyIncome,
      fixed_expenses_total_calculated: built.fixedTotal,
      flexible_budget_monthly: built.flexibleMonthly,
      flexible_budget_weekly: built.flexibleWeekly,
      flexible_budget_daily: built.flexibleDaily,
      created_at: (S.plan && S.plan.created_at) || now,
      updated_at: now,
    };
    S.plan = plan;
    await Store.cset(KEY_PLAN, JSON.stringify(plan));
    S.onboarding = { ...(S.onboarding || defaults()), completed: true, completed_at: (S.onboarding && S.onboarding.completed_at) || now, skipped_at: null, step: 0, draft: null };
    await saveOnboarding();
    return { ok: true, plan, incomeNote };
  }

  // ───────── Phase 2: where the user lands, skipping, resuming and editing ─────────
  // The app has no URL router, so "/onboarding" is an in-app screen (S.tab === 'onboarding') that only
  // exists after login, exactly like Home, Bills or Overview.
  (function injectStyles() {
    if (document.getElementById('smart-plan-style')) return;
    const st = document.createElement('style');
    st.id = 'smart-plan-style';
    st.textContent = `
      .ob-mode #nav,.ob-mode #sidebar{display:none!important}
      .plan-banner{display:flex;align-items:center;gap:12px;margin-bottom:8px;padding:12px 14px}
      .plan-banner .btn-icon{flex-shrink:0;padding:8px}
      .ob-wrap{max-width:460px;margin:0 auto;padding-top:calc(env(safe-area-inset-top,0px) + 8px)}
      .ob-title{font-family:var(--display);font-weight:700;font-size:24px;letter-spacing:-.02em}
      .ob-actions{display:flex;gap:10px;margin-top:18px;align-items:center}`;
    document.head.appendChild(st);
  })();

  // After login: new users go to the onboarding; everyone else lands on the dashboard as before.
  function maybeRedirect() {
    if (!S.onboarding) return false;            // the flag could not be read: never trap the user
    if (S.confirmArc) return false;              // the month-rollover prompt comes first
    if (state() === 'new') { S.tab = 'onboarding'; S.obEdit = false; return true; }
    if (S.tab === 'onboarding') S.tab = 'home';  // stale screen from a previous session or user
    return false;
  }
  function openEditor() { S.tab = 'onboarding'; S.obEdit = true; render(); }
  async function skipNow() { await skip(); S.tab = 'home'; S.obEdit = false; render(); }
  function leaveEditor() { S.tab = 'home'; S.obEdit = false; render(); }

  // Discreet card on the dashboard until the plan exists. Never blocks anything.
  function bannerHtml() {
    if (!S.onboarding || state() === 'done' || S._planBannerHidden) return '';
    return `<div class="card plan-banner" id="plan-banner">
      <div class="cat-icon" style="background:var(--amber-dim)"><i class="ti ti-sparkles" style="color:var(--amber)"></i></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600">Smart Spending Plan</div>
        <div style="font-size:12px;color:var(--t2);margin-top:2px">Know what you can spend each day while you save. Under 2 minutes.</div>
      </div>
      <button class="btn-green" id="plan-start" style="width:auto;padding:9px 16px;font-size:13px">Set up</button>
      <button class="btn-icon" id="plan-hide" aria-label="Hide for now"><i class="ti ti-x" style="font-size:14px"></i></button>
    </div>`;
  }

  // The guided steps arrive in phase 3; this is the screen they will live in.
  function renderScreen() {
    const back = !!S.obEdit;
    return `<div class="ob-wrap"><div class="card" style="padding:22px">
      <div class="ob-title">Smart Spending Plan</div>
      <div style="font-size:14px;color:var(--t2);margin-top:8px;line-height:1.5">${state() === 'done' ? 'Your plan is saved. Editing it will be available here shortly.' : 'The guided setup is almost ready. You can come back to it any time from the dashboard or the profile menu.'}</div>
      <div class="ob-actions">
        ${back ? '<button class="btn-ghost" id="ob-back" style="padding:11px 20px">Back</button>' : '<button class="btn-green" id="ob-skip" style="padding:13px">Do it later</button>'}
      </div></div></div>`;
  }

  function bind() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('plan-start', openEditor); on('menu-plan', openEditor); on('sb-plan', openEditor);
    on('plan-hide', () => { S._planBannerHidden = true; render(); });
    on('ob-skip', skipNow); on('ob-back', leaveEditor);
  }

  return { KEY_PLAN, KEY_OB, load, state, saveDraft, skip, prefill, compute, apply, maybeRedirect, openEditor, bannerHtml, renderScreen, bind };
})();

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
        ? { payAmount: p.pay_amount, frequency: p.pay_frequency, basis: p.pay_basis, taxPercent: p.pay_tax_percent == null ? '' : p.pay_tax_percent, irregularMonthly: p.irregular_monthly == null ? '' : p.irregular_monthly, nextPayDate: p.next_pay_date || '', savingsPercent: p.savings_goal_percent }
        : { payAmount: monthly > 0 ? monthly : '', frequency: 'monthly', basis: 'net', taxPercent: '', irregularMonthly: '', nextPayDate: '', savingsPercent: C.suggestSavingsPercent(monthly, fixed) },
    };
  }

  // Live numbers for the summary screen, from the answers so far and the data that already exists.
  function compute(input) {
    const monthly = C.monthlyFromPay(C.netPay(input.payAmount, input.basis, input.taxPercent), input.frequency, input.irregularMonthly);
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
      pay_tax_percent: input.basis === 'gross' ? (Number(input.taxPercent) || 0) : null,
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
    if (state() === 'new') { S.tab = 'onboarding'; S.obEdit = false; ob.active = false; return true; }
    if (S.tab === 'onboarding') S.tab = 'home';  // stale screen from a previous session or user
    return false;
  }
  function openEditor() { S.tab = 'onboarding'; S.obEdit = true; ob.active = false; render(); }
  async function skipNow() { await skip(); ob.active = false; S.tab = 'home'; S.obEdit = false; render(); }
  function leaveEditor() { ob.active = false; S.tab = 'home'; S.obEdit = false; render(); }

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

  // ───────── Phase 3: the guided steps ─────────
  // One screen per step, progress saved after every change (so closing the app resumes where you were).
  // Money inputs keep their text in state and never re-render while typing, so nothing is lost.
  const ob = { active: false, step: 0, input: {}, errors: {}, bill: null, saving: false, saved: false, formError: '', method: 'rec', focus: false };
  const STEPS = 5;
  const FREQ = [
    ['weekly', 'Every week', 'Paid weekly'],
    ['biweekly', 'Every 2 weeks', 'Paid every other week'],
    ['semimonthly', 'Twice a month', 'For example on the 15th and the 30th'],
    ['monthly', 'Once a month', 'One paycheck a month'],
    ['irregular', 'Irregular / freelance', 'Income that changes from month to month'],
  ];
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const pct1 = n => (Math.round(n * 10) / 10) + '%';
  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  (function injectFlowStyles() {
    const st = document.getElementById('smart-plan-style');
    st.textContent += `
      .ob-top{display:flex;align-items:center;gap:10px;margin-bottom:16px}
      .ob-top .btn-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
      .ob-progress{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
      .ob-progress span{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#ffb066,#e5584f);transition:width .35s ease}
      .ob-later{background:none;border:none;color:var(--t2);font-size:13px;font-weight:600;padding:8px 4px;flex-shrink:0}
      .ob-h{font-family:var(--display);font-weight:700;font-size:26px;letter-spacing:-.02em;line-height:1.15;outline:none}
      .ob-sub{font-size:14px;color:var(--t2);margin:8px 0 18px;line-height:1.5}
      .ob-lbl{display:block;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--t2);margin:16px 0 8px}
      .ob-money{position:relative}
      .ob-money>span{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-family:var(--display);font-weight:700;font-size:24px;color:var(--t2)}
      .ob-money input{width:100%;font-family:var(--display);font-weight:700;font-size:28px;padding:14px 16px 14px 38px}
      .ob-err{min-height:18px;margin-top:6px;font-size:13px;color:var(--red)}
      .ob-seg{display:flex;gap:8px}
      .ob-seg button,.ob-opt{background:rgba(255,255,255,.07);border:1px solid var(--border);color:var(--t2);border-radius:16px;font-size:14px;text-align:left}
      .ob-seg button{flex:1;padding:12px 10px;text-align:center}
      .ob-opt{display:flex;flex-direction:column;gap:2px;width:100%;padding:13px 16px;margin-bottom:8px}
      .ob-opt b{font-size:15px;color:var(--text)}
      .ob-opt small{font-size:12px;color:var(--t2)}
      .ob-seg button[aria-checked=true],.ob-opt[aria-checked=true]{background:rgba(255,176,102,.18);border:1.5px solid var(--amber);color:var(--text)}
      .ob-note{margin-top:12px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.06);font-size:13px;line-height:1.5;color:var(--t2)}
      .ob-note.warn{background:rgba(255,176,102,.12);color:var(--text)}
      .ob-note.bad{background:rgba(255,138,128,.14);color:var(--text)}
      .ob-pill{display:inline-block;margin-top:10px;padding:6px 12px;border-radius:14px;background:var(--amber-dim);color:var(--amber);font-size:13px;font-weight:600}
      .ob-bill{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
      .ob-bill:last-child{border-bottom:none}
      .ob-total{display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;font-weight:700}
      .ob-nav{display:flex;gap:10px;margin-top:20px}
      .ob-nav .btn-green{flex:1}
      .ob-nav button[disabled]{opacity:.45;cursor:not-allowed}
      .ob-center{text-align:center;padding-top:6vh}
      .ob-badge{position:relative;width:92px;height:92px;margin:0 auto 22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#ffb066,#e5584f);box-shadow:0 14px 40px rgba(229,88,79,.45);animation:popIn .55s cubic-bezier(.34,1.56,.64,1) both}
      .ob-badge i{font-size:44px;color:#2a120c}
      .ob-ring{position:absolute;inset:-10px;border-radius:50%;border:2px solid rgba(255,176,102,.55);animation:obPulse 2.2s ease-out infinite}
      @keyframes obPulse{from{transform:scale(.9);opacity:.9}to{transform:scale(1.5);opacity:0}}
      .ob-confetti{position:absolute;left:0;right:0;top:0;height:0;pointer-events:none}
      .ob-confetti i{position:absolute;top:0;left:var(--x);width:8px;height:12px;border-radius:2px;background:var(--c);opacity:0;animation:obFall 2.6s var(--d) ease-out forwards}
      @keyframes obFall{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(320px) rotate(var(--r));opacity:0}}
      .ob-hero{text-align:center;padding:6px 0 2px}
      .ob-hero .big{font-family:var(--display);font-weight:700;font-size:64px;letter-spacing:-.03em;line-height:1;color:var(--amber)}
      .ob-hero .cap{font-size:14px;color:var(--t2);margin-top:4px}
      .ob-three{display:flex;gap:8px;margin:14px 0}
      .ob-three div{flex:1;padding:12px;border-radius:16px;background:rgba(255,255,255,.07)}
      .ob-three small{display:block;font-size:11px;color:var(--t2);text-transform:uppercase;letter-spacing:.06em}
      .ob-three b{font-family:var(--display);font-size:18px}
      .ob-donut{display:flex;align-items:center;gap:16px;margin:8px 0}
      .ob-legend{flex:1;font-size:13px}
      .ob-legend div{display:flex;align-items:center;gap:8px;padding:5px 0}
      .ob-legend i{width:10px;height:10px;border-radius:3px;flex-shrink:0}
      .ob-legend span{margin-left:auto;font-weight:600}
      input[type=range].ob-range{-webkit-appearance:none;appearance:none;width:100%;height:34px;padding:0;margin:4px 0;background:transparent;border:none;box-shadow:none;cursor:pointer}
      input[type=range].ob-range:focus-visible{outline:2px solid var(--amber);outline-offset:4px;border-radius:8px}
      .ob-range::-webkit-slider-runnable-track{height:10px;border-radius:5px;background:linear-gradient(90deg,#ffb066 var(--p,0%),rgba(255,255,255,.16) var(--p,0%))}
      .ob-range::-webkit-slider-thumb{-webkit-appearance:none;width:28px;height:28px;margin-top:-9px;border-radius:50%;background:#fff3e6;border:3px solid #ffb066;box-shadow:0 4px 12px rgba(0,0,0,.45)}
      .ob-range::-moz-range-track{height:10px;border-radius:5px;background:linear-gradient(90deg,#ffb066 var(--p,0%),rgba(255,255,255,.16) var(--p,0%))}
      .ob-range::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#fff3e6;border:3px solid #ffb066}
      @media(min-width:768px) and (min-height:520px){.ob-wrap{padding-top:24px}}
      @media(prefers-reduced-motion:reduce){.ob-badge,.ob-ring,.ob-confetti i,.ob-progress span{animation:none;transition:none}.ob-confetti{display:none}}`;
  })();

  function startFlow() {
    const pre = prefill(), d = state() !== 'done' && S.onboarding && S.onboarding.draft && S.onboarding.draft.input;
    const inp = { ...pre.input, ...(d || {}) };
    for (const k of ['payAmount', 'taxPercent', 'irregularMonthly', 'savingsPercent']) inp[k] = inp[k] === '' || inp[k] == null ? '' : String(inp[k]);
    ob.input = inp; ob.errors = {}; ob.bill = null; ob.saving = false; ob.saved = false; ob.formError = '';
    const saved = S.onboarding && !S.onboarding.completed ? (S.onboarding.step | 0) : 0;
    ob.step = state() === 'done' ? 1 : Math.min(STEPS, saved);   // editing never shows the welcome again
    const sug = C.suggestSavingsPercent(pre.monthlyIncome || C.monthlyFromPay(C.netPay(num(inp.payAmount), inp.basis, inp.taxPercent), inp.frequency, inp.irregularMonthly), pre.fixedTotal);
    ob.method = inp.savingsPercent !== '' && num(inp.savingsPercent) !== sug ? 'custom' : 'rec';
    ob.active = true;
  }
  let persistTimer = 0;
  const editing = () => state() === 'done';   // an existing plan is being edited: no drafts, "Close" instead of "Later"
  const persist = () => { clearTimeout(persistTimer); if (!editing()) persistTimer = setTimeout(() => saveDraft(ob.step, { input: ob.input }), 450); };
  function goto(step) {
    ob.step = step; ob.errors = {}; ob.formError = ''; ob.bill = null; ob.focus = true;
    clearTimeout(persistTimer); if (!editing()) saveDraft(step, { input: ob.input });
    const ct = document.getElementById('content'); if (ct) ct.scrollTop = 0;
    render();
  }

  // The live numbers every step needs.
  const payload = () => ({
    ...ob.input, payAmount: num(ob.input.payAmount), savingsPercent: num(ob.input.savingsPercent),
    taxPercent: ob.input.taxPercent === '' ? '' : num(ob.input.taxPercent),
    irregularMonthly: ob.input.irregularMonthly === '' ? '' : num(ob.input.irregularMonthly),
  });
  const live = () => compute(payload());
  const only = (errors, keys) => Object.fromEntries(Object.entries(errors).filter(([k]) => keys.includes(k)));
  function validateStep(step) {
    const v = C.validateInput(payload()).errors;
    if (step === 1) return only(v, ['payAmount', 'basis', 'taxPercent']);
    if (step === 2) {
      const e = only(v, ['frequency', 'irregularMonthly']);
      const d = ob.input.nextPayDate;
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) e.nextPayDate = 'Pick a valid date or leave it empty.';
      return e;
    }
    if (step === 4) {
      const e = only(v, ['savingsPercent']);
      if (!e.savingsPercent && live().plan.status === 'overcommitted') e.savingsPercent = 'Fixed expenses plus savings are more than your income. Lower the savings percent.';
      return e;
    }
    return {};
  }
  function next() {
    const e = validateStep(ob.step);
    if (Object.keys(e).length) { ob.errors = e; ob.focus = false; render(); return; }
    goto(ob.step + 1);
  }

  // ----- screens -----
  function topBar() {
    return `<div class="ob-top">
      ${ob.step > 0 ? '<button type="button" class="btn-icon" id="ob-prev" aria-label="Back"><i class="ti ti-chevron-left" style="font-size:18px"></i></button>' : '<span style="width:36px"></span>'}
      ${ob.step > 0 ? `<div class="ob-progress" role="progressbar" aria-label="Plan setup progress" aria-valuemin="1" aria-valuemax="${STEPS}" aria-valuenow="${ob.step}"><span style="width:${Math.round(ob.step / STEPS * 100)}%"></span></div>` : '<span style="flex:1"></span>'}
      <button type="button" class="ob-later" id="ob-later">${editing() ? 'Close' : 'Later'}</button></div>`;
  }
  const head = (t, sub) => `<h2 class="ob-h" id="ob-h" tabindex="-1">${t}</h2>${sub ? `<p class="ob-sub">${sub}</p>` : ''}`;
  const err = (k, id) => `<div class="ob-err" ${id ? `id="${id}"` : ''} role="alert">${ob.errors[k] ? esc(ob.errors[k]) : ''}</div>`;
  const navBtns = (label, disabled) => `<div class="ob-nav"><button type="button" class="btn-green" id="ob-next" ${disabled ? 'disabled' : ''}>${label}</button></div>`;

  function confetti() {
    const cols = ['#ffb066', '#e5584f', '#6fe0b0', '#7cc4ff', '#b9a2ff', '#ff8fb1'];
    return `<div class="ob-confetti" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i style="--x:${6 + (i * 6) % 90}%;--c:${cols[i % cols.length]};--d:${(i % 6) * 0.08}s;--r:${(i % 2 ? 1 : -1) * (180 + i * 20)}deg"></i>`).join('')}</div>`;
  }
  function stepWelcome() {
    return `<div class="ob-center" style="position:relative">${confetti()}
      <div class="ob-badge"><div class="ob-ring"></div><i class="ti ti-check"></i></div>
      ${head("You're in. Welcome!", "Let's build your <b>Smart Spending Plan</b>.<br>It takes less than 2 minutes.")}
      <div class="ob-nav" style="margin-top:26px"><button type="button" class="btn-green" id="ob-start">Start</button></div></div>`;
  }
  function stepIncome() {
    const gross = ob.input.basis === 'gross';
    return `${head('How much do you make?', 'The amount you receive each time you get paid.')}
      <label class="ob-lbl" for="ob-pay">Amount per paycheck</label>
      <div class="ob-money"><span aria-hidden="true">$</span><input id="ob-pay" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(ob.input.payAmount)}" aria-describedby="ob-pay-err" ${ob.errors.payAmount ? 'aria-invalid="true"' : ''}></div>
      ${err('payAmount', 'ob-pay-err')}
      <div class="ob-lbl" id="ob-basis-l">Is that before or after taxes?</div>
      <div class="ob-seg" role="radiogroup" aria-labelledby="ob-basis-l">
        <button type="button" role="radio" aria-checked="${!gross}" data-basis="net">After taxes (net)</button>
        <button type="button" role="radio" aria-checked="${gross}" data-basis="gross">Before taxes (gross)</button>
      </div>
      ${gross ? `<div class="ob-note warn">The plan works best with what really reaches your account (net). Estimate the taxes taken out and we'll adjust it for you.</div>
        <label class="ob-lbl" for="ob-tax">Estimated taxes withheld (%)</label>
        <input id="ob-tax" type="text" inputmode="numeric" autocomplete="off" value="${esc(ob.input.taxPercent)}" style="font-size:16px" aria-describedby="ob-tax-err">
        ${err('taxPercent', 'ob-tax-err')}
        <div class="ob-pill" id="ob-net">${netText()}</div>` : ''}
      ${navBtns('Continue')}`;
  }
  const netText = () => `≈ ${fmtAbs(C.netPay(num(ob.input.payAmount), 'gross', ob.input.taxPercent))} take-home per paycheck`;
  function stepFrequency() {
    const f = ob.input.frequency;
    return `${head('How often do you get paid?')}
      <div role="radiogroup" aria-label="Pay frequency" style="margin-top:14px">${FREQ.map(([v, t, d]) => `<button type="button" class="ob-opt" role="radio" aria-checked="${f === v}" data-freq="${v}"><b>${t}</b><small>${d}</small></button>`).join('')}</div>
      ${err('frequency')}
      ${f === 'irregular' ? `<label class="ob-lbl" for="ob-irr">Your average monthly income</label>
        <div class="ob-money"><span aria-hidden="true">$</span><input id="ob-irr" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(ob.input.irregularMonthly)}" aria-describedby="ob-irr-err"></div>${err('irregularMonthly', 'ob-irr-err')}` : ''}
      <label class="ob-lbl" for="ob-nextpay">Next payday (optional)</label>
      <input id="ob-nextpay" type="date" value="${esc(ob.input.nextPayDate || '')}" style="font-size:16px;width:100%" aria-describedby="ob-np-err">${err('nextPayDate', 'ob-np-err')}
      <div class="ob-pill" id="ob-monthly">${monthlyText()}</div>
      ${navBtns('Continue')}`;
  }
  const monthlyText = () => { const m = live().monthly; return m > 0 ? `That's about ${fmtAbs(m)} a month` : 'Enter your pay to see your monthly income'; };

  function billRow(b) {
    const c = catOf(b.category);
    return `<div class="ob-bill"><div class="cat-icon" style="background:${c.bg}"><i class="ti ${c.icon}" style="color:${c.color}"></i></div>
      <div style="flex:1;min-width:0"><div class="exp-desc">${esc(b.name)}</div><div class="exp-meta">Due on day ${b.dueDay}</div></div>
      <span style="font-family:var(--mono);font-weight:600;font-size:14px">${fmtAbs(b.amount)}</span>
      <button type="button" class="btn-icon" data-bill-edit="${b.id}" aria-label="Edit ${esc(b.name)}"><i class="ti ti-pencil" style="font-size:14px"></i></button>
      <button type="button" class="btn-icon" data-bill-del="${b.id}" aria-label="Remove ${esc(b.name)}"><i class="ti ti-trash" style="font-size:14px"></i></button></div>`;
  }
  function billForm() {
    const b = ob.bill;
    return `<div class="card" style="margin-top:12px"><div style="font-weight:600;margin-bottom:10px">${b.id ? 'Edit expense' : 'New fixed expense'}</div>
      <label for="ob-b-name">Name</label><input id="ob-b-name" type="text" maxlength="${LIMITS.TEXT_NAME}" placeholder="Rent, gas, internet…" value="${esc(b.name)}" autocomplete="off" style="font-size:16px;width:100%">
      <div class="form-row-2" style="margin-top:10px"><div><label for="ob-b-cat">Category</label><select id="ob-b-cat" style="font-size:16px;width:100%">${CATS.map(c => `<option${b.category === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="ob-b-day">Due day</label><select id="ob-b-day" style="font-size:16px;width:100%">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}"${+b.dueDay === i + 1 ? ' selected' : ''}>Day ${i + 1}</option>`).join('')}</select></div></div>
      <label for="ob-b-amt" style="margin-top:10px;display:block">Amount per month ($)</label><input id="ob-b-amt" type="text" inputmode="decimal" placeholder="0.00" value="${esc(b.amount)}" autocomplete="off" style="font-size:16px;width:100%">
      <div class="ob-err" id="ob-b-err" role="alert">${esc(ob.formError)}</div>
      <div style="display:flex;gap:8px"><button type="button" class="btn-green" id="ob-b-save" style="padding:12px">Save</button><button type="button" class="btn-ghost" id="ob-b-cancel" style="padding:0 18px">Cancel</button></div></div>`;
  }
  function stepBills() {
    const bills = S.bills || [], total = C.sumAmounts(bills), inc = live().monthly;
    return `${head('Your fixed expenses', 'Rent, gas, electricity, internet, phone, insurance, subscriptions or debt payments: what you pay every month.')}
      <div class="card" style="padding:6px 14px">${bills.length ? bills.map(billRow).join('') : '<div style="padding:14px 0;font-size:13px;color:var(--t2)">No fixed expenses yet. Add the ones you pay every month.</div>'}</div>
      ${ob.bill ? billForm() : '<button type="button" class="btn-ghost" id="ob-bill-add" style="margin-top:10px;width:100%;padding:12px"><i class="ti ti-plus" style="margin-right:6px"></i>Add an expense</button>'}
      <div class="ob-total"><span>Total per month</span><span id="ob-bills-total" style="font-family:var(--mono)">${fmtAbs(total)}</span></div>
      <div id="ob-bills-pct" style="font-size:12px;color:var(--t2);margin-top:4px">${inc > 0 ? pct1(total / inc * 100) + ' of your monthly income' : ''}</div>
      ${navBtns('Continue')}`;
  }

  function savingsMessage(r) {
    const p = r.plan;
    if (p.status === 'overcommitted') return `<div class="ob-note bad" id="ob-msg" role="alert">Your fixed expenses plus this savings goal are ${fmtAbs(-p.flexibleMonthly)} more than your monthly income. Lower the savings percent, or review your fixed expenses, to continue.</div>`;
    if (p.status === 'fixed_over_50') return `<div class="ob-note warn" id="ob-msg">Your fixed expenses are ${pct1(p.fixedPercent)} of your income, above the usual 50%. That's very common and nothing to feel bad about. Starting with ${C.suggestSavingsPercent(r.monthly, r.fixed)}% in savings is a realistic first step, and you can raise it over time.</div>`;
    return '<div class="ob-note" id="ob-msg">A simple rule: 50% for needs, 30% for wants and 20% for savings.</div>';
  }
  function stepSavings() {
    const r = live(), sug = C.suggestSavingsPercent(r.monthly, r.fixed), custom = ob.method === 'custom';
    if (!custom) ob.input.savingsPercent = String(sug);
    const pct = num(ob.input.savingsPercent);
    return `${head('Your savings goal', 'How much of your income do you want to put aside each month?')}
      <div role="radiogroup" aria-label="Savings method" style="margin-top:14px">
        <button type="button" class="ob-opt" role="radio" aria-checked="${!custom}" data-method="rec"><b>${r.fixed / (r.monthly || 1) > 0.5 ? 'Realistic start' : 'Recommended 50/30/20'}</b><small>${r.fixed / (r.monthly || 1) > 0.5 ? `Save ${sug}% to begin` : '50% needs · 30% wants · 20% savings'}</small></button>
        <button type="button" class="ob-opt" role="radio" aria-checked="${custom}" data-method="custom"><b>Custom</b><small>Choose your own percentage</small></button></div>
      ${custom ? `<label class="ob-lbl" for="ob-slider">Savings percent: <span id="ob-pct">${pct}%</span></label>
        <input class="ob-range" id="ob-slider" type="range" min="0" max="100" step="1" value="${pct}" style="--p:${pct}%">` : ''}
      <div class="ob-pill" id="ob-saveamt">You'd save ${fmtAbs(C.round2(r.monthly * pct / 100))} a month</div>
      <div id="ob-msgwrap">${savingsMessage(live())}</div>${err('savingsPercent')}
      ${navBtns('See my plan', r.plan.status === 'overcommitted')}`;
  }

  function donut(p) {
    const R = 54, L = 2 * Math.PI * R, tot = Math.max(1, p.monthlyIncome);
    const parts = [[Math.min(p.fixedTotal, tot), '#7cc4ff'], [p.savingsMonthly, '#6fe0b0'], [Math.max(0, p.flexibleMonthly), '#ffb066']];
    let off = 0;
    return `<svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label="How your income is split" style="flex-shrink:0;transform:rotate(-90deg)"><circle cx="66" cy="66" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="16"/>${parts.map(([v, c]) => { const len = v / tot * L, el = `<circle cx="66" cy="66" r="${R}" fill="none" stroke="${c}" stroke-width="16" stroke-dasharray="${len} ${L - len}" stroke-dashoffset="${-off}"/>`; off += len; return el; }).join('')}</svg>`;
  }
  function stepSummary() {
    const p = live().plan, share = v => (p.monthlyIncome > 0 ? pct1(v / p.monthlyIncome * 100) : '0%');
    return `${head('Your plan')}
      <div class="ob-hero"><div class="big">${fmtAbs(p.flexibleDaily)}</div><div class="cap">you can spend per day</div></div>
      <div class="ob-three"><div><small>Per week</small><b>${fmtAbs(p.flexibleWeekly)}</b></div><div><small>Per month</small><b>${fmtAbs(Math.max(0, p.flexibleMonthly))}</b></div></div>
      <div class="card"><div class="ob-donut">${donut(p)}<div class="ob-legend">
        <div><i style="background:#7cc4ff"></i>Fixed expenses<span>${fmtAbs(p.fixedTotal)}</span></div>
        <div><i style="background:#6fe0b0"></i>Savings<span>${fmtAbs(p.savingsMonthly)}</span></div>
        <div><i style="background:#ffb066"></i>Spending money<span>${fmtAbs(Math.max(0, p.flexibleMonthly))}</span></div></div></div>
        <div style="font-size:12px;color:var(--t2)">Monthly income ${fmtAbs(p.monthlyIncome)} · fixed ${share(p.fixedTotal)} · savings ${share(p.savingsMonthly)}</div></div>
      <div class="ob-err" role="alert">${esc(ob.formError)}</div>
      <div class="ob-nav"><button type="button" class="btn-green" id="ob-save" ${ob.saving || p.status === 'overcommitted' ? 'disabled' : ''}>${ob.saving ? 'Saving…' : 'Save my plan'}</button></div>`;
  }
  function stepSaved() {
    const d = fmtAbs(live().plan.flexibleDaily);
    return `<div class="ob-center" style="position:relative">${confetti()}<div class="ob-badge"><div class="ob-ring"></div><i class="ti ti-check"></i></div>
      ${head('Your plan is saved', `Your daily limit is now <b>${d}</b>.`)}</div>`;
  }

  function renderScreen() {
    if (!ob.active) startFlow();
    const body = ob.saved ? stepSaved() : [stepWelcome, stepIncome, stepFrequency, stepBills, stepSavings, stepSummary][ob.step]();
    return `<div class="ob-wrap">${ob.saved ? '' : topBar()}${body}</div>`;
  }

  // ----- events (bind() runs after every render, so handlers always match the screen) -----
  function bind() {
    const $ = id => document.getElementById(id);
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    // dashboard / menu entry points from phase 2
    on('plan-start', openEditor); on('menu-plan', openEditor); on('sb-plan', openEditor);
    on('plan-hide', () => { S._planBannerHidden = true; render(); });
    if (S.tab !== 'onboarding' || !ob.active) return;

    on('ob-start', () => goto(1));
    on('ob-prev', () => goto(Math.max(0, ob.step - 1)));
    on('ob-later', async () => {
      clearTimeout(persistTimer);
      if (editing()) { leaveEditor(); return; }        // closing the editor changes nothing
      await saveDraft(ob.step, { input: ob.input }); ob.active = false; await skipNow();
    });
    on('ob-next', next); on('ob-save', finish);
    if (ob.focus) { ob.focus = false; const h = $('ob-h'); if (h) h.focus({ preventScroll: true }); }

    // step 1: income
    const pay = $('ob-pay');
    if (pay) {
      pay.addEventListener('input', e => { const c = sanitizeAmt(e.target.value); if (c !== e.target.value) e.target.value = c; ob.input.payAmount = c; const n = $('ob-net'); if (n) n.textContent = netText(); persist(); });
      pay.addEventListener('keydown', e => { if (e.key === 'Enter') next(); });
    }
    document.querySelectorAll('[data-basis]').forEach(b => b.addEventListener('click', () => {
      ob.input.basis = b.dataset.basis; if (ob.input.basis === 'gross' && ob.input.taxPercent === '') ob.input.taxPercent = '20';
      ob.errors = {}; persist(); render();
    }));
    const tax = $('ob-tax');
    if (tax) tax.addEventListener('input', e => { const c = e.target.value.replace(/\D/g, '').slice(0, 2); if (c !== e.target.value) e.target.value = c; ob.input.taxPercent = c; const n = $('ob-net'); if (n) n.textContent = netText(); persist(); });

    // step 2: frequency
    document.querySelectorAll('[data-freq]').forEach(b => b.addEventListener('click', () => { ob.input.frequency = b.dataset.freq; ob.errors = {}; persist(); render(); }));
    const irr = $('ob-irr');
    if (irr) irr.addEventListener('input', e => { const c = sanitizeAmt(e.target.value); if (c !== e.target.value) e.target.value = c; ob.input.irregularMonthly = c; const m = $('ob-monthly'); if (m) m.textContent = monthlyText(); persist(); });
    const np = $('ob-nextpay');
    if (np) np.addEventListener('change', e => { ob.input.nextPayDate = e.target.value; persist(); });

    // step 3: fixed expenses, stored in the app's own bills list
    on('ob-bill-add', () => { ob.bill = { id: null, name: '', category: 'Housing', amount: '', dueDay: 1 }; ob.formError = ''; render(); });
    document.querySelectorAll('[data-bill-edit]').forEach(b => b.addEventListener('click', () => {
      const x = S.bills.find(y => y.id === +b.dataset.billEdit); if (!x) return;
      ob.bill = { id: x.id, name: x.name, category: x.category, amount: String(x.amount), dueDay: x.dueDay }; ob.formError = ''; render();
    }));
    document.querySelectorAll('[data-bill-del]').forEach(b => b.addEventListener('click', () => {
      const i = S.bills.findIndex(y => y.id === +b.dataset.billDel); if (i < 0) return;
      const [gone] = S.bills.splice(i, 1); haptic.press(); saveBills(); render();
      ExpSwipe.toast(`${gone.name} removed`, 'Undo', () => { if (!S.bills.some(y => y.id === gone.id)) { S.bills.splice(Math.min(i, S.bills.length), 0, gone); saveBills(); if (ob.active) render(); } });
    }));
    const bn = $('ob-b-name');
    if (bn) {
      bn.addEventListener('input', e => { const c = sanitizeText(e.target.value, LIMITS.TEXT_NAME); if (c !== e.target.value) e.target.value = c; ob.bill.name = c; });
      $('ob-b-cat').addEventListener('change', e => { ob.bill.category = e.target.value; });
      $('ob-b-day').addEventListener('change', e => { ob.bill.dueDay = +e.target.value; });
      $('ob-b-amt').addEventListener('input', e => { const c = sanitizeAmt(e.target.value); if (c !== e.target.value) e.target.value = c; ob.bill.amount = c; });
      on('ob-b-cancel', () => { ob.bill = null; ob.formError = ''; render(); });
      on('ob-b-save', () => {
        const b = ob.bill, name = b.name.trim(), amt = num(b.amount);
        if (!name) { ob.formError = 'Give the expense a name.'; render(); return; }
        if (!(amt > 0 && amt <= LIMITS.AMT_MAX)) { ob.formError = 'Enter an amount greater than 0.'; render(); return; }
        const rec = { name, category: b.category, amount: amt, dueDay: +b.dueDay };
        if (b.id) S.bills = S.bills.map(x => x.id === b.id ? { ...rec, id: b.id } : x); else S.bills.push({ ...rec, id: Date.now() });
        ob.bill = null; ob.formError = ''; haptic.tap(); saveBills(); render();
      });
    }

    // step 4: savings
    document.querySelectorAll('[data-method]').forEach(b => b.addEventListener('click', () => { ob.method = b.dataset.method; ob.errors = {}; persist(); render(); }));
    const sl = $('ob-slider');
    if (sl) {
      sl.addEventListener('input', e => { ob.input.savingsPercent = e.target.value; sl.style.setProperty('--p', e.target.value + '%'); const r = live(); const a = $('ob-pct'); if (a) a.textContent = e.target.value + '%'; const b = $('ob-saveamt'); if (b) b.textContent = `You'd save ${fmtAbs(C.round2(r.monthly * num(e.target.value) / 100))} a month`; });
      sl.addEventListener('change', () => { persist(); ob.errors = {}; render(); });
    }
  }

  async function finish() {
    if (ob.saving) return;
    ob.saving = true; ob.formError = ''; render();
    try {
      const r = await apply(payload());
      if (!r.ok) { ob.saving = false; ob.formError = Object.values(r.errors)[0] || 'Could not save your plan.'; render(); return; }
      ob.saving = false; ob.saved = true; haptic.ok(); render();
      setTimeout(() => { ob.saved = false; ob.active = false; S.tab = 'home'; S.obEdit = false; render(); }, reduced() ? 600 : 1700);
    } catch (e) {
      ob.saving = false; ob.formError = 'Could not save your plan. Your answers are kept, try again.'; render();
    }
  }

  return { KEY_PLAN, KEY_OB, load, state, saveDraft, skip, prefill, compute, apply, maybeRedirect, openEditor, bannerHtml, renderScreen, bind };
})();

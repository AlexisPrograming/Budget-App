// Credit cards — pure calculations (no DOM, no storage).
// Works as a classic <script> (exposes window.CardsCalc) and can be loaded in Node for tests.
//
// Model
//   card       { id, name, dueDay, archived? }
//   expense    gets an optional  card: <card id>   (absent = cash or debit)
//   statement  { id, cardId, source, year, month0, amount, dueYear, dueMonth0, dueDay, cardDueDay,
//                paid, paidAmount, paidDate }
//   Purchases made in a calendar month are due the FOLLOWING month, on the card's due day.
//   What is being built this month is never stored: it is the sum of this month's credit expenses.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardsCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AMT_MAX = 9999999.99;
  const MAX_CARDS = 10;
  const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const idx = (year, month0) => year * 12 + month0;                 // comparable month number

  const dim = (year, month0) => new Date(year, month0 + 1, 0).getDate();
  const clampDay = (year, month0, day) => Math.min(Math.max(1, Math.floor(Number(day)) || 1), dim(year, month0));

  function addMonths(year, month0, n) {
    const t = year * 12 + month0 + n;
    return { year: Math.floor(t / 12), month0: ((t % 12) + 12) % 12 };
  }
  function dueDate(year, month0, dueDay) {
    const day = clampDay(year, month0, dueDay);
    return { year, month0, day, iso: `${year}-${pad(month0 + 1)}-${pad(day)}` };
  }
  // Purchases of (year, month0) are paid the following month.
  function dueForPurchaseMonth(year, month0, dueDay) {
    const n = addMonths(year, month0, 1);
    return dueDate(n.year, n.month0, dueDay);
  }

  function validateCard(c) {
    const errors = {};
    const name = String((c && c.name) || '').trim();
    if (!name) errors.name = 'Give the card a name.';
    else if (name.length > 30) errors.name = 'Use 30 characters or fewer.';
    const d = Number(c && c.dueDay);
    if (!(Number.isInteger(d) && d >= 1 && d <= 31)) errors.dueDay = 'Pick a due day from 1 to 31.';
    return { ok: Object.keys(errors).length === 0, errors };
  }
  // The amount you owe on a card when you add it (optional, 0 means nothing owed).
  function validateOwed(v) {
    if (v === '' || v == null) return { ok: true, amount: 0 };
    const n = Number(v);
    if (!(Number.isFinite(n) && n >= 0 && n <= AMT_MAX)) return { ok: false, error: 'Enter an amount of 0 or more.' };
    return { ok: true, amount: round2(n) };
  }

  // Credit purchases of one calendar month, per card. Cards that were removed still count as "unassigned".
  function buildingByCard(expenses, cards, year, month0) {
    const prefix = `${year}-${pad(month0 + 1)}-`;
    const sums = new Map(), counts = new Map();
    let unassigned = 0;
    for (const e of expenses || []) {
      if (e == null || e.card == null) continue;
      if (!String(e.date || '').startsWith(prefix)) continue;
      const a = Number(e.amount);
      if (!(a > 0)) continue;
      if (!(cards || []).some(c => c.id === e.card)) { unassigned += a; continue; }
      sums.set(e.card, (sums.get(e.card) || 0) + a);
      counts.set(e.card, (counts.get(e.card) || 0) + 1);
    }
    const rows = (cards || []).filter(c => sums.has(c.id))
      .map(c => ({ cardId: c.id, name: c.name, amount: round2(sums.get(c.id)), count: counts.get(c.id) }));
    const total = round2(rows.reduce((s, r) => s + r.amount, 0) + unassigned);
    return { rows, total, unassigned: round2(unassigned) };
  }

  // Statement for what is owed when a card is added: due on the card's day this very month.
  function openingStatement(card, amount, year, month0, nowISO) {
    const v = validateOwed(amount);
    if (!v.ok || !(v.amount > 0)) return null;
    const due = dueDate(year, month0, card.dueDay);
    const prev = addMonths(year, month0, -1);
    return {
      id: `o${card.id}-${year}-${month0}`, cardId: card.id, source: 'opening', year: prev.year, month0: prev.month0,
      amount: v.amount, dueYear: due.year, dueMonth0: due.month0, dueDay: due.day, cardDueDay: card.dueDay,
      paid: false, paidAmount: null, paidDate: null, created_at: nowISO || null,
    };
  }

  // Freezes a month's credit purchases into statements to pay next month. Safe to call twice:
  // a card/month that already has its statement is left as it is. Returns { statements, created, unassigned }.
  function closeMonth(statements, expenses, cards, year, month0, nowISO) {
    const b = buildingByCard(expenses, cards, year, month0);
    const out = (statements || []).map(s => ({ ...s }));
    const created = [];
    for (const r of b.rows) {
      if (!(r.amount > 0)) continue;
      const id = `c${r.cardId}-${year}-${month0}`;
      if (out.some(s => s.id === id)) continue;
      const card = cards.find(c => c.id === r.cardId);
      const due = dueForPurchaseMonth(year, month0, card.dueDay);
      const st = {
        id, cardId: r.cardId, source: 'closed', year, month0, amount: r.amount,
        dueYear: due.year, dueMonth0: due.month0, dueDay: due.day, cardDueDay: card.dueDay,
        paid: false, paidAmount: null, paidDate: null, created_at: nowISO || null,
      };
      out.push(st); created.push(st);
    }
    return { statements: out, created, unassigned: b.unassigned };
  }

  // Pay a statement in full or in part. A part payment leaves the rest as a new statement due a month later.
  function payStatement(statements, id, paidAmount, dateISO, nowISO) {
    const i = (statements || []).findIndex(s => s.id === id);
    if (i < 0) return { ok: false, error: 'not_found' };
    const s = statements[i];
    if (s.paid) return { ok: false, error: 'already_paid' };
    const p = round2(paidAmount);
    if (!(p > 0)) return { ok: false, error: 'invalid_amount' };
    if (p > s.amount + 0.004) return { ok: false, error: 'exceeds_balance' };
    const out = statements.map(x => ({ ...x }));
    out[i] = { ...s, paid: true, paidAmount: Math.min(p, s.amount), paidDate: dateISO || null };
    const rest = round2(s.amount - p);
    if (rest > 0.004) {
      const n = addMonths(s.dueYear, s.dueMonth0, 1);
      const due = dueDate(n.year, n.month0, s.cardDueDay || s.dueDay);
      out.push({
        id: `k${s.id}`, cardId: s.cardId, source: 'carryover', carriedFrom: s.id, year: s.year, month0: s.month0, amount: rest,
        dueYear: due.year, dueMonth0: due.month0, dueDay: due.day, cardDueDay: s.cardDueDay || s.dueDay,
        paid: false, paidAmount: null, paidDate: null, created_at: nowISO || null,
      });
    }
    return { ok: true, statements: out };
  }

  // Undo a payment. Refuses if the leftover it created has already been paid.
  function undoPayment(statements, id) {
    const i = (statements || []).findIndex(s => s.id === id);
    if (i < 0) return { ok: false, error: 'not_found' };
    if (!statements[i].paid) return { ok: false, error: 'not_paid' };
    const carry = statements.find(s => s.id === `k${id}`);
    if (carry && carry.paid) return { ok: false, error: 'carryover_already_paid' };
    const out = statements.filter(s => s.id !== `k${id}`).map(s => (s.id === id ? { ...s, paid: false, paidAmount: null, paidDate: null } : { ...s }));
    return { ok: true, statements: out };
  }

  // Everything the screens need about cards for the month being viewed.
  //   dueNow: unpaid statements due this month or earlier (overdue ones flagged by todayISO)
  //   dueLater: unpaid statements due after this month
  //   building: this month's credit purchases, to be paid next month
  function summary(o) {
    const statements = o.statements || [], cards = o.cards || [];
    const now = idx(o.year, o.month0), today = o.todayISO || null;
    const unpaid = statements.filter(s => !s.paid && s.amount > 0);
    const dueIso = s => `${s.dueYear}-${pad(s.dueMonth0 + 1)}-${pad(s.dueDay)}`;
    const byDue = (a, b) => (dueIso(a) < dueIso(b) ? -1 : dueIso(a) > dueIso(b) ? 1 : 0);
    const nameOf = id => (cards.find(c => c.id === id) || {}).name || 'Card';
    const decorate = s => ({ ...s, name: nameOf(s.cardId), dueISO: dueIso(s), overdue: !!today && dueIso(s) < today });
    const dueNowItems = unpaid.filter(s => idx(s.dueYear, s.dueMonth0) <= now).sort(byDue).map(decorate);
    const dueLaterItems = unpaid.filter(s => idx(s.dueYear, s.dueMonth0) > now).sort(byDue).map(decorate);
    const sum = list => round2(list.reduce((t, s) => t + s.amount, 0));
    const building = buildingByCard(o.expenses, cards, o.year, o.month0);
    return {
      dueNow: { items: dueNowItems, total: sum(dueNowItems), overdueTotal: sum(dueNowItems.filter(s => s.overdue)) },
      dueLater: { items: dueLaterItems, total: sum(dueLaterItems) },
      building,
      totalOwed: round2(sum(unpaid) + building.total),
    };
  }

  return {
    AMT_MAX, MAX_CARDS, round2, addMonths, dueDate, dueForPurchaseMonth, validateCard, validateOwed,
    buildingByCard, openingStatement, closeMonth, payStatement, undoPayment, summary,
  };
});

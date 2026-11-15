import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { self: {} };
vm.runInNewContext(readFileSync(join(here, '..', 'cards-calc.js'), 'utf8'), sandbox);
const C = sandbox.self.CardsCalc;
const plain = o => JSON.parse(JSON.stringify(o));

const visa = { id: 'v', name: 'Visa', dueDay: 15 };
const amex = { id: 'a', name: 'Amex', dueDay: 28 };
const cards = [visa, amex];
const ex = (id, date, amount, card) => ({ id, date, amount, category: 'Food', description: '', ...(card ? { card } : {}) });

test('API is exposed', () => {
  for (const f of ['validateCard', 'validateOwed', 'buildingByCard', 'openingStatement', 'closeMonth', 'payStatement', 'undoPayment', 'summary', 'dueDate'])
    assert.equal(typeof C[f], 'function');
});

test('due dates clamp to month length and roll over the year', () => {
  assert.equal(C.dueDate(2026, 1, 31).iso, '2026-02-28');
  assert.equal(C.dueDate(2028, 1, 31).iso, '2028-02-29');
  assert.equal(C.dueForPurchaseMonth(2026, 11, 10).iso, '2027-01-10');
  assert.equal(C.dueForPurchaseMonth(2026, 0, 31).iso, '2026-02-28');
});

test('validation', () => {
  assert.equal(C.validateCard({ name: 'Visa', dueDay: 15 }).ok, true);
  assert.equal(C.validateCard({ name: '  ', dueDay: 15 }).ok, false);
  assert.equal(C.validateCard({ name: 'x'.repeat(31), dueDay: 15 }).ok, false);
  assert.equal(C.validateCard({ name: 'V', dueDay: 0 }).ok, false);
  assert.equal(C.validateCard({ name: 'V', dueDay: 32 }).ok, false);
  assert.equal(C.validateCard({ name: 'V', dueDay: 1.5 }).ok, false);
  assert.equal(C.validateOwed('').amount, 0);
  assert.equal(C.validateOwed('12.345').amount, 12.35);
  assert.equal(C.validateOwed(-1).ok, false);
  assert.equal(C.validateOwed('abc').ok, false);
});

test('buildingByCard sums only credit expenses of that month', () => {
  const e = [
    ex(1, '2026-11-02', 100, 'v'), ex(2, '2026-11-10', 50.5, 'v'), ex(3, '2026-11-11', 200, 'a'),
    ex(4, '2026-11-12', 999), ex(5, '2026-10-30', 300, 'v'), ex(6, '2026-11-13', 25, 'gone'),
  ];
  const b = plain(C.buildingByCard(e, cards, 2026, 10));
  assert.equal(b.rows.find(r => r.cardId === 'v').amount, 150.5);
  assert.equal(b.rows.find(r => r.cardId === 'v').count, 2);
  assert.equal(b.rows.find(r => r.cardId === 'a').amount, 200);
  assert.equal(b.unassigned, 25);
  assert.equal(b.total, 375.5);
});

test('closeMonth freezes statements due next month and is idempotent', () => {
  const e = [ex(1, '2026-11-02', 100, 'v'), ex(2, '2026-11-11', 200, 'a')];
  const r1 = C.closeMonth([], e, cards, 2026, 10, 'now');
  assert.equal(r1.created.length, 2);
  const sv = r1.statements.find(s => s.cardId === 'v');
  assert.equal(sv.amount, 100);
  assert.equal(`${sv.dueYear}-${sv.dueMonth0}-${sv.dueDay}`, '2026-11-15');   // December 15
  const r2 = C.closeMonth(r1.statements, e, cards, 2026, 10, 'later');
  assert.equal(r2.created.length, 0);
  assert.equal(r2.statements.length, 2);
  // a late-added expense after closing does not alter the frozen statement
  const r3 = C.closeMonth(r2.statements, [...e, ex(3, '2026-11-20', 50, 'v')], cards, 2026, 10);
  assert.equal(r3.statements.find(s => s.cardId === 'v').amount, 100);
});

test('closeMonth does not mutate its input', () => {
  const st = [];
  C.closeMonth(st, [ex(1, '2026-11-02', 100, 'v')], cards, 2026, 10);
  assert.equal(st.length, 0);
});

test('closeMonth ignores months without credit spending', () => {
  assert.equal(C.closeMonth([], [ex(1, '2026-11-02', 100)], cards, 2026, 10).created.length, 0);
});

test('payStatement: full, partial with carryover, errors', () => {
  const st = C.closeMonth([], [ex(1, '2026-11-02', 100, 'v')], cards, 2026, 10).statements;
  const id = st[0].id;
  assert.equal(C.payStatement(st, 'nope', 10, '2026-12-01').error, 'not_found');
  assert.equal(C.payStatement(st, id, 0, '2026-12-01').error, 'invalid_amount');
  assert.equal(C.payStatement(st, id, 101, '2026-12-01').error, 'exceeds_balance');

  const full = C.payStatement(st, id, 100, '2026-12-10');
  assert.equal(full.ok, true);
  assert.equal(full.statements.length, 1);
  assert.equal(full.statements[0].paid, true);
  assert.equal(C.payStatement(full.statements, id, 10, '2026-12-11').error, 'already_paid');

  const part = C.payStatement(st, id, 40, '2026-12-10');
  assert.equal(part.statements.length, 2);
  const k = part.statements.find(s => s.id === 'k' + id);
  assert.equal(k.amount, 60);
  assert.equal(`${k.dueYear}-${k.dueMonth0}-${k.dueDay}`, '2027-0-15');         // January 15, next year
  assert.equal(k.paid, false);
  assert.equal(st[0].paid, false);                                               // input untouched
});

test('undoPayment restores the statement and removes the leftover', () => {
  const st = C.closeMonth([], [ex(1, '2026-11-02', 100, 'v')], cards, 2026, 10).statements;
  const id = st[0].id;
  const part = C.payStatement(st, id, 40, '2026-12-10').statements;
  const undone = C.undoPayment(part, id);
  assert.equal(undone.ok, true);
  assert.equal(undone.statements.length, 1);
  assert.equal(undone.statements[0].paid, false);
  assert.equal(C.undoPayment(undone.statements, id).error, 'not_paid');
  // leftover already paid → refuse
  const paidCarry = C.payStatement(part, 'k' + id, 60, '2027-01-10').statements;
  assert.equal(C.undoPayment(paidCarry, id).error, 'carryover_already_paid');
});

test('openingStatement: due this month on the card day, none for 0', () => {
  const s = C.openingStatement(visa, 700, 2026, 10, 'now');
  assert.equal(s.amount, 700);
  assert.equal(`${s.dueYear}-${s.dueMonth0}-${s.dueDay}`, '2026-10-15');
  assert.equal(C.openingStatement(visa, 0, 2026, 10), null);
  assert.equal(C.openingStatement(visa, '', 2026, 10), null);
});

test('summary: two cards owing 1,200 this month', () => {
  const st = [C.openingStatement(visa, 700, 2026, 10, 'n'), C.openingStatement(amex, 500, 2026, 10, 'n')];
  const e = [ex(1, '2026-11-05', 80, 'v')];
  const s = plain(C.summary({ statements: st, expenses: e, cards, year: 2026, month0: 10, todayISO: '2026-11-20' }));
  assert.equal(s.dueNow.total, 1200);
  assert.equal(s.dueNow.items.length, 2);
  assert.equal(s.dueNow.items[0].name, 'Visa');
  assert.equal(s.dueNow.items[0].overdue, true);          // due the 15th, today is the 20th
  assert.equal(s.dueNow.items[1].overdue, false);         // due the 28th
  assert.equal(s.dueNow.overdueTotal, 700);
  assert.equal(s.building.total, 80);
  assert.equal(s.dueLater.total, 0);
  assert.equal(s.totalOwed, 1280);
});

test('summary: next month statements are "later" until that month; paid ones disappear', () => {
  const st = C.closeMonth([], [ex(1, '2026-11-02', 100, 'v')], cards, 2026, 10).statements;
  const nov = plain(C.summary({ statements: st, expenses: [], cards, year: 2026, month0: 10, todayISO: '2026-11-30' }));
  assert.equal(nov.dueNow.total, 0);
  assert.equal(nov.dueLater.total, 100);
  const dec = plain(C.summary({ statements: st, expenses: [], cards, year: 2026, month0: 11, todayISO: '2026-12-01' }));
  assert.equal(dec.dueNow.total, 100);
  const paid = C.payStatement(st, st[0].id, 100, '2026-12-05').statements;
  assert.equal(C.summary({ statements: paid, expenses: [], cards, year: 2026, month0: 11 }).dueNow.total, 0);
});

test('summary tolerates empty or missing input', () => {
  const s = plain(C.summary({}));
  assert.equal(s.totalOwed, 0);
  assert.equal(s.dueNow.items.length, 0);
});

// Credit cards — data layer. Classic <script>; exposes global `Cards`.
// Uses the app globals S (state) and Store (storage), plus CardsCalc (pure math, cards-calc.js).
// Keys: budget:cards (list of cards), budget:card_statements (what is owed, frozen per month).
// Nothing here draws a screen. Every function that can fail returns { ok:false, error } instead of throwing.
const Cards = (() => {
  const C = () => window.CardsCalc;
  const KEY_CARDS = 'budget:cards', KEY_ST = 'budget:card_statements';
  const parseList = r => { try { const v = r ? JSON.parse(r.value) : []; return Array.isArray(v) ? v : []; } catch { return []; } };
  const nowISO = () => new Date().toISOString();
  const pad = n => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function load() {
    S.cards = parseList(await Store.cget(KEY_CARDS));
    S.cardStatements = parseList(await Store.cget(KEY_ST));
  }
  const saveCards = () => Store.cset(KEY_CARDS, JSON.stringify(S.cards));
  const saveStatements = () => Store.cset(KEY_ST, JSON.stringify(S.cardStatements));

  const active = () => (S.cards || []).filter(c => !c.archived);
  const sameName = (name, exceptId) => (S.cards || []).some(c => c.id !== exceptId && !c.archived && c.name.trim().toLowerCase() === name.trim().toLowerCase());

  // owed = what you owe on the card right now (optional). It becomes a statement due this month.
  async function addCard({ name, dueDay, owed }) {
    const v = C().validateCard({ name, dueDay });
    if (!v.ok) return { ok: false, error: 'invalid', errors: v.errors };
    const o = C().validateOwed(owed);
    if (!o.ok) return { ok: false, error: 'invalid', errors: { owed: o.error } };
    if (active().length >= C().MAX_CARDS) return { ok: false, error: 'too_many' };
    if (sameName(name)) return { ok: false, error: 'invalid', errors: { name: 'You already have a card with that name.' } };
    const card = { id: newId(), name: String(name).trim(), dueDay: Number(dueDay) };
    S.cards = [...(S.cards || []), card];
    if (o.amount > 0) {
      const d = new Date();
      const st = C().openingStatement(card, o.amount, d.getFullYear(), d.getMonth(), nowISO());
      if (st) S.cardStatements = [...(S.cardStatements || []), st];
    }
    await saveCards(); await saveStatements();
    return { ok: true, card };
  }

  async function updateCard(id, { name, dueDay }) {
    const i = (S.cards || []).findIndex(c => c.id === id);
    if (i < 0) return { ok: false, error: 'not_found' };
    const v = C().validateCard({ name, dueDay });
    if (!v.ok) return { ok: false, error: 'invalid', errors: v.errors };
    if (sameName(name, id)) return { ok: false, error: 'invalid', errors: { name: 'You already have a card with that name.' } };
    S.cards = S.cards.map(c => (c.id === id ? { ...c, name: String(name).trim(), dueDay: Number(dueDay) } : c));
    await saveCards();
    return { ok: true };
  }

  // A card with history is archived, never deleted. Blocked while something is still owed on it.
  async function archiveCard(id) {
    const card = (S.cards || []).find(c => c.id === id);
    if (!card) return { ok: false, error: 'not_found' };
    const d = new Date();
    const b = C().buildingByCard(S.data ? S.data.expenses : [], S.cards, d.getFullYear(), d.getMonth());
    if ((S.cardStatements || []).some(s => s.cardId === id && !s.paid) || b.rows.some(r => r.cardId === id))
      return { ok: false, error: 'has_balance' };
    S.cards = S.cards.map(c => (c.id === id ? { ...c, archived: true } : c));
    await saveCards();
    return { ok: true };
  }

  // Mark (or clear, with null) the card used for an expense. Only active cards can be chosen.
  async function tagExpense(expenseId, cardId) {
    const e = ((S.data && S.data.expenses) || []).find(x => x.id === expenseId);
    if (!e) return { ok: false, error: 'not_found' };
    if (cardId == null) delete e.card;
    else {
      if (!active().some(c => c.id === cardId)) return { ok: false, error: 'unknown_card' };
      e.card = cardId;
    }
    await saveData();
    return { ok: true };
  }

  // Freeze a month's credit purchases into statements. Call BEFORE the month's expenses are wiped.
  async function closeMonth(year, month0) {
    const r = C().closeMonth(S.cardStatements || [], (S.data && S.data.expenses) || [], S.cards || [], year, month0, nowISO());
    if (r.created.length) { S.cardStatements = r.statements; await saveStatements(); }
    return r;
  }

  async function pay(id, amount, dateISO) {
    const r = C().payStatement(S.cardStatements || [], id, amount, dateISO || todayISO(), nowISO());
    if (r.ok) { S.cardStatements = r.statements; await saveStatements(); }
    return r;
  }
  async function undoPay(id) {
    const r = C().undoPayment(S.cardStatements || [], id);
    if (r.ok) { S.cardStatements = r.statements; await saveStatements(); }
    return r;
  }

  function summary(year, month0) {
    const d = new Date();
    return C().summary({
      statements: S.cardStatements || [], expenses: (S.data && S.data.expenses) || [], cards: S.cards || [],
      year: year == null ? d.getFullYear() : year, month0: month0 == null ? d.getMonth() : month0, todayISO: todayISO(),
    });
  }

  return { load, active, addCard, updateCard, archiveCard, tagExpense, closeMonth, pay, undoPay, summary };
})();

'use strict';
/* Works out which alerts a user's saved plan should trigger today.
   Each alert has a stable `key` so the same alert is only sent once. */

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmt = n => Math.round(n).toLocaleString('en-US');

function addMonths(date, m) {
  const d = new Date(date.getFullYear(), date.getMonth() + m, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function loanPayment(l) {
  const P = num(l.amount), n = Math.max(1, Math.round(num(l.months))), annual = num(l.rate) / 100;
  if (l.method === 'flat') return (P + P * annual * (n / 12)) / n;
  const r = annual / 12;
  return r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
}

function computeAlerts(state, now = new Date()) {
  const out = [];
  if (!state || typeof state !== 'object') return out;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const month = isoDay(today).slice(0, 7);
  const cur = (state.profile && state.profile.currency) || 'UGX';
  const warnAt = num(state.profile && state.profile.warnAt) || 80;
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const incomes = Array.isArray(state.incomes) ? state.incomes : [];
  const loans = Array.isArray(state.loans) ? state.loans : [];

  for (const e of expenses) {
    const budget = num(e.budget), spent = num(e.spent);
    if (budget <= 0) continue;
    const p = (spent / budget) * 100;
    if (p > 100) out.push({ key: `budget-over:${e.id}:${month}`, text: `You have overspent your ${e.category} budget: ${cur} ${fmt(spent)} of ${cur} ${fmt(budget)}.` });
    else if (p >= warnAt) out.push({ key: `budget-warn:${e.id}:${month}`, text: `You have spent ${Math.round(p)}% of your ${e.category} budget.` });
  }

  const income = incomes.reduce((a, i) => a + num(i.amount), 0);
  const spent = expenses.reduce((a, e) => a + num(e.spent), 0);
  if (income > 0 && spent > income) out.push({ key: `spent-over-income:${month}`, text: `You have spent ${cur} ${fmt(spent - income)} more than your income this month.` });

  for (const l of loans) {
    if (!l.start) continue;
    const start = parseDate(l.start), n = Math.max(1, Math.round(num(l.months)));
    for (let k = 1; k <= n; k++) {
      const due = addMonths(start, k);
      if (due < today) continue;
      const days = Math.round((due - today) / 86400000);
      if (days <= 3) {
        const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
        out.push({ key: `loan-due:${l.id}:${isoDay(due)}`, text: `${l.name} payment of ${cur} ${fmt(loanPayment(l))} is due ${when} (${isoDay(due)}).` });
      }
      break;
    }
  }
  return out;
}

module.exports = { computeAlerts };

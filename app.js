/* Financial Planning Tool — all data stays in this browser (localStorage). */
'use strict';

const STORE_KEY = 'financial-planning-tool.v1';
const COLORS = ['#12795b', '#2f6fd0', '#d08a1f', '#b03a8a', '#5a8f29', '#7a5bd6', '#c0362c', '#2a9db0', '#8c6d46', '#64748b'];

const DEFAULT_INVEST_OPTIONS = [
  { name: 'Mobile Money savings', rate: 5, risk: 'Low' },
  { name: 'Fixed deposit', rate: 10, risk: 'Low' },
  { name: 'Treasury Bills', rate: 11, risk: 'Low' },
  { name: 'SACCO shares / savings', rate: 12, risk: 'Medium' },
  { name: 'Stocks (shares)', rate: 15, risk: 'High' },
];

function defaultState() {
  return {
    profile: { name: '', type: 'Individual / Student', currency: 'UGX', familySize: 1, risk: 'medium', warnAt: 80 },
    incomes: [],
    expenses: [],
    goals: [],
    loans: [],
    transactions: [],
    contributions: [],
    invest: { amount: 1000000, years: 1, monthly: 0, options: DEFAULT_INVEST_OPTIONS.map(o => ({ ...o })) },
    emergency: { months: 6, monthlyExpenses: '', saved: 0 },
    retire: { age: 25, retireAge: 60, monthlyNeed: 1000000, years: 20, saved: 0, returnRate: 10, inflation: 5 },
  };
}

/* ---------- storage ---------- */
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    return mergeDefaults(JSON.parse(raw));
  } catch { return defaultState(); }
}
function mergeDefaults(s) {
  const d = defaultState();
  return {
    ...d, ...s,
    profile: { ...d.profile, ...(s.profile || {}) },
    invest: { ...d.invest, ...(s.invest || {}) },
    emergency: { ...d.emergency, ...(s.emergency || {}) },
    retire: { ...d.retire, ...(s.retire || {}) },
    incomes: Array.isArray(s.incomes) ? s.incomes : [],
    expenses: Array.isArray(s.expenses) ? s.expenses : [],
    goals: Array.isArray(s.goals) ? s.goals : [],
    loans: Array.isArray(s.loans) ? s.loans : [],
    transactions: Array.isArray(s.transactions) ? s.transactions : [],
    contributions: Array.isArray(s.contributions) ? s.contributions : [],
  };
}
let state = load();
let mode = 'offline'; // 'online' when logged in to the server; then data is saved to the online database
function save() {
  if (mode === 'online') scheduleSync();
  else { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ } }
  render();
}

/* ---------- helpers ---------- */
const $ = sel => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => Math.round(n).toLocaleString('en-US');
const money = n => `${esc(state.profile.currency || '')} ${fmtNum(n)}`.trim();
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function barClass(p) {
  const warnAt = num(state.profile.warnAt) || 80;
  return p > 100 ? 'bad' : p >= warnAt ? 'warn' : '';
}
function progressBar(p) {
  return `<div class="bar ${barClass(p)}"><i style="width:${Math.min(100, Math.max(0, p)).toFixed(1)}%"></i></div>`;
}

/* ---------- calculations ---------- */
function totals() {
  const income = sum(state.incomes, i => num(i.amount));
  const planned = sum(state.expenses, e => num(e.budget));
  const spent = sum(state.expenses, e => num(e.spent));
  return { income, planned, spent, balance: income - planned };
}

function loanCalc(l) {
  const P = num(l.amount), n = Math.max(1, Math.round(num(l.months))), annual = num(l.rate) / 100;
  let monthly, totalInterest;
  if (l.method === 'flat') {
    totalInterest = P * annual * (n / 12);
    monthly = (P + totalInterest) / n;
  } else {
    const r = annual / 12;
    monthly = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    totalInterest = monthly * n - P;
  }
  const start = parseDate(l.start);
  const end = addMonths(start, n);
  const now = today();
  let paidCount = 0, nextDue = null;
  for (let k = 1; k <= n; k++) {
    const due = addMonths(start, k);
    if (due < now) paidCount++;
    else { nextDue = due; break; }
  }
  const daysToDue = nextDue ? Math.round((nextDue - now) / 86400000) : null;
  return { monthly, totalInterest, totalPaid: P + totalInterest, end, nextDue, daysToDue, paidCount, n };
}

function futureValue(principal, ratePct, years, monthly) {
  // Lump sum: interest added once a year (1,000,000 at 12% for 1 year = 1,120,000).
  // Monthly top-ups: added at the end of each month, growing at the monthly rate.
  const lump = principal * Math.pow(1 + ratePct / 100, years);
  const r = ratePct / 100 / 12, m = Math.round(years * 12);
  if (r === 0) return lump + monthly * m;
  return lump + monthly * ((Math.pow(1 + r, m) - 1) / r);
}

function goalCalc(g) {
  const remaining = Math.max(0, num(g.target) - num(g.saved));
  const created = g.created ? new Date(g.created) : new Date();
  const deadline = addMonths(created, num(g.months));
  const monthsLeft = Math.max(1, Math.ceil((deadline - today()) / (30.44 * 86400000)));
  const elapsedMonths = Math.max(0, (today() - created) / (30.44 * 86400000));
  const expectedByNow = Math.min(num(g.target), (num(g.target) / num(g.months)) * elapsedMonths);
  return {
    perMonthOriginal: num(g.target) / num(g.months),
    perMonthNow: remaining / monthsLeft,
    remaining, deadline, monthsLeft,
    progress: pct(num(g.saved), num(g.target)),
    behind: num(g.saved) + 1 < expectedByNow && remaining > 0,
  };
}

function alerts() {
  const out = [];
  const t = totals();
  const warnAt = num(state.profile.warnAt) || 80;

  if (t.income > 0 && t.planned > t.income)
    out.push({ level: 'bad', text: `Your planned expenses are ${money(t.planned - t.income)} more than your income.` });
  if (t.income > 0 && t.spent > t.income)
    out.push({ level: 'bad', text: `You have spent ${money(t.spent - t.income)} more than your income this month.` });

  state.expenses.forEach(e => {
    const p = pct(num(e.spent), num(e.budget));
    if (num(e.budget) <= 0) return;
    if (p > 100) out.push({ level: 'bad', text: `Overspent on ${esc(e.category)}: ${money(e.spent)} of ${money(e.budget)} (${p.toFixed(0)}%).` });
    else if (p >= warnAt) out.push({ level: 'warn', text: `You have spent ${p.toFixed(0)}% of your ${esc(e.category)} budget.` });
  });

  state.loans.forEach(l => {
    const c = loanCalc(l);
    if (c.daysToDue !== null && c.daysToDue <= 3)
      out.push({ level: c.daysToDue <= 1 ? 'bad' : 'warn', text: `${esc(l.name)} payment of ${money(c.monthly)} is due ${c.daysToDue === 0 ? 'today' : c.daysToDue === 1 ? 'tomorrow' : `in ${c.daysToDue} days`} (${fmtDate(c.nextDue)}).` });
  });

  state.goals.forEach(g => {
    const c = goalCalc(g);
    if (c.remaining <= 0) out.push({ level: 'good', text: `Goal reached: ${esc(g.name)} 🎉` });
    else if (c.behind) out.push({ level: 'warn', text: `You are behind on “${esc(g.name)}”. Save ${money(c.perMonthNow)} per month to still finish on time.` });
  });

  if (!out.length) {
    if (!state.incomes.length) out.push({ level: 'good', text: 'Start by adding your income and expenses in the Budget tab — or load the example data in Profile & Data.' });
    else out.push({ level: 'good', text: 'All good — no overspending and no loan payments due in the next 3 days.' });
  }
  return out;
}

/* ---------- charts (plain SVG, no internet needed) ---------- */
function pieChart(items) {
  const total = sum(items, i => i.value);
  if (total <= 0) return '<p class="empty">Add expense categories to see this chart.</p>';
  const cx = 110, cy = 110, R = 100, r = 58;
  let angle = -Math.PI / 2, paths = '';
  items.forEach((it, i) => {
    const frac = it.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (rad, rr) => `${(cx + rr * Math.cos(rad)).toFixed(2)},${(cy + rr * Math.sin(rad)).toFixed(2)}`;
    if (frac >= 0.9999) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="${R - r}"/>`;
    } else {
      paths += `<path d="M${p(angle, R)} A${R},${R} 0 ${large} 1 ${p(a2, R)} L${p(a2, r)} A${r},${r} 0 ${large} 0 ${p(angle, r)} Z" fill="${COLORS[i % COLORS.length]}" stroke="var(--card)" stroke-width="2"><title>${esc(it.label)}: ${fmtNum(it.value)}</title></path>`;
    }
    angle = a2;
  });
  const legend = items.map((it, i) =>
    `<div><span><span class="sw" style="background:${COLORS[i % COLORS.length]}"></span>${esc(it.label)}</span><span>${fmtNum(it.value)} · ${pct(it.value, total).toFixed(0)}%</span></div>`).join('');
  return `<svg viewBox="0 0 220 220" style="max-width:240px;margin:0 auto">${paths}
    <text x="110" y="106" text-anchor="middle" style="font-size:11px;fill:var(--muted)">Total</text>
    <text x="110" y="124" text-anchor="middle" style="font-weight:600">${fmtNum(total)}</text></svg>
    <div class="legend">${legend}</div>`;
}

function barChart(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  const W = 360, H = 200, base = 170, top = 20, bw = 60, gap = (W - items.length * bw) / (items.length + 1);
  const bars = items.map((it, i) => {
    const h = ((base - top) * it.value) / max, x = gap + i * (bw + gap);
    return `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="4" fill="${it.color}"><title>${esc(it.label)}: ${fmtNum(it.value)}</title></rect>
      <text x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle">${fmtNum(it.value)}</text>
      <text x="${x + bw / 2}" y="${base + 18}" text-anchor="middle" style="fill:var(--muted)">${esc(it.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--border)"/>${bars}</svg>`;
}

/* ---------- rendering ---------- */
function render() {
  const t = totals();
  const p = state.profile;
  $('#greeting').textContent = p.name ? `Hello ${p.name} — ${p.type}` : 'Plan, track and control your money';

  // KPIs
  $('#k-income').textContent = money(t.income);
  $('#k-expenses').textContent = money(t.planned);
  const kb = $('#k-balance');
  kb.textContent = money(t.balance);
  kb.className = t.balance < 0 ? 'neg' : 'pos';
  $('#k-spent').textContent = money(t.spent);

  // Alerts
  $('#alerts').innerHTML = alerts().map(a => `<li class="${a.level}">${a.text}</li>`).join('');

  // Advice (50 / 30 / 20 split of balance)
  if (t.balance > 0) {
    $('#advice').innerHTML = `<p class="muted">You have <strong>${money(t.balance)}</strong> left each month after planned expenses. A suggested split:</p>
      <table class="list"><tbody>
        <tr><td>50% → Emergency fund</td><td class="num">${money(t.balance * 0.5)}</td></tr>
        <tr><td>30% → Savings goals</td><td class="num">${money(t.balance * 0.3)}</td></tr>
        <tr><td>20% → Investment</td><td class="num">${money(t.balance * 0.2)}</td></tr>
      </tbody></table>`;
  } else if (t.income > 0) {
    $('#advice').innerHTML = `<p class="neg">Your expenses are equal to or more than your income. Reduce spending in the biggest categories below or find extra income before saving.</p>`;
  } else {
    $('#advice').innerHTML = '<p class="empty">Add your income to get advice.</p>';
  }

  // Charts
  const expItems = state.expenses.filter(e => num(e.budget) > 0)
    .map(e => ({ label: e.category, value: num(e.budget) })).sort((a, b) => b.value - a.value);
  $('#pie').innerHTML = pieChart(expItems);
  $('#bars').innerHTML = (t.income || t.planned || t.spent)
    ? barChart([
        { label: 'Income', value: t.income, color: COLORS[0] },
        { label: 'Planned', value: t.planned, color: COLORS[1] },
        { label: 'Spent', value: t.spent, color: t.spent > t.income ? '#c0362c' : COLORS[2] },
      ])
    : '<p class="empty">Add income and expenses to see this chart.</p>';

  // Dashboard goals
  $('#dash-goals').innerHTML = state.goals.length
    ? state.goals.map(g => {
        const c = goalCalc(g);
        return `<div class="goal-row"><div class="item-head"><span>${esc(g.name)}</span><span class="muted">${money(g.saved)} / ${money(g.target)} (${c.progress.toFixed(0)}%)</span></div>${progressBar(c.progress).replace('class="bar ', 'class="bar goal ')}</div>`;
      }).join('')
    : '<p class="empty">No savings goals yet.</p>';

  renderBudget(t);
  renderGoals();
  renderLoans();
  renderInvest();
  renderFuture(t);
}

function renderBudget(t) {
  $('#income-list').innerHTML = state.incomes.length
    ? state.incomes.map(i => `<tr><td>${esc(i.source)}</td><td class="num">${money(i.amount)}</td><td><button class="link" data-del="incomes" data-id="${i.id}" title="Delete">✕</button></td></tr>`).join('')
      + `<tr><th>Total</th><th class="num">${money(t.income)}</th><th></th></tr>`
    : '<tr><td colspan="3" class="empty">No income added yet.</td></tr>';

  $('#expense-list').innerHTML = state.expenses.length
    ? state.expenses.map(e => {
        const p = pct(num(e.spent), num(e.budget));
        return `<tr><td>${esc(e.category)}</td><td class="num">${money(e.budget)}</td><td class="num">${money(e.spent)}</td>
          <td>${progressBar(p)}<span class="small muted">${p.toFixed(0)}%</span></td>
          <td><button class="link" data-del="expenses" data-id="${e.id}" title="Delete">✕</button></td></tr>`;
      }).join('')
    : '<tr><td colspan="5" class="empty">No expense categories yet.</td></tr>';

  $('#budget-summary').innerHTML = t.income || t.planned
    ? `Total income ${money(t.income)} − total planned expenses ${money(t.planned)} = <span class="${t.balance < 0 ? 'neg' : 'pos'}">balance ${money(t.balance)}</span>`
      + (t.balance < 0 ? ' <span class="neg">⚠ You are planning to overspend.</span>' : '')
    : '';

  const sel = $('#spend-category');
  const current = sel.value;
  sel.innerHTML = state.expenses.length
    ? state.expenses.map(e => `<option value="${e.id}">${esc(e.category)}</option>`).join('')
    : '<option value="">Add a category first</option>';
  if (state.expenses.some(e => e.id === current)) sel.value = current;
}

function renderGoals() {
  $('#goal-list').innerHTML = state.goals.length ? state.goals.map(g => {
    const c = goalCalc(g);
    return `<div class="card">
      <div class="item-head"><h2>${esc(g.name)}</h2><button class="link" data-del="goals" data-id="${g.id}">Delete</button></div>
      ${progressBar(c.progress).replace('class="bar ', 'class="bar goal ')}
      <div class="facts">
        <div><span>Target</span><strong>${money(g.target)}</strong></div>
        <div><span>Saved</span><strong>${money(g.saved)} (${c.progress.toFixed(0)}%)</strong></div>
        <div><span>Plan</span><strong>${money(c.perMonthOriginal)} / month for ${fmtNum(g.months)} months</strong></div>
        <div><span>Deadline</span><strong>${fmtDate(c.deadline)}</strong></div>
        <div><span>Needed now</span><strong class="${c.behind ? 'warn-text' : ''}">${c.remaining > 0 ? `${money(c.perMonthNow)} / month` : 'Done 🎉'}</strong></div>
      </div>
      <form class="row-form" data-contribute="${g.id}">
        <input name="amount" type="number" step="any" placeholder="Add savings (use − to withdraw)" required>
        <button class="primary">Add to goal</button>
      </form>
    </div>`;
  }).join('') : '<div class="card"><p class="empty">No goals yet. Create one above.</p></div>';
}

function renderLoans() {
  $('#loan-list').innerHTML = state.loans.length ? state.loans.map(l => {
    const c = loanCalc(l);
    const dueText = c.nextDue
      ? `${fmtDate(c.nextDue)} (${c.daysToDue === 0 ? 'today' : `in ${c.daysToDue} day${c.daysToDue === 1 ? '' : 's'}`})`
      : 'Fully paid';
    return `<div class="card">
      <div class="item-head"><h2>${esc(l.name)}</h2><button class="link" data-del="loans" data-id="${l.id}">Delete</button></div>
      <p class="muted small">${money(l.amount)} at ${num(l.rate)}% per year, ${l.method === 'flat' ? 'flat rate' : 'reducing balance'}, ${fmtNum(c.n)} months from ${fmtDate(parseDate(l.start))}</p>
      <div class="facts">
        <div><span>Monthly repayment</span><strong>${money(c.monthly)}</strong></div>
        <div><span>Total interest</span><strong>${money(c.totalInterest)}</strong></div>
        <div><span>Total to pay back</span><strong>${money(c.totalPaid)}</strong></div>
        <div><span>Loan ends</span><strong>${fmtDate(c.end)}</strong></div>
        <div><span>Next payment</span><strong class="${c.daysToDue !== null && c.daysToDue <= 3 ? 'warn-text' : ''}">${dueText}</strong></div>
        <div><span>Payments made (by date)</span><strong>${c.paidCount} of ${c.n}</strong></div>
      </div>
      ${progressBar(pct(c.paidCount, c.n)).replace('class="bar ', 'class="bar goal ')}
    </div>`;
  }).join('') : '<div class="card"><p class="empty">No loans added.</p></div>';
}

function renderInvest() {
  const inv = state.invest;
  const f = $('#form-invest');
  if (document.activeElement?.form !== f) {
    f.amount.value = inv.amount; f.years.value = inv.years; f.monthly.value = inv.monthly || '';
  }
  const invested = num(inv.amount) + num(inv.monthly) * Math.round(num(inv.years) * 12);
  const rows = inv.options.map((o, i) => {
    const fv = futureValue(num(inv.amount), num(o.rate), num(inv.years), num(inv.monthly));
    return { o, i, fv, gain: fv - invested };
  });
  const best = Math.max(...rows.map(r => r.fv));
  const tbody = $('#invest-list');
  const focusedIdx = document.activeElement?.dataset?.rate;
  if (focusedIdx !== undefined && tbody.contains(document.activeElement)) {
    // update numbers only, keep the input being typed in
    rows.forEach(r => {
      const tr = tbody.children[r.i];
      tr.children[3].innerHTML = money(r.fv) + (r.fv === best ? ' ★' : '');
      tr.children[4].textContent = money(r.gain);
    });
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
      <td>${esc(r.o.name)}</td>
      <td class="num"><input type="number" step="any" data-rate="${r.i}" value="${r.o.rate}"></td>
      <td>${esc(r.o.risk)}</td>
      <td class="num">${money(r.fv)}${r.fv === best ? ' ★' : ''}</td>
      <td class="num">${money(r.gain)}</td></tr>`).join('');
}

function renderFuture(t) {
  // Emergency fund
  const em = state.emergency, fe = $('#form-emergency');
  if (document.activeElement?.form !== fe) {
    fe.months.value = em.months; fe.monthlyExpenses.value = em.monthlyExpenses; fe.saved.value = em.saved || '';
  }
  const monthly = em.monthlyExpenses !== '' && num(em.monthlyExpenses) > 0 ? num(em.monthlyExpenses) : t.planned;
  const need = monthly * num(em.months);
  const gap = Math.max(0, need - num(em.saved));
  const monthlySaving = t.balance > 0 ? t.balance * 0.5 : 0;
  $('#emergency-result').innerHTML = monthly > 0 ? `
    <p>Monthly expenses: <strong>${money(monthly)}</strong></p>
    <p>Emergency fund needed (${em.months} months): <strong>${money(need)}</strong></p>
    <p>Still to save: <strong class="${gap > 0 ? 'warn-text' : 'pos'}">${money(gap)}</strong></p>
    ${progressBar(pct(num(em.saved), need)).replace('class="bar ', 'class="bar goal ')}
    ${gap > 0 && monthlySaving > 0 ? `<p class="muted small">Saving 50% of your balance (${money(monthlySaving)}/month) you will be done in about ${Math.ceil(gap / monthlySaving)} months.</p>` : ''}`
    : '<p class="empty">Add expenses in the Budget tab or type your monthly expenses.</p>';

  // Retirement
  const r = state.retire, fr = $('#form-retire');
  if (document.activeElement?.form !== fr) {
    for (const k of Object.keys(r)) if (fr[k]) fr[k].value = r[k];
  }
  const years = num(r.retireAge) - num(r.age);
  if (years <= 0) { $('#retire-result').innerHTML = '<p class="neg">Retirement age must be greater than current age.</p>'; return; }
  const inf = num(r.inflation) / 100, ret = num(r.returnRate) / 100;
  const futureMonthly = num(r.monthlyNeed) * Math.pow(1 + inf, years);
  // Money needed at retirement: present value of the yearly need, growing with inflation, earning `ret` during retirement.
  const yearly = futureMonthly * 12, Y = num(r.years);
  const realRate = (1 + ret) / (1 + inf) - 1;
  const corpus = Math.abs(realRate) < 1e-9 ? yearly * Y : yearly * (1 - Math.pow(1 + realRate, -Y)) / realRate * (1 + realRate);
  const rm = ret / 12, N = years * 12;
  const savedFV = num(r.saved) * Math.pow(1 + rm, N);
  const shortfall = Math.max(0, corpus - savedFV);
  const perMonth = rm === 0 ? shortfall / N : shortfall * rm / (Math.pow(1 + rm, N) - 1);
  $('#retire-result').innerHTML = `
    <p>Years until retirement: <strong>${years}</strong></p>
    <p>${money(r.monthlyNeed)} today will cost about <strong>${money(futureMonthly)}</strong> per month in ${years} years (inflation ${num(r.inflation)}%).</p>
    <p>Total needed at retirement: <strong>${money(corpus)}</strong></p>
    <p>Your current savings will grow to: <strong>${money(savedFV)}</strong></p>
    <p>You need to save: <strong class="${shortfall > 0 ? 'warn-text' : 'pos'}">${shortfall > 0 ? `${money(perMonth)} per month` : 'nothing more — you are on track 🎉'}</strong></p>
    <p class="muted small">Estimate only. Assumes a steady return and inflation; real results will vary.</p>`;
}

/* ---------- events ---------- */
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${b.dataset.tab}`));
  try { sessionStorage.setItem('fpt.tab', b.dataset.tab); } catch { /* ignore */ }
});

function onSubmit(id, fn) {
  $(id).addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (fn(data, e.target) !== false) { e.target.reset(); save(); }
  });
}

onSubmit('#form-income', d => {
  state.incomes.push({ id: uid(), source: d.source.trim(), amount: num(d.amount) });
  toast('Income added');
});

onSubmit('#form-expense', d => {
  const name = d.category.trim();
  const existing = state.expenses.find(x => x.category.toLowerCase() === name.toLowerCase());
  if (existing) { existing.budget = num(d.budget); toast(`${name} budget updated`); }
  else { state.expenses.push({ id: uid(), category: name, budget: num(d.budget), spent: 0 }); toast('Category added'); }
});

onSubmit('#form-spend', d => {
  const e = state.expenses.find(x => x.id === d.category);
  if (!e) { toast('Add an expense category first'); return false; }
  e.spent = num(e.spent) + num(d.amount);
  state.transactions.push({ id: uid(), categoryId: e.id, amount: num(d.amount), date: isoToday() });
  const p = pct(e.spent, num(e.budget));
  toast(p > 100 ? `⚠ Over budget on ${e.category}!` : `Logged. ${p.toFixed(0)}% of ${e.category} budget used`);
});

$('#btn-new-month').addEventListener('click', () => {
  if (!confirm('Reset spending for all categories to zero? Budgets stay the same.')) return;
  state.expenses.forEach(e => { e.spent = 0; });
  save(); toast('New month started');
});

onSubmit('#form-goal', d => {
  state.goals.push({ id: uid(), name: d.name.trim(), target: num(d.target), months: Math.max(1, Math.round(num(d.months))), saved: num(d.saved), created: today().toISOString() });
  toast(`Plan: save ${money(num(d.target) / Math.max(1, Math.round(num(d.months))))} per month`);
});

onSubmit('#form-loan', d => {
  state.loans.push({ id: uid(), name: d.name.trim(), amount: num(d.amount), rate: num(d.rate), months: Math.max(1, Math.round(num(d.months))), start: d.start, method: d.method });
  toast('Loan saved');
});

// delete buttons + goal contributions (delegated)
document.addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const list = b.dataset.del;
  if (!confirm('Delete this item?')) return;
  state[list] = state[list].filter(x => x.id !== b.dataset.id);
  if (list === 'expenses') state.transactions = state.transactions.filter(t => t.categoryId !== b.dataset.id);
  if (list === 'goals') state.contributions = state.contributions.filter(c => c.goalId !== b.dataset.id);
  save();
});
document.addEventListener('submit', e => {
  const id = e.target.dataset.contribute;
  if (!id) return;
  e.preventDefault();
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  const amount = num(new FormData(e.target).get('amount'));
  g.saved = Math.max(0, num(g.saved) + amount);
  state.contributions.push({ id: uid(), goalId: g.id, amount, date: isoToday() });
  save();
  toast(g.saved >= num(g.target) ? `Goal “${g.name}” reached! 🎉` : 'Savings updated');
});

// live forms
$('#form-invest').addEventListener('input', e => {
  const f = e.currentTarget;
  state.invest.amount = num(f.amount.value); state.invest.years = num(f.years.value); state.invest.monthly = num(f.monthly.value);
  save();
});
$('#invest-list').addEventListener('input', e => {
  const i = e.target.dataset.rate;
  if (i === undefined) return;
  state.invest.options[i].rate = num(e.target.value);
  save();
});
$('#form-emergency').addEventListener('input', e => {
  const f = e.currentTarget;
  state.emergency = { months: num(f.months.value), monthlyExpenses: f.monthlyExpenses.value, saved: num(f.saved.value) };
  save();
});
$('#form-emergency').addEventListener('change', e => e.currentTarget.dispatchEvent(new Event('input')));
$('#form-retire').addEventListener('input', e => {
  const f = e.currentTarget;
  for (const k of Object.keys(state.retire)) if (f[k]) state.retire[k] = num(f[k].value);
  save();
});
$('#form-profile').addEventListener('input', e => {
  const f = e.currentTarget;
  state.profile = { name: f.name.value, type: f.type.value, currency: f.currency.value, familySize: num(f.familySize.value) || 1, risk: f.risk.value, warnAt: num(f.warnAt.value) || 80 };
  save();
});
$('#form-profile').addEventListener('change', e => e.currentTarget.dispatchEvent(new Event('input')));

$('#btn-print').addEventListener('click', () => window.print());

$('#btn-sample').addEventListener('click', () => {
  if ((state.incomes.length || state.expenses.length) && !confirm('Replace your current budget, goals and loans with example data?')) return;
  const start = addMonths(today(), -3);
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  state.incomes = [{ id: uid(), source: 'Salary', amount: 1500000 }];
  state.transactions = [];
  state.contributions = [];
  state.expenses = [
    { id: uid(), category: 'Rent', budget: 400000, spent: 400000 },
    { id: uid(), category: 'Food', budget: 350000, spent: 290000 },
    { id: uid(), category: 'Transport', budget: 200000, spent: 120000 },
    { id: uid(), category: 'Others', budget: 250000, spent: 90000 },
  ];
  state.goals = [{ id: uid(), name: 'Laptop', target: 2000000, months: 10, saved: 400000, created: addMonths(today(), -2).toISOString() }];
  state.loans = [{ id: uid(), name: 'SACCO loan', amount: 3000000, rate: 18, months: 12, start: startStr, method: 'reducing' }];
  save(); toast('Example data loaded');
});

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financial-plan-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#file-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state = mergeDefaults(JSON.parse(await file.text()));
    fillProfile(); save(); toast('Backup imported');
  } catch { toast('That file is not a valid backup'); }
  e.target.value = '';
});

$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Delete ALL your financial data from this device? This cannot be undone.')) return;
  state = defaultState(); fillProfile(); save(); toast('All data deleted');
});

function fillProfile() {
  const f = $('#form-profile'), p = state.profile;
  f.name.value = p.name; f.type.value = p.type; f.currency.value = p.currency;
  f.familySize.value = p.familySize; f.risk.value = p.risk; f.warnAt.value = p.warnAt;
}

/* ---------- online account (only when served by server/server.js) ---------- */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status });
  return json;
}

let syncTimer = null;
function setSyncStatus(text) { $('#sync-status').textContent = text; }
function scheduleSync() {
  setSyncStatus('Saving…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 800);
}
async function syncNow() {
  clearTimeout(syncTimer);
  try { await api('PUT', '/api/data', { data: state }); setSyncStatus('Saved online'); }
  catch (err) {
    if (err.status === 401) { setSyncStatus('Logged out'); showAuth('Your session expired. Please log in again — your last changes will be saved.'); }
    else { setSyncStatus('Not saved — will retry'); syncTimer = setTimeout(syncNow, 10000); }
  }
}
window.addEventListener('beforeunload', e => {
  if (mode === 'online' && $('#sync-status').textContent !== 'Saved online') { syncNow(); e.preventDefault(); }
});

function showAuth(message = '') {
  $('#auth').hidden = false;
  $('#auth-error').textContent = message;
}

async function startOnline(user) {
  mode = 'online';
  $('#auth').hidden = true;
  $('#account-card').hidden = false;
  $('#save-note').textContent = 'Saved to your online account. Use “Account & alerts” to get SMS / email alerts.';
  fillAccount(user);
  const { data } = await api('GET', '/api/data');
  if (data) state = mergeDefaults(data);
  else {
    // First login: move any plan already on this device into the account.
    state = load();
    if (!state.profile.name) state.profile.name = user.name;
    await syncNow();
  }
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  setSyncStatus('Saved online');
  fillProfile();
  render();
  loadSentAlerts();
}

function fillAccount(user) {
  $('#acc-email').textContent = user.email;
  const f = $('#form-account');
  f.phone.value = user.phone; f.alertEmail.checked = user.alertEmail; f.alertSms.checked = user.alertSms;
}

async function loadSentAlerts() {
  try {
    const { alerts } = await api('GET', '/api/alerts');
    $('#sent-alerts').innerHTML = alerts.length
      ? alerts.map(a => `<li><span class="muted small">${esc(a.sent_at)} UTC · ${esc(a.channel)}</span><br>${esc(a.message)}</li>`).join('')
      : '<li class="empty">No alerts sent yet.</li>';
  } catch { /* ignore */ }
}

document.querySelectorAll('[data-auth]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-auth]').forEach(x => x.classList.toggle('active', x === b));
  $('#form-login').hidden = b.dataset.auth !== 'login';
  $('#form-register').hidden = b.dataset.auth !== 'register';
  $('#auth-error').textContent = '';
}));

async function authSubmit(e, url) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true; $('#auth-error').textContent = '';
  try {
    const { user } = await api('POST', url, Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    if (mode === 'online') { $('#auth').hidden = true; fillAccount(user); await syncNow(); } // re-login after expiry
    else await startOnline(user);
    toast(`Welcome, ${user.name}`);
  } catch (err) { $('#auth-error').textContent = err.message; }
  finally { btn.disabled = false; }
}
$('#form-login').addEventListener('submit', e => authSubmit(e, '/api/login'));
$('#form-register').addEventListener('submit', e => authSubmit(e, '/api/register'));
$('#btn-offline').addEventListener('click', () => { $('#auth').hidden = true; });

$('#form-account').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const { user } = await api('PUT', '/api/settings', { name: state.profile.name, phone: f.phone.value, alertEmail: f.alertEmail.checked, alertSms: f.alertSms.checked });
    fillAccount(user);
    toast(f.alertSms.checked && !user.alertSms ? 'Add a phone number to turn on SMS alerts' : 'Alert settings saved');
  } catch (err) { toast(err.message); }
});
$('#btn-test-alert').addEventListener('click', async () => {
  try {
    const { result } = await api('POST', '/api/alerts/test', {});
    const parts = Object.entries(result).map(([ch, r]) => `${ch}: ${r.ok ? (r.dryRun ? 'dry run (not configured on server)' : 'sent') : `failed — ${r.error}`}`);
    toast(parts.join(' · '));
  } catch (err) { toast(err.message); }
});
$('#btn-check-alerts').addEventListener('click', async () => {
  try {
    await syncNow();
    const { sent } = await api('POST', '/api/alerts/check', {});
    toast(sent ? `${sent} new alert(s) sent` : 'No new alerts to send');
    loadSentAlerts();
  } catch (err) { toast(err.message); }
});
$('#btn-logout').addEventListener('click', async () => {
  await syncNow();
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  location.reload();
});
$('#form-password').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('POST', '/api/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Password changed'); }
  catch (err) { toast(err.message); }
});

/* ---------- start ---------- */
$('#form-loan').start.value = new Date().toISOString().slice(0, 10);
fillProfile();
try {
  const tab = sessionStorage.getItem('fpt.tab');
  if (tab) document.querySelector(`#tabs button[data-tab="${tab}"]`)?.click();
} catch { /* ignore */ }
render();

(async function init() {
  if (!location.protocol.startsWith('http')) return; // opened as a file: offline mode
  try {
    const { user } = await api('GET', '/api/me');
    await startOnline(user);
  } catch (err) {
    if (err.status === 401) showAuth(); // server is there, user not logged in
    // any other error (no server, e.g. a plain static host): stay in offline mode
  }
})();

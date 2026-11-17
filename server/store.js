'use strict';
/* Database tables for each user's plan, and conversion between the app's plan object and those tables. */

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const money = v => Math.round(v * 100) / 100;
const text = (v, max = 200) => String(v ?? '').slice(0, max);

function addMonths(date, m) {
  const d = new Date(date.getFullYear(), date.getMonth() + m, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function loanFigures(l) {
  const P = num(l.amount), n = Math.max(1, Math.round(num(l.months))), annual = num(l.rate) / 100;
  let monthly, interest;
  if (l.method === 'flat') { interest = P * annual * (n / 12); monthly = (P + interest) / n; }
  else {
    const r = annual / 12;
    monthly = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    interest = monthly * n - P;
  }
  const [y, m, d] = String(l.start || '').split('-').map(Number);
  const end = y ? isoDay(addMonths(new Date(y, (m || 1) - 1, d || 1), n)) : null;
  return { monthly, interest, end, n };
}
function futureValue(principal, ratePct, years, monthly) {
  const lump = principal * Math.pow(1 + ratePct / 100, years);
  const r = ratePct / 100 / 12, m = Math.round(years * 12);
  return r === 0 ? lump + monthly * m : lump + monthly * ((Math.pow(1 + r, m) - 1) / r);
}

function createTables(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const addCol = (name, def) => { if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`); };
  addCol('user_type', "TEXT NOT NULL DEFAULT 'Individual / Student'");
  addCol('family_size', 'INTEGER NOT NULL DEFAULT 1');
  addCol('risk_level', "TEXT NOT NULL DEFAULT 'medium'");
  addCol('currency', "TEXT NOT NULL DEFAULT 'UGX'");
  addCol('warn_percent', 'INTEGER NOT NULL DEFAULT 80');

  db.exec(`
    CREATE TABLE IF NOT EXISTS incomes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      income_id TEXT NOT NULL,
      source TEXT NOT NULL,
      amount REAL NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, income_id)
    );
    CREATE TABLE IF NOT EXISTS expense_categories (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      monthly_budget REAL NOT NULL,
      spent_this_month REAL NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      user_id INTEGER NOT NULL,
      transaction_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      amount REAL NOT NULL,
      txn_date TEXT NOT NULL,
      PRIMARY KEY (user_id, transaction_id),
      FOREIGN KEY (user_id, category_id) REFERENCES expense_categories(user_id, category_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS savings_goals (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      months INTEGER NOT NULL,
      monthly_plan REAL NOT NULL,
      saved_amount REAL NOT NULL,
      start_date TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, goal_id)
    );
    CREATE TABLE IF NOT EXISTS goal_contributions (
      user_id INTEGER NOT NULL,
      contribution_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      amount REAL NOT NULL,
      contribution_date TEXT NOT NULL,
      PRIMARY KEY (user_id, contribution_id),
      FOREIGN KEY (user_id, goal_id) REFERENCES savings_goals(user_id, goal_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS loans (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      loan_id TEXT NOT NULL,
      lender TEXT NOT NULL,
      principal REAL NOT NULL,
      interest_rate REAL NOT NULL,
      period_months INTEGER NOT NULL,
      method TEXT NOT NULL,
      monthly_payment REAL NOT NULL,
      total_interest REAL NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, loan_id)
    );
    CREATE TABLE IF NOT EXISTS investments (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      option_name TEXT NOT NULL,
      risk TEXT NOT NULL,
      amount REAL NOT NULL,
      monthly_topup REAL NOT NULL,
      expected_rate REAL NOT NULL,
      years REAL NOT NULL,
      expected_value REAL NOT NULL,
      PRIMARY KEY (user_id, position)
    );
    CREATE TABLE IF NOT EXISTS plans (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      emergency_months INTEGER NOT NULL,
      emergency_monthly_expenses REAL,
      emergency_saved REAL NOT NULL,
      current_age INTEGER NOT NULL,
      retire_age INTEGER NOT NULL,
      retire_monthly_need REAL NOT NULL,
      retire_years INTEGER NOT NULL,
      retire_saved REAL NOT NULL,
      expected_return REAL NOT NULL,
      inflation REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/* Replace everything stored for this user with the given plan (one transaction: all or nothing). */
function saveState(db, userId, s) {
  const arr = v => (Array.isArray(v) ? v : []);
  const p = s.profile || {}, inv = s.invest || {}, em = s.emergency || {}, r = s.retire || {};
  db.exec('BEGIN');
  try {
    for (const t of ['transactions', 'goal_contributions', 'incomes', 'expense_categories', 'savings_goals', 'loans', 'investments', 'plans'])
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);

    db.prepare(`UPDATE users SET name = COALESCE(NULLIF(?, ''), name), user_type = ?, family_size = ?, risk_level = ?, currency = ?, warn_percent = ? WHERE id = ?`)
      .run(text(p.name, 100).trim(), text(p.type || 'Individual / Student', 50), Math.max(1, Math.round(num(p.familySize)) || 1),
        ['low', 'medium', 'high'].includes(p.risk) ? p.risk : 'medium', text(p.currency || 'UGX', 5), Math.round(num(p.warnAt)) || 80, userId);

    const insIncome = db.prepare('INSERT OR REPLACE INTO incomes VALUES (?, ?, ?, ?, ?)');
    arr(s.incomes).forEach((i, k) => insIncome.run(userId, text(i.id, 40), text(i.source, 100), num(i.amount), k));

    const insCat = db.prepare('INSERT OR REPLACE INTO expense_categories VALUES (?, ?, ?, ?, ?, ?)');
    const catIds = new Set();
    arr(s.expenses).forEach((e, k) => { catIds.add(text(e.id, 40)); insCat.run(userId, text(e.id, 40), text(e.category, 50), num(e.budget), num(e.spent), k); });

    const insTxn = db.prepare('INSERT OR REPLACE INTO transactions VALUES (?, ?, ?, ?, ?)');
    for (const t of arr(s.transactions))
      if (catIds.has(text(t.categoryId, 40))) insTxn.run(userId, text(t.id, 40), text(t.categoryId, 40), num(t.amount), text(t.date, 10));

    const insGoal = db.prepare('INSERT OR REPLACE INTO savings_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const goalIds = new Set();
    arr(s.goals).forEach((g, k) => {
      const months = Math.max(1, Math.round(num(g.months)));
      goalIds.add(text(g.id, 40));
      insGoal.run(userId, text(g.id, 40), text(g.name, 100), num(g.target), months, money(num(g.target) / months), num(g.saved),
        text(g.created || new Date().toISOString(), 30), num(g.saved) >= num(g.target) ? 'achieved' : 'active', k);
    });

    const insContrib = db.prepare('INSERT OR REPLACE INTO goal_contributions VALUES (?, ?, ?, ?, ?)');
    for (const c of arr(s.contributions))
      if (goalIds.has(text(c.goalId, 40))) insContrib.run(userId, text(c.id, 40), text(c.goalId, 40), num(c.amount), text(c.date, 10));

    const insLoan = db.prepare('INSERT OR REPLACE INTO loans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    arr(s.loans).forEach((l, k) => {
      const f = loanFigures(l);
      insLoan.run(userId, text(l.id, 40), text(l.name, 100), num(l.amount), num(l.rate), f.n, l.method === 'flat' ? 'flat' : 'reducing',
        money(f.monthly), money(f.interest), text(l.start, 10), f.end, k);
    });

    const insInv = db.prepare('INSERT INTO investments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    arr(inv.options).forEach((o, k) => insInv.run(userId, k, text(o.name, 60), text(o.risk, 20), num(inv.amount), num(inv.monthly),
      num(o.rate), num(inv.years), money(futureValue(num(inv.amount), num(o.rate), num(inv.years), num(inv.monthly)))));

    db.prepare('INSERT INTO plans (user_id, emergency_months, emergency_monthly_expenses, emergency_saved, current_age, retire_age, retire_monthly_need, retire_years, retire_saved, expected_return, inflation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, Math.round(num(em.months)) || 6, em.monthlyExpenses === '' || em.monthlyExpenses == null ? null : num(em.monthlyExpenses), num(em.saved),
        Math.round(num(r.age)), Math.round(num(r.retireAge)), num(r.monthlyNeed), Math.round(num(r.years)), num(r.saved), num(r.returnRate), num(r.inflation));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Build the app's plan object back from the tables. Returns null if the user has never saved a plan. */
function loadState(db, userId) {
  const plan = db.prepare('SELECT * FROM plans WHERE user_id = ?').get(userId);
  if (!plan) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const all = (sql) => db.prepare(sql).all(userId);
  const inv = all('SELECT * FROM investments WHERE user_id = ? ORDER BY position');
  return {
    profile: { name: u.name, type: u.user_type, currency: u.currency, familySize: u.family_size, risk: u.risk_level, warnAt: u.warn_percent },
    incomes: all('SELECT * FROM incomes WHERE user_id = ? ORDER BY position').map(i => ({ id: i.income_id, source: i.source, amount: i.amount })),
    expenses: all('SELECT * FROM expense_categories WHERE user_id = ? ORDER BY position')
      .map(e => ({ id: e.category_id, category: e.name, budget: e.monthly_budget, spent: e.spent_this_month })),
    transactions: all('SELECT * FROM transactions WHERE user_id = ? ORDER BY txn_date')
      .map(t => ({ id: t.transaction_id, categoryId: t.category_id, amount: t.amount, date: t.txn_date })),
    goals: all('SELECT * FROM savings_goals WHERE user_id = ? ORDER BY position')
      .map(g => ({ id: g.goal_id, name: g.name, target: g.target_amount, months: g.months, saved: g.saved_amount, created: g.start_date })),
    contributions: all('SELECT * FROM goal_contributions WHERE user_id = ? ORDER BY contribution_date')
      .map(c => ({ id: c.contribution_id, goalId: c.goal_id, amount: c.amount, date: c.contribution_date })),
    loans: all('SELECT * FROM loans WHERE user_id = ? ORDER BY position')
      .map(l => ({ id: l.loan_id, name: l.lender, amount: l.principal, rate: l.interest_rate, months: l.period_months, start: l.start_date, method: l.method })),
    invest: inv.length
      ? { amount: inv[0].amount, years: inv[0].years, monthly: inv[0].monthly_topup, options: inv.map(o => ({ name: o.option_name, rate: o.expected_rate, risk: o.risk })) }
      : undefined,
    emergency: { months: plan.emergency_months, monthlyExpenses: plan.emergency_monthly_expenses ?? '', saved: plan.emergency_saved },
    retire: { age: plan.current_age, retireAge: plan.retire_age, monthlyNeed: plan.retire_monthly_need, years: plan.retire_years,
      saved: plan.retire_saved, returnRate: plan.expected_return, inflation: plan.inflation },
  };
}

/* One-time move from the old single-record storage (user_data) into the tables. */
function migrateOldData(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_data'").get();
  if (!exists) return;
  for (const row of db.prepare('SELECT user_id, data FROM user_data').all()) {
    try { saveState(db, row.user_id, JSON.parse(row.data)); } catch (err) { console.error(`Could not migrate user ${row.user_id}:`, err.message); return; }
  }
  db.exec('DROP TABLE user_data');
  console.log('Moved saved plans into the new database tables.');
}

module.exports = { createTables, saveState, loadState, migrateOldData };

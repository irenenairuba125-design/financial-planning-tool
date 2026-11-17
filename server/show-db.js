'use strict';
/* Prints every table in the database:  npm run db   (password hashes and session tokens are hidden) */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'app.db');
const db = new DatabaseSync(file, { readOnly: true });
const tables = ['users', 'incomes', 'expense_categories', 'transactions', 'savings_goals', 'goal_contributions',
  'loans', 'investments', 'plans', 'alerts_sent'];
console.log(`Database: ${file}\n`);
for (const t of tables) {
  let rows;
  try { rows = db.prepare(`SELECT * FROM ${t}`).all(); } catch { continue; }
  console.log(`== ${t} (${rows.length} row${rows.length === 1 ? '' : 's'}) ==`);
  if (rows.length) console.table(rows.map(r => { const { password_hash, ...rest } = r; return rest; }));
  console.log();
}

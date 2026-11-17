# Financial Planning Tool

Budgeting, savings goals, loans, investments, emergency fund and retirement planning, with a login, an online database and SMS / email alerts.

## Two ways to use it

**1. Offline (no setup):** double-click `index.html`. Data is saved in that browser only.

**2. With accounts and alerts (needs Node.js 22.5 or newer):**

```
npm install
npm start
```

Then open http://localhost:3000, create an account and log in. Plans are saved in `data/app.db` (SQLite).

## Turning on real alerts

Copy `.env.example` to `.env` and fill in:

- **Email:** any SMTP account (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).
- **SMS:** an [Africa's Talking](https://africastalking.com) account (`AT_USERNAME`, `AT_API_KEY`). Use `AT_USERNAME=sandbox` to test for free.

Without these, alerts are only printed in the server console ("dry run").
The server checks every user's plan every `ALERT_CHECK_MINUTES` (default 60) and sends each alert once:
80% of a category budget, overspending, spending above income, and loan payments due within 3 days.

## Putting it online

Deploy the folder to any host that runs Node.js and keeps files on disk (a VPS, Render or Railway with a persistent disk).
Point `DATA_DIR` at the persistent disk, serve it over HTTPS and set `COOKIE_SECURE=1`. Back up `data/app.db` regularly.

## Security

- Passwords hashed with scrypt; sessions are random tokens stored hashed, in HttpOnly cookies.
- Login is locked for 15 minutes after 10 failed attempts.
- All writes must be JSON requests (blocks cross-site form attacks).
- Each user can only read and change their own plan.

# Ticker — real accounts, real database, paper-trading crypto

This is the full-stack version of the Ticker app: a Node.js backend with
genuine password hashing, sessions, and a **real relational SQLite
database**, serving the same frontend you already had.

## What's actually real here

- **Passwords are hashed properly** — scrypt with a random salt per user
  (Node's built-in `crypto.scryptSync`), compared with a timing-safe check.
  Nothing is stored in plain text.
- **Sessions are real** — a random 32-byte token is issued on login/signup and
  verified server-side on every request.
- **A real relational database** — `data/ticker.db` is an actual SQLite file
  with four proper tables (`users`, `sessions`, `holdings`, `transactions`),
  foreign keys linking them, and real SQL queries (including an `UPSERT` for
  accumulating coin holdings across multiple purchases). It's built on
  Node's own built-in `node:sqlite` module — no npm install, no native
  compilation, works anywhere Node 22+ runs.
- **The server is the source of truth for prices and balances** — the browser
  no longer decides what a "purchase" costs; the backend does, and it
  rejects buys that would overdraw the account.

You can inspect the database directly with any SQLite tool — DB Browser for
SQLite, the `sqlite3` CLI, or a one-off Node script:

```js
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/ticker.db");
console.log(db.prepare("SELECT * FROM users").all());
```

## What's intentionally NOT real

- **The USD balance is fake paper money** ($10,000 credited to every new
  account). No real bank account, card, or payment processor is involved.
- **"Buying" a coin does not move any real money or real cryptocurrency.**
  It debits your paper balance and credits a paper holding in the database.
- **Prices are simulated** — a random walk seeded from realistic recent
  levels, not a live market feed.

## Why it stops there

Turning this into something that moves real money or real crypto is not a
coding task you finish in an afternoon — it's a regulated financial
business. At minimum it would require:

- A **money transmitter license** (or equivalent) in every jurisdiction you
  operate in, or partnering with someone who already holds one.
- **KYC/AML compliance** — identity verification, transaction monitoring,
  sanctions screening.
- A licensed **exchange or custody partner** (e.g. Coinbase, Kraken, and
  similar all have institutional APIs for exactly this, but onboarding goes
  through legal agreements and compliance review, not just an API key).
- Real security hardening: HTTPS/TLS, rate limiting, fraud detection,
  audited infrastructure, and a lot more than a demo server should attempt.

None of that is something to bolt on casually, and this project deliberately
stops at the "real accounts, fake money" line for that reason.

## Payment gateway (adding real-money-funded paper balance)

You can add funds to your **paper trading balance** using either **Stripe**
or **Square**, in their test/sandbox modes — a provider toggle in the Add
Funds modal lets you pick. Both are genuine integrations with the real
REST APIs (no SDKs — built with Node's own `https` module, so the project
stays dependency-free): real checkout session/payment link creation, real
payment-status verification, real database crediting.

**What this does and doesn't do:**
- ✅ Real Stripe Checkout Sessions and real Square Payment Links, real
  sandbox payment flows, real server-side verification before crediting.
- ❌ Does **not** let you buy real cryptocurrency, on either provider. It
  only adds simulated USD to your paper trading balance, same as
  everything else in this app. Turning this into an actual crypto on-ramp
  is a different, heavily regulated undertaking — see "Why it stops
  there" above.

### Setting up Stripe

1. Create a free Stripe account at https://dashboard.stripe.com/register
   (no business verification needed to use test mode).
2. Go to https://dashboard.stripe.com/test/apikeys and copy your
   **Secret key** (starts with `sk_test_...`).
3. Set it as an environment variable when starting the server (see below).
4. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any
   3-digit CVC, any billing ZIP.

### Setting up Square

1. Create a free Square developer account at
   https://developer.squareup.com/apps
2. Create an app, then find the **Sandbox** section for that app — you'll
   need the **Sandbox Access Token** and a **Sandbox Location ID** (Square
   auto-creates a test location; find its ID under Sandbox Test Accounts,
   or via a `GET /v2/locations` call).
3. Set both as environment variables when starting the server.
4. Square's sandbox checkout page has its own test card numbers, shown
   directly on the payment page — no need to look them up separately.

### Running with both configured

```
# macOS/Linux
STRIPE_SECRET_KEY=sk_test_xxx \
SQUARE_ACCESS_TOKEN=EAAAExxxxx \
SQUARE_LOCATION_ID=Lxxxxxxxxx \
node server.js

# Windows PowerShell
$env:STRIPE_SECRET_KEY="sk_test_xxx"
$env:SQUARE_ACCESS_TOKEN="EAAAExxxxx"
$env:SQUARE_LOCATION_ID="Lxxxxxxxxx"
node server.js
```

You don't need both configured — the toggle only fails for whichever
provider you haven't set up (the error message will say exactly which
environment variable is missing).

### A note on testing this integration

Every other part of this app was tested against the real, running server.
This part is different: the sandbox this was built in has no internet
access, so the actual calls to Stripe's and Square's live servers
couldn't be tested here. What *was* tested, using local mock servers
standing in for each provider: request formatting (Stripe's
bracket-notation form encoding, Square's JSON body shape), database
crediting, idempotency (confirming the same payment twice doesn't
double-credit, checked for both providers), and cross-user protection
(one user can't confirm another user's payment). During testing, this
process actually caught and fixed a real idempotency bug in the Stripe
flow before it shipped — worth knowing that testing here goes beyond a
surface check.

The part that depends on actually reaching each provider's real servers
is unverified until you try it with real sandbox credentials — Square's
API in particular is more complex (JSON with nested objects, versioned by
date) and reconstructed from documentation knowledge rather than a live
reference, so it's the more likely of the two to need a small fix if
Square's exact response shape differs from what's assumed here. If
something doesn't work, the terminal running `node server.js` prints the
actual error message from whichever provider failed — that's the fastest
way to spot and fix a mismatch.



Requires **Node.js 22 or later** (for the built-in `node:sqlite` module) —
no `npm install`, no external dependencies.

```
node server.js
```

Then open **http://localhost:3000** in your browser. You'll see an
`ExperimentalWarning: SQLite is an experimental feature` line in the
terminal — that's expected and harmless; it's Node's own disclaimer about
that built-in module, not a bug.

The database file is created automatically at `data/ticker.db` on first run.
Delete that file any time to reset all accounts.

## Project structure

```
ticker-app/
  server.js        the entire backend (plain Node + built-in SQLite, no dependencies)
  public/
    index.html      the frontend (unchanged UI, calling real APIs)
  data/
    ticker.db        created automatically — a real SQLite database file
```

## Database schema

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  balance_usd REAL NOT NULL DEFAULT 10000,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE holdings (
  user_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ticker),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  ticker TEXT NOT NULL,
  usd_amount REAL NOT NULL,
  coins_bought REAL NOT NULL,
  price_at_purchase REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

## API reference

| Method | Path            | Auth required | What it does |
|--------|-----------------|----------------|---------------|
| POST   | `/api/signup`   | no             | Create an account. Body: `{ name, email, password }` |
| POST   | `/api/login`    | no             | Sign in. Body: `{ email, password }` |
| POST   | `/api/logout`   | yes            | Invalidate the current session token |
| GET    | `/api/me`       | yes            | Get the current user's profile, balance, holdings |
| GET    | `/api/prices`   | no             | Current simulated prices for all 17 tracked coins |
| POST   | `/api/buy`      | yes            | Buy a coin with paper USD. Body: `{ ticker, usdAmount }` |

Auth is a `Bearer` token in the `Authorization` header, issued by signup/login.

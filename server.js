/**
 * Ticker — real backend, now on a real relational database (SQLite).
 *
 * WHAT CHANGED FROM THE JSON-FILE VERSION:
 *  - Accounts, sessions, holdings, and transactions now live in proper SQL tables
 *    instead of one big JSON blob that got rewritten on every request.
 *  - Foreign keys tie holdings/transactions/sessions to a user's row.
 *  - Uses Node's built-in `node:sqlite` module (Node 22+) — no npm install, no
 *    native compilation, no network access needed. It's marked "experimental"
 *    by Node itself (hence the warning printed on startup), but it's real SQLite
 *    under the hood, not a toy.
 *
 * WHAT'S STILL THE SAME (see the previous version's notes — still true here):
 *  - Real password hashing (scrypt + per-user salt, timing-safe compare)
 *  - Real session tokens, verified server-side on every request
 *  - "USD balance" is fake paper money — no real bank account involved
 *  - "Buying" a coin moves paper balances only — no real money or crypto moves
 *  - Prices are a simulated random walk, not a live market feed
 *
 * The API routes and response shapes are unchanged from the JSON-file version,
 * so the existing frontend (public/index.html) works with this file as-is.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "ticker.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const STARTING_PAPER_BALANCE = 10000; // fake USD credited to every new account, for demo trading only

/* ---------------------------------------------------------------- */
/* Stripe configuration — test mode only                              */
/* ---------------------------------------------------------------- */
/* Get a free test secret key from https://dashboard.stripe.com/test/apikeys
   (starts with sk_test_...). Never put a live (sk_live_...) key in a demo
   project like this — this code has not been through the security review a
   real production payment integration needs. Set it as an environment
   variable rather than hardcoding it:
     macOS/Linux:  STRIPE_SECRET_KEY=sk_test_xxx node server.js
     Windows (PowerShell): $env:STRIPE_SECRET_KEY="sk_test_xxx"; node server.js */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_API_HOST = process.env.STRIPE_API_HOST || "api.stripe.com"; // overridable for local testing against a mock
const STRIPE_API_PORT = process.env.STRIPE_API_PORT ? Number(process.env.STRIPE_API_PORT) : 443;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

/** Flattens a nested JS object into Stripe's bracket-notation form fields,
 * e.g. {a:{b:1}} -> [["a[b]", 1]], because Stripe's REST API expects
 * application/x-www-form-urlencoded bodies, not JSON. */
function flattenStripeParams(obj, prefix) {
  const pairs = [];
  for (const key in obj) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") {
          pairs.push(...flattenStripeParams(item, `${fullKey}[${i}]`));
        } else {
          pairs.push([`${fullKey}[${i}]`, String(item)]);
        }
      });
    } else if (typeof value === "object") {
      pairs.push(...flattenStripeParams(value, fullKey));
    } else {
      pairs.push([fullKey, String(value)]);
    }
  }
  return pairs;
}

function stripeRequest(method, apiPath, params) {
  return new Promise((resolve, reject) => {
    if (!STRIPE_SECRET_KEY) {
      return reject(new Error("Stripe isn't configured — set the STRIPE_SECRET_KEY environment variable to a test key from your Stripe dashboard."));
    }
    const transport = STRIPE_API_PORT === 443 ? https : http;
    const postData = params ? new URLSearchParams(flattenStripeParams(params)).toString() : null;
    const query = !params && method === "GET" ? "" : "";
    const options = {
      hostname: STRIPE_API_HOST,
      port: STRIPE_API_PORT,
      path: apiPath + query,
      method,
      headers: {
        "Authorization": "Basic " + Buffer.from(STRIPE_SECRET_KEY + ":").toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };
    if (postData) options.headers["Content-Length"] = Buffer.byteLength(postData);

    const req = transport.request(options, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        let json;
        try { json = JSON.parse(raw); } catch (err) { return reject(new Error("Stripe returned a non-JSON response.")); }
        if (res.statusCode >= 400) {
          return reject(new Error((json.error && json.error.message) || "Stripe API error."));
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/* ---------------------------------------------------------------- */
/* Square configuration — sandbox only                                */
/* ---------------------------------------------------------------- */
/* Get free sandbox credentials from https://developer.squareup.com/apps
   (create an app, then look under "Sandbox" for an access token and a
   sandbox Location ID). Set both as environment variables:
     SQUARE_ACCESS_TOKEN=EAAAExxxxxxxxxx
     SQUARE_LOCATION_ID=Lxxxxxxxxxx
   Unlike Stripe (form-encoded, Basic auth), Square's API takes JSON bodies
   and a Bearer token — the code below reflects that difference.
   NOTE: Square versions its API by date (the Square-Version header below).
   If Square's response shape has changed since this was written, the
   server will print Square's actual error message, which is the fastest
   way to spot a mismatch — see the README for more on this. */

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_API_HOST = process.env.SQUARE_API_HOST || "connect.squareupsandbox.com";
const SQUARE_API_PORT = process.env.SQUARE_API_PORT ? Number(process.env.SQUARE_API_PORT) : 443;
const SQUARE_VERSION = "2025-01-23";

function squareRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return reject(new Error("Square isn't configured — set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID environment variables from your Square Sandbox dashboard."));
    }
    const transport = SQUARE_API_PORT === 443 ? https : http;
    const postData = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: SQUARE_API_HOST,
      port: SQUARE_API_PORT,
      path: apiPath,
      method,
      headers: {
        "Authorization": "Bearer " + SQUARE_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION
      }
    };
    if (postData) options.headers["Content-Length"] = Buffer.byteLength(postData);

    const req = transport.request(options, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        let json;
        try { json = JSON.parse(raw); } catch (err) { return reject(new Error("Square returned a non-JSON response.")); }
        if (res.statusCode >= 400) {
          const msg = (json.errors && json.errors[0] && json.errors[0].detail) || "Square API error.";
          return reject(new Error(msg));
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/* ---------------------------------------------------------------- */
/* Database setup                                                     */
/* ---------------------------------------------------------------- */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    balance_usd REAL NOT NULL DEFAULT ${STARTING_PAPER_BALANCE},
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS holdings (
    user_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ticker),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
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
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL,
    usd_amount REAL NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, provider_ref),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS square_pending (
    ref TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    usd_amount REAL NOT NULL,
    square_order_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

/* Prepared statements — reused across requests instead of re-parsed every time */
const stmts = {
  insertUser: db.prepare(`INSERT INTO users (name, email, password_hash, balance_usd, created_at) VALUES (?, ?, ?, ?, ?)`),
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateBalance: db.prepare(`UPDATE users SET balance_usd = ? WHERE id = ?`),

  insertSession: db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  getHoldings: db.prepare(`SELECT ticker, amount FROM holdings WHERE user_id = ?`),
  upsertHolding: db.prepare(`
    INSERT INTO holdings (user_id, ticker, amount) VALUES (?, ?, ?)
    ON CONFLICT(user_id, ticker) DO UPDATE SET amount = amount + excluded.amount
  `),

  insertTransaction: db.prepare(`
    INSERT INTO transactions (user_id, type, ticker, usd_amount, coins_bought, price_at_purchase, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getRecentTransactions: db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20
  `),

  getDepositByProviderRef: db.prepare(`SELECT * FROM deposits WHERE provider = ? AND provider_ref = ?`),
  insertDeposit: db.prepare(`
    INSERT INTO deposits (user_id, provider, provider_ref, usd_amount, created_at) VALUES (?, ?, ?, ?, ?)
  `),

  insertSquarePending: db.prepare(`
    INSERT INTO square_pending (ref, user_id, usd_amount, square_order_id, created_at) VALUES (?, ?, ?, ?, ?)
  `),
  setSquareOrderId: db.prepare(`UPDATE square_pending SET square_order_id = ? WHERE ref = ?`),
  getSquarePending: db.prepare(`SELECT * FROM square_pending WHERE ref = ?`)
};

/* ---------------------------------------------------------------- */
/* Password hashing (scrypt — a real, slow, salted KDF)               */
/* ---------------------------------------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const attemptHash = crypto.scryptSync(password, salt, 64);
  const storedHash = Buffer.from(hash, "hex");
  if (attemptHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(attemptHash, storedHash);
}

/* ---------------------------------------------------------------- */
/* Sessions                                                            */
/* ---------------------------------------------------------------- */

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  stmts.insertSession.run(token, userId, Date.now());
  return token;
}

function getUserFromRequest(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const session = stmts.getSession.get(token);
  if (!session) return null;
  const user = stmts.getUserById.get(session.user_id);
  return user ? { user, token } : null;
}

/* ---------------------------------------------------------------- */
/* Server-authoritative simulated coin prices                        */
/* ---------------------------------------------------------------- */

const COINS = [
  { ticker: "BTC", name: "Bitcoin", base: 64000, vol: 0.006 },
  { ticker: "ETH", name: "Ethereum", base: 3400, vol: 0.008 },
  { ticker: "USDT", name: "Tether", base: 1.0, vol: 0.0005 },
  { ticker: "BNB", name: "BNB", base: 590, vol: 0.01 },
  { ticker: "SOL", name: "Solana", base: 150, vol: 0.014 },
  { ticker: "XRP", name: "XRP", base: 0.62, vol: 0.012 },
  { ticker: "ADA", name: "Cardano", base: 0.45, vol: 0.012 },
  { ticker: "DOGE", name: "Dogecoin", base: 0.15, vol: 0.02 },
  { ticker: "AVAX", name: "Avalanche", base: 36, vol: 0.016 },
  { ticker: "DOT", name: "Polkadot", base: 6.8, vol: 0.014 },
  { ticker: "LINK", name: "Chainlink", base: 14.5, vol: 0.013 },
  { ticker: "TON", name: "Toncoin", base: 5.9, vol: 0.015 },
  { ticker: "MATIC", name: "Polygon", base: 0.58, vol: 0.018 },
  { ticker: "LTC", name: "Litecoin", base: 68, vol: 0.012 },
  { ticker: "TRX", name: "Tron", base: 0.12, vol: 0.015 },
  { ticker: "SHIB", name: "Shiba Inu", base: 0.000018, vol: 0.022 },
  { ticker: "SUI", name: "Sui", base: 3.4, vol: 0.02 }
];

const livePrices = {};
COINS.forEach(c => { livePrices[c.ticker] = c.base; });

setInterval(() => {
  COINS.forEach(c => {
    const delta = (Math.random() - 0.49) * c.vol;
    livePrices[c.ticker] = Math.max(livePrices[c.ticker] * 0.1, livePrices[c.ticker] * (1 + delta));
  });
}, 3000);

/* ---------------------------------------------------------------- */
/* Request helpers                                                    */
/* ---------------------------------------------------------------- */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** Square Orders stay "OPEN" even after payment (that field is about fulfillment, not
 * payment) — so to check whether an order was actually paid, we list recent payments for
 * the location and match on order_id, then check that Payment's own `status` field.
 * Filtered to a time window around when we created the order (rather than "all recent
 * payments") so a growing sandbox history doesn't crowd out the one we're looking for,
 * sorted newest-first, with a couple of short retries in case of brief indexing lag. */
async function findSquarePaymentForOrder(orderId, createdAtMs){
  const beginTime = new Date(createdAtMs - 5 * 60 * 1000).toISOString(); // 5 min before we created the order
  const query = `location_id=${encodeURIComponent(SQUARE_LOCATION_ID)}&begin_time=${encodeURIComponent(beginTime)}&sort_order=DESC&limit=100`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await squareRequest("GET", `/v2/payments?${query}`);
    const payments = result.payments || [];
    const match = payments.find(p => p.order_id === orderId);
    if (match) return match;
    if (attempt < 2) await new Promise(r => setTimeout(r, 700)); // brief pause before retrying, in case Square hasn't indexed it yet
  }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function publicUser(user) {
  const holdingsRows = stmts.getHoldings.all(user.id);
  const holdings = {};
  holdingsRows.forEach(row => { holdings[row.ticker] = row.amount; });

  const txRows = stmts.getRecentTransactions.all(user.id);
  const transactions = txRows.map(row => ({
    type: row.type,
    ticker: row.ticker,
    usdAmount: row.usd_amount,
    coinsBought: row.coins_bought,
    priceAtPurchase: row.price_at_purchase,
    timestamp: row.timestamp
  }));

  return {
    name: user.name,
    email: user.email,
    balanceUsd: user.balance_usd,
    holdings,
    transactions
  };
}

/* ---------------------------------------------------------------- */
/* API routes                                                         */
/* ---------------------------------------------------------------- */

async function handleApi(req, res, pathname) {
  if (pathname === "/api/signup" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const { name, email, password } = body;
    if (!name || !isValidEmail(email) || !password || password.length < 6) {
      return sendJson(res, 400, { error: "Enter a name, a valid email, and a password of at least 6 characters." });
    }
    const normalizedEmail = email.toLowerCase();
    if (stmts.getUserByEmail.get(normalizedEmail)) {
      return sendJson(res, 409, { error: "An account with that email already exists. Try signing in instead." });
    }
    const result = stmts.insertUser.run(name, normalizedEmail, hashPassword(password), STARTING_PAPER_BALANCE, Date.now());
    const user = stmts.getUserById.get(Number(result.lastInsertRowid));
    const token = createSession(user.id);
    return sendJson(res, 201, { token, user: publicUser(user) });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const { email, password } = body;
    if (!isValidEmail(email) || !password) {
      return sendJson(res, 400, { error: "Enter a valid email and password." });
    }
    const normalizedEmail = email.toLowerCase();
    const user = stmts.getUserByEmail.get(normalizedEmail);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: "Incorrect email or password." });
    }
    const token = createSession(user.id);
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token) stmts.deleteSession.run(token);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Not signed in." });
    return sendJson(res, 200, { user: publicUser(auth.user) });
  }

  if (pathname === "/api/prices" && req.method === "GET") {
    return sendJson(res, 200, { prices: livePrices, coins: COINS.map(c => ({ ticker: c.ticker, name: c.name })) });
  }

  if (pathname === "/api/buy" && req.method === "POST") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in before buying." });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const { ticker, usdAmount } = body;
    const coin = COINS.find(c => c.ticker === ticker);
    if (!coin) return sendJson(res, 400, { error: "Unknown coin." });
    const amount = Number(usdAmount);
    if (!amount || amount <= 0) return sendJson(res, 400, { error: "Enter a valid USD amount." });

    const user = auth.user;
    if (amount > user.balance_usd) {
      return sendJson(res, 400, { error: `Insufficient paper balance. You have $${user.balance_usd.toFixed(2)} available.` });
    }
    const price = livePrices[ticker];
    const coinsBought = amount / price;
    const newBalance = Number((user.balance_usd - amount).toFixed(2));

    db.exec("BEGIN");
    try {
      stmts.updateBalance.run(newBalance, user.id);
      stmts.upsertHolding.run(user.id, ticker, coinsBought);
      stmts.insertTransaction.run(user.id, "buy", ticker, amount, coinsBought, price, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const updatedUser = stmts.getUserById.get(user.id);
    return sendJson(res, 200, { ok: true, user: publicUser(updatedUser) });
  }

  if (pathname === "/api/deposit/create-checkout-session" && req.method === "POST") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in before adding funds." });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const amount = Number(body.usdAmount);
    if (!amount || amount < 1 || amount > 10000) {
      return sendJson(res, 400, { error: "Enter an amount between $1 and $10,000." });
    }
    try {
      const session = await stripeRequest("POST", "/v1/checkout/sessions", {
        mode: "payment",
        success_url: `${APP_BASE_URL}/deposit-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_BASE_URL}/index.html#crypto`,
        client_reference_id: String(auth.user.id),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Ticker paper trading balance top-up",
              description: "Adds simulated USD to your Ticker account for paper trading. Not a real financial product."
            }
          }
        }],
        metadata: { userId: String(auth.user.id), purpose: "paper_balance_topup" }
      });
      return sendJson(res, 200, { url: session.url, sessionId: session.id });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't reach Stripe: " + err.message });
    }
  }

  if (pathname === "/api/deposit/confirm" && req.method === "GET") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in to confirm a deposit." });
    const parsedUrl = url.parse(req.url, true);
    const sessionId = parsedUrl.query.session_id;
    if (!sessionId) return sendJson(res, 400, { error: "Missing session_id." });

    const existing = stmts.getDepositByProviderRef.get("stripe", sessionId);
    if (existing) {
      if (existing.user_id !== auth.user.id) {
        return sendJson(res, 403, { error: "This payment session doesn't belong to your account." });
      }
      // Already credited (e.g. user refreshed the success page) — don't double-credit, just return current state.
      const user = stmts.getUserById.get(auth.user.id);
      return sendJson(res, 200, { ok: true, alreadyProcessed: true, user: publicUser(user) });
    }

    try {
      const session = await stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (session.client_reference_id !== String(auth.user.id)) {
        return sendJson(res, 403, { error: "This payment session doesn't belong to your account." });
      }
      if (session.payment_status !== "paid") {
        return sendJson(res, 400, { error: `Payment not completed yet (status: ${session.payment_status}).` });
      }
      const amount = session.amount_total / 100;
      const newBalance = Number((auth.user.balance_usd + amount).toFixed(2));

      db.exec("BEGIN");
      try {
        stmts.updateBalance.run(newBalance, auth.user.id);
        stmts.insertDeposit.run(auth.user.id, "stripe", sessionId, amount, Date.now());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      const updatedUser = stmts.getUserById.get(auth.user.id);
      return sendJson(res, 200, { ok: true, amount, user: publicUser(updatedUser) });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't verify payment with Stripe: " + err.message });
    }
  }

  if (pathname === "/api/deposit/square/create" && req.method === "POST") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in before adding funds." });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const amount = Number(body.usdAmount);
    if (!amount || amount < 1 || amount > 10000) {
      return sendJson(res, 400, { error: "Enter an amount between $1 and $10,000." });
    }

    const ref = crypto.randomBytes(16).toString("hex");
    stmts.insertSquarePending.run(ref, auth.user.id, amount, null, Date.now());

    try {
      const result = await squareRequest("POST", "/v2/online-checkout/payment-links", {
        idempotency_key: ref,
        order: {
          location_id: SQUARE_LOCATION_ID,
          reference_id: ref,
          line_items: [{
            name: "Ticker paper trading balance top-up",
            quantity: "1",
            base_price_money: { amount: Math.round(amount * 100), currency: "USD" }
          }]
        },
        checkout_options: {
          redirect_url: `${APP_BASE_URL}/deposit-success.html?provider=square&ref=${ref}`
        }
      });
      const orderId = result.payment_link && result.payment_link.order_id;
      if (orderId) stmts.setSquareOrderId.run(orderId, ref);
      return sendJson(res, 200, { url: result.payment_link.url, ref });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't reach Square: " + err.message });
    }
  }

  if (pathname === "/api/deposit/square/confirm" && req.method === "GET") {
    const auth = getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in to confirm a deposit." });
    const parsedUrl = url.parse(req.url, true);
    const ref = parsedUrl.query.ref;
    if (!ref) return sendJson(res, 400, { error: "Missing ref." });

    const pending = stmts.getSquarePending.get(ref);
    if (!pending) return sendJson(res, 404, { error: "No matching payment found." });
    if (pending.user_id !== auth.user.id) {
      return sendJson(res, 403, { error: "This payment doesn't belong to your account." });
    }

    const existing = stmts.getDepositByProviderRef.get("square", ref);
    if (existing) {
      const user = stmts.getUserById.get(auth.user.id);
      return sendJson(res, 200, { ok: true, alreadyProcessed: true, user: publicUser(user) });
    }

    if (!pending.square_order_id) {
      return sendJson(res, 400, { error: "Payment session isn't ready yet — try again in a moment." });
    }

    try {
      // NOTE: Square Orders stay in state "OPEN" even after successful payment — that field
      // tracks fulfillment, not payment status. The reliable signal is the associated Payment
      // object's own `status` field, which we find by listing recent payments for this location
      // and matching on order_id.
      const payment = await findSquarePaymentForOrder(pending.square_order_id, pending.created_at);
      if (!payment || payment.status !== "COMPLETED") {
        return sendJson(res, 400, { error: `Payment not completed yet (status: ${payment ? payment.status : "not found"}).` });
      }
      const amount = pending.usd_amount;
      const newBalance = Number((auth.user.balance_usd + amount).toFixed(2));

      db.exec("BEGIN");
      try {
        stmts.updateBalance.run(newBalance, auth.user.id);
        stmts.insertDeposit.run(auth.user.id, "square", ref, amount, Date.now());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      const updatedUser = stmts.getUserById.get(auth.user.id);
      return sendJson(res, 200, { ok: true, amount, user: publicUser(updatedUser) });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't verify payment with Square: " + err.message });
    }
  }

  return sendJson(res, 404, { error: "Not found." });
}

/* ---------------------------------------------------------------- */
/* Static file serving (the frontend)                                 */
/* ---------------------------------------------------------------- */

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------------------------------------------------------- */
/* Server                                                              */
/* ---------------------------------------------------------------- */

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch(err => {
      console.error(err);
      sendJson(res, 500, { error: "Server error." });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Ticker server running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH} (real SQLite — inspect it with any SQLite browser/CLI)`);
});

/**
 * Ticker — real backend, now on a real hosted Postgres database (Neon/Supabase/etc).
 *
 * WHAT CHANGED FROM THE SQLITE VERSION:
 *  - Accounts, sessions, holdings, transactions now live in a real Postgres database
 *    reached over the network via a connection string — not a local file. This solves
 *    the problem where a local SQLite file got wiped every time a free-tier host (like
 *    Render's free web service) spun down and back up: Postgres lives independently,
 *    on its own host, and survives your app server restarting completely.
 *  - Uses the `pg` package (the standard, extremely widely-used Postgres client for
 *    Node) — this is the one dependency this project needs, added specifically to
 *    solve the persistence problem. Everything else stays dependency-free.
 *  - IMPORTANT HONESTY NOTE: this rewrite could not be tested against a real Postgres
 *    database in the environment it was written in (no internet access, no local
 *    Postgres installed). It's written using standard, well-established `pg` patterns,
 *    but — unlike the rest of this project, which was tested directly — expect to
 *    debug real connection/query issues together once you actually run this against
 *    your real Neon/Supabase database.
 *
 * WHAT'S STILL THE SAME:
 *  - Real password hashing (scrypt + per-user salt, timing-safe compare)
 *  - Real session tokens, verified server-side on every request
 *  - "USD balance" is fake paper money — no real bank account involved
 *  - "Buying" a coin moves paper balances only — no real money or crypto moves
 *  - Prices are a simulated random walk, not a live market feed
 *
 * The API routes and response shapes are unchanged, so the existing frontend
 * (public/index.html, public/mobile.html) works with this file as-is.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const STARTING_PAPER_BALANCE = 10000; // fake USD credited to every new account, for demo trading only

/* ---------------------------------------------------------------- */
/* Postgres configuration                                             */
/* ---------------------------------------------------------------- */
/* Set DATABASE_URL to your Neon/Supabase/etc connection string, e.g.:
     postgresql://user:password@host.neon.tech/dbname?sslmode=require
   Most hosted Postgres providers (Neon, Supabase, Render Postgres) require SSL —
   the ssl option below is set permissively (rejectUnauthorized: false) since these
   providers use certificates that Node doesn't always validate cleanly by default.
   This is a common, accepted pattern for connecting to managed Postgres providers,
   not a security shortcut specific to this project. */

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Set it to your Postgres connection string (e.g. from Neon or Supabase) before starting the server.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

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

/* ---------------------------------------------------------------- */
/* Database schema (created automatically on startup if missing)     */
/* ---------------------------------------------------------------- */
/* Note on types: timestamps use BIGINT, not INTEGER — Date.now() returns
 * millisecond timestamps that are already too large for Postgres's 4-byte
 * INTEGER type (max ~2.1 billion; current millisecond timestamps are in the
 * trillions). This was a real gotcha ported over from SQLite, which doesn't
 * have this limitation, so it's called out explicitly here. */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      balance_usd DOUBLE PRECISION NOT NULL DEFAULT ${STARTING_PAPER_BALANCE},
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, ticker)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      ticker TEXT NOT NULL,
      usd_amount DOUBLE PRECISION NOT NULL,
      coins_bought DOUBLE PRECISION NOT NULL,
      price_at_purchase DOUBLE PRECISION NOT NULL,
      timestamp BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      usd_amount DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(provider, provider_ref)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS square_pending (
      ref TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usd_amount DOUBLE PRECISION NOT NULL,
      square_order_id TEXT,
      created_at BIGINT NOT NULL
    );
  `);
}

/* ---------------------------------------------------------------- */
/* Database helpers — thin async wrappers around pool.query           */
/* ---------------------------------------------------------------- */
/* Postgres uses $1, $2... placeholders (not SQLite's ?), and every call
 * here is async (a real network round-trip to the database), unlike the
 * synchronous SQLite version. `row(result)` / `rows(result)` just pull the
 * data out of pg's result object shape ({ rows: [...] }). */

function row(result) { return result.rows[0] || null; }
function rows(result) { return result.rows; }

const db = {
  insertUser: (name, email, passwordHash, balance, createdAt) =>
    pool.query(`INSERT INTO users (name, email, password_hash, balance_usd, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, email, passwordHash, balance, createdAt]).then(row),

  getUserByEmail: (email) =>
    pool.query(`SELECT * FROM users WHERE email = $1`, [email]).then(row),

  getUserById: (id) =>
    pool.query(`SELECT * FROM users WHERE id = $1`, [id]).then(row),

  updateBalance: (newBalance, userId) =>
    pool.query(`UPDATE users SET balance_usd = $1 WHERE id = $2`, [newBalance, userId]),

  insertSession: (token, userId, createdAt) =>
    pool.query(`INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)`, [token, userId, createdAt]),

  getSession: (token) =>
    pool.query(`SELECT * FROM sessions WHERE token = $1`, [token]).then(row),

  deleteSession: (token) =>
    pool.query(`DELETE FROM sessions WHERE token = $1`, [token]),

  getHoldings: (userId) =>
    pool.query(`SELECT ticker, amount FROM holdings WHERE user_id = $1`, [userId]).then(rows),

  upsertHolding: (userId, ticker, amount) =>
    pool.query(
      `INSERT INTO holdings (user_id, ticker, amount) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, ticker) DO UPDATE SET amount = holdings.amount + EXCLUDED.amount`,
      [userId, ticker, amount]
    ),

  insertTransaction: (userId, type, ticker, usdAmount, coinsBought, price, timestamp) =>
    pool.query(
      `INSERT INTO transactions (user_id, type, ticker, usd_amount, coins_bought, price_at_purchase, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, type, ticker, usdAmount, coinsBought, price, timestamp]
    ),

  getRecentTransactions: (userId) =>
    pool.query(`SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 20`, [userId]).then(rows),

  getDepositByProviderRef: (provider, ref) =>
    pool.query(`SELECT * FROM deposits WHERE provider = $1 AND provider_ref = $2`, [provider, ref]).then(row),

  insertDeposit: (userId, provider, ref, amount, createdAt) =>
    pool.query(`INSERT INTO deposits (user_id, provider, provider_ref, usd_amount, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [userId, provider, ref, amount, createdAt]),

  insertSquarePending: (ref, userId, amount, orderId, createdAt) =>
    pool.query(`INSERT INTO square_pending (ref, user_id, usd_amount, square_order_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [ref, userId, amount, orderId, createdAt]),

  setSquareOrderId: (orderId, ref) =>
    pool.query(`UPDATE square_pending SET square_order_id = $1 WHERE ref = $2`, [orderId, ref]),

  getSquarePending: (ref) =>
    pool.query(`SELECT * FROM square_pending WHERE ref = $1`, [ref]).then(row)
};

/** Runs a few queries as a single atomic transaction using one dedicated client
 * (required because BEGIN/COMMIT must happen on the same connection — unlike the
 * simple query helpers above, which each borrow any available connection from the pool). */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.insertSession(token, userId, Date.now());
  return token;
}

async function getUserFromRequest(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const session = await db.getSession(token);
  if (!session) return null;
  const user = await db.getUserById(session.user_id);
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

async function publicUser(user) {
  const holdingsRows = await db.getHoldings(user.id);
  const holdings = {};
  holdingsRows.forEach(row => { holdings[row.ticker] = row.amount; });

  const txRows = await db.getRecentTransactions(user.id);
  const transactions = txRows.map(row => ({
    type: row.type,
    ticker: row.ticker,
    usdAmount: row.usd_amount,
    coinsBought: row.coins_bought,
    priceAtPurchase: row.price_at_purchase,
    timestamp: Number(row.timestamp)
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
    if (await db.getUserByEmail(normalizedEmail)) {
      return sendJson(res, 409, { error: "An account with that email already exists. Try signing in instead." });
    }
    const user = await db.insertUser(name, normalizedEmail, hashPassword(password), STARTING_PAPER_BALANCE, Date.now());
    const token = await createSession(user.id);
    return sendJson(res, 201, { token, user: await publicUser(user) });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const { email, password } = body;
    if (!isValidEmail(email) || !password) {
      return sendJson(res, 400, { error: "Enter a valid email and password." });
    }
    const normalizedEmail = email.toLowerCase();
    const user = await db.getUserByEmail(normalizedEmail);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: "Incorrect email or password." });
    }
    const token = await createSession(user.id);
    return sendJson(res, 200, { token, user: await publicUser(user) });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token) await db.deleteSession(token);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const auth = await getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Not signed in." });
    return sendJson(res, 200, { user: await publicUser(auth.user) });
  }

  if (pathname === "/api/prices" && req.method === "GET") {
    return sendJson(res, 200, { prices: livePrices, coins: COINS.map(c => ({ ticker: c.ticker, name: c.name })) });
  }

  if (pathname === "/api/buy" && req.method === "POST") {
    const auth = await getUserFromRequest(req);
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

    await withTransaction(async (client) => {
      await client.query(`UPDATE users SET balance_usd = $1 WHERE id = $2`, [newBalance, user.id]);
      await client.query(
        `INSERT INTO holdings (user_id, ticker, amount) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, ticker) DO UPDATE SET amount = holdings.amount + EXCLUDED.amount`,
        [user.id, ticker, coinsBought]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, ticker, usd_amount, coins_bought, price_at_purchase, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.id, "buy", ticker, amount, coinsBought, price, Date.now()]
      );
    });

    const updatedUser = await db.getUserById(user.id);
    return sendJson(res, 200, { ok: true, user: await publicUser(updatedUser) });
  }

  if (pathname === "/api/deposit/create-checkout-session" && req.method === "POST") {
    const auth = await getUserFromRequest(req);
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
    const auth = await getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in to confirm a deposit." });
    const parsedUrl = url.parse(req.url, true);
    const sessionId = parsedUrl.query.session_id;
    if (!sessionId) return sendJson(res, 400, { error: "Missing session_id." });

    const existing = await db.getDepositByProviderRef("stripe", sessionId);
    if (existing) {
      if (existing.user_id !== auth.user.id) {
        return sendJson(res, 403, { error: "This payment session doesn't belong to your account." });
      }
      // Already credited (e.g. user refreshed the success page) — don't double-credit, just return current state.
      const user = await db.getUserById(auth.user.id);
      return sendJson(res, 200, { ok: true, alreadyProcessed: true, user: await publicUser(user) });
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

      await withTransaction(async (client) => {
        await client.query(`UPDATE users SET balance_usd = $1 WHERE id = $2`, [newBalance, auth.user.id]);
        await client.query(
          `INSERT INTO deposits (user_id, provider, provider_ref, usd_amount, created_at) VALUES ($1,$2,$3,$4,$5)`,
          [auth.user.id, "stripe", sessionId, amount, Date.now()]
        );
      });

      const updatedUser = await db.getUserById(auth.user.id);
      return sendJson(res, 200, { ok: true, amount, user: await publicUser(updatedUser) });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't verify payment with Stripe: " + err.message });
    }
  }

  if (pathname === "/api/deposit/square/create" && req.method === "POST") {
    const auth = await getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in before adding funds." });
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: "Malformed request body." });
    const amount = Number(body.usdAmount);
    if (!amount || amount < 1 || amount > 10000) {
      return sendJson(res, 400, { error: "Enter an amount between $1 and $10,000." });
    }

    const ref = crypto.randomBytes(16).toString("hex");
    await db.insertSquarePending(ref, auth.user.id, amount, null, Date.now());

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
      if (orderId) await db.setSquareOrderId(orderId, ref);
      return sendJson(res, 200, { url: result.payment_link.url, ref });
    } catch (err) {
      return sendJson(res, 502, { error: "Couldn't reach Square: " + err.message });
    }
  }

  if (pathname === "/api/deposit/square/confirm" && req.method === "GET") {
    const auth = await getUserFromRequest(req);
    if (!auth) return sendJson(res, 401, { error: "Sign in to confirm a deposit." });
    const parsedUrl = url.parse(req.url, true);
    const ref = parsedUrl.query.ref;
    if (!ref) return sendJson(res, 400, { error: "Missing ref." });

    const pending = await db.getSquarePending(ref);
    if (!pending) return sendJson(res, 404, { error: "No matching payment found." });
    if (pending.user_id !== auth.user.id) {
      return sendJson(res, 403, { error: "This payment doesn't belong to your account." });
    }

    const existing = await db.getDepositByProviderRef("square", ref);
    if (existing) {
      const user = await db.getUserById(auth.user.id);
      return sendJson(res, 200, { ok: true, alreadyProcessed: true, user: await publicUser(user) });
    }

    if (!pending.square_order_id) {
      return sendJson(res, 400, { error: "Payment session isn't ready yet — try again in a moment." });
    }

    try {
      // NOTE: Square Orders stay in state "OPEN" even after successful payment — that field
      // tracks fulfillment, not payment status. The reliable signal is the associated Payment
      // object's own `status` field, which we find by listing recent payments for this location
      // and matching on order_id.
      const payment = await findSquarePaymentForOrder(pending.square_order_id, Number(pending.created_at));
      if (!payment || payment.status !== "COMPLETED") {
        return sendJson(res, 400, { error: `Payment not completed yet (status: ${payment ? payment.status : "not found"}).` });
      }
      const amount = pending.usd_amount;
      const newBalance = Number((auth.user.balance_usd + amount).toFixed(2));

      await withTransaction(async (client) => {
        await client.query(`UPDATE users SET balance_usd = $1 WHERE id = $2`, [newBalance, auth.user.id]);
        await client.query(
          `INSERT INTO deposits (user_id, provider, provider_ref, usd_amount, created_at) VALUES ($1,$2,$3,$4,$5)`,
          [auth.user.id, "square", ref, amount, Date.now()]
        );
      });

      const updatedUser = await db.getUserById(auth.user.id);
      return sendJson(res, 200, { ok: true, amount, user: await publicUser(updatedUser) });
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

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Ticker server running at http://localhost:${PORT}`);
      console.log(`Database: connected via DATABASE_URL (Postgres) — tables created if they didn't already exist.`);
    });
  })
  .catch(err => {
    console.error("Failed to initialize the database. Check that DATABASE_URL is set correctly and the database is reachable.");
    console.error(err);
    process.exit(1);
  });

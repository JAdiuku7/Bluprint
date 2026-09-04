require('dotenv').config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 4000;
const SECRET_FILE = path.join(__dirname, ".session-secret");
const SYNC_INTERVAL_MS = 60000; // re-fetch company boards at most this often
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS) || 30 * 24 * 60 * 60 * 1000; // sessions last 30 days by default — consider shortening (e.g. 7 days) for production
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Comma-separated list of allowed frontend origins, e.g.
// "https://bluprint.app,https://www.bluprint.app". Falls back to the
// local Vite dev server so `npm run dev` keeps working unconfigured.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

// ---------------------------------------------------------------
// Live job sources — same real companies used in the frontend
// ---------------------------------------------------------------
const JOB_SOURCES = [
    { type: "greenhouse", token: "hightouch", name: "Hightouch" },
    { type: "greenhouse", token: "knock", name: "Knock" },
    { type: "greenhouse", token: "verkada", name: "Verkada" },
    { type: "greenhouse", token: "greenhouse", name: "Greenhouse Software" },
    { type: "lever", token: "workwave", name: "WorkWave" },
];

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
function stripHtml(html) {
    if (!html) return "";
    return html
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

function timeAgo(dateStr) {
    if (!dateStr) return "Recently";
    const diffMs = Date.now() - new Date(dateStr).getTime();
    if (Number.isNaN(diffMs)) return "Recently";
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "1 day ago";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? "s" : ""} ago`;
}

// ---------------------------------------------------------------
// Auth helpers — password hashing (scrypt, built into Node, no
// extra dependency) and lightweight signed session tokens (a
// hand-rolled JWT-lite: base64url payload + HMAC signature, no
// external library needed for a project this size).
// ---------------------------------------------------------------
function loadOrCreateSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "SESSION_SECRET environment variable is required in production. " +
            "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
        );
    }

    // Local dev fallback only: persist a generated secret to disk so
    // sessions survive server restarts. Never relied on in production —
    // most hosts wipe the filesystem on every redeploy, which would
    // silently invalidate every active session token.
    try {
        return fs.readFileSync(SECRET_FILE, "utf8").trim();
    } catch (err) {
        const secret = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(SECRET_FILE, secret);
        console.warn(
            "[auth] No SESSION_SECRET set — generated a dev-only secret at .session-secret. " +
            "Set SESSION_SECRET in your environment before deploying."
        );
        return secret;
    }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(input) {
    return Buffer.from(input).toString("base64url");
}

function signToken(userId) {
    const payload = base64url(JSON.stringify({ userId, exp: Date.now() + TOKEN_TTL_MS }));
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [payload, sig] = token.split(".");
    const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    const a = Buffer.from(sig || "");
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!data.userId || !data.exp || Date.now() > data.exp) return null;
        return data.userId;
    } catch (err) {
        return null;
    }
}

function guessCategory(title, extra) {
    const t = `${title} ${extra || ""}`.toLowerCase();
    if (/\b(design|ux|ui|product designer)\b/.test(t)) return "Design";
    if (/\b(sales|account executive|business development|revenue)\b/.test(t)) return "Sales";
    if (/\b(support|success|operations|logistics|supply chain)\b/.test(t)) return "Operations";
    if (/\b(nurse|clinical|health|medical)\b/.test(t)) return "Healthcare";
    if (/\b(electric|technician|trade|installer)\b/.test(t)) return "Trades";
    if (/\b(engineer|developer|swe|backend|frontend|infrastructure|data|platform)\b/.test(t)) return "Engineering";
    return "Other";
}

async function fetchGreenhouseJobs(token, companyName) {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    if (!res.ok) throw new Error(`${companyName} (Greenhouse) responded ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).map((j) => {
        const deptName = (j.departments && j.departments[0] && j.departments[0].name) || "";
        const locationName = (j.location && j.location.name) || "Not specified";
        return {
            id: `GH-${token}-${j.id}`,
            title: j.title,
            company: companyName,
            location: locationName,
            remote: /remote/i.test(locationName),
            type: "Full-time",
            category: guessCategory(j.title, deptName),
            salaryMin: null,
            salaryMax: null,
            posted: timeAgo(j.updated_at),
            updatedAt: j.updated_at || null,
            description: stripHtml(j.content).slice(0, 700) || "See the original listing for the full description.",
            requirements: [],
            sourceLabel: `Live from ${companyName}'s Greenhouse board`,
            sourceUrl: j.absolute_url,
        };
    });
}

async function fetchLeverJobs(token, companyName) {
    const res = await fetch(`https://api.lever.co/v0/postings/${token}?mode=json`);
    if (!res.ok) throw new Error(`${companyName} (Lever) responded ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((p) => {
        const locationName = (p.categories && p.categories.location) || "Not specified";
        return {
            id: `LV-${token}-${p.id}`,
            title: p.text,
            company: companyName,
            location: locationName,
            remote: /remote/i.test(locationName),
            type: (p.categories && p.categories.commitment) || "Full-time",
            category: guessCategory(p.text, p.categories && p.categories.team),
            salaryMin: (p.salaryRange && p.salaryRange.min != null) ? p.salaryRange.min : null,
            salaryMax: (p.salaryRange && p.salaryRange.max != null) ? p.salaryRange.max : null,
            posted: timeAgo(p.createdAt),
            updatedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
            description:
                (p.descriptionPlain || stripHtml(p.description)).slice(0, 700) ||
                "See the original listing for the full description.",
            requirements: (p.lists || []).flatMap((l) => (l.content ? [stripHtml(l.content)] : [])).slice(0, 4),
            sourceLabel: `Live from ${companyName}'s Lever board`,
            sourceUrl: p.hostedUrl,
        };
    });
}

async function fetchAllSources() {
    const results = await Promise.allSettled(
        JOB_SOURCES.map((s) =>
            s.type === "greenhouse" ? fetchGreenhouseJobs(s.token, s.name) : fetchLeverJobs(s.token, s.name)
        )
    );
    const jobs = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const failed = results
        .map((r, i) => (r.status === "rejected" ? { name: JOB_SOURCES[i].name, error: r.reason && r.reason.message } : null))
        .filter(Boolean);
    const succeededCount = results.filter((r) => r.status === "fulfilled").length;
    return { jobs, failed, succeededCount };
}

// ---------------------------------------------------------------
// In-memory job cache (server-wide, shared by everyone hitting the API)
// ---------------------------------------------------------------
let jobCache = { jobs: [], failed: [], syncedAt: null, status: "connecting" };

async function refreshJobCache() {
    try {
        const { jobs, failed, succeededCount } = await fetchAllSources();
        if (succeededCount === 0) throw new Error("All company boards failed to respond");
        jobCache = { jobs, failed, syncedAt: new Date().toISOString(), status: "live" };
    } catch (err) {
        jobCache = {...jobCache, status: "offline", failed: JOB_SOURCES.map((s) => ({ name: s.name, error: err.message })) };
    }
    return jobCache;
}

// ---------------------------------------------------------------
// Per-user data now lives in Postgres (see db/store.js) instead of
// a flat data.json file — that file wasn't safe for concurrent
// writes and wouldn't survive a redeploy on most hosts.
// ---------------------------------------------------------------
const store = require("./db/store");
const email = require("../email");

const EMPTY_PROFILE = { name: "", email: "", phone: "", headline: "", location: "", resumeUrl: "", skills: "" };
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // verification links last 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // reset links last 1 hour

// ---------------------------------------------------------------
// Express app
// ---------------------------------------------------------------
const app = express();
app.use(cors({
    origin(origin, callback) {
        // Allow tools with no Origin header (curl, server-to-server health
        // checks) and any origin explicitly present in CORS_ORIGINS.
        if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
}));
app.use(express.json());

// Every request after this point is scoped to a user via a signed
// session token, proven by an email+password login or signup below.
// The token is a hand-rolled JWT-lite (see signToken/verifyToken) —
// the client can't forge a userId the way it could with a bare
// x-user-id header, since it doesn't have SESSION_SECRET.
function requireAuth(req, res, next) {
    const authHeader = req.header("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.header("x-auth-token");
    const userId = verifyToken(token);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    req.userId = userId;
    next();
}

// scrypt is deliberately slow (that's what makes it resistant to
// brute-forcing password hashes), which cuts both ways: it also makes
// each login/signup attempt expensive for this server to compute. These
// limits stop someone from burning CPU or credential-stuffing accounts
// by hammering the auth endpoints. Keyed by IP, since there's no user
// identity yet at this point in the request.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// ---- Auth: signup ----
app.post("/api/auth/signup", authLimiter, async(req, res) => {
    const { email: rawEmail, password, name } = req.body || {};
    if (!rawEmail || !EMAIL_RE.test(String(rawEmail))) return res.status(400).json({ error: "Enter a valid email address" });
    if (!password || String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const normalizedEmail = String(rawEmail).trim().toLowerCase();
    const existing = await store.findUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: "An account with that email already exists" });

    const userId = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);
    const profile = {...EMPTY_PROFILE, email: normalizedEmail };
    if (name) profile.name = String(name).trim();
    const user = await store.createUser({ id: userId, email: normalizedEmail, passwordSalt: salt, passwordHash: hash, profile });

    // Don't let a flaky email provider block account creation — log and
    // move on. The user can request another verification email later.
    try {
        const verifyToken = await store.createAuthToken(userId, "verify_email", EMAIL_VERIFY_TTL_MS);
        await email.verificationEmail(normalizedEmail, verifyToken);
    } catch (err) {
        console.error("Failed to send verification email:", err.message);
    }

    res.status(201).json({ userId, token: signToken(userId), profile: store.toProfile(user), emailVerified: false });
});

// ---- Auth: login ----
app.post("/api/auth/login", authLimiter, async(req, res) => {
    const { email: rawEmail, password } = req.body || {};
    if (!rawEmail || !password) return res.status(400).json({ error: "Email and password are required" });

    const normalizedEmail = String(rawEmail).trim().toLowerCase();
    const user = await store.findUserByEmail(normalizedEmail);

    // Same generic error whether the email is unknown or the password is
    // wrong, so a caller can't use this endpoint to enumerate accounts.
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
        return res.status(401).json({ error: "Incorrect email or password" });
    }

    res.json({ userId: user.id, token: signToken(user.id), profile: store.toProfile(user), emailVerified: user.email_verified });
});

// ---- Auth: who am I (used by the frontend to validate a stored token) ----
app.get("/api/auth/me", requireAuth, async(req, res) => {
    const user = await store.findUserById(req.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json({ userId: req.userId, profile: store.toProfile(user), emailVerified: user.email_verified });
});

// ---- Auth: verify email ----
app.post("/api/auth/verify-email", async(req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });
    const userId = await store.consumeAuthToken(token, "verify_email");
    if (!userId) return res.status(400).json({ error: "This verification link is invalid or has expired" });
    await store.setEmailVerified(userId);
    res.json({ ok: true });
});

// ---- Auth: resend verification email ----
app.post("/api/auth/resend-verification", authLimiter, requireAuth, async(req, res) => {
    const user = await store.findUserById(req.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

    const verifyToken = await store.createAuthToken(user.id, "verify_email", EMAIL_VERIFY_TTL_MS);
    try {
        await email.verificationEmail(user.email, verifyToken);
    } catch (err) {
        console.error("Failed to send verification email:", err.message);
        return res.status(502).json({ error: "Couldn't send the verification email — please try again shortly" });
    }
    res.json({ ok: true });
});

// ---- Auth: forgot password ----
app.post("/api/auth/forgot-password", authLimiter, async(req, res) => {
    const { email: rawEmail } = req.body || {};
    if (!rawEmail) return res.status(400).json({ error: "email is required" });

    const normalizedEmail = String(rawEmail).trim().toLowerCase();
    const user = await store.findUserByEmail(normalizedEmail);

    // Always respond the same way regardless of whether the account
    // exists, so this endpoint can't be used to enumerate registered
    // emails. Only send the actual email if there IS a matching account.
    if (user) {
        try {
            const resetToken = await store.createAuthToken(user.id, "reset_password", PASSWORD_RESET_TTL_MS);
            await email.passwordResetEmail(user.email, resetToken);
        } catch (err) {
            console.error("Failed to send password reset email:", err.message);
        }
    }

    res.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
});

// ---- Auth: reset password ----
app.post("/api/auth/reset-password", authLimiter, async(req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: "token and password are required" });
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const userId = await store.consumeAuthToken(token, "reset_password");
    if (!userId) return res.status(400).json({ error: "This reset link is invalid or has expired" });

    const { salt, hash } = hashPassword(password);
    await store.updatePassword(userId, salt, hash);
    res.json({ ok: true });
});

// ---- Jobs (public, no user scoping needed) ----
app.get("/api/jobs", async(req, res) => {
    const isStale = !jobCache.syncedAt || Date.now() - new Date(jobCache.syncedAt).getTime() > SYNC_INTERVAL_MS;
    if (isStale) await refreshJobCache();
    res.json(jobCache);
});

app.post("/api/jobs/refresh", async(req, res) => {
    const result = await refreshJobCache();
    res.json(result);
});

// ---- Profile ----
app.get("/api/profile", requireAuth, async(req, res) => {
    const user = await store.findUserById(req.userId);
    res.json(store.toProfile(user));
});

app.put("/api/profile", requireAuth, async(req, res) => {
    // Email is the account identifier (tied to the users table + login) —
    // it's not editable through the general profile form. A real app
    // would offer a dedicated "change email" flow with re-verification.
    const { email, ...editableFields } = req.body || {};
    const user = await store.findUserById(req.userId);
    const updatedProfile = {...store.toProfile(user), ...editableFields };
    const saved = await store.updateProfile(req.userId, updatedProfile);
    res.json(store.toProfile(saved));
});

// ---- Saved jobs ----
app.get("/api/saved", requireAuth, async(req, res) => {
    res.json(await store.getSavedJobIds(req.userId));
});

app.post("/api/saved", requireAuth, async(req, res) => {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    await store.addSavedJob(req.userId, jobId);
    res.json(await store.getSavedJobIds(req.userId));
});

app.delete("/api/saved/:jobId", requireAuth, async(req, res) => {
    await store.removeSavedJob(req.userId, req.params.jobId);
    res.json(await store.getSavedJobIds(req.userId));
});

// ---- Alerts ----
app.get("/api/alerts", requireAuth, async(req, res) => {
    res.json(await store.getAlerts(req.userId));
});

app.post("/api/alerts", requireAuth, async(req, res) => {
    const { name, query } = req.body;
    if (!name || !query) return res.status(400).json({ error: "name and query are required" });
    const alert = { id: `AL-${Date.now()}`, name, query, createdAt: new Date().toISOString() };
    await store.addAlert(req.userId, alert);
    res.json(await store.getAlerts(req.userId));
});

app.delete("/api/alerts/:id", requireAuth, async(req, res) => {
    await store.removeAlert(req.userId, req.params.id);
    res.json(await store.getAlerts(req.userId));
});

// ---- Applications (Quick Apply logs + manual tracker entries) ----
app.get("/api/applications", requireAuth, async(req, res) => {
    res.json(await store.getApplications(req.userId));
});

app.post("/api/applications", requireAuth, async(req, res) => {
    const { jobId, jobTitle, company, name, email, phone, link, note } = req.body;
    if (!jobId || !jobTitle || !company) {
        return res.status(400).json({ error: "jobId, jobTitle, and company are required" });
    }
    const record = {
        ref: `APP-${Math.floor(1000 + Math.random() * 9000)}`,
        jobId,
        jobTitle,
        company,
        submitted: new Date().toISOString(),
        name: name || "",
        email: email || "",
        phone: phone || "",
        link: link || "",
        note: note || "",
    };
    await store.addApplication(req.userId, record);
    res.json(record);
});

app.get("/", (req, res) => {
    res.json({
        name: "Bluprint backend",
        message: "This is an API server, not a webpage — there's nothing to render at '/'.",
        tryInstead: ["/api/health", "/api/jobs"],
        note: "The Bluprint frontend (the React artifact) calls these endpoints in the background. Open the artifact itself to see the job board UI.",
    });
});

app.get("/api/health", (req, res) => {
    res.json({ ok: true, jobCacheStatus: jobCache.status, jobCount: jobCache.jobs.length });
});

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
refreshJobCache().then(() => {
    app.listen(PORT, () => {
        console.log(`Bluprint backend listening on http://localhost:${PORT}`);
        console.log(`Job cache: ${jobCache.jobs.length} listings, status=${jobCache.status}`);
    });
});

/**
 * ------------------------------------------------------------
 * What this backend does NOT do, and would need for production:
 *
 * 1. [DONE] Email verification and password reset are implemented
 *    (see lib/email.js and the /api/auth/verify-email,
 *    resend-verification, forgot-password, reset-password routes).
 *    Set RESEND_API_KEY, FROM_EMAIL, and FRONTEND_URL to send real
 *    emails — without RESEND_API_KEY it just logs to the console,
 *    which is fine for local dev but not for production.
 *
 * 2. [DONE] Per-user data now lives in Postgres (db/store.js) instead
 *    of data.json. Run db/schema.sql once against your database, and
 *    db/migrate-from-json.js once if you have existing local users
 *    to carry over.
 *
 * 3. [DONE] express-rate-limit caps /api/auth/signup and
 *    /api/auth/login at AUTH_RATE_LIMIT_MAX attempts per IP per
 *    15-minute window (default 20). Tune AUTH_RATE_LIMIT_MAX per
 *    environment if it's too strict or too loose in practice.
 *
 * 4. [DONE] SESSION_SECRET now reads from the environment (required
 *    in production, dev-only file fallback otherwise) and CORS is
 *    restricted to an allowlist via CORS_ORIGIN instead of wide open.
 *    Still worth doing before a real deploy: HTTPS at the hosting
 *    layer (most PaaS providers handle this for you), and consider
 *    shortening TOKEN_TTL_MS from the 30-day default.
 * ------------------------------------------------------------
 */
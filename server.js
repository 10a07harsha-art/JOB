const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
require("dotenv").config();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const PROVISION_RATE_LIMIT_MAX = Number(process.env.PROVISION_RATE_LIMIT_MAX || 5);
const PASSWORD_RESET_RATE_LIMIT_MAX = Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || 5);
const VERIFICATION_RATE_LIMIT_MAX = Number(process.env.VERIFICATION_RATE_LIMIT_MAX || 5);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MONGODB_STORAGE_MODE = process.env.MONGODB_STORAGE_MODE || "single-document";
const PUBLIC_DIR = path.join(__dirname, "public");
const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, "data", "store.json");
const STORE_TEMPLATE_PATH = process.env.STORE_TEMPLATE_PATH || path.join(__dirname, "data", "store.example.json");
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 15;
const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || `http://127.0.0.1:${PORT}`;
const DEFAULT_JOBS_URL = "https://remotive.com/api/remote-jobs?limit=24";
const DEFAULT_JOBICY_URL = "https://jobicy.com/api/v2/remote-jobs?count=24";
const DEFAULT_ARBEITNOW_URL = "https://www.arbeitnow.com/api/job-board-api";
const MongoClient = (() => {
  try {
    return require("mongodb").MongoClient;
  } catch (error) {
    return null;
  }
})();
const MONGODB_STORE_ID = "store";

let mongoClient = null;
let mongoStoreCollection = null;
let mongoDatabase = null;
let mongoConnectPromise = null;
let mongoFallbackToLocal = false;
let mutationQueue = Promise.resolve();
const LIVE_CACHE_TTL_MS = 1000 * 60 * 10;
const liveCache = {
  jobs: null,
  jobsFetchedAt: 0,
  jobsPromise: null,
  trends: null,
  trendsFetchedAt: 0,
  trendsPromise: null,
};
const rateLimitBuckets = new Map();

function createRequestId() {
  return crypto.randomBytes(12).toString("hex");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

function readLocalStore() {
  const sourcePath = fs.existsSync(STORE_PATH) ? STORE_PATH : STORE_TEMPLATE_PATH;
  return JSON.parse(fs.readFileSync(sourcePath, "utf8"));
}

function writeLocalStore(store) {
  const temporaryPath = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, STORE_PATH);
}

function runSerializedMutation(task) {
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => {});
  return next;
}

function hasMongoStore() {
  return Boolean(process.env.MONGODB_URI);
}

async function getMongoStoreCollection() {
  if (!hasMongoStore() || mongoFallbackToLocal) {
    return null;
  }

  if (!MongoClient) {
    throw new Error("MongoDB support requires the mongodb package");
  }

  if (mongoStoreCollection) {
    return mongoStoreCollection;
  }

  if (!mongoConnectPromise) {
    mongoConnectPromise = (async () => {
      mongoClient = new MongoClient(process.env.MONGODB_URI, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      try {
        await mongoClient.connect();
        const database = mongoClient.db(process.env.MONGODB_DB || "careerlink");
        mongoDatabase = database;
        mongoStoreCollection = database.collection("app_state");
        return mongoStoreCollection;
      } catch (error) {
        mongoFallbackToLocal = true;
        mongoStoreCollection = null;
        mongoDatabase = null;
        mongoConnectPromise = null;
        throw error;
      }
    })();
  }

  return mongoConnectPromise;
}

async function getMongoDatabase() {
  await getMongoStoreCollection();
  return mongoDatabase;
}

async function readNormalizedStore() {
  const database = await getMongoDatabase();
  const meta = await database.collection("app_meta").findOne({ _id: "store" });
  if (!meta) {
    const legacy = await database.collection("app_state").findOne({ _id: MONGODB_STORE_ID });
    return legacy?.data || readLocalStore();
  }
  const [users, jobs, trends, degrees] = await Promise.all([
    database.collection("users").find({}).toArray(),
    database.collection("jobs").find({}).toArray(),
    database.collection("trends").find({}).toArray(),
    database.collection("degrees").find({}).toArray(),
  ]);
  users.forEach((record) => delete record._id);
  jobs.forEach((record) => delete record._id);
  trends.forEach((record) => delete record._id);
  degrees.forEach((record) => delete record._id);
  const { _id, migratedAt, ...cleanMeta } = meta;
  return { meta: cleanMeta, users, jobs, trends, degrees };
}

async function writeNormalizedStore(store) {
  const database = await getMongoDatabase();
  const session = mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      await database.collection("app_meta").replaceOne({ _id: "store" }, { _id: "store", ...store.meta, updatedAt: new Date().toISOString() }, { upsert: true, session });
      for (const [name, records] of [["users", store.users], ["jobs", store.jobs], ["trends", store.trends], ["degrees", store.degrees]]) {
        const collection = database.collection(name);
        await collection.deleteMany({}, { session });
        if (records?.length) {
          await collection.insertMany(records.map((record) => ({ ...record })), { session });
        }
      }
    });
  } finally {
    await session.endSession();
  }
}

async function readStore() {
  if (!hasMongoStore() || mongoFallbackToLocal) {
    return readLocalStore();
  }

  try {
    if (MONGODB_STORAGE_MODE === "normalized") {
      return await readNormalizedStore();
    }
    const collection = await getMongoStoreCollection();
    const existing = await collection.findOne({ _id: MONGODB_STORE_ID });
    if (existing?.data) {
      if (!Number.isInteger(existing.version)) {
        await collection.updateOne({ _id: MONGODB_STORE_ID, version: { $exists: false } }, { $set: { version: 0 } });
      }
      Object.defineProperty(existing.data, "__storeVersion", {
        value: Number.isInteger(existing.version) ? existing.version : 0,
        writable: true,
        enumerable: false,
      });
      return existing.data;
    }

    const seed = readLocalStore();
    await collection.insertOne({
      _id: MONGODB_STORE_ID,
      data: seed,
      version: 0,
      updatedAt: new Date().toISOString(),
    });
    Object.defineProperty(seed, "__storeVersion", { value: 0, writable: true, enumerable: false });
    return seed;
  } catch (error) {
    mongoFallbackToLocal = true;
    mongoStoreCollection = null;
    mongoDatabase = null;
    return readLocalStore();
  }
}

async function writeStore(store) {
  if (!hasMongoStore() || mongoFallbackToLocal) {
    writeLocalStore(store);
    return;
  }

  try {
    if (MONGODB_STORAGE_MODE === "normalized") {
      await writeNormalizedStore(store);
      return;
    }
    const collection = await getMongoStoreCollection();
    const expectedVersion = Number.isInteger(store.__storeVersion) ? store.__storeVersion : 0;
    const result = await collection.updateOne(
      { _id: MONGODB_STORE_ID, version: expectedVersion },
      {
        $set: {
          data: store,
          version: expectedVersion + 1,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    if (result.matchedCount === 0 && result.upsertedCount === 0) {
      throw new Error("Concurrent store update detected; retry the request");
    }
    store.__storeVersion = expectedVersion + 1;
  } catch (error) {
    if (error.message === "Concurrent store update detected; retry the request") {
      throw error;
    }
    mongoFallbackToLocal = true;
    mongoStoreCollection = null;
    writeLocalStore(store);
  }
}

function sendJson(res, statusCode, payload) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  if (CORS_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, file) => {
    if (error) {
      sendJson(res, 404, { message: "File not found" });
      return;
    }

    const extension = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": [".html", ".css", ".js"].includes(extension) ? "no-store, max-age=0" : "public, max-age=3600",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      ...(process.env.NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    });
    res.end(file);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error("Request body is too large"));
        req.resume();
      }
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function isRateLimited(req, limit = RATE_LIMIT_MAX) {
  const key = `${req.socket.remoteAddress || "unknown"}:${req.url.split("?")[0]}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

function hasValidProvisioningKey(req) {
  const configuredKey = String(process.env.ADMIN_PROVISION_KEY || "");
  const submittedKey = String(req.headers["x-provisioning-key"] || "");
  return Boolean(configuredKey) && safeTimingEqual(submittedKey, configuredKey);
}

function isAllowedMutationOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  const allowedOrigins = CORS_ORIGIN
    ? CORS_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean)
    : [`http://${req.headers.host}`, `https://${req.headers.host}`];
  return allowedOrigins.includes(origin);
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function validateTextFields(body, limits) {
  for (const [field, limit] of Object.entries(limits)) {
    if (body[field] !== undefined && String(body[field]).length > limit) {
      return `${field} must be ${limit} characters or fewer`;
    }
  }
  return "";
}

function parseAge(value) {
  if (value === undefined || value === "") return 0;
  const age = Number(value);
  return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
}

function isSafeHttpUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

function getPagination(parsedUrl) {
  const page = Math.max(1, Number.parseInt(parsedUrl.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(parsedUrl.searchParams.get("pageSize") || "24", 10) || 24));
  return { page, pageSize };
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: currentPage,
    pageSize,
    total,
    totalPages,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString("hex"),
  };
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function sendPasswordResetEmail(user, resetToken) {
  if (!process.env.EMAIL_PROVIDER_URL || !process.env.EMAIL_API_KEY) {
    return false;
  }

  const response = await fetch(process.env.EMAIL_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
    },
    body: JSON.stringify({
      to: user.email,
      from: process.env.EMAIL_FROM || "no-reply@example.com",
      subject: "Reset your Orbit Jobs password",
      text: `Use this link to reset your password: ${PUBLIC_APP_URL}/?resetToken=${encodeURIComponent(resetToken)}`,
      resetUrl: `${PUBLIC_APP_URL}/?resetToken=${encodeURIComponent(resetToken)}`,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Email provider error: ${response.status}`);
  }
  return true;
}

async function sendVerificationEmail(user, verificationToken) {
  if (!process.env.EMAIL_PROVIDER_URL || !process.env.EMAIL_API_KEY) {
    return false;
  }
  const verificationUrl = `${PUBLIC_APP_URL}/?verificationToken=${encodeURIComponent(verificationToken)}`;
  const response = await fetch(process.env.EMAIL_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
    },
    body: JSON.stringify({
      to: user.email,
      from: process.env.EMAIL_FROM || "no-reply@example.com",
      subject: "Verify your Orbit Jobs email",
      text: `Verify your email address: ${verificationUrl}`,
      verificationUrl,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Email provider error: ${response.status}`);
  }
  return true;
}

function safeTimingEqual(left, right, encoding = "utf8") {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left, encoding);
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right, encoding);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password, user) {
  if (!user) {
    return false;
  }

  if (!user.passwordSalt || !user.passwordHash) {
    return Boolean(user.password) && safeTimingEqual(String(password), String(user.password));
  }

  const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString("hex");
  return safeTimingEqual(Buffer.from(candidate, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function parseToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  if (!safeTimingEqual(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function getSecret(store) {
  return process.env.TOKEN_SECRET || store.meta.tokenSecret;
}

function createSessionToken(store, user) {
  const payload = {
    sub: user.id,
    role: user.role,
    jti: createId("session"),
    ver: Number(user.sessionVersion || 0),
    exp: Date.now() + TOKEN_TTL_MS,
  };

  return signToken(payload, getSecret(store));
}

function getTokenFromRequest(req) {
  const cookies = String(req.headers.cookie || "").split(";").map((part) => part.trim());
  const sessionCookie = cookies.find((part) => part.startsWith("orbit_session="));
  return sessionCookie ? decodeURIComponent(sessionCookie.slice("orbit_session=".length)) : "";
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `orbit_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "orbit_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash, passwordSalt, password, ...safeUser } = user;
  return safeUser;
}

function ensureNotificationStore(user) {
  if (!user.notifications) {
    user.notifications = [];
  }
  return user.notifications;
}

function pushNotification(user, notification) {
  if (!user) {
    return;
  }

  const notifications = ensureNotificationStore(user);
  notifications.unshift({
    id: createId("note"),
    createdAt: new Date().toISOString(),
    read: false,
    ...notification,
  });
  notifications.splice(50);
}

function applicationStageLabel(status) {
  switch (String(status || "").toLowerCase()) {
    case "reviewed":
      return "Reviewed";
    case "shortlisted":
      return "Shortlisted";
    case "interview":
      return "Interview";
    case "offer":
      return "Offer";
    case "rejected":
      return "Rejected";
    default:
      return "Applied";
  }
}

function normalizeApplicationStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (["applied", "reviewed", "shortlisted", "interview", "offer", "rejected"].includes(value)) {
    return value;
  }
  return "reviewed";
}

function getApplicationStatus(job, userId) {
  return job?.applicants?.find((applicant) => applicant.userId === userId)?.status || "Applied";
}

function initials(name) {
  return String(name || "")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function scoreResume(resume, job) {
  const blob = `${resume} ${job.skills.join(" ")}`.toLowerCase();
  const matches = job.skills.reduce((count, skill) => count + (blob.includes(skill.toLowerCase()) ? 1 : 0), 0);
  return Math.min(98, 55 + matches * 10);
}

async function fetchJsonWithFallback(url, apiKey) {
  if (!url) {
    return null;
  }

  const response = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Remote fetch failed: ${response.status}`);
  }

  return response.json();
}

function normalizeRemoteJobs(payload) {
  const list = Array.isArray(payload) ? payload : payload.jobs || payload.data || [];
  return list.map((job, index) => ({
    id: job.id || `remote_job_${index}`,
    source: "global",
    provider: "remotive",
    providerLabel: "Remotive",
    title: job.title || job.position || "Untitled role",
    company: job.company || job.company_name || "External company",
    location: job.location || job.region || "Remote",
    country: job.country || job.region || "Global",
    type: normalizeJobType(job.type || job.job_type || "Full-time"),
    salary: job.salary || job.compensation || "Salary not listed",
    category: job.category || "General",
    applyUrl: job.url || job.apply_url || "",
    skills: Array.isArray(job.skills) ? job.skills : String(job.skills || job.tags || "").split(",").map((item) => item.trim()).filter(Boolean),
    description: job.description || job.summary || "External role imported from provider.",
    postedBy: null,
    createdAt: job.createdAt || job.created_at || new Date().toISOString(),
    applicants: [],
  }));
}

function normalizeJobicyJobs(payload) {
  const list = Array.isArray(payload) ? payload : payload.jobs || payload.data || [];
  return list.map((job, index) => ({
    id: job.id || `jobicy_job_${index}`,
    source: "global",
    provider: "jobicy",
    providerLabel: "Jobicy",
    title: job.jobTitle || job.title || "Untitled role",
    company: job.companyName || job.company || "External company",
    location: job.jobGeo || job.location || "Remote",
    country: job.jobGeo || job.country || "Global",
    type: normalizeJobType(job.jobType || job.type || "Full-time"),
    salary: job.salary || job.compensation || "Salary not listed",
    category: job.jobIndustry || job.category || "General",
    applyUrl: job.url || job.apply_url || "",
    skills: Array.isArray(job.skills)
      ? job.skills
      : String(job.tags || job.jobTags || job.jobIndustry || "").split(",").map((item) => item.trim()).filter(Boolean),
    description: job.jobDescription || job.jobExcerpt || job.description || "External role imported from provider.",
    postedBy: null,
    createdAt: job.createdAt || job.publishedAt || job.created_at || new Date().toISOString(),
    applicants: [],
  }));
}

function normalizeArbeitnowJobs(payload) {
  const list = Array.isArray(payload) ? payload : payload.data || payload.jobs || [];
  return list
    .filter((job) => job.remote !== false)
    .map((job, index) => ({
      id: job.slug || job.id || `arbeitnow_job_${index}`,
      source: "global",
      provider: "arbeitnow",
      providerLabel: "Arbeitnow",
      title: job.title || job.job_title || "Untitled role",
      company: job.company_name || job.company || "External company",
      location: job.location || job.city || job.region || job.country || "Europe",
      country: job.country || job.region || "Global",
      type: normalizeJobType(job.job_types?.[0] || job.jobType || job.type || "Full-time"),
      salary: job.salary || job.compensation || "Salary not listed",
      category: job.tags?.[0] || job.category || "General",
      applyUrl: job.url || job.job_url || job.apply_url || "",
      skills: Array.isArray(job.tags) ? job.tags : String(job.tags || job.skills || "").split(",").map((item) => item.trim()).filter(Boolean),
      description: job.description || job.job_description || job.body || "External role imported from provider.",
      postedBy: null,
      createdAt: job.created_at || job.date || new Date().toISOString(),
      applicants: [],
    }));
}

function normalizeJobType(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!text) {
    return "Full-Time";
  }
  if (text === "full_time" || text === "full-time" || text === "fulltime") {
    return "Full-Time";
  }
  if (text === "part_time" || text === "part-time" || text === "parttime") {
    return "Part-Time";
  }
  return text
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function normalizeJobFingerprint(job) {
  return [
    String(job.title || "").trim().toLowerCase(),
    String(job.company || "").trim().toLowerCase(),
    String(job.location || "").trim().toLowerCase(),
    String(job.type || "").trim().toLowerCase(),
    String(job.applyUrl || "").trim().toLowerCase(),
  ].join("|");
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const fingerprint = normalizeJobFingerprint(job);
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
}

async function fetchJobSource(url, apiKey, normalizer) {
  const payload = await fetchJsonWithFallback(url, apiKey);
  if (!payload) {
    return [];
  }

  return normalizer(payload);
}

function isCacheFresh(entry) {
  return Boolean(entry) && Date.now() - entry.fetchedAt < LIVE_CACHE_TTL_MS;
}

function refreshGlobalJobsInBackground(store) {
  if (liveCache.jobsPromise) {
    return liveCache.jobsPromise;
  }

  const providers = [
    {
      name: "remotive",
      url: process.env.REMOTIVE_JOBS_URL || process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL,
      apiKey: process.env.REMOTIVE_JOBS_API_KEY || process.env.GLOBAL_JOBS_API_KEY,
      normalizer: normalizeRemoteJobs,
    },
    {
      name: "jobicy",
      url: process.env.JOBICY_JOBS_URL || DEFAULT_JOBICY_URL,
      apiKey: process.env.JOBICY_JOBS_API_KEY || "",
      normalizer: normalizeJobicyJobs,
    },
    {
      name: "arbeitnow",
      url: process.env.ARBEITNOW_JOBS_URL || DEFAULT_ARBEITNOW_URL,
      apiKey: process.env.ARBEITNOW_JOBS_API_KEY || "",
      normalizer: normalizeArbeitnowJobs,
    },
  ];

  liveCache.jobsPromise = (async () => {
    try {
      const settled = await Promise.allSettled(
        providers.map((provider) =>
          fetchJobSource(provider.url, provider.apiKey, provider.normalizer).then((jobs) =>
            jobs.map((job) => ({
              ...job,
              provider: job.provider || provider.name,
              providerLabel: job.providerLabel || provider.name[0].toUpperCase() + provider.name.slice(1),
            })),
          ),
        ),
      );

      const combined = dedupeJobs(settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
      if (combined.length) {
        liveCache.jobs = combined;
        liveCache.jobsFetchedAt = Date.now();
      } else if (!liveCache.jobs) {
        liveCache.jobs = store.jobs.filter((job) => job.source === "global");
        liveCache.jobsFetchedAt = Date.now();
      }
    } catch (error) {
      if (!liveCache.jobs) {
        liveCache.jobs = store.jobs.filter((job) => job.source === "global");
        liveCache.jobsFetchedAt = Date.now();
      }
    } finally {
      liveCache.jobsPromise = null;
    }

    return liveCache.jobs;
  })();

  return liveCache.jobsPromise;
}

function refreshTrendsInBackground(store) {
  if (liveCache.trendsPromise) {
    return liveCache.trendsPromise;
  }

  liveCache.trendsPromise = (async () => {
    try {
      const payload = await fetchJsonWithFallback(process.env.GLOBAL_TRENDS_URL, process.env.GLOBAL_TRENDS_API_KEY);
      if (payload) {
        const normalized = normalizeRemoteTrends(payload);
        liveCache.trends = normalized;
        liveCache.trendsFetchedAt = Date.now();
        return normalized;
      }
    } catch (error) {
      // Fallback to local trends when remote provider is unavailable.
    }

    if (!process.env.GLOBAL_TRENDS_URL) {
      const liveJobs = await getGlobalJobs(store);
      const derived = deriveLiveTrendsFromJobs(liveJobs);
      if (derived.length) {
        liveCache.trends = derived;
        liveCache.trendsFetchedAt = Date.now();
        return derived;
      }
    }

    liveCache.trends = store.trends;
    liveCache.trendsFetchedAt = Date.now();
    return store.trends;
  })().finally(() => {
    liveCache.trendsPromise = null;
  });

  return liveCache.trendsPromise;
}

function normalizeRemoteTrends(payload) {
  const list = Array.isArray(payload) ? payload : payload.trends || payload.data || [];
  return list.map((trend, index) => ({
    id: trend.id || `remote_trend_${index}`,
    title: trend.title || trend.name || "Market trend",
    direction: trend.direction || trend.movement || "up",
    change: trend.change || trend.delta || "Live update",
    summary: trend.summary || trend.description || "Imported live market signal.",
    regions: Array.isArray(trend.regions) ? trend.regions : [trend.region || "Global"],
  }));
}

async function getGlobalJobs(store) {
  if (Array.isArray(liveCache.jobs) && liveCache.jobs.length) {
    return liveCache.jobs;
  }

  if (liveCache.jobsPromise) {
    return liveCache.jobsPromise;
  }

  if (Array.isArray(liveCache.jobs) && Date.now() - liveCache.jobsFetchedAt >= LIVE_CACHE_TTL_MS) {
    refreshGlobalJobsInBackground(store);
    return liveCache.jobs;
  }

  refreshGlobalJobsInBackground(store);
  if (Array.isArray(liveCache.jobs)) {
    return liveCache.jobs;
  }

  return liveCache.jobsPromise;
}

function mergeGlobalJobs(store, globalJobs) {
  const localGlobalJobs = store.jobs.filter((job) => job.source === "global");
  const localById = new Map(localGlobalJobs.map((job) => [job.id, job]));
  const merged = globalJobs.map((job) => {
    const local = localById.get(job.id);
    if (!local) {
      return job;
    }

    return {
      ...job,
      applicants: local.applicants || job.applicants || [],
      postedBy: local.postedBy ?? job.postedBy ?? null,
      createdAt: local.createdAt || job.createdAt,
      category: local.category || job.category,
    };
  });

  localGlobalJobs.forEach((job) => {
    if (!merged.some((entry) => entry.id === job.id)) {
      merged.push(job);
    }
  });

  return merged;
}

function deriveLiveTrendsFromJobs(jobs) {
  const categoryCounts = new Map();
  const countryCounts = new Map();

  jobs.forEach((job) => {
    categoryCounts.set(job.category || "General", (categoryCounts.get(job.category || "General") || 0) + 1);
    countryCounts.set(job.country || "Global", (countryCounts.get(job.country || "Global") || 0) + 1);
  });

  const topCategories = [...categoryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  const topCountries = [...countryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([country]) => country);

  return topCategories.map(([category, count], index) => ({
    id: `live_trend_${index + 1}`,
    title: `${category} hiring`,
    direction: "up",
    change: `${count} active roles`,
    summary: `Live jobs currently show elevated demand in ${category.toLowerCase()} roles across tracked markets.`,
    regions: topCountries.length ? topCountries : ["Global"],
  }));
}

async function getTrends(store) {
  if (Array.isArray(liveCache.trends) && liveCache.trends.length) {
    return liveCache.trends;
  }

  if (liveCache.trendsPromise) {
    return liveCache.trendsPromise;
  }

  if (Array.isArray(liveCache.trends) && Date.now() - liveCache.trendsFetchedAt >= LIVE_CACHE_TTL_MS) {
    refreshTrendsInBackground(store);
    return liveCache.trends;
  }

  refreshTrendsInBackground(store);
  if (Array.isArray(liveCache.trends)) {
    return liveCache.trends;
  }

  return liveCache.trendsPromise;
}

function buildDegreeSuggestions(store, user) {
  const budget = String(user.budget || "").toLowerCase();
  return store.degrees.filter((degree) => {
    const fits = degree.fitFor.some((tag) => user.skills.includes(tag) || user.resume.toLowerCase().includes(tag.toLowerCase()));
    if (!fits) {
      return false;
    }

    if (budget.includes("1800") && degree.budgetRange.includes("35k")) {
      return false;
    }

    return true;
  });
}

function buildTrendSummary(trends, user) {
  const matches = trends.filter((trend) => {
    const text = `${trend.title} ${trend.summary}`.toLowerCase();
    return user.skills.some((skill) => text.includes(skill.toLowerCase()));
  });

  if (matches.length) {
    return `Your strongest market momentum is around ${matches[0].title}.`;
  }

  return "Your best move is to track rising digital and AI-adjacent roles.";
}

const CLOUD_KEYWORDS = [
  "cloud",
  "aws",
  "azure",
  "gcp",
  "google cloud",
  "kubernetes",
  "docker",
  "terraform",
  "devops",
  "sre",
  "platform engineering",
  "serverless",
  "finops",
  "iac",
  "infrastructure as code",
  "observability",
  "site reliability",
];

const CLOUD_SKILLS = [
  "AWS",
  "Azure",
  "GCP",
  "Kubernetes",
  "Docker",
  "Terraform",
  "Linux",
  "CI/CD",
  "DevOps",
  "Observability",
  "Networking",
  "Security",
  "Serverless",
  "FinOps",
];

function normalizeCloudText(job) {
  return [
    job.title,
    job.company,
    job.location,
    job.country,
    job.category,
    job.type,
    job.salary,
    job.description,
    ...(job.skills || []),
  ]
    .join(" ")
    .toLowerCase();
}

function isCloudRelatedJob(job) {
  const text = normalizeCloudText(job);
  return CLOUD_KEYWORDS.some((keyword) => text.includes(keyword));
}

function cloudSkillCounts(jobs) {
  const counts = new Map();

  jobs.forEach((job) => {
    (job.skills || []).forEach((skill) => {
      const label = String(skill || "").trim();
      if (!label) {
        return;
      }

      const normalized = label.toLowerCase();
      if (!CLOUD_SKILLS.some((cloudSkill) => normalized.includes(cloudSkill.toLowerCase()))) {
        return;
      }

      counts.set(label, (counts.get(label) || 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([skill, count]) => ({ skill, count }));
}

function buildCloudInsights(user, jobs, trends) {
  const cloudJobs = jobs.filter(isCloudRelatedJob);
  const topSkills = cloudSkillCounts(cloudJobs).slice(0, 5);
  const userText = `${user.resume || ""} ${(user.skills || []).join(" ")}`.toLowerCase();
  const matchedSkills = CLOUD_SKILLS.filter((skill) => userText.includes(skill.toLowerCase()));
  const missingSkills = CLOUD_SKILLS.filter((skill) => !userText.includes(skill.toLowerCase())).slice(0, 4);
  const trend = trends.find((entry) => normalizeCloudText(entry).includes("cloud")) || null;
  const readiness = Math.min(
    98,
    38 +
      matchedSkills.length * 8 +
      (cloudJobs.length ? 8 : 0) +
      (trend ? 6 : 0) +
      (user.resume && /cloud|aws|azure|gcp|kubernetes|terraform|devops/i.test(user.resume) ? 10 : 0),
  );

  return {
    title: "Cloud computing",
    summary: trend?.summary || "Cloud hiring and platform engineering roles are showing up in the live market feed.",
    readiness,
    marketCount: cloudJobs.length,
    topSkills,
    cloudJobs: cloudJobs.slice(0, 4).map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      type: job.type,
      salary: job.salary,
    })),
    matchedSkills,
    nextFocus: missingSkills,
    roadmap: [
      "Infrastructure as code",
      "Containers and orchestration",
      "Cost control and platform reliability",
    ],
    trendTitle: trend?.title || "Cloud cost optimization",
  };
}

function buildLocalAiAdvisor(store, user, jobs, trends) {
  const matches = jobs
    .map((job) => ({ job, score: scoreResume(user.resume, job) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ job, score }) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      score,
      reason: job.skills.filter((skill) => user.skills.includes(skill)).join(", ") || "career direction",
    }));

  const degreeSuggestions = buildDegreeSuggestions(store, user);

  return {
    source: "local-ai",
    overview: `${user.name}, you are currently strongest for ${matches[0]?.title || "product-aligned digital roles"} and similar paths.`,
    resumeReview: {
      score: Math.min(97, 66 + user.skills.length * 4),
      strengths: [
        "Clear role intent",
        "Good keyword overlap with market roles",
        "Resume language is readable for recruiters",
      ],
      improvements: [
        "Add measurable outcomes for each project",
        "Mention stack depth near every achievement",
        "Customize the first three lines for each application",
      ],
    },
    trendSummary: buildTrendSummary(trends, user),
    budgetAdvice: `With a monthly target budget of ${user.budget}, shortlist countries with better tuition-to-salary balance before applying widely.`,
    jobMatches: matches,
    degreeSuggestions,
  };
}

async function maybeRunExternalAi(user, jobs, trends, prompt) {
  if (!process.env.AI_PROVIDER_URL || !process.env.AI_API_KEY) {
    return null;
  }

  const model = process.env.AI_MODEL || "gpt-4.1-mini";
  const response = await fetch(process.env.AI_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a career advisor helping job seekers or hiring leads with concrete, concise guidance.",
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            profile: {
              name: user.name,
              role: user.role,
              headline: user.headline,
              skills: user.skills,
              budget: user.budget,
              resume: user.resume,
            },
            topJobs: jobs.slice(0, 6).map((job) => ({
              title: job.title,
              company: job.company,
              location: job.location,
              skills: job.skills,
              salary: job.salary,
            })),
            trends,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw new Error(`AI provider error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || data.output_text || null;
}

function withApplicantDetails(store, applicant) {
  return {
    ...applicant,
    user: sanitizeUser(store.users.find((entry) => entry.id === applicant.userId)),
  };
}

function enrichJob(store, job, viewer) {
  const applicants = (job.applicants || []).map((applicant) => withApplicantDetails(store, applicant));
  return {
    ...job,
    applicants,
    applicantCount: applicants.length,
    postedByUser: sanitizeUser(store.users.find((entry) => entry.id === job.postedBy)),
    viewerApplied: Boolean(viewer && applicants.some((applicant) => applicant.userId === viewer.id)),
    viewerSaved: Boolean(viewer && viewer.savedJobs.includes(job.id)),
    viewerApplicationStatus: viewer ? getApplicationStatus(job, viewer.id) : "",
  };
}

function buildAuthPayload(store, user) {
  return {
    viewer: sanitizeUser(user),
    mode: user.role,
  };
}

async function sendDashboardWithSession(res, statusCode, store, user, extra = {}) {
  setSessionCookie(res, createSessionToken(store, user));
  sendJson(res, statusCode, { ...(await buildDashboard(store, user)), ...extra });
}

async function buildMemberDashboard(store, user) {
  const [globalJobs, trends] = await Promise.all([getGlobalJobs(store), getTrends(store)]);
  const mergedGlobalJobs = mergeGlobalJobs(store, globalJobs);
  const jobs = [...store.jobs.filter((job) => job.source === "internal"), ...mergedGlobalJobs].map((job) => enrichJob(store, job, user));
  const notifications = ensureNotificationStore(user);
  const cloudInsights = buildCloudInsights(user, jobs, trends);
  return {
    kind: "member",
    auth: buildAuthPayload(store, user),
    viewer: sanitizeUser(user),
    features: {
      liveJobs: Boolean(process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveTrends: Boolean(process.env.GLOBAL_TRENDS_URL || process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveAi: Boolean(process.env.AI_PROVIDER_URL),
      cloudInsights: true,
    },
    jobs,
    appliedJobs: jobs.filter((job) => user.appliedJobs.includes(job.id)),
    savedJobs: jobs.filter((job) => user.savedJobs.includes(job.id)),
    trends,
    notifications,
    cloudInsights,
    ai: buildLocalAiAdvisor(store, user, jobs, trends),
  };
}

async function buildAdminDashboard(store, user) {
  const [trends, globalJobs] = await Promise.all([getTrends(store), getGlobalJobs(store)]);
  const worldJobs = mergeGlobalJobs(store, globalJobs).map((job) => enrichJob(store, job, user));
  const postedJobs = store.jobs.filter((job) => job.postedBy === user.id).map((job) => enrichJob(store, job, user));
  const cloudInsights = buildCloudInsights(user, [...postedJobs, ...worldJobs], trends);
  const applicants = postedJobs.flatMap((job) =>
    job.applicants.map((applicant) => ({
      ...applicant,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
    }))
  );

  return {
    kind: "talent_lead",
    auth: buildAuthPayload(store, user),
    viewer: sanitizeUser(user),
    features: {
      liveJobs: Boolean(process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveTrends: Boolean(process.env.GLOBAL_TRENDS_URL || process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveAi: Boolean(process.env.AI_PROVIDER_URL),
      cloudInsights: true,
    },
    postedJobs,
    applicants,
    trends,
    resumeChecks: user.verifiedResumes,
    worldJobs,
    notifications: ensureNotificationStore(user),
    cloudInsights,
  };
}

async function buildDashboard(store, user) {
  if (user.role === "talent_lead") {
    return buildAdminDashboard(store, user);
  }

  return buildMemberDashboard(store, user);
}

function requireAuth(req, store) {
  const token = getTokenFromRequest(req);
  const payload = parseToken(token, getSecret(store));
  const user = payload && store.users.find((entry) => entry.id === payload.sub);
  if (!payload || !user || store.meta.revokedSessions?.includes(payload.jti) || Number(payload.ver || 0) !== Number(user.sessionVersion || 0)) {
    return null;
  }
  return user;
}

async function handleApi(req, res, parsedUrl) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "orbit-jobs" });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/ready") {
    try {
      await readStore();
      sendJson(res, 200, { ok: true, service: "orbit-jobs", storage: mongoFallbackToLocal ? "local-fallback" : hasMongoStore() ? `mongodb:${MONGODB_STORAGE_MODE}` : "local" });
    } catch (error) {
      sendJson(res, 503, { ok: false, message: "Storage is not ready" });
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/logout") {
    const store = await readStore();
    const token = getTokenFromRequest(req);
    const payload = parseToken(token, getSecret(store));
    if (payload?.jti) {
      store.meta.revokedSessions = Array.isArray(store.meta.revokedSessions) ? store.meta.revokedSessions : [];
      if (!store.meta.revokedSessions.includes(payload.jti)) {
        store.meta.revokedSessions.push(payload.jti);
        store.meta.revokedSessions = store.meta.revokedSessions.slice(-1000);
        await writeStore(store);
      }
    }
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/password-reset/request") {
    const store = await readStore();
    const body = await parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = store.users.find((entry) => entry.email.toLowerCase() === email);
    const response = { message: "If an account matches that email, reset instructions will be sent." };

    if (user) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = hashResetToken(resetToken);
      user.resetTokenExpiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
      await writeStore(store);
      try {
        await sendPasswordResetEmail(user, resetToken);
      } catch (error) {
        // Do not disclose provider failures or account existence to the caller.
      }
      // Development fallback until an email provider is configured.
      if (process.env.NODE_ENV !== "production") {
        response.resetToken = resetToken;
      }
    }

    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/password-reset/confirm") {
    const store = await readStore();
    const body = await parseBody(req);
    const token = String(body.token || "");
    const newPassword = String(body.newPassword || "");
    const confirmPassword = String(body.confirmPassword || "");
    const tokenHash = hashResetToken(token);
    const user = store.users.find((entry) => entry.resetTokenHash && safeTimingEqual(entry.resetTokenHash, tokenHash));

    if (!user || !user.resetTokenExpiresAt || Date.now() > user.resetTokenExpiresAt) {
      sendJson(res, 400, { message: "This password reset link is invalid or expired" });
      return;
    }
    if (newPassword.length < 8) {
      sendJson(res, 400, { message: "Password must be at least 8 characters long" });
      return;
    }
    if (newPassword !== confirmPassword) {
      sendJson(res, 400, { message: "New password and confirmation do not match" });
      return;
    }

    const credential = hashPassword(newPassword);
    user.passwordSalt = credential.salt;
    user.passwordHash = credential.hash;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    delete user.password;
    delete user.resetTokenHash;
    delete user.resetTokenExpiresAt;
    await writeStore(store);
    sendJson(res, 200, { message: "Password reset successfully. Please log in again." });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/email-verification/request") {
    const store = await readStore();
    const body = await parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = store.users.find((entry) => entry.email.toLowerCase() === email && entry.emailVerified === false);
    const response = { message: "If that account needs verification, instructions will be sent." };
    if (user) {
      const verificationToken = crypto.randomBytes(32).toString("hex");
      user.verificationTokenHash = hashResetToken(verificationToken);
      user.verificationTokenExpiresAt = Date.now() + EMAIL_VERIFICATION_TTL_MS;
      await writeStore(store);
      try {
        await sendVerificationEmail(user, verificationToken);
      } catch (error) {
        // Keep account existence and provider failures private.
      }
      if (process.env.NODE_ENV !== "production") {
        response.verificationToken = verificationToken;
      }
    }
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/email-verification/confirm") {
    const store = await readStore();
    const body = await parseBody(req);
    const tokenHash = hashResetToken(String(body.token || ""));
    const user = store.users.find((entry) => entry.verificationTokenHash && safeTimingEqual(entry.verificationTokenHash, tokenHash));
    if (!user || !user.verificationTokenExpiresAt || Date.now() > user.verificationTokenExpiresAt) {
      sendJson(res, 400, { message: "This verification link is invalid or expired" });
      return;
    }
    user.emailVerified = true;
    delete user.verificationTokenHash;
    delete user.verificationTokenExpiresAt;
    await writeStore(store);
    sendJson(res, 200, { message: "Email verified successfully. You can now log in." });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/login") {
    const store = await readStore();
    const body = await parseBody(req);
    const user = store.users.find((entry) => entry.email.toLowerCase() === String(body.email || "").trim().toLowerCase());

    if (!user || user.role !== body.role || !verifyPassword(String(body.password || ""), user)) {
      sendJson(res, 401, { message: "Wrong role, email, or password" });
      return;
    }
    if (user.emailVerified === false) {
      sendJson(res, 403, { message: "Please verify your email before logging in" });
      return;
    }

    if (!user.passwordHash || !user.passwordSalt) {
      const credential = hashPassword(String(body.password || ""));
      user.passwordSalt = credential.salt;
      user.passwordHash = credential.hash;
      delete user.password;
      await writeStore(store);
    }

    await sendDashboardWithSession(res, 200, store, user);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/register") {
    const store = await readStore();
    const body = await parseBody(req);
    const lengthError = validateTextFields(body, { name: 120, email: 320, password: 256, headline: 200, address: 300, country: 100, city: 100, phone: 40, budget: 100, skills: 1000, resume: 20000, about: 5000 });
    if (lengthError) {
      sendJson(res, 400, { message: lengthError });
      return;
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!name || !email || !password) {
      sendJson(res, 400, { message: "Name, email, and password are required" });
      return;
    }
    if (password.length < 8) {
      sendJson(res, 400, { message: "Password must be at least 8 characters long" });
      return;
    }
    const age = parseAge(body.age);
    if (age === null) {
      sendJson(res, 400, { message: "Age must be a whole number between 0 and 120" });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { message: "Enter a valid email address" });
      return;
    }

    if (store.users.some((entry) => entry.email.toLowerCase() === email)) {
      sendJson(res, 409, { message: "This email already exists" });
      return;
    }

    const credential = hashPassword(password);
    const user = {
      id: createId("u_member"),
      role: "career_member",
      name,
      headline: String(body.headline || "Open to work").trim() || "Open to work",
      email,
      passwordSalt: credential.salt,
      passwordHash: credential.hash,
      emailVerified: false,
      avatar: initials(name),
      address: String(body.address || "").trim(),
      country: String(body.country || "").trim(),
      city: String(body.city || "").trim(),
      age,
      phone: String(body.phone || "").trim(),
      budget: String(body.budget || "$1500 / month").trim(),
      skills: String(body.skills || "").split(",").map((item) => item.trim()).filter(Boolean),
      resume: String(body.resume || "").trim(),
      resumeFileName: String(body.resumeFileName || "manual-entry.txt").trim(),
      about: String(body.about || "Building a thoughtful career path with Orbit Jobs.").trim(),
      appliedJobs: [],
      savedJobs: [],
      postedJobs: [],
      verifiedResumes: [],
      notifications: [],
    };

    const verificationToken = crypto.randomBytes(32).toString("hex");
    user.verificationTokenHash = hashResetToken(verificationToken);
    user.verificationTokenExpiresAt = Date.now() + EMAIL_VERIFICATION_TTL_MS;
    store.users.push(user);
    await writeStore(store);
    try {
      await sendVerificationEmail(user, verificationToken);
    } catch (error) {
      // Account creation must not reveal email-provider details.
    }
    await sendDashboardWithSession(
      res,
      201,
      store,
      user,
      process.env.NODE_ENV === "production" ? {} : { verificationToken },
    );
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/admin/provision") {
    const store = await readStore();
    const body = await parseBody(req);
    const lengthError = validateTextFields(body, { name: 120, email: 320, password: 256, companyName: 160, companyWebsite: 500, companyIndustry: 160, headline: 200, address: 300, country: 100, city: 100, phone: 40, budget: 100, skills: 1000, resume: 20000, about: 5000 });
    if (lengthError) {
      sendJson(res, 400, { message: lengthError });
      return;
    }
    if (!hasValidProvisioningKey(req)) {
      sendJson(res, 403, { message: "Developer provisioning key is not valid" });
      return;
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!name || !email || !password) {
      sendJson(res, 400, { message: "Name, email, and password are required" });
      return;
    }
    const age = parseAge(body.age);
    if (age === null || !isSafeHttpUrl(body.companyWebsite)) {
      sendJson(res, 400, { message: "Enter a valid age and company website URL" });
      return;
    }
    if (password.length < 12) {
      sendJson(res, 400, { message: "Provisioned account passwords must be at least 12 characters long" });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { message: "Enter a valid email address" });
      return;
    }

    if (store.users.some((entry) => entry.email.toLowerCase() === email)) {
      sendJson(res, 409, { message: "This email already exists" });
      return;
    }

    const credential = hashPassword(password);
    const user = {
      id: createId("u_admin"),
      role: "talent_lead",
      name,
      headline: String(body.headline || "Talent Lead").trim(),
      companyName: String(body.companyName || "ForgeHire Company").trim(),
      companyWebsite: String(body.companyWebsite || "").trim(),
      companyIndustry: String(body.companyIndustry || "").trim(),
      companyLogoText: String(body.companyLogoText || initials(String(body.companyName || name))).trim().slice(0, 3).toUpperCase(),
      teamSize: String(body.teamSize || "").trim(),
      email,
      passwordSalt: credential.salt,
      passwordHash: credential.hash,
      avatar: initials(name),
      address: String(body.address || "").trim(),
      country: String(body.country || "").trim(),
      city: String(body.city || "").trim(),
      age,
      phone: String(body.phone || "").trim(),
      budget: String(body.budget || "$0").trim(),
      skills: String(body.skills || "Hiring, Ops").split(",").map((item) => item.trim()).filter(Boolean),
      resume: String(body.resume || "Hiring and review operations.").trim(),
      resumeFileName: "admin-profile.txt",
      about: String(body.about || "Provisioned through developer access.").trim(),
      appliedJobs: [],
      savedJobs: [],
      postedJobs: [],
      verifiedResumes: [],
      notifications: [],
    };

    store.users.push(user);
    await writeStore(store);
    await sendDashboardWithSession(res, 201, store, user);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/internal/provision-company") {
    const store = await readStore();
    const body = await parseBody(req);
    const lengthError = validateTextFields(body, { name: 120, email: 320, password: 256, companyName: 160, companyWebsite: 500, companyIndustry: 160, headline: 200, address: 300, country: 100, city: 100, phone: 40, budget: 100, skills: 1000, resume: 20000, about: 5000 });
    if (lengthError) {
      sendJson(res, 400, { message: lengthError });
      return;
    }
    if (!hasValidProvisioningKey(req)) {
      sendJson(res, 403, { message: "Developer provisioning key is not valid" });
      return;
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const companyName = String(body.companyName || "").trim();

    if (!name || !email || !password || !companyName) {
      sendJson(res, 400, { message: "Company name, admin name, email, and password are required" });
      return;
    }
    const age = parseAge(body.age);
    if (age === null || !isSafeHttpUrl(body.companyWebsite)) {
      sendJson(res, 400, { message: "Enter a valid age and company website URL" });
      return;
    }
    if (password.length < 12) {
      sendJson(res, 400, { message: "Provisioned account passwords must be at least 12 characters long" });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { message: "Enter a valid email address" });
      return;
    }

    if (store.users.some((entry) => entry.email.toLowerCase() === email)) {
      sendJson(res, 409, { message: "This email already exists" });
      return;
    }

    const credential = hashPassword(password);
    const user = {
      id: createId("u_admin"),
      role: "talent_lead",
      name,
      headline: String(body.headline || "Talent Lead").trim(),
      companyName,
      companyWebsite: String(body.companyWebsite || "").trim(),
      companyIndustry: String(body.companyIndustry || "").trim(),
      companyLogoText: String(body.companyLogoText || initials(companyName)).trim().slice(0, 3).toUpperCase(),
      teamSize: String(body.teamSize || "").trim(),
      email,
      passwordSalt: credential.salt,
      passwordHash: credential.hash,
      avatar: initials(name),
      address: String(body.address || "").trim(),
      country: String(body.country || "").trim(),
      city: String(body.city || "").trim(),
      age,
      phone: String(body.phone || "").trim(),
      budget: String(body.budget || "$0").trim(),
      skills: String(body.skills || "Hiring, Ops").split(",").map((item) => item.trim()).filter(Boolean),
      resume: String(body.resume || "Hiring and review operations.").trim(),
      resumeFileName: "admin-profile.txt",
      about: String(body.about || `${companyName} hiring workspace.`).trim(),
      appliedJobs: [],
      savedJobs: [],
      postedJobs: [],
      verifiedResumes: [],
      notifications: [],
    };

    store.users.push(user);
    await writeStore(store);
    sendJson(res, 201, {
      message: `ForgeHire account created for ${companyName}`,
      company: sanitizeUser(user),
    });
    return;
  }

  const store = await readStore();
  const viewer = requireAuth(req, store);

  if (!viewer) {
    sendJson(res, 401, { message: "Please login first" });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/jobs") {
    const { page, pageSize } = getPagination(parsedUrl);
    const globalJobs = viewer.role === "career_member" ? await getGlobalJobs(store) : [];
    const jobs = [
      ...store.jobs.filter((job) => viewer.role === "talent_lead" ? job.postedBy === viewer.id : job.source === "internal"),
      ...globalJobs,
    ].map((job) => enrichJob(store, job, viewer));
    sendJson(res, 200, paginate(jobs, page, pageSize));
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/applicants") {
    if (viewer.role !== "talent_lead") {
      sendJson(res, 403, { message: "Only ForgeHire can view applicants" });
      return;
    }
    const { page, pageSize } = getPagination(parsedUrl);
    const applicants = store.jobs
      .filter((job) => job.postedBy === viewer.id)
      .flatMap((job) => (job.applicants || []).map((applicant) => ({
        ...applicant,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        user: sanitizeUser(store.users.find((entry) => entry.id === applicant.userId)),
      })));
    sendJson(res, 200, paginate(applicants, page, pageSize));
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/session") {
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "PATCH" && parsedUrl.pathname === "/api/profile") {
    const body = await parseBody(req);
    const lengthError = validateTextFields(body, { name: 120, headline: 200, address: 300, country: 100, city: 100, phone: 40, budget: 100, about: 5000, resume: 20000, resumeFileName: 255, skills: 1000 });
    if (lengthError) {
      sendJson(res, 400, { message: lengthError });
      return;
    }
    const profileAge = parseAge(body.age);
    if (profileAge === null) {
      sendJson(res, 400, { message: "Age must be a whole number between 0 and 120" });
      return;
    }
    const fields = ["name", "headline", "address", "country", "city", "age", "phone", "budget", "about", "resume", "resumeFileName", "skills"];
    fields.forEach((field) => {
      if (body[field] === undefined) {
        return;
      }
      if (field === "skills") {
        viewer.skills = String(body.skills).split(",").map((item) => item.trim()).filter(Boolean);
      } else if (field === "age") {
        viewer.age = profileAge;
      } else {
        viewer[field] = String(body[field]).trim();
      }
    });
    viewer.avatar = initials(viewer.name);
    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/change-password") {
    const body = await parseBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const confirmPassword = String(body.confirmPassword || "");

    if (!currentPassword || !newPassword || !confirmPassword) {
      sendJson(res, 400, { message: "Current password, new password, and confirmation are required" });
      return;
    }

    if (!verifyPassword(currentPassword, viewer)) {
      sendJson(res, 401, { message: "Current password is incorrect" });
      return;
    }

    if (newPassword.length < 8) {
      sendJson(res, 400, { message: "New password must be at least 8 characters long" });
      return;
    }

    if (newPassword !== confirmPassword) {
      sendJson(res, 400, { message: "New password and confirmation do not match" });
      return;
    }

    if (currentPassword === newPassword) {
      sendJson(res, 400, { message: "Choose a different password from your current one" });
      return;
    }

    const credential = hashPassword(newPassword);
    viewer.passwordSalt = credential.salt;
    viewer.passwordHash = credential.hash;
    delete viewer.password;
    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/jobs") {
    if (viewer.role !== "talent_lead") {
      sendJson(res, 403, { message: "Only ForgeHire can post jobs" });
      return;
    }

    const body = await parseBody(req);
    const lengthError = validateTextFields(body, { title: 200, company: 160, location: 200, country: 100, type: 60, salary: 120, description: 20000, skills: 1000 });
    if (lengthError) {
      sendJson(res, 400, { message: lengthError });
      return;
    }
    const required = ["title", "company", "location", "country", "type", "salary", "description", "skills"];
    if (required.some((field) => !String(body[field] || "").trim())) {
      sendJson(res, 400, { message: "Complete every job field before publishing" });
      return;
    }

    const job = {
      id: createId("job_internal"),
      source: "internal",
      title: String(body.title).trim(),
      company: String(body.company).trim(),
      location: String(body.location).trim(),
      country: String(body.country).trim(),
      type: String(body.type).trim(),
      salary: String(body.salary).trim(),
      skills: String(body.skills).split(",").map((item) => item.trim()).filter(Boolean),
      description: String(body.description).trim(),
      postedBy: viewer.id,
      createdAt: new Date().toISOString(),
      applicants: [],
    };

    store.jobs.unshift(job);
    viewer.postedJobs.unshift(job.id);
    await writeStore(store);
    sendJson(res, 201, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/apply$/.test(parsedUrl.pathname)) {
    if (viewer.role !== "career_member") {
      sendJson(res, 403, { message: "Only public users can apply to jobs" });
      return;
    }

    const jobId = parsedUrl.pathname.split("/")[3];
    const job = store.jobs.find((entry) => entry.id === jobId) || (await getGlobalJobs(store)).find((entry) => entry.id === jobId);
    if (!job) {
      sendJson(res, 404, { message: "Job not found" });
      return;
    }

    if (!job.applicants.some((applicant) => applicant.userId === viewer.id)) {
      job.applicants.push({
        userId: viewer.id,
        status: "Applied",
        resumeScore: scoreResume(viewer.resume, job),
        notes: "Auto-ranked by Orbit AI screening.",
      });
    }

    if (!viewer.appliedJobs.includes(job.id)) {
      viewer.appliedJobs.push(job.id);
    }

    if (!store.jobs.some((entry) => entry.id === job.id)) {
      store.jobs.push(job);
    }

    pushNotification(viewer, {
      type: "application",
      title: `Applied to ${job.title}`,
      message: `Your application for ${job.company} is now ${applicationStageLabel("Applied")}.`,
      jobId: job.id,
    });

    if (job.source === "internal") {
      const employer = store.users.find((entry) => entry.id === job.postedBy);
      pushNotification(employer, {
        type: "applicant",
        title: `New application for ${job.title}`,
        message: `${viewer.name} applied to ${job.company}.`,
        jobId: job.id,
        candidateId: viewer.id,
      });
    }

    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/save$/.test(parsedUrl.pathname)) {
    const jobId = parsedUrl.pathname.split("/")[3];
    if (viewer.savedJobs.includes(jobId)) {
      viewer.savedJobs = viewer.savedJobs.filter((entry) => entry !== jobId);
    } else {
      viewer.savedJobs.push(jobId);
    }
    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/admin/verify-resume") {
    if (viewer.role !== "talent_lead") {
      sendJson(res, 403, { message: "Only ForgeHire can verify resumes" });
      return;
    }

    const body = await parseBody(req);
    const candidate = store.users.find((entry) => entry.id === body.candidateId && entry.role === "career_member");
    if (!candidate) {
      sendJson(res, 404, { message: "Candidate not found" });
      return;
    }

    viewer.verifiedResumes.unshift({
      candidateName: candidate.name,
      status: "Verified",
      summary: `Resume file ${candidate.resumeFileName || "manual-entry.txt"} reviewed. Strongest signals: ${candidate.skills.slice(0, 3).join(", ")}.`,
    });
    pushNotification(candidate, {
      type: "resume",
      title: "Resume verified",
      message: `${viewer.companyName || "Your company"} reviewed your resume and marked it verified.`,
    });
    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/admin/applications/status") {
    if (viewer.role !== "talent_lead") {
      sendJson(res, 403, { message: "Only ForgeHire can update application stages" });
      return;
    }

    const body = await parseBody(req);
    const job = store.jobs.find((entry) => entry.id === body.jobId && entry.postedBy === viewer.id);
    if (!job) {
      sendJson(res, 404, { message: "Job not found" });
      return;
    }

    const applicant = job.applicants.find((entry) => entry.userId === body.candidateId);
    if (!applicant) {
      sendJson(res, 404, { message: "Applicant not found" });
      return;
    }

    const nextStatus = normalizeApplicationStatus(body.status);
    applicant.status = nextStatus;
    applicant.updatedAt = new Date().toISOString();

    const candidate = store.users.find((entry) => entry.id === body.candidateId);
    pushNotification(candidate, {
      type: "application",
      title: `Application ${applicationStageLabel(nextStatus)}`,
      message: `${viewer.companyName || "A hiring team"} updated your application for ${job.title} to ${applicationStageLabel(nextStatus)}.`,
      jobId: job.id,
    });

    pushNotification(viewer, {
      type: "applicant",
      title: `Stage updated for ${job.title}`,
      message: `${candidate?.name || "A candidate"} is now ${applicationStageLabel(nextStatus)}.`,
      jobId: job.id,
      candidateId: body.candidateId,
    });

    await writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/ai/advice") {
    const jobs = [...store.jobs.filter((job) => job.source === "internal"), ...(await getGlobalJobs(store))];
    const trends = await getTrends(store);
    const body = await parseBody(req);
    const prompt = String(body.prompt || "Review my current opportunities.").trim();
    const localAdvisor = buildLocalAiAdvisor(store, viewer, jobs, trends);

    try {
      const externalText = await maybeRunExternalAi(viewer, jobs, trends, prompt);
      if (externalText) {
        sendJson(res, 200, { ...localAdvisor, source: "external-ai", answer: externalText });
        return;
      }
    } catch (error) {
      sendJson(res, 200, { ...localAdvisor, source: "local-ai", answer: `${localAdvisor.overview} ${localAdvisor.trendSummary}` });
      return;
    }

    sendJson(res, 200, { ...localAdvisor, answer: `${localAdvisor.overview} ${localAdvisor.trendSummary}` });
    return;
  }

  sendJson(res, 404, { message: "Route not found" });
}

const server = http.createServer(async (req, res) => {
  const requestId = createRequestId();
  res.setHeader("X-Request-Id", requestId);
  const startedAt = Date.now();
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname.startsWith("/api/")) {
      if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !isAllowedMutationOrigin(req)) {
        sendJson(res, 403, { message: "Request origin is not allowed" });
        return;
      }
      const rateLimitedRoutes = [
        "/api/login",
        "/api/register",
      ];
      if (["POST", "PATCH"].includes(req.method) && rateLimitedRoutes.includes(parsedUrl.pathname) && isRateLimited(req)) {
        sendJson(res, 429, { message: "Too many requests. Please try again later." });
        return;
      }
      if (["/api/admin/provision", "/api/internal/provision-company"].includes(parsedUrl.pathname) && req.method === "POST" && isRateLimited(req, PROVISION_RATE_LIMIT_MAX)) {
        sendJson(res, 429, { message: "Too many provisioning attempts. Please try again later." });
        return;
      }
      if (["/api/password-reset/request", "/api/password-reset/confirm"].includes(parsedUrl.pathname) && req.method === "POST" && isRateLimited(req, PASSWORD_RESET_RATE_LIMIT_MAX)) {
        sendJson(res, 429, { message: "Too many password reset attempts. Please try again later." });
        return;
      }
      if (["/api/email-verification/request", "/api/email-verification/confirm"].includes(parsedUrl.pathname) && req.method === "POST" && isRateLimited(req, VERIFICATION_RATE_LIMIT_MAX)) {
        sendJson(res, 429, { message: "Too many verification attempts. Please try again later." });
        return;
      }
      const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method);
      if (isMutation) {
        await runSerializedMutation(() => handleApi(req, res, parsedUrl));
      } else {
        await handleApi(req, res, parsedUrl);
      }
      return;
    }

    const cleanPath = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    let publicPath = cleanPath === "/" || cleanPath === "/candidate" || cleanPath.startsWith("/job/")
      ? "index.html"
      : cleanPath === "/professional" || cleanPath === "/studio" || cleanPath.startsWith("/professional/")
        ? "studio.html"
        : cleanPath.slice(1);

    let filePath = path.join(PUBLIC_DIR, publicPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { message: "Forbidden" });
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, "index.html");
    }

    sendFile(res, filePath);
  } catch (error) {
    const statusCode = error.message === "Request body is too large" ? 413 : error.message === "Invalid JSON body" ? 400 : error.message === "Concurrent store update detected; retry the request" ? 409 : 500;
    if (statusCode === 500) {
      console.error(JSON.stringify({ level: "error", requestId, method: req.method, path: req.url, durationMs: Date.now() - startedAt, error: error.message }));
    }
    sendJson(res, statusCode, { message: statusCode === 500 ? "Internal server error" : error.message, requestId });
  }
});

if (require.main === module) {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.TOKEN_SECRET || process.env.TOKEN_SECRET.length < 32) {
      throw new Error("TOKEN_SECRET must be set to a random value of at least 32 characters in production");
    }
    if (!process.env.ADMIN_PROVISION_KEY || process.env.ADMIN_PROVISION_KEY.length < 24) {
      throw new Error("ADMIN_PROVISION_KEY must be set to a random value of at least 24 characters in production");
    }
  }
  server.listen(PORT, HOST, () => {
    console.log(`Orbit Jobs running at http://localhost:${PORT}`);
    console.log(`Orbit Jobs running at http://127.0.0.1:${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received; shutting down gracefully`);
    server.close(async () => {
      if (mongoClient) {
        await mongoClient.close().catch(() => {});
      }
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = server;

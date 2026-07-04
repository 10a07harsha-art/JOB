const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
const PUBLIC_DIR = path.join(__dirname, "public");
const STORE_PATH = path.join(__dirname, "data", "store.json");
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_JOBS_URL = "https://remotive.com/api/remote-jobs?limit=24";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

function readStore() {
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
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
    });
    res.end(file);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
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

    req.on("error", reject);
  });
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString("hex"),
  };
}

function verifyPassword(password, user) {
  if (!user) {
    return false;
  }

  if (!user.passwordSalt || !user.passwordHash) {
    return Boolean(user.password) && crypto.timingSafeEqual(Buffer.from(String(password)), Buffer.from(String(user.password)));
  }

  const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.passwordHash, "hex"));
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
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
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
    exp: Date.now() + TOKEN_TTL_MS,
  };

  return signToken(payload, getSecret(store));
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return "";
  }
  return auth.slice(7);
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash, passwordSalt, password, ...safeUser } = user;
  return safeUser;
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
    title: job.title || job.position || "Untitled role",
    company: job.company || job.company_name || "External company",
    location: job.location || job.region || "Remote",
    country: job.country || job.region || "Global",
    type: job.type || job.job_type || "Full-time",
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
  try {
    const payload = await fetchJsonWithFallback(process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL, process.env.GLOBAL_JOBS_API_KEY);
    if (payload) {
      return normalizeRemoteJobs(payload);
    }
  } catch (error) {
    // Fallback to local jobs when remote provider is unavailable.
  }

  return store.jobs.filter((job) => job.source === "global");
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
  try {
    const payload = await fetchJsonWithFallback(process.env.GLOBAL_TRENDS_URL, process.env.GLOBAL_TRENDS_API_KEY);
    if (payload) {
      return normalizeRemoteTrends(payload);
    }
  } catch (error) {
    // Fallback to local trends when remote provider is unavailable.
  }

  if (!process.env.GLOBAL_TRENDS_URL) {
    const liveJobs = await getGlobalJobs(store);
    const derived = deriveLiveTrendsFromJobs(liveJobs);
    if (derived.length) {
      return derived;
    }
  }

  return store.trends;
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
  };
}

function buildAuthPayload(store, user) {
  return {
    token: createSessionToken(store, user),
    viewer: sanitizeUser(user),
    mode: user.role,
  };
}

async function buildMemberDashboard(store, user) {
  const globalJobs = await getGlobalJobs(store);
  const jobs = [...store.jobs.filter((job) => job.source === "internal"), ...globalJobs].map((job) => enrichJob(store, job, user));
  const trends = await getTrends(store);
  return {
    kind: "member",
    auth: buildAuthPayload(store, user),
    viewer: sanitizeUser(user),
    features: {
      liveJobs: Boolean(process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveTrends: Boolean(process.env.GLOBAL_TRENDS_URL || process.env.GLOBAL_JOBS_URL || DEFAULT_JOBS_URL),
      liveAi: Boolean(process.env.AI_PROVIDER_URL),
    },
    jobs,
    appliedJobs: jobs.filter((job) => user.appliedJobs.includes(job.id)),
    savedJobs: jobs.filter((job) => user.savedJobs.includes(job.id)),
    trends,
    ai: buildLocalAiAdvisor(store, user, jobs, trends),
  };
}

async function buildAdminDashboard(store, user) {
  const trends = await getTrends(store);
  const worldJobs = (await getGlobalJobs(store)).map((job) => enrichJob(store, job, user));
  const postedJobs = store.jobs.filter((job) => job.postedBy === user.id).map((job) => enrichJob(store, job, user));
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
    },
    postedJobs,
    applicants,
    trends,
    resumeChecks: user.verifiedResumes,
    worldJobs,
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
  if (!payload) {
    return null;
  }
  return store.users.find((entry) => entry.id === payload.sub) || null;
}

async function handleApi(req, res, parsedUrl) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/login") {
    const store = readStore();
    const body = await parseBody(req);
    const user = store.users.find((entry) => entry.email.toLowerCase() === String(body.email || "").trim().toLowerCase());

    if (!user || user.role !== body.role || !verifyPassword(String(body.password || ""), user)) {
      sendJson(res, 401, { message: "Wrong role, email, or password" });
      return;
    }

    if (!user.passwordHash || !user.passwordSalt) {
      const credential = hashPassword(String(body.password || ""));
      user.passwordSalt = credential.salt;
      user.passwordHash = credential.hash;
      delete user.password;
      writeStore(store);
    }

    sendJson(res, 200, await buildDashboard(store, user));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/register") {
    const store = readStore();
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();

    if (!name || !email || !password) {
      sendJson(res, 400, { message: "Name, email, and password are required" });
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
      avatar: initials(name),
      address: String(body.address || "").trim(),
      country: String(body.country || "").trim(),
      city: String(body.city || "").trim(),
      age: Number(body.age || 0),
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
    };

    store.users.push(user);
    writeStore(store);
    sendJson(res, 201, await buildDashboard(store, user));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/admin/provision") {
    const store = readStore();
    const body = await parseBody(req);
    const key = String(body.developerKey || "").trim();

    if (key !== (process.env.ADMIN_PROVISION_KEY || store.meta.developerProvisionKey)) {
      sendJson(res, 403, { message: "Developer provisioning key is not valid" });
      return;
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();

    if (!name || !email || !password) {
      sendJson(res, 400, { message: "Name, email, and password are required" });
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
      age: Number(body.age || 0),
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
    };

    store.users.push(user);
    writeStore(store);
    sendJson(res, 201, await buildDashboard(store, user));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/internal/provision-company") {
    const store = readStore();
    const body = await parseBody(req);
    const key = String(body.developerKey || "").trim();

    if (key !== (process.env.ADMIN_PROVISION_KEY || store.meta.developerProvisionKey)) {
      sendJson(res, 403, { message: "Developer provisioning key is not valid" });
      return;
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();
    const companyName = String(body.companyName || "").trim();

    if (!name || !email || !password || !companyName) {
      sendJson(res, 400, { message: "Company name, admin name, email, and password are required" });
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
      age: Number(body.age || 0),
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
    };

    store.users.push(user);
    writeStore(store);
    sendJson(res, 201, {
      message: `ForgeHire account created for ${companyName}`,
      company: sanitizeUser(user),
    });
    return;
  }

  const store = readStore();
  const viewer = requireAuth(req, store);

  if (!viewer) {
    sendJson(res, 401, { message: "Please login first" });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/session") {
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "PATCH" && parsedUrl.pathname === "/api/profile") {
    const body = await parseBody(req);
    const fields = ["name", "headline", "address", "country", "city", "age", "phone", "budget", "about", "resume", "resumeFileName", "skills"];
    fields.forEach((field) => {
      if (body[field] === undefined) {
        return;
      }
      if (field === "skills") {
        viewer.skills = String(body.skills).split(",").map((item) => item.trim()).filter(Boolean);
      } else if (field === "age") {
        viewer.age = Number(body.age || 0);
      } else {
        viewer[field] = String(body[field]).trim();
      }
    });
    viewer.avatar = initials(viewer.name);
    writeStore(store);
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
    writeStore(store);
    sendJson(res, 200, await buildDashboard(store, viewer));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/jobs") {
    if (viewer.role !== "talent_lead") {
      sendJson(res, 403, { message: "Only ForgeHire can post jobs" });
      return;
    }

    const body = await parseBody(req);
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
    writeStore(store);
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

    writeStore(store);
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
    writeStore(store);
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
    writeStore(store);
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
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, parsedUrl);
      return;
    }

    const cleanPath = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    let publicPath = cleanPath === "/" ? "index.html" : cleanPath.slice(1);

    if (cleanPath === "/studio") {
      publicPath = "studio.html";
    }

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
    sendJson(res, 500, { message: error.message || "Internal server error" });
  }
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Orbit Jobs running at port ${PORT}`);
  });
}

module.exports = server;

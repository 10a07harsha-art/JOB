const app = document.getElementById("app");
const TOKEN_KEY = "orbit_jobs_token";
const SESSION_KEY = "orbit_jobs_session";
const LEGACY_TOKEN_KEY = "careerlink_token";
const AUTH_SCREEN_KEY = "orbit_jobs_auth_screen";

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

const state = {
  session: readStoredSession(),
  token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || readStoredSession()?.auth?.token || "",
  authScreen: ["login", "signup"].includes(localStorage.getItem(AUTH_SCREEN_KEY)) ? localStorage.getItem(AUTH_SCREEN_KEY) : "login",
  message: "",
  messageType: "success",
  aiResponse: "",
  profileOpen: false,
  passwordOpen: false,
  notificationsOpen: false,
  activeJobId: "",
  focusedJobId: "",
  jobQuery: "",
  jobSourceFilter: "all",
  jobTypeFilter: "all",
  jobSort: "recent",
};

document.title = "Orbit Jobs Candidate Portal";
let refreshSessionRun = 0;

async function request(path, options = {}) {
  const { headers: requestHeaders, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(requestHeaders || {}),
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Something went wrong");
  }

  return data;
}

function setMessage(text, type = "success") {
  state.message = text;
  state.messageType = type;
  render();
  clearTimeout(setMessage.timer);
  setMessage.timer = window.setTimeout(() => {
    state.message = "";
    render();
  }, 3200);
}

function persistAuthScreen(value) {
  state.authScreen = value;
  localStorage.setItem(AUTH_SCREEN_KEY, value);
}

function saveSession(session) {
  state.session = session;
  state.token = session.auth.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function clearSession() {
  state.session = null;
  state.token = "";
  state.aiResponse = "";
  state.profileOpen = false;
  state.passwordOpen = false;
  state.notificationsOpen = false;
  state.activeJobId = "";
  state.focusedJobId = "";
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

async function refreshSession() {
  const runId = ++refreshSessionRun;
  const tokenAtStart = state.token;

  if (!state.token) {
    render();
    return;
  }

  try {
    const session = await request("/api/session");
    if (runId !== refreshSessionRun || tokenAtStart !== state.token) {
      return;
    }
    state.session = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (error) {
    if (runId !== refreshSessionRun || tokenAtStart !== state.token) {
      return;
    }
    clearSession();
    setMessage(error.message, "error");
  }

  render();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function readResumeFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve({ text: "", name: "manual-entry.txt" });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => resolve({ text: String(reader.result || ""), name: file.name });
    reader.onerror = () => reject(new Error("Unable to read the selected resume file"));
    reader.readAsText(file);
  });
}

function normalizeJobText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function previewText(value, maxLength = 220) {
  const clean = normalizeJobText(value);
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength).trim()}...`;
}

function initialsFromName(value, fallback = "OJ") {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) {
    return fallback;
  }
  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function brandHueFromName(value) {
  return String(value || "")
    .split("")
    .reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
}

function companyMark(name, fallback = "OJ") {
  const initials = initialsFromName(name, fallback);
  const hue = brandHueFromName(name || fallback);
  return `
    <div class="company-mark" style="--brand-hue:${hue}deg">
      <span>${initials}</span>
    </div>
  `;
}

function isInternalJob(job) {
  return job?.source === "internal";
}

function jobSourceLabel(job) {
  if (isInternalJob(job)) {
    return "ForgeHire";
  }

  return job?.providerLabel || "Global";
}

function jobSourceDescription(job) {
  if (isInternalJob(job)) {
    return "ForgeHire role";
  }

  return `${job?.providerLabel || "Global"} listing`;
}

function jobAcronym(job) {
  return isInternalJob(job) ? "FH" : (job?.providerLabel || "G").slice(0, 2).toUpperCase();
}

function topSkillsFromJobs(jobs, limit = 4) {
  const counts = new Map();
  jobs.forEach((job) => {
    (job.skills || []).forEach((skill) => {
      const key = String(skill || "").trim();
      if (!key) {
        return;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([skill, count]) => ({ skill, count }));
}

function topLocationsFromJobs(jobs, limit = 4) {
  const counts = new Map();
  jobs.forEach((job) => {
    const key = String(job.location || "Remote").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([location, count]) => ({ location, count }));
}

function topCompaniesFromJobs(jobs, limit = 4) {
  const counts = new Map();
  jobs.forEach((job) => {
    const key = String(job.company || "Unknown company").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([company, count]) => ({ company, count }));
}

function getFocusedJob(jobs) {
  if (!jobs.length) {
    return null;
  }
  return jobs.find((job) => job.id === state.focusedJobId) || jobs[0];
}

function featureChip(label, enabled) {
  return `<span class="feature-chip ${enabled ? "live" : "fallback"}">${label}: ${enabled ? "live" : "fallback"}</span>`;
}

function getJobRouteId() {
  const match = window.location.pathname.match(/^\/job\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function openJobRoute(jobId) {
  window.history.pushState({}, "", `/job/${encodeURIComponent(jobId)}`);
}

function closeJobRoute() {
  if (window.location.pathname.startsWith("/job/")) {
    window.history.pushState({}, "", "/");
  }
}

function salaryValue(text) {
  const value = String(text || "").toLowerCase();
  const match = value.match(/(\d+(?:\.\d+)?)(k?)/);
  if (!match) {
    return 0;
  }
  const number = Number(match[1]);
  return match[2] === "k" ? number * 1000 : number;
}

function filterJobs(jobs) {
  const query = state.jobQuery.trim().toLowerCase();
  const sourceFilter = state.jobSourceFilter;
  const typeFilter = state.jobTypeFilter;

  const filtered = jobs.filter((job) => {
    if (sourceFilter !== "all" && job.source !== sourceFilter) {
      return false;
    }

    if (typeFilter !== "all" && normalizeJobType(job.type) !== typeFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      job.title,
      job.company,
      job.location,
      job.country,
      job.type,
      job.salary,
      job.description,
      ...(job.skills || []),
    ].join(" ").toLowerCase();

    return haystack.includes(query);
  });

  const sorted = [...filtered];
  switch (state.jobSort) {
    case "recent":
    case "newest":
      sorted.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
      break;
    case "title":
      sorted.sort((left, right) => left.title.localeCompare(right.title));
      break;
    case "salary-high":
      sorted.sort((left, right) => salaryValue(right.salary) - salaryValue(left.salary));
      break;
    case "salary-low":
      sorted.sort((left, right) => salaryValue(left.salary) - salaryValue(right.salary));
      break;
    default:
      break;
  }

  return sorted;
}

function formatNotificationTime(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizeJobType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function formatJobType(value) {
  const normalized = normalizeJobType(value);
  if (normalized === "full-time" || normalized === "fulltime") {
    return "Full-Time";
  }
  if (normalized === "part-time" || normalized === "parttime") {
    return "Part-Time";
  }
  return normalized
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function authView() {
  const loginScreen = state.authScreen === "login";
  const signupScreen = state.authScreen === "signup";

  return `
    <div class="auth-shell orbit-auth-shell">
      ${state.message ? `<div class="notice ${state.messageType}">${state.message}</div>` : ""}
      <section class="hero-card glass reveal-up hero-card-orbit">
        <span class="eyebrow">Orbit Jobs</span>
        <h1>Candidate workspace for discovering and applying to roles.</h1>
        <p>
          Orbit Jobs is the public candidate site. Search live roles, track market signals, save jobs, and get AI-backed career guidance
          without the company tools that belong on the separate ForgeHire site.
        </p>
        <div class="hero-grid hero-feature-grid">
          <div class="hero-feature-card"><strong>Orbit Explorer</strong><span>live jobs, AI guidance, market movement</span></div>
          <div class="hero-feature-card"><strong>Profile workspace</strong><span>resume, budget, applied jobs, saved roles</span></div>
          <div class="hero-feature-card"><strong>Candidate only</strong><span>students and job seekers stay here</span></div>
        </div>
        <div class="hero-metrics">
          <div><b>Live market</b><span>global jobs and trend-aware signals</span></div>
          <div><b>Resume intelligence</b><span>fit scoring, advice, and study planning</span></div>
        </div>
        <div class="hero-actions">
          <a class="ghost-link-button" href="/professional">Employer login: open ForgeHire</a>
        </div>
      </section>

      <section class="auth-card glass reveal-up delay-2 auth-card-orbit">
        <div class="tab-row">
          <button type="button" class="tab-pill ${loginScreen ? "active" : ""}" data-auth-screen="login">Login</button>
          <button type="button" class="tab-pill ${signupScreen ? "active" : ""}" data-auth-screen="signup">Signup</button>
        </div>

        ${loginScreen ? `
          <form id="login-form" class="stack-form">
            <input type="hidden" name="role" value="career_member" />
            <label class="field"><span>Email</span><input id="login-email" name="email" placeholder="name@company.com" autocomplete="username" /></label>
            <label class="field"><span>Password</span><input type="password" name="password" placeholder="Enter your password" autocomplete="current-password" /></label>
            <button class="primary-button xl" type="submit">Enter workspace</button>
          </form>
        ` : ""}

        ${signupScreen ? `
          <form id="signup-form" class="stack-form">
            <label class="field"><span>Name</span><input name="name" placeholder="Your name" autocomplete="name" required /></label>
            <label class="field"><span>Email</span><input name="email" type="email" placeholder="email@example.com" autocomplete="email" required /></label>
            <label class="field"><span>Password</span><input type="password" name="password" placeholder="Create a password" autocomplete="new-password" required /></label>
            <button class="primary-button xl" type="submit">Create candidate account</button>
          </form>
        ` : ""}

      </section>
    </div>
  `;
}

function topbar() {
  if (state.session?.kind === "member") {
    const notificationCount = (state.session.notifications || []).length;
    return `
      <header class="linkedin-topbar">
        <div class="linkedin-topbar-left">
          <div class="linkedin-logo orbit-logo">
            <img src="/orbit-icon.svg" alt="Orbit Jobs" />
          </div>
          <label class="linkedin-search">
            <span>⌕</span>
            <input id="job-search" value="${state.jobQuery}" placeholder="Describe the job you want" />
          </label>
        </div>
        <nav class="linkedin-nav">
          <button type="button" class="linkedin-nav-item active" data-nav="home">
            <span>⌂</span>
            <small>Home</small>
          </button>
          <button type="button" class="linkedin-nav-item" data-nav="jobs">
            <span>⌖</span>
            <small>Jobs</small>
          </button>
          <button type="button" class="linkedin-nav-item" data-nav="saved">
            <span>🔖</span>
            <small>Saved</small>
          </button>
          <button type="button" class="linkedin-nav-item" id="open-notifications">
            <span>◌</span>
            <small>Alerts ${notificationCount ? `(${notificationCount})` : ""}</small>
          </button>
          <button type="button" class="linkedin-nav-item" id="open-profile">
            <span>☺</span>
            <small>Me</small>
          </button>
          <button type="button" class="linkedin-nav-item" id="open-password">
            <span>⋯</span>
            <small>Account</small>
          </button>
          <button type="button" class="linkedin-nav-item" id="logout-button">
            <span>⇢</span>
            <small>Sign out</small>
          </button>
        </nav>
      </header>
    `;
  }

  const notificationCount = (state.session.notifications || []).length;
  return `
    <header class="topbar glass reveal-down">
      <div class="brand-lockup">
        <img class="brand-wordmark" src="/orbit-wordmark.svg" alt="Orbit Jobs" />
        <div class="brand-copy">
          <strong>Orbit Jobs</strong>
          <span>${state.session.kind === "talent_lead" ? "ForgeHire" : "Candidate Portal"}</span>
        </div>
      </div>
      <div class="topbar-actions">
        ${featureChip("Jobs", state.session.features.liveJobs)}
        ${featureChip("Trends", state.session.features.liveTrends)}
        ${featureChip("AI", state.session.features.liveAi)}
        <button class="ghost-button" id="open-notifications">Notifications ${notificationCount ? `(${notificationCount})` : ""}</button>
        ${state.session.kind === "member" ? `<button class="ghost-button" id="open-profile">Profile</button>` : ""}
        <button class="ghost-button" id="open-password">Password</button>
        <button class="ghost-button" id="refresh-session">Refresh</button>
        <button class="ghost-button" id="logout-button">Logout</button>
      </div>
    </header>
  `;
}

function trendCards(trends) {
  return trends.map((trend) => `
    <article class="trend-card ${trend.direction}">
      <div class="trend-top">
        <strong>${trend.title}</strong>
        <span class="trend-badge ${trend.direction}">${trend.change}</span>
      </div>
      <p>${trend.summary}</p>
      <small>${trend.regions.join(" • ")}</small>
    </article>
  `).join("");
}

function jobCards(jobs, memberMode) {
  return jobs.map((job) => `
    <article class="job-card ${job.source}">
      <div class="job-card-top">
        <div>
          <span class="source-badge ${isInternalJob(job) ? "internal" : "global"}">${jobSourceLabel(job)}</span>
          <h4>${job.title}</h4>
          <p>${job.company}</p>
        </div>
        <div class="card-stack">
          <span class="salary-pill">${job.salary}</span>
          ${job.viewerApplicationStatus ? `<span class="score-pill">${job.viewerApplicationStatus}</span>` : ""}
        </div>
      </div>
      <div class="meta-row compact-wrap">
        <span>${job.location}</span>
        <span>${formatJobType(job.type)}</span>
        <span>${job.country}</span>
      </div>
      <p class="job-description">${previewText(job.description)}</p>
      <div class="skill-row">
        ${job.skills.map((skill) => `<span>${skill}</span>`).join("")}
      </div>
      ${memberMode ? `
        <div class="job-actions">
          <button class="ghost-button" type="button" data-open-job="${job.id}">View details</button>
          <button class="ghost-button" data-save-job="${job.id}">${job.viewerSaved ? "Saved" : "Save"}</button>
          ${job.source !== "internal" && job.applyUrl ? `
            <a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>
          ` : `
            <button class="primary-button" data-apply-job="${job.id}">${job.viewerApplied ? "Applied" : "Apply"}</button>
          `}
        </div>
      ` : `
        <div class="job-actions">
          <span class="feature-chip live">Applicants: ${job.applicantCount}</span>
          <button class="ghost-button" type="button" data-open-job="${job.id}">View details</button>
          ${job.source !== "internal" && job.applyUrl ? `<a class="ghost-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">View listing</a>` : ""}
        </div>
      `}
    </article>
  `).join("");
}

function jobFeedCards(jobs) {
  return jobs.map((job) => `
    <article class="linkedin-job-post glass">
      <div class="linkedin-post-head">
        <div class="linkedin-company">
          ${companyMark(job.company, jobAcronym(job))}
          <div>
            <strong>${job.title}</strong>
            <small>${job.company} · ${job.location} · ${formatJobType(job.type)}</small>
          </div>
        </div>
        <div class="job-post-meta">
          <span class="linkedin-post-time">${formatDate(job.createdAt || new Date().toISOString())}</span>
          <span class="salary-pill">${job.salary}</span>
        </div>
      </div>
      <div class="linkedin-post-copy-wrap">
        <p class="linkedin-post-copy">${previewText(job.description, 260)}</p>
      </div>
      <div class="skill-row linkedin-skill-row">
        ${job.skills.map((skill) => `<span>${skill}</span>`).join("")}
      </div>
      <div class="linkedin-post-stats">
        <span>${jobSourceDescription(job)}</span>
        <span>${job.applicantCount || 0} applicants</span>
        ${job.viewerApplicationStatus ? `<span>${job.viewerApplicationStatus}</span>` : ""}
      </div>
      <div class="linkedin-post-actions">
        <button class="ghost-button" type="button" data-open-job="${job.id}">View job</button>
        <button class="ghost-button" data-save-job="${job.id}">${job.viewerSaved ? "Saved" : "Save"}</button>
        ${job.source !== "internal" && job.applyUrl ? `
          <a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Apply</a>
        ` : `
          <button class="primary-button" data-apply-job="${job.id}">${job.viewerApplied ? "Applied" : "Apply now"}</button>
        `}
      </div>
    </article>
  `).join("");
}

function candidateSidebar(viewer, appliedJobs, savedJobs, ai, jobs) {
  const topSkills = topSkillsFromJobs(jobs || [], 4);
  const topLocations = topLocationsFromJobs(jobs || [], 4);
  const topCompanies = topCompaniesFromJobs(jobs || [], 4);
  const recentJobs = (jobs || []).slice(0, 4);
  return `
    <aside class="linkedin-sidebar left">
      <section class="linkedin-card profile-card glass" id="profile">
        <div class="profile-cover"></div>
        <div class="profile-avatar">${viewer.avatar || initialsFromName(viewer.name || "OJ")}</div>
        <div class="profile-body">
          <h3>${viewer.name}</h3>
          <p>${viewer.headline || "Open to work"}</p>
          <small>${viewer.city || "Your city"}${viewer.country ? `, ${viewer.country}` : ""}</small>
          <div class="profile-meta">
            <span>${appliedJobs.length} applied</span>
            <span>${savedJobs.length} saved</span>
          </div>
        </div>
      </section>

      <section class="linkedin-card glass quick-links-card">
        <span class="eyebrow">Preferences</span>
        <a href="#jobs">Job tracker</a>
        <a href="#saved">Saved jobs</a>
        <a href="#applied">Applications</a>
        <a href="#profile">Profile & resume</a>
      </section>

      <section class="linkedin-card glass tips-card">
        <span class="eyebrow">Career tips</span>
        <h4>${ai.overview}</h4>
        <p>${ai.trendSummary}</p>
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Profile boost</span>
        <div class="rail-item">
          <strong>${viewer.headline ? "Profile looks active" : "Add a headline"}</strong>
          <p>${viewer.headline ? "Your profile already has a strong public summary." : "Add a short headline so employers know what you want."}</p>
        </div>
        <div class="rail-item">
          <strong>${viewer.resumeText ? "Resume uploaded" : "Resume missing"}</strong>
          <p>${viewer.resumeText ? "Your resume text is ready for matching." : "Upload resume text to improve matching."}</p>
        </div>
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Skill radar</span>
        ${topSkills.length ? `
          <div class="rail-pill-grid">
            ${topSkills.map((entry) => `<span class="rail-pill">${entry.skill}</span>`).join("")}
          </div>
        ` : `<p>More live jobs will surface the most common skills here.</p>`}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Market watch</span>
        ${topLocations.length ? topLocations.map((entry) => `
          <div class="rail-item">
            <strong>${entry.location}</strong>
            <p>${entry.count} live roles in your current feed</p>
          </div>
        `).join("") : `<p>Location trends will appear as more jobs load.</p>`}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Top employers</span>
        ${topCompanies.length ? topCompanies.map((entry) => `
          <div class="rail-item">
            <strong>${entry.company}</strong>
            <p>${entry.count} jobs in the live feed</p>
          </div>
        `).join("") : `<p>Company trends will appear as more jobs load.</p>`}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Job tracker</span>
        <div class="rail-item">
          <strong>${savedJobs.length} saved jobs</strong>
          <p>Keep your shortlist tight and revisit these roles when you're ready to apply.</p>
        </div>
        <div class="rail-item">
          <strong>${appliedJobs.length} active applications</strong>
          <p>Check back on roles you’ve already moved on so you don’t lose track of them.</p>
        </div>
        <div class="rail-item">
          <strong>Recent searches</strong>
          <p>${recentJobs.length ? recentJobs.map((job) => job.title).join(" · ") : "Search terms will appear here once you explore more jobs."}</p>
        </div>
      </section>
    </aside>
  `;
}

function candidateRightRail(trends, notifications, ai, savedJobs, jobs) {
  const topSkills = topSkillsFromJobs(jobs || [], 5);
  const topLocations = topLocationsFromJobs(jobs || [], 4);
  const topCompanies = topCompaniesFromJobs(jobs || [], 4);
  const quickTargets = (jobs || []).slice(0, 3);
  const moreTargets = (jobs || []).slice(3, 8);
  return `
    <aside class="linkedin-sidebar right">
      <section class="linkedin-card glass rail-card" id="trends">
        <span class="eyebrow">LinkedIn News</span>
        <div class="skill-row rail-skill-row">
          ${trends.slice(0, 4).map((trend) => `<span>${trend.title}</span>`).join("")}
        </div>
      </section>

      <section class="linkedin-card glass rail-card" id="notifications">
        <span class="eyebrow">Notifications</span>
        ${notifications.slice(0, 3).length ? notifications.slice(0, 3).map((item) => `
          <div class="rail-item">
            <strong>${item.title}</strong>
            <p>${item.message}</p>
          </div>
        `).join("") : `<p>No updates yet.</p>`}
        <button class="ghost-button rail-action" type="button" data-open-notifications-panel>Open all</button>
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Saved jobs</span>
        ${savedJobs.length ? savedJobs.slice(0, 4).map((job) => `
          <div class="rail-item">
            <strong>${job.title}</strong>
            <p>${job.company}</p>
          </div>
        `).join("") : `<p>No saved jobs yet.</p>`}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">AI helper</span>
        <p>${ai.overview}</p>
        <form id="ai-form" class="stack-form rail-ai-form">
          <textarea name="prompt" rows="3" placeholder="Ask for job targets, resume advice, relocation ideas, or budget-friendly masters."></textarea>
          <button class="primary-button" type="submit">Get AI guidance</button>
        </form>
        ${state.aiResponse ? `<div class="ai-answer rail-ai-answer">${state.aiResponse}</div>` : ""}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Quick matches</span>
        ${quickTargets.length ? quickTargets.map((job) => `
          <div class="rail-item">
            <strong>${job.title}</strong>
            <p>${job.company} · ${job.location}</p>
          </div>
        `).join("") : `<p>No quick matches yet.</p>`}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Career signals</span>
        ${topSkills.length ? `
          <div class="rail-item">
            <strong>Top skills</strong>
            <p>${topSkills.map((entry) => entry.skill).join(" · ")}</p>
          </div>
        ` : ""}
        ${topLocations.length ? `
          <div class="rail-item">
            <strong>Top locations</strong>
            <p>${topLocations.map((entry) => entry.location).join(" · ")}</p>
          </div>
        ` : ""}
        ${trends.slice(0, 2).map((trend) => `
          <div class="rail-item">
            <strong>${trend.title}</strong>
            <p>${trend.summary}</p>
          </div>
        `).join("")}
      </section>

      <section class="linkedin-card glass rail-card">
        <span class="eyebrow">Hiring heat</span>
        ${topCompanies.length ? topCompanies.map((entry) => `
          <div class="rail-item">
            <strong>${entry.company}</strong>
            <p>${entry.count} live jobs in your feed</p>
          </div>
        `).join("") : `<p>Company trends will appear here as the feed grows.</p>`}
        ${moreTargets.length ? `
          <div class="rail-divider"></div>
          ${moreTargets.map((job) => `
            <div class="rail-item">
              <strong>${job.title}</strong>
              <p>${job.company} · ${job.type}</p>
            </div>
          `).join("")}
        ` : ""}
      </section>
    </aside>
  `;
}

function jobExplorer(jobs, memberMode, options = {}) {
  if (!jobs.length) {
    return `<div class="empty-card">${options.emptyText || "No jobs available right now."}</div>`;
  }

  const focused = getFocusedJob(jobs);
  const detail = normalizeJobText(focused.description);

  return `
    <div class="job-explorer">
      <div class="job-list-panel">
        ${jobs.map((job) => `
          <article class="job-list-item ${job.id === focused.id ? "active" : ""}" data-preview-job="${job.id}">
            <div class="job-list-top">
              <span class="source-badge ${isInternalJob(job) ? "internal" : "global"}">${jobSourceLabel(job)}</span>
              <div class="card-stack compact">
                <span class="salary-pill">${job.salary}</span>
                ${job.viewerApplicationStatus ? `<span class="score-pill">${job.viewerApplicationStatus}</span>` : ""}
              </div>
            </div>
            <h4>${job.title}</h4>
            <p>${job.company}</p>
            <div class="meta-row compact-wrap">
              <span>${job.location}</span>
              <span>${job.type}</span>
            </div>
          </article>
        `).join("")}
      </div>
      <div class="job-preview-panel glass">
        <div class="job-preview-head">
        <div class="job-preview-brand">
            ${companyMark(focused.company, jobAcronym(focused))}
            <div>
              <span class="source-badge ${isInternalJob(focused) ? "internal" : "global"}">${jobSourceDescription(focused)}</span>
              <h2>${focused.title}</h2>
              <p>${focused.company}</p>
            </div>
          </div>
          <div class="job-preview-actions">
            <button class="ghost-button" type="button" data-open-job="${focused.id}">View full details</button>
            ${memberMode ? `
              <button class="ghost-button" data-save-job="${focused.id}">${focused.viewerSaved ? "Saved" : "Save"}</button>
              ${focused.source !== "internal" && focused.applyUrl ? `
                <a class="primary-link-button" href="${focused.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>
              ` : `
                <button class="primary-button" data-apply-job="${focused.id}">${focused.viewerApplied ? "Applied" : "Apply"}</button>
              `}
            ` : `
              ${focused.source !== "internal" && focused.applyUrl ? `<a class="primary-link-button" href="${focused.applyUrl}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
            `}
          </div>
        </div>
        <div class="job-modal-meta">
          <span>${focused.location}</span>
          <span>${formatJobType(focused.type)}</span>
          <span>${focused.country}</span>
          <span>${focused.salary}</span>
        </div>
        <div class="skill-row">
          ${focused.skills.map((skill) => `<span>${skill}</span>`).join("")}
        </div>
        <div class="job-preview-copy">
          <div class="job-detail-column">
            <span class="eyebrow">Role Summary</span>
            <p>${detail}</p>
          </div>
          <div class="job-detail-column">
            <span class="eyebrow">Why It Stands Out</span>
            <p>${focused.source === "internal" ? "This is a direct company-owned role inside the hiring platform, so your application quality and profile fit have immediate recruiter visibility." : `This role comes from ${focused.providerLabel || "an external source"} and gives you a live benchmark from the market right now, including its company, compensation framing, and apply route.`}</p>
            <span class="eyebrow">Updated View</span>
            <p>${focused.viewerApplied ? "You have already applied to this role." : focused.viewerSaved ? "You saved this role to revisit it later." : "Use the actions above to save or move fast on this opening."}</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

function jobDetailModal() {
  if (!state.session || !state.activeJobId) {
    return "";
  }

  const pools = [
    ...(state.session.jobs || []),
    ...(state.session.appliedJobs || []),
    ...(state.session.savedJobs || []),
    ...(state.session.worldJobs || []),
    ...(state.session.postedJobs || []),
  ];
  const job = pools.find((entry) => entry.id === state.activeJobId);
  if (!job) {
    return "";
  }

  const fullText = normalizeJobText(job.description);

  return `
    <div class="job-modal-overlay" id="close-job-modal-overlay">
      <section class="job-modal glass cinematic-rise" role="dialog" aria-modal="true" aria-label="Job details">
        <div class="job-modal-top">
          <div class="job-preview-brand">
            ${companyMark(job.company, jobAcronym(job))}
            <div>
              <span class="source-badge ${isInternalJob(job) ? "internal" : "global"}">${jobSourceLabel(job)}</span>
              <h2>${job.title}</h2>
              <p>${job.company}</p>
            </div>
          </div>
          <button class="ghost-button" type="button" id="close-job-modal">Close</button>
        </div>
        <div class="job-modal-meta">
          <span>${job.location}</span>
          <span>${formatJobType(job.type)}</span>
          <span>${job.country}</span>
          <span>${job.salary}</span>
        </div>
        <div class="skill-row">
          ${job.skills.map((skill) => `<span>${skill}</span>`).join("")}
        </div>
        <div class="job-modal-body">
          <div class="job-detail-column">
            <span class="eyebrow">Role Summary</span>
            <p>${fullText}</p>
          </div>
          <div class="job-detail-column">
            <span class="eyebrow">Why It Matters</span>
            <p>${job.source === "internal" ? "This is a direct internal role, so your application and profile alignment matter immediately for recruiter review." : `This listing is coming from ${job.providerLabel || "an external source"}, so use it to compare role language, compensation, and required skills against your saved shortlist.`}</p>
            <span class="eyebrow">Action</span>
            <div class="job-actions modal-actions">
              ${job.source !== "internal" && job.applyUrl ? `<a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>` : ""}
              ${job.viewerSaved !== undefined ? `<button class="ghost-button" data-save-job="${job.id}">${job.viewerSaved ? "Saved" : "Save"}</button>` : ""}
              ${job.viewerApplied !== undefined && job.source === "internal" ? `<button class="primary-button" data-apply-job="${job.id}">${job.viewerApplied ? "Applied" : "Apply"}</button>` : ""}
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

function jobDetailPage(job) {
  if (!job) {
    return `
      <div class="dashboard-shell">
        <section class="panel glass">
          <span class="eyebrow">Job detail</span>
          <h3>Job not found</h3>
          <p>This listing is no longer available or the link is invalid.</p>
          <button class="primary-button" id="close-job-detail">Back to jobs</button>
        </section>
      </div>
    `;
  }

  return `
    <div class="dashboard-shell job-detail-shell">
      <section class="hero-panel glass reveal-up orbit-hero-panel">
        <div class="job-preview-brand">
          ${companyMark(job.company, jobAcronym(job))}
          <div>
            <span class="source-badge ${isInternalJob(job) ? "internal" : "global"}">${jobSourceDescription(job)}</span>
            <h1>${job.title}</h1>
            <p>${job.company}</p>
          </div>
        </div>
        <div class="job-modal-meta">
          <span>${job.location}</span>
          <span>${formatJobType(job.type)}</span>
          <span>${job.country}</span>
          <span>${job.salary}</span>
        </div>
        <div class="skill-row">
          ${job.skills.map((skill) => `<span>${skill}</span>`).join("")}
        </div>
        <div class="hero-actions">
          ${job.source !== "internal" && job.applyUrl ? `<a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>` : ""}
          ${job.source === "internal" ? `<button class="ghost-button" data-apply-job="${job.id}">${job.viewerApplicationStatus ? job.viewerApplicationStatus : "Apply"}</button>` : ""}
          <button class="ghost-button" id="close-job-detail">Back to jobs</button>
          <button class="ghost-button" data-save-job="${job.id}">${job.viewerSaved ? "Saved" : "Save"}</button>
        </div>
      </section>

      <section class="panel glass reveal-up delay-1">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Role Summary</span>
            <h3>What this job is about</h3>
          </div>
        </div>
        <p class="job-detail-copy">${normalizeJobText(job.description)}</p>
      </section>

      <section class="panel glass reveal-up delay-2">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Signals</span>
            <h3>Why this role stands out</h3>
          </div>
        </div>
        <div class="info-grid">
          <div><strong>${job.source === "internal" ? "Direct employer visibility" : "Market benchmark"}</strong><span>Context</span></div>
          <div><strong>${job.viewerApplicationStatus || "Not applied"}</strong><span>Your status</span></div>
          <div><strong>${job.viewerSaved ? "Saved" : "Not saved"}</strong><span>Shortlist</span></div>
        </div>
      </section>
    </div>
  `;
}

function notificationsDrawer() {
  if (!state.session || !state.notificationsOpen) {
    return "";
  }

  const notifications = state.session.notifications || [];

  return `
    <div class="profile-overlay" id="close-notifications-overlay">
      <aside class="profile-drawer glass reveal-up notifications-drawer" role="dialog" aria-modal="true" aria-label="Notifications panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Notifications</span>
            <h3>Recent updates</h3>
          </div>
          <button class="ghost-button" type="button" id="close-notifications">Close</button>
        </div>
        <div class="mini-card-grid notification-grid">
          ${notifications.length ? notifications.map((item) => `
            <article class="mini-card notification-card">
              <strong>${item.title}</strong>
              <span>${formatJobType(item.type)}</span>
              <p>${item.message}</p>
              <small>${formatNotificationTime(item.createdAt)}</small>
            </article>
          `).join("") : `<div class="empty-card">You’re all caught up. New applications, status changes, and resume checks will appear here.</div>`}
        </div>
      </aside>
    </div>
  `;
}

function jobFilterBar() {
  const jobs = state.session?.jobs || [];
  const types = [...new Map(jobs.map((job) => [normalizeJobType(job.type), formatJobType(job.type)])).entries()];
  return `
    <section class="panel glass reveal-up delay-1 job-filter-bar">
      <div class="panel-header">
        <div>
          <span class="eyebrow">Find roles</span>
          <h3>Search, filter, and sort jobs</h3>
        </div>
      </div>
      <div class="search-grid">
        <label class="field"><span>Search</span><input id="job-search" value="${state.jobQuery}" placeholder="Title, company, skill, location" /></label>
        <label class="field"><span>Source</span>
          <select id="job-source-filter">
            <option value="all" ${state.jobSourceFilter === "all" ? "selected" : ""}>All sources</option>
            <option value="global" ${state.jobSourceFilter === "global" ? "selected" : ""}>Global jobs</option>
            <option value="internal" ${state.jobSourceFilter === "internal" ? "selected" : ""}>ForgeHire roles</option>
          </select>
        </label>
        <label class="field"><span>Type</span>
          <select id="job-type-filter">
            <option value="all" ${state.jobTypeFilter === "all" ? "selected" : ""}>All types</option>
            ${types.map(([value, label]) => `<option value="${value}" ${state.jobTypeFilter === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Sort</span>
          <select id="job-sort">
            <option value="recent" ${state.jobSort === "recent" ? "selected" : ""}>Most recent</option>
            <option value="salary-high" ${state.jobSort === "salary-high" ? "selected" : ""}>Salary high to low</option>
            <option value="salary-low" ${state.jobSort === "salary-low" ? "selected" : ""}>Salary low to high</option>
            <option value="title" ${state.jobSort === "title" ? "selected" : ""}>Title A to Z</option>
          </select>
        </label>
      </div>
    </section>
  `;
}

function getCandidateJobById(jobId) {
  if (!state.session || !jobId) {
    return null;
  }

  const pools = [
    ...(state.session.jobs || []),
    ...(state.session.appliedJobs || []),
    ...(state.session.savedJobs || []),
    ...(state.session.worldJobs || []),
    ...(state.session.postedJobs || []),
  ];
  return pools.find((entry) => entry.id === jobId) || null;
}

function memberDashboard() {
  const { viewer, jobs, appliedJobs, savedJobs, trends, ai, features } = state.session;
  const visibleJobs = filterJobs(jobs);
  const visibleAppliedJobs = filterJobs(appliedJobs);
  const visibleSavedJobs = filterJobs(savedJobs);
  const topSkills = topSkillsFromJobs(visibleJobs, 6);
  const topLocations = topLocationsFromJobs(visibleJobs, 4);
  const topCompanies = topCompaniesFromJobs(visibleJobs, 4);
  const featuredJobs = visibleJobs.slice(0, 3);
  const collections = [
    "Government",
    "Easy Apply",
    "Remote",
    "Hybrid",
  ];
  const dynamicCollections = [...new Set([
    ...collections,
    ...jobs.map((job) => formatJobType(job.type)).filter(Boolean),
  ])].slice(0, 6);
  return `
    <div class="linkedin-layout">
      ${candidateSidebar(viewer, appliedJobs, savedJobs, ai, jobs)}

      <main class="linkedin-feed">
        <section class="linkedin-card glass feed-hero">
          <div>
            <span class="eyebrow">Jobs feed</span>
            <h1>Browse job posts in a feed built for hiring</h1>
            <p>These are live roles from Orbit Jobs and ForgeHire, styled more like LinkedIn Jobs than a social feed.</p>
          </div>
          <div class="feed-hero-aside">
            <div class="feed-stat-block">
              <strong>${jobs.length}</strong>
              <span>Jobs</span>
            </div>
            <div class="feed-stat-block">
              <strong>${appliedJobs.length}</strong>
              <span>Applied</span>
            </div>
            <div class="feed-stat-block">
              <strong>${savedJobs.length}</strong>
              <span>Saved</span>
            </div>
          </div>
        </section>

        <section class="linkedin-card glass feed-collections-card">
          <div class="feed-section-head feed-collections-head">
            <div>
              <span class="eyebrow">Explore with job collections</span>
              <h2>Find roles by what you care about</h2>
            </div>
            <span>Curated from your profile and search history</span>
          </div>
          <div class="collection-tabs">
            ${dynamicCollections.map((label, index) => `<span class="collection-pill ${index === 0 ? "active" : ""}">${label}</span>`).join("")}
          </div>
        </section>

        <section class="linkedin-card glass feed-section feed-insights">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">Feed insights</span>
              <h2>What the market is showing right now</h2>
            </div>
            <span>${visibleJobs.length} live jobs analyzed</span>
          </div>
          <div class="insight-grid">
            <article class="mini-card insight-card">
              <span class="eyebrow">Top skills</span>
              <div class="rail-pill-grid">
                ${topSkills.length ? topSkills.map((entry) => `<span class="rail-pill">${entry.skill}</span>`).join("") : `<span class="rail-pill">Loading skills</span>`}
              </div>
            </article>
            <article class="mini-card insight-card">
              <span class="eyebrow">Top locations</span>
              ${topLocations.length ? topLocations.map((entry) => `
                <div class="rail-item">
                  <strong>${entry.location}</strong>
                  <p>${entry.count} roles</p>
                </div>
              `).join("") : `<p>No location data yet.</p>`}
            </article>
            <article class="mini-card insight-card">
              <span class="eyebrow">Hiring heat</span>
              ${topCompanies.length ? topCompanies.map((entry) => `
                <div class="rail-item">
                  <strong>${entry.company}</strong>
                  <p>${entry.count} open roles</p>
                </div>
              `).join("") : `<p>No employer data yet.</p>`}
            </article>
          </div>
        </section>

        <section class="linkedin-card glass feed-section feed-focus">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">Featured roles</span>
              <h2>Three jobs worth opening next</h2>
            </div>
            <span>Curated from the top of your current feed</span>
          </div>
          <div class="featured-job-grid">
            ${featuredJobs.length ? featuredJobs.map((job) => `
              <article class="mini-card featured-job-card">
                <div class="job-list-top">
                  <span class="source-badge ${isInternalJob(job) ? "internal" : "global"}">${jobSourceLabel(job)}</span>
                  <span class="salary-pill">${job.salary}</span>
                </div>
                <h4>${job.title}</h4>
                <p>${job.company} · ${job.location}</p>
                <small>${formatJobType(job.type)}</small>
              </article>
            `).join("") : `<div class="empty-card">No featured jobs yet.</div>`}
          </div>
        </section>

        <section class="linkedin-card glass feed-section" id="jobs">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">More jobs for you</span>
              <h2>Job posts matched to your feed</h2>
            </div>
            <span>${visibleJobs.length} results</span>
          </div>
          <div class="feed-stack">
            ${visibleJobs.length ? jobFeedCards(visibleJobs) : `<div class="empty-card">No jobs match your current filters.</div>`}
          </div>
        </section>

        <section class="linkedin-card glass feed-section" id="applied">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">Applied jobs</span>
              <h2>Your active applications</h2>
            </div>
            <span>${visibleAppliedJobs.length} shown</span>
          </div>
          <div class="feed-stack">
            ${visibleAppliedJobs.length ? jobFeedCards(visibleAppliedJobs) : `<div class="empty-card">You have not applied yet. Start with one of the jobs above.</div>`}
          </div>
        </section>

        <section class="linkedin-card glass feed-section" id="saved">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">Saved jobs</span>
              <h2>Your shortlist</h2>
            </div>
            <span>${visibleSavedJobs.length} saved</span>
          </div>
          <div class="feed-stack">
            ${visibleSavedJobs.length ? jobFeedCards(visibleSavedJobs) : `<div class="empty-card">Save jobs here to keep them in one place.</div>`}
          </div>
        </section>

        <section class="linkedin-card glass feed-section">
          <div class="feed-section-head">
            <div>
              <span class="eyebrow">Trending now</span>
              <h2>Market movement and career signals</h2>
            </div>
          </div>
          <div class="trend-grid linkedin-trend-grid">${trendCards(trends)}</div>
        </section>
      </main>

      ${candidateRightRail(trends, state.session.notifications || [], ai, savedJobs, jobs)}
    </div>
  `;
}

function adminDashboard() {
  const { viewer, postedJobs, applicants, trends, worldJobs, resumeChecks } = state.session;
  return `
    <div class="dashboard-shell">
      <section class="hero-panel glass reveal-up admin-tone forge-hero-panel">
        <div>
          <span class="eyebrow">ForgeHire</span>
          <h1>Protected hiring workspace for admins.</h1>
          <p>
            Publish internal jobs, inspect applicants, verify resumes, and compare your openings with world-market demand.
          </p>
        </div>
        <div class="hero-grid compact-stats stat-showcase">
          <div class="stat-card"><strong>${postedJobs.length}</strong><span>Posted roles</span></div>
          <div class="stat-card"><strong>${applicants.length}</strong><span>Applicants</span></div>
          <div class="stat-card"><strong>${resumeChecks.length}</strong><span>Resume checks</span></div>
        </div>
      </section>

      <section class="panel glass reveal-up delay-1">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Admin profile</span>
            <h3>${viewer.name}</h3>
          </div>
          <div class="avatar-plate">${viewer.avatar}</div>
        </div>
        <div class="info-grid">
          <div><strong>${viewer.country}</strong><span>Country</span></div>
          <div><strong>${viewer.phone}</strong><span>Phone</span></div>
          <div><strong>${viewer.budget}</strong><span>Ops note</span></div>
        </div>
      </section>

      <section class="panel glass reveal-up delay-2">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Post job</span>
            <h3>Add a new internal role</h3>
          </div>
        </div>
        <form id="job-form" class="stack-form">
          <div class="double-grid">
            <label class="field"><span>Title</span><input name="title" placeholder="Senior Backend Engineer" /></label>
            <label class="field"><span>Company</span><input name="company" placeholder="Northstar Labs" /></label>
          </div>
          <div class="triple-grid">
            <label class="field"><span>Location</span><input name="location" placeholder="Remote - APAC" /></label>
            <label class="field"><span>Country</span><input name="country" placeholder="Singapore" /></label>
            <label class="field"><span>Type</span><input name="type" placeholder="Full-time" /></label>
          </div>
          <div class="double-grid">
            <label class="field"><span>Salary</span><input name="salary" placeholder="$90k - $130k" /></label>
            <label class="field"><span>Skills</span><input name="skills" placeholder="Node.js, SQL, AWS" /></label>
          </div>
          <label class="field"><span>Description</span><textarea name="description" rows="4" placeholder="Describe success, team, and responsibilities."></textarea></label>
          <button class="primary-button xl" type="submit">Publish role</button>
        </form>
      </section>

      <section class="panel glass reveal-up delay-3">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Applicant review</span>
            <h3>Resume scoring and verification</h3>
          </div>
        </div>
        <div class="applicant-grid">
          ${applicants.length ? applicants.map((applicant) => `
            <article class="applicant-card">
              <div class="applicant-top">
                <div>
                  <strong>${applicant.user.name}</strong>
                  <span>${applicant.jobTitle}</span>
                </div>
                <b>${applicant.resumeScore}%</b>
              </div>
              <p>${applicant.notes}</p>
              <small>${applicant.user.headline}</small>
              <div class="meta-row compact-wrap">
                <span>${applicant.status}</span>
                <span>${applicant.user.country}</span>
                <span>${applicant.user.resumeFileName || "manual-entry.txt"}</span>
              </div>
              <button class="ghost-button" data-verify-candidate="${applicant.user.id}">Verify resume</button>
            </article>
          `).join("") : `<div class="empty-card">No applicants yet. Publish jobs to start receiving candidates.</div>`}
        </div>
      </section>

      <section class="panel glass reveal-up delay-4">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Verified resumes</span>
            <h3>Recent checks</h3>
          </div>
        </div>
        <div class="mini-card-grid">
          ${resumeChecks.map((item) => `
            <article class="mini-card">
              <strong>${item.candidateName}</strong>
              <span>${item.status}</span>
              <p>${item.summary}</p>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="panel glass reveal-up delay-5">
        <div class="panel-header">
          <div>
            <span class="eyebrow">World trends</span>
            <h3>Real-world demand signals</h3>
          </div>
        </div>
        <div class="trend-grid">${trendCards(trends)}</div>
      </section>

      <section class="panel glass reveal-up delay-6">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Current market roles</span>
            <h3>Global jobs and your internal openings</h3>
          </div>
        </div>
        <div class="job-grid compact-grid">${jobCards(worldJobs, false)}</div>
      </section>

      <section class="panel glass reveal-up delay-6">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Internal roles</span>
            <h3>Your posted jobs</h3>
          </div>
        </div>
        <div class="job-grid compact-grid">${jobCards(postedJobs, false)}</div>
      </section>
    </div>
  `;
}

function profileDrawer() {
  if (!state.session || state.session.kind !== "member" || !state.profileOpen) {
    return "";
  }

  const { viewer } = state.session;
  return `
    <div class="profile-overlay" id="close-profile-overlay">
      <aside class="profile-drawer glass reveal-up" role="dialog" aria-modal="true" aria-label="Profile panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Your profile</span>
            <h3>Update your candidate profile</h3>
          </div>
          <div class="drawer-actions">
            <div class="avatar-plate">${viewer.avatar}</div>
            <button class="ghost-button" type="button" id="close-profile">Close</button>
          </div>
        </div>
        <form id="profile-form" class="stack-form">
          <div class="double-grid">
            <label class="field"><span>Name</span><input name="name" value="${viewer.name || ""}" /></label>
            <label class="field"><span>Headline</span><input name="headline" value="${viewer.headline || ""}" /></label>
          </div>
          <div class="triple-grid">
            <label class="field"><span>Address</span><input name="address" value="${viewer.address || ""}" /></label>
            <label class="field"><span>City</span><input name="city" value="${viewer.city || ""}" /></label>
            <label class="field"><span>Country</span><input name="country" value="${viewer.country || ""}" /></label>
          </div>
          <div class="triple-grid">
            <label class="field"><span>Age</span><input name="age" value="${viewer.age || ""}" /></label>
            <label class="field"><span>Phone</span><input name="phone" value="${viewer.phone || ""}" /></label>
            <label class="field"><span>Budget</span><input name="budget" value="${viewer.budget || ""}" /></label>
          </div>
          <label class="field"><span>Skills</span><input name="skills" value="${(viewer.skills || []).join(", ")}" /></label>
          <label class="field"><span>About</span><textarea name="about" rows="3">${viewer.about || ""}</textarea></label>
          <label class="field"><span>Resume summary</span><textarea name="resume" rows="4">${viewer.resume || ""}</textarea></label>
          <label class="field"><span>Resume upload</span><input id="resume-file" type="file" accept=".txt,.md,.csv,.json,.log,.rtf,.html,.xml,text/plain" /></label>
          <button class="primary-button" type="submit">Save profile</button>
        </form>
      </aside>
    </div>
  `;
}

function passwordDrawer() {
  if (!state.session || !state.passwordOpen) {
    return "";
  }

  return `
    <div class="profile-overlay" id="close-password-overlay">
      <aside class="profile-drawer glass reveal-up" role="dialog" aria-modal="true" aria-label="Password panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Account Security</span>
            <h3>Change your password</h3>
          </div>
          <div class="drawer-actions">
            <button class="ghost-button" type="button" id="close-password">Close</button>
          </div>
        </div>
        <form id="password-form" class="stack-form">
          <label class="field"><span>Current Password</span><input type="password" name="currentPassword" autocomplete="current-password" /></label>
          <label class="field"><span>New Password</span><input type="password" name="newPassword" autocomplete="new-password" /></label>
          <label class="field"><span>Confirm New Password</span><input type="password" name="confirmPassword" autocomplete="new-password" /></label>
          <button class="primary-button" type="submit">Update password</button>
        </form>
      </aside>
    </div>
  `;
}

function shell() {
  const routeJobId = getJobRouteId();
  const routeJob = routeJobId ? getCandidateJobById(routeJobId) : null;
  return `
    <div class="page-frame">
      ${topbar()}
      ${state.message ? `<div class="notice ${state.messageType}">${state.message}</div>` : ""}
      ${routeJobId ? jobDetailPage(routeJob) : state.session.kind === "talent_lead" ? adminDashboard() : memberDashboard()}
      ${profileDrawer()}
      ${passwordDrawer()}
      ${notificationsDrawer()}
      ${jobDetailModal()}
    </div>
  `;
}

function render() {
  if (state.session?.kind === "talent_lead") {
    window.location.replace("/professional");
    return;
  }
  app.innerHTML = state.session ? shell() : authView();
  bindEvents();
}

async function handleLogin(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const session = await request("/api/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    saveSession(session);
    setMessage(`Welcome back, ${session.viewer.name}.`);
    render();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  try {
    await request("/api/register", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    clearSession();
    persistAuthScreen("login");
    setMessage("Signed up successfully. Please log in.");
    render();
    window.setTimeout(() => {
      document.getElementById("login-email")?.focus();
    }, 0);
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handleProfileSave(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const resumeFile = document.getElementById("resume-file")?.files?.[0];

  try {
    const filePayload = await readResumeFile(resumeFile);
    const payload = Object.fromEntries(formData.entries());
    if (filePayload.text) {
      payload.resume = filePayload.text;
      payload.resumeFileName = filePayload.name;
    }

    const session = await request("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    saveSession(session);
    state.profileOpen = false;
    setMessage("Profile updated.");
    render();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());

  try {
    const session = await request("/api/change-password", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    saveSession(session);
    state.passwordOpen = false;
    setMessage("Password updated successfully.");
    render();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handleJobPost(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  try {
    const session = await request("/api/jobs", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    saveSession(session);
    setMessage("Job published.");
    render();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handleAiPrompt(event) {
  event.preventDefault();
  const prompt = new FormData(event.currentTarget).get("prompt");
  try {
    const ai = await request("/api/ai/advice", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    state.aiResponse = ai.answer;
    state.session.ai = ai;
    render();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function bindEvents() {
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.nav;
      if (target === "home") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (target === "jobs") {
        document.getElementById("jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (target === "saved") {
        document.getElementById("saved")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  document.querySelectorAll("[data-auth-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      persistAuthScreen(button.dataset.authScreen);
      render();
    });
  });

  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("signup-form")?.addEventListener("submit", handleSignup);
  document.getElementById("profile-form")?.addEventListener("submit", handleProfileSave);
  document.getElementById("password-form")?.addEventListener("submit", handlePasswordChange);
  document.getElementById("job-form")?.addEventListener("submit", handleJobPost);
  document.getElementById("ai-form")?.addEventListener("submit", handleAiPrompt);

  document.getElementById("refresh-session")?.addEventListener("click", refreshSession);
  document.getElementById("open-notifications")?.addEventListener("click", () => {
    state.notificationsOpen = true;
    render();
  });
  document.querySelectorAll("[data-open-notifications-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notificationsOpen = true;
      render();
    });
  });
  document.getElementById("open-password")?.addEventListener("click", () => {
    state.passwordOpen = true;
    render();
  });
  document.getElementById("open-profile")?.addEventListener("click", () => {
    state.profileOpen = true;
    render();
  });
  document.getElementById("close-profile")?.addEventListener("click", () => {
    state.profileOpen = false;
    render();
  });
  document.getElementById("close-profile-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "close-profile-overlay") {
      state.profileOpen = false;
      render();
    }
  });
  document.getElementById("close-notifications")?.addEventListener("click", () => {
    state.notificationsOpen = false;
    render();
  });
  document.getElementById("close-notifications-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "close-notifications-overlay") {
      state.notificationsOpen = false;
      render();
    }
  });
  document.getElementById("close-password")?.addEventListener("click", () => {
    state.passwordOpen = false;
    render();
  });
  document.getElementById("close-password-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "close-password-overlay") {
      state.passwordOpen = false;
      render();
    }
  });
  document.getElementById("close-job-modal")?.addEventListener("click", () => {
    state.activeJobId = "";
    closeJobRoute();
    render();
  });
  document.getElementById("close-job-modal-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "close-job-modal-overlay") {
      state.activeJobId = "";
      closeJobRoute();
      render();
    }
  });
  document.getElementById("close-job-detail")?.addEventListener("click", () => {
    state.activeJobId = "";
    closeJobRoute();
    render();
  });
  document.getElementById("logout-button")?.addEventListener("click", () => {
    clearSession();
    persistAuthScreen("login");
    render();
  });

  document.getElementById("job-search")?.addEventListener("input", (event) => {
    state.jobQuery = event.target.value;
    render();
  });
  document.getElementById("job-source-filter")?.addEventListener("change", (event) => {
    state.jobSourceFilter = event.target.value;
    render();
  });
  document.getElementById("job-type-filter")?.addEventListener("change", (event) => {
    state.jobTypeFilter = event.target.value;
    render();
  });
  document.getElementById("job-sort")?.addEventListener("change", (event) => {
    state.jobSort = event.target.value;
    render();
  });

  document.querySelectorAll("[data-apply-job]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const session = await request(`/api/jobs/${button.dataset.applyJob}/apply`, { method: "POST" });
        saveSession(session);
        setMessage("Application sent.");
        render();
      } catch (error) {
        setMessage(error.message, "error");
      }
    });
  });

  document.querySelectorAll("[data-save-job]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const session = await request(`/api/jobs/${button.dataset.saveJob}/save`, { method: "POST" });
        saveSession(session);
        setMessage("Saved jobs updated.");
        render();
      } catch (error) {
        setMessage(error.message, "error");
      }
    });
  });

  document.querySelectorAll("[data-open-job]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openJobRoute(button.dataset.openJob);
      render();
    });
  });

  document.querySelectorAll("[data-preview-job]").forEach((button) => {
    button.addEventListener("click", () => {
      state.focusedJobId = button.dataset.previewJob;
      render();
    });
  });

  document.querySelectorAll("[data-verify-candidate]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const session = await request("/api/admin/verify-resume", {
          method: "POST",
          body: JSON.stringify({ candidateId: button.dataset.verifyCandidate }),
        });
        saveSession(session);
        setMessage("Resume verified.");
        render();
      } catch (error) {
        setMessage(error.message, "error");
      }
    });
  });
}

window.addEventListener("popstate", () => {
  render();
});

refreshSession();

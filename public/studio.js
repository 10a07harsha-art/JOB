const app = document.getElementById("app");
const TOKEN_KEY = "forgehire_token";
const SESSION_KEY = "forgehire_session";
const LEGACY_TOKEN_KEY = "careerlink_token";

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
  message: "",
  messageType: "success",
  passwordOpen: false,
  notificationsOpen: false,
  activeJobId: "",
  focusedJobId: "",
  jobQuery: "",
  jobSourceFilter: "all",
  jobTypeFilter: "all",
  jobSort: "recent",
};

document.title = "ForgeHire Employer Console";
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
    if (session.kind !== "talent_lead") {
      window.location.replace("/candidate");
      return;
    }
    state.session = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (error) {
    if (runId !== refreshSessionRun || tokenAtStart !== state.token) {
      return;
    }
    clearSession();
    render();
  }

  render();
}

function featureChip(label, enabled) {
  return `<span class="feature-chip ${enabled ? "live" : "fallback"}">${label}: ${enabled ? "live" : "fallback"}</span>`;
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

function getJobRouteId() {
  const match = window.location.pathname.match(/^\/(?:professional|studio)\/job\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function openJobRoute(jobId) {
  const base = window.location.pathname.startsWith("/studio") ? "/studio" : "/professional";
  window.history.pushState({}, "", `${base}/job/${encodeURIComponent(jobId)}`);
}

function closeJobRoute() {
  if (window.location.pathname.startsWith("/professional/job/") || window.location.pathname.startsWith("/studio/job/")) {
    const base = window.location.pathname.startsWith("/studio/job/") ? "/studio" : "/professional";
    window.history.pushState({}, "", base);
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

function initialsFromName(value, fallback = "FH") {
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

function companyMark(name, fallback = "FH") {
  const initials = initialsFromName(name, fallback);
  const hue = brandHueFromName(name || fallback);
  return `
    <div class="company-mark" style="--brand-hue:${hue}deg">
      <span>${initials}</span>
    </div>
  `;
}

function getFocusedJob(jobs) {
  if (!jobs.length) {
    return null;
  }
  return jobs.find((job) => job.id === state.focusedJobId) || jobs[0];
}

function authView() {
  return `
    <div class="auth-shell studio-shell">
      <section class="hero-card glass reveal-up studio-hero forge-hero-card">
        <span class="eyebrow">ForgeHire</span>
        <h1>Employer workspace for hiring teams and recruiters.</h1>
        <p>
          This workspace is built for recruiters, founders, and hiring managers. Publish roles, review applicants,
          verify resumes, and track market demand in a dedicated company site that stays separate from the candidate portal.
        </p>
        <div class="hero-grid hero-feature-grid">
          <div class="hero-feature-card"><strong>Company login</strong><span>secure employer-only workspace</span></div>
          <div class="hero-feature-card"><strong>Private access</strong><span>company accounts are issued internally by your platform team</span></div>
          <div class="hero-feature-card"><strong>Market view</strong><span>internal roles plus live global signals</span></div>
        </div>
        <div class="hero-metrics">
          <div><b>Hiring command center</b><span>posting, screening, and resume review</span></div>
          <div><b>Market context</b><span>compare company hiring with global demand</span></div>
        </div>
        <div class="hero-actions">
          <a class="ghost-link-button" href="/candidate">Back to Orbit Jobs</a>
        </div>
      </section>

      <section class="auth-card glass reveal-up delay-2 auth-card-forge">
        <form id="login-form" class="stack-form">
          <input type="hidden" name="role" value="talent_lead" />
          <label class="field"><span>Work Email</span><input name="email" placeholder="talent@company.com" autocomplete="username" /></label>
          <label class="field"><span>Password</span><input type="password" name="password" placeholder="Enter your password" autocomplete="current-password" /></label>
          <div class="field helper-note">
            <span>Access model</span>
            <small>ForgeHire accounts are issued privately. Companies can only sign in here, not self-register.</small>
          </div>
          <button class="primary-button xl" type="submit">Open ForgeHire</button>
        </form>
      </section>
    </div>
  `;
}

function topbar() {
  const { viewer } = state.session;
  const notificationCount = (state.session.notifications || []).length;
  return `
    <header class="topbar glass reveal-down">
      <div class="brand-lockup">
        <img class="brand-wordmark" src="/forge-wordmark.svg" alt="ForgeHire" />
        <div class="brand-copy">
          <strong>${viewer.companyName || "ForgeHire"}</strong>
          <span>${viewer.companyIndustry || "Company workspace"}</span>
        </div>
      </div>
      <div class="topbar-actions">
        ${featureChip("Jobs", state.session.features.liveJobs)}
        ${featureChip("Trends", state.session.features.liveTrends)}
        ${featureChip("AI", state.session.features.liveAi)}
        <button class="ghost-button" id="open-notifications">Notifications ${notificationCount ? `(${notificationCount})` : ""}</button>
        <a class="ghost-link-button" href="/">Orbit Jobs</a>
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

function jobCards(jobs) {
  return jobs.map((job) => `
    <article class="job-card ${job.source}">
      <div class="job-card-top">
        <div>
          <span class="source-badge ${job.source}">${job.source === "internal" ? "Internal" : "Global"}</span>
          <h4>${job.title}</h4>
          <p>${job.company}</p>
        </div>
        <span class="salary-pill">${job.salary}</span>
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
      <div class="job-actions">
        <span class="feature-chip live">Applicants: ${job.applicantCount}</span>
        <button class="ghost-button" type="button" data-open-job="${job.id}">View details</button>
        ${job.source === "global" && job.applyUrl ? `<a class="ghost-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">View listing</a>` : ""}
      </div>
    </article>
  `).join("");
}

function jobExplorer(jobs, options = {}) {
  if (!jobs.length) {
    return `<div class="empty-card">${options.emptyText || "No jobs available yet."}</div>`;
  }

  const focused = getFocusedJob(jobs);
  const detail = normalizeJobText(focused.description);

  return `
    <div class="job-explorer">
      <div class="job-list-panel">
        ${jobs.map((job) => `
          <article class="job-list-item ${job.id === focused.id ? "active" : ""}" data-preview-job="${job.id}">
            <div class="job-list-top">
              <span class="source-badge ${job.source}">${job.source === "internal" ? "Internal" : "Global"}</span>
              <span class="salary-pill">${job.salary}</span>
            </div>
            <h4>${job.title}</h4>
            <p>${job.company}</p>
            <div class="meta-row compact-wrap">
              <span>${job.location}</span>
              <span>${formatJobType(job.type)}</span>
            </div>
          </article>
        `).join("")}
      </div>
      <div class="job-preview-panel glass">
        <div class="job-preview-head">
          <div class="job-preview-brand">
            ${companyMark(focused.company, focused.source === "internal" ? "FH" : "GL")}
            <div>
              <span class="source-badge ${focused.source}">${focused.source === "internal" ? "Internal role" : "Global listing"}</span>
              <h2>${focused.title}</h2>
              <p>${focused.company}</p>
            </div>
          </div>
          <div class="job-preview-actions">
            <button class="ghost-button" type="button" data-open-job="${focused.id}">View full details</button>
            ${focused.source === "global" && focused.applyUrl ? `<a class="primary-link-button" href="${focused.applyUrl}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
          </div>
        </div>
        <div class="job-modal-meta">
          <span>${focused.location}</span>
          <span>${focused.type}</span>
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
            <span class="eyebrow">Hiring View</span>
            <p>${focused.source === "global" ? "Use this listing to benchmark your own role framing against the wider market before you publish or adjust your internal jobs." : "This is one of your own active roles, so this preview shows exactly how candidates will experience the opportunity."}</p>
            <span class="eyebrow">Applicant Signal</span>
            <p>${focused.applicantCount || 0} applicant${focused.applicantCount === 1 ? "" : "s"} currently associated with this role.</p>
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

  const pools = [...(state.session.worldJobs || []), ...(state.session.postedJobs || [])];
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
            ${companyMark(job.company, job.source === "internal" ? "FH" : "GL")}
            <div>
              <span class="source-badge ${job.source}">${job.source === "internal" ? "Internal" : "Global"}</span>
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
            <span class="eyebrow">Hiring View</span>
            <p>${job.source === "global" ? "Use this market listing to benchmark your team’s titles, salary language, and role expectations against the wider hiring landscape." : "This is one of your internal roles. Review it carefully as candidates will read this exact narrative before applying."}</p>
            <div class="job-actions modal-actions">
              ${job.source === "global" && job.applyUrl ? `<a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
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
      <section class="hero-panel glass reveal-up forge-hero-panel">
        <div class="job-preview-brand">
          ${companyMark(job.company, job.source === "internal" ? "FH" : "GL")}
          <div>
            <span class="source-badge ${job.source}">${job.source === "internal" ? "Internal role" : "Global listing"}</span>
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
          ${job.source === "global" && job.applyUrl ? `<a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
          <button class="ghost-button" id="close-job-detail">Back to jobs</button>
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
            <span class="eyebrow">Market View</span>
            <h3>How it compares to your openings</h3>
          </div>
        </div>
        <div class="info-grid">
          <div><strong>${job.source === "global" ? "External benchmark" : "Company-owned role"}</strong><span>Source</span></div>
          <div><strong>${job.applicantCount || 0}</strong><span>Applicants</span></div>
          <div><strong>${job.source === "global" && job.applyUrl ? "Live apply link" : "Internal posting"}</strong><span>Action</span></div>
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
              <span>${item.type}</span>
              <p>${item.message}</p>
              <small>${formatNotificationTime(item.createdAt)}</small>
            </article>
          `).join("") : `<div class="empty-card">You’re all caught up. New applications and resume checks will appear here.</div>`}
        </div>
      </aside>
    </div>
  `;
}

function jobFilterBar() {
  const jobs = state.session ? [...(state.session.worldJobs || []), ...(state.session.postedJobs || [])] : [];
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
            <option value="internal" ${state.jobSourceFilter === "internal" ? "selected" : ""}>Internal roles</option>
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

function getEmployerJobById(jobId) {
  if (!state.session || !jobId) {
    return null;
  }
  return [...(state.session.worldJobs || []), ...(state.session.postedJobs || [])].find((entry) => entry.id === jobId) || null;
}

function adminDashboard() {
  const { viewer, postedJobs, applicants, trends, worldJobs, resumeChecks } = state.session;
  const visibleWorldJobs = filterJobs(worldJobs);
  const visiblePostedJobs = filterJobs(postedJobs);
  return `
    <div class="dashboard-shell">
      <section class="hero-panel glass reveal-up admin-tone forge-hero-panel">
        <div>
          <span class="eyebrow">Company workspace</span>
          <h1>${viewer.companyName || "Your company"}, manage hiring in a dedicated environment.</h1>
          <p>
            Keep internal recruiting separate from the public candidate experience while still seeing live market roles and trend signals.
          </p>
        </div>
        <div class="hero-grid compact-stats stat-showcase">
          <div class="stat-card"><strong>${postedJobs.length}</strong><span>Posted roles</span></div>
          <div class="stat-card"><strong>${applicants.length}</strong><span>Applicants</span></div>
          <div class="stat-card"><strong>${resumeChecks.length}</strong><span>Resume checks</span></div>
        </div>
      </section>

      ${jobFilterBar()}

      <section class="panel glass reveal-up delay-1">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Company profile</span>
            <h3>${viewer.companyName || viewer.name}</h3>
          </div>
          <div class="avatar-plate">${viewer.companyLogoText || viewer.avatar}</div>
        </div>
        <div class="info-grid">
          <div><strong>${viewer.name}</strong><span>Admin</span></div>
          <div><strong>${viewer.headline || "Hiring Team"}</strong><span>Role</span></div>
          <div><strong>${viewer.companyIndustry || "Not added"}</strong><span>Industry</span></div>
        </div>
        <div class="info-grid">
          <div><strong>${viewer.teamSize || "Not added"}</strong><span>Team size</span></div>
          <div><strong>${viewer.country || "Global"}</strong><span>Country</span></div>
          <div><strong>${viewer.phone || "Not added"}</strong><span>Phone</span></div>
        </div>
        ${viewer.companyWebsite ? `<div class="hero-actions"><a class="ghost-link-button" href="${viewer.companyWebsite}" target="_blank" rel="noreferrer">Visit company website</a></div>` : ""}
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
            <label class="field"><span>Company</span><input name="company" placeholder="Your company name" value="${viewer.companyName || ""}" /></label>
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
          <label class="field"><span>Description</span><textarea name="description" rows="4" placeholder="Describe responsibilities, outcomes, and team context."></textarea></label>
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
                <div class="card-stack compact">
                  <b>${applicant.resumeScore}%</b>
                  <span class="score-pill">${applicant.status}</span>
                </div>
              </div>
              <p>${applicant.notes}</p>
              <small>${applicant.user.headline || "Candidate"}</small>
              <div class="meta-row compact-wrap">
                <span>${applicant.status}</span>
                <span>${applicant.user.country || "Unknown"}</span>
                <span>${applicant.user.resumeFileName || "manual-entry.txt"}</span>
              </div>
              <div class="action-grid">
                <button class="ghost-button" data-verify-candidate="${applicant.user.id}">Verify resume</button>
                <button class="ghost-button" data-update-stage="reviewed" data-job-id="${applicant.jobId}" data-candidate-id="${applicant.user.id}">Reviewed</button>
                <button class="ghost-button" data-update-stage="shortlisted" data-job-id="${applicant.jobId}" data-candidate-id="${applicant.user.id}">Shortlist</button>
                <button class="ghost-button" data-update-stage="interview" data-job-id="${applicant.jobId}" data-candidate-id="${applicant.user.id}">Interview</button>
                <button class="ghost-button" data-update-stage="offer" data-job-id="${applicant.jobId}" data-candidate-id="${applicant.user.id}">Offer</button>
                <button class="ghost-button" data-update-stage="rejected" data-job-id="${applicant.jobId}" data-candidate-id="${applicant.user.id}">Reject</button>
              </div>
            </article>
          `).join("") : `<div class="empty-card">No applicants yet. Publish your first role to start receiving applications.</div>`}
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
          ${resumeChecks.length ? resumeChecks.map((item) => `
            <article class="mini-card">
              <strong>${item.candidateName}</strong>
              <span>${item.status}</span>
              <p>${item.summary}</p>
            </article>
          `).join("") : `<div class="empty-card">Verified resumes will appear here after your team reviews candidates.</div>`}
        </div>
      </section>

      <section class="panel glass reveal-up delay-5">
        <div class="panel-header">
          <div>
            <span class="eyebrow">World trends</span>
            <h3>Market signals for hiring plans</h3>
          </div>
        </div>
        <div class="trend-grid">${trendCards(trends)}</div>
      </section>

      <section class="panel glass reveal-up delay-6">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Market roles</span>
            <h3>See world jobs beside your own openings</h3>
            <p>${visibleWorldJobs.length} market listings after filters.</p>
          </div>
        </div>
        ${jobExplorer(visibleWorldJobs, { emptyText: "No global benchmark roles available right now." })}
      </section>

      <section class="panel glass reveal-up delay-6">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Internal roles</span>
            <h3>Your published jobs</h3>
            <p>${visiblePostedJobs.length} internal roles after filters.</p>
          </div>
        </div>
        ${jobExplorer(visiblePostedJobs, { emptyText: "No internal roles yet. Use the form above to publish your first position." })}
      </section>
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
            <h3>Change company password</h3>
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
  const routeJob = routeJobId ? getEmployerJobById(routeJobId) : null;
  return `
    <div class="page-frame">
      ${topbar()}
      ${state.message ? `<div class="notice ${state.messageType}">${state.message}</div>` : ""}
      ${routeJobId ? jobDetailPage(routeJob) : adminDashboard()}
      ${jobDetailModal()}
      ${notificationsDrawer()}
      ${passwordDrawer()}
    </div>
  `;
}

function render() {
  if (state.session?.kind === "member") {
    window.location.replace("/");
    return;
  }
  if (state.session?.kind === "talent_lead" && window.location.pathname === "/") {
    window.history.replaceState({}, "", "/professional");
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

function bindEvents() {
  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("job-form")?.addEventListener("submit", handleJobPost);
  document.getElementById("password-form")?.addEventListener("submit", handlePasswordChange);

  document.getElementById("refresh-session")?.addEventListener("click", refreshSession);
  document.getElementById("open-notifications")?.addEventListener("click", () => {
    state.notificationsOpen = true;
    render();
  });
  document.getElementById("open-password")?.addEventListener("click", () => {
    state.passwordOpen = true;
    render();
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
  document.getElementById("logout-button")?.addEventListener("click", () => {
    clearSession();
    render();
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

  document.querySelectorAll("[data-update-stage]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const session = await request("/api/admin/applications/status", {
          method: "POST",
          body: JSON.stringify({
            jobId: button.dataset.jobId,
            candidateId: button.dataset.candidateId,
            status: button.dataset.updateStage,
          }),
        });
        saveSession(session);
        setMessage(`Applicant updated to ${button.dataset.updateStage}.`);
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
}

window.addEventListener("popstate", () => {
  render();
});

refreshSession();

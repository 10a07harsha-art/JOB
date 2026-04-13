const app = document.getElementById("app");
const TOKEN_KEY = "orbit_jobs_token";
const LEGACY_TOKEN_KEY = "careerlink_token";
const AUTH_SCREEN_KEY = "orbit_jobs_auth_screen";

const state = {
  session: null,
  token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || "",
  authScreen: ["login", "signup"].includes(localStorage.getItem(AUTH_SCREEN_KEY)) ? localStorage.getItem(AUTH_SCREEN_KEY) : "login",
  message: "",
  messageType: "success",
  aiResponse: "",
  profileOpen: false,
  passwordOpen: false,
  activeJobId: "",
  focusedJobId: "",
};

document.title = "Orbit Jobs";
let refreshSessionRun = 0;

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
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
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function clearSession() {
  state.session = null;
  state.token = "";
  state.aiResponse = "";
  state.profileOpen = false;
  state.passwordOpen = false;
  state.activeJobId = "";
  state.focusedJobId = "";
  localStorage.removeItem(TOKEN_KEY);
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

function getFocusedJob(jobs) {
  if (!jobs.length) {
    return null;
  }
  return jobs.find((job) => job.id === state.focusedJobId) || jobs[0];
}

function featureChip(label, enabled) {
  return `<span class="feature-chip ${enabled ? "live" : "fallback"}">${label}: ${enabled ? "live" : "fallback"}</span>`;
}

function authView() {
  const loginScreen = state.authScreen === "login";
  const signupScreen = state.authScreen === "signup";

  return `
    <div class="auth-shell orbit-auth-shell">
      <section class="hero-card glass reveal-up hero-card-orbit">
        <span class="eyebrow">Orbit Jobs</span>
        <h1>Professional hiring intelligence for candidates and teams.</h1>
        <p>
          Orbit Jobs tracks live global jobs, external apply links, market signals, and AI-backed career guidance.
          Explore current openings, market movement, and profile-driven recommendations without employer tools crowding the experience.
        </p>
        <div class="hero-grid hero-feature-grid">
          <div class="hero-feature-card"><strong>Orbit Explorer</strong><span>live jobs, AI guidance, market movement</span></div>
          <div class="hero-feature-card"><strong>Profile workspace</strong><span>resume, budget, applied jobs, saved roles</span></div>
          <div class="hero-feature-card"><strong>Employer access</strong><span>companies enter from the separate ForgeHire site</span></div>
        </div>
        <div class="hero-metrics">
          <div><b>Live market</b><span>global jobs and trend-aware signals</span></div>
          <div><b>Resume intelligence</b><span>fit scoring, advice, and study planning</span></div>
        </div>
        <div class="hero-actions">
          <a class="ghost-link-button" href="/studio">Company or recruiter? Open ForgeHire</a>
        </div>
      </section>

      <section class="auth-card glass reveal-up delay-2 auth-card-orbit">
        <div class="tab-row">
          <button class="tab-pill ${loginScreen ? "active" : ""}" data-auth-screen="login">Login</button>
          <button class="tab-pill ${signupScreen ? "active" : ""}" data-auth-screen="signup">Signup</button>
        </div>

        ${loginScreen ? `
          <form id="login-form" class="stack-form">
            <input type="hidden" name="role" value="career_member" />
            <label class="field"><span>Email</span><input name="email" placeholder="name@company.com" autocomplete="username" /></label>
            <label class="field"><span>Password</span><input type="password" name="password" placeholder="Enter your password" autocomplete="current-password" /></label>
            <button class="primary-button xl" type="submit">Enter workspace</button>
          </form>
        ` : ""}

        ${signupScreen ? `
          <form id="signup-form" class="stack-form auth-scroll">
            <label class="field"><span>Name</span><input name="name" placeholder="Your name" /></label>
            <label class="field"><span>Headline</span><input name="headline" placeholder="Frontend engineer, analyst, designer..." /></label>
            <div class="double-grid">
              <label class="field"><span>Email</span><input name="email" placeholder="email@example.com" /></label>
              <label class="field"><span>Password</span><input type="password" name="password" placeholder="Password" /></label>
            </div>
            <div class="triple-grid">
              <label class="field"><span>Address</span><input name="address" placeholder="Street" /></label>
              <label class="field"><span>City</span><input name="city" placeholder="Bengaluru" /></label>
              <label class="field"><span>Country</span><input name="country" placeholder="India" /></label>
            </div>
            <div class="triple-grid">
              <label class="field"><span>Age</span><input name="age" placeholder="25" /></label>
              <label class="field"><span>Phone</span><input name="phone" placeholder="+91 ..." /></label>
              <label class="field"><span>Budget</span><input name="budget" placeholder="$1800 / month" /></label>
            </div>
            <label class="field"><span>Skills</span><input name="skills" placeholder="React, Node.js, SQL" /></label>
            <label class="field"><span>About</span><textarea name="about" rows="3" placeholder="What kind of work do you want?"></textarea></label>
            <label class="field"><span>Resume Summary</span><textarea name="resume" rows="4" placeholder="Paste a short resume summary here."></textarea></label>
            <button class="primary-button xl" type="submit">Create candidate account</button>
          </form>
        ` : ""}

      </section>
    </div>
  `;
}

function topbar() {
  return `
    <header class="topbar glass reveal-down">
      <div class="brand-lockup">
        <img class="brand-wordmark" src="/orbit-wordmark.svg" alt="Orbit Jobs" />
        <div class="brand-copy">
          <strong>Orbit Jobs</strong>
          <span>${state.session.kind === "talent_lead" ? "ForgeHire" : "Explorer Workspace"}</span>
        </div>
      </div>
      <div class="topbar-actions">
        ${featureChip("Jobs", state.session.features.liveJobs)}
        ${featureChip("Trends", state.session.features.liveTrends)}
        ${featureChip("AI", state.session.features.liveAi)}
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
          <span class="source-badge ${job.source}">${job.source === "internal" ? "ForgeHire" : "Global"}</span>
          <h4>${job.title}</h4>
          <p>${job.company}</p>
        </div>
        <span class="salary-pill">${job.salary}</span>
      </div>
      <div class="meta-row compact-wrap">
        <span>${job.location}</span>
        <span>${job.type}</span>
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
          ${job.source === "global" && job.applyUrl ? `
            <a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>
          ` : `
            <button class="primary-button" data-apply-job="${job.id}">${job.viewerApplied ? "Applied" : "Apply"}</button>
          `}
        </div>
      ` : `
        <div class="job-actions">
          <span class="feature-chip live">Applicants: ${job.applicantCount}</span>
          <button class="ghost-button" type="button" data-open-job="${job.id}">View details</button>
          ${job.source === "global" && job.applyUrl ? `<a class="ghost-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">View listing</a>` : ""}
        </div>
      `}
    </article>
  `).join("");
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
              <span class="source-badge ${job.source}">${job.source === "internal" ? "ForgeHire" : "Global"}</span>
              <span class="salary-pill">${job.salary}</span>
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
            ${companyMark(focused.company, focused.source === "internal" ? "FH" : "OJ")}
            <div>
              <span class="source-badge ${focused.source}">${focused.source === "internal" ? "ForgeHire role" : "Global listing"}</span>
              <h2>${focused.title}</h2>
              <p>${focused.company}</p>
            </div>
          </div>
          <div class="job-preview-actions">
            <button class="ghost-button" type="button" data-open-job="${focused.id}">View full details</button>
            ${memberMode ? `
              <button class="ghost-button" data-save-job="${focused.id}">${focused.viewerSaved ? "Saved" : "Save"}</button>
              ${focused.source === "global" && focused.applyUrl ? `
                <a class="primary-link-button" href="${focused.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>
              ` : `
                <button class="primary-button" data-apply-job="${focused.id}">${focused.viewerApplied ? "Applied" : "Apply"}</button>
              `}
            ` : `
              ${focused.source === "global" && focused.applyUrl ? `<a class="primary-link-button" href="${focused.applyUrl}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
            `}
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
            <span class="eyebrow">Why It Stands Out</span>
            <p>${focused.source === "global" ? "This role gives you a live benchmark from the market right now, including its company, compensation framing, and apply route." : "This is a direct company-owned role inside the hiring platform, so your application quality and profile fit have immediate recruiter visibility."}</p>
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
            ${companyMark(job.company, job.source === "internal" ? "FH" : "OJ")}
            <div>
              <span class="source-badge ${job.source}">${job.source === "internal" ? "ForgeHire" : "Global"}</span>
              <h2>${job.title}</h2>
              <p>${job.company}</p>
            </div>
          </div>
          <button class="ghost-button" type="button" id="close-job-modal">Close</button>
        </div>
        <div class="job-modal-meta">
          <span>${job.location}</span>
          <span>${job.type}</span>
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
            <p>${job.source === "global" ? "This listing is coming from the wider market, so use it to compare role language, compensation, and required skills against your saved shortlist." : "This is a direct internal role, so your application and profile alignment matter immediately for recruiter review."}</p>
            <span class="eyebrow">Action</span>
            <div class="job-actions modal-actions">
              ${job.source === "global" && job.applyUrl ? `<a class="primary-link-button" href="${job.applyUrl}" target="_blank" rel="noreferrer">Open apply link</a>` : ""}
              ${job.viewerSaved !== undefined ? `<button class="ghost-button" data-save-job="${job.id}">${job.viewerSaved ? "Saved" : "Save"}</button>` : ""}
              ${job.viewerApplied !== undefined && job.source !== "global" ? `<button class="primary-button" data-apply-job="${job.id}">${job.viewerApplied ? "Applied" : "Apply"}</button>` : ""}
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

function memberDashboard() {
  const { viewer, jobs, appliedJobs, savedJobs, trends, ai, features } = state.session;
  return `
    <div class="dashboard-shell">
      <section class="hero-panel glass reveal-up orbit-hero-panel">
        <div>
          <span class="eyebrow">Orbit Explorer</span>
          <h1>Live roles, market movement, and career direction in one workspace.</h1>
          <p>
            Track current openings from the global market, save roles, apply through live external links,
            and use Orbit AI to sharpen your resume, role targeting, and study planning.
          </p>
        </div>
        <div class="hero-grid compact-stats stat-showcase">
          <div class="stat-card"><strong>${jobs.length}</strong><span>Available jobs</span></div>
          <div class="stat-card"><strong>${appliedJobs.length}</strong><span>Applied jobs</span></div>
          <div class="stat-card"><strong>${savedJobs.length}</strong><span>Saved jobs</span></div>
        </div>
      </section>

      <section class="panel glass reveal-up delay-1 ai-panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">AI support</span>
            <h3>${features.liveAi ? "Live AI advisor" : "Built-in AI fallback advisor"}</h3>
          </div>
          <div class="score-pill">Resume score ${ai.resumeReview.score}</div>
        </div>
        <div class="ai-grid wide-grid">
          <article class="ai-card highlight">
            <h4>Overview</h4>
            <p>${ai.overview}</p>
            <small>${ai.trendSummary}</small>
          </article>
          <article class="ai-card">
            <h4>Strengths</h4>
            <ul class="mini-list">${ai.resumeReview.strengths.map((item) => `<li>${item}</li>`).join("")}</ul>
          </article>
          <article class="ai-card">
            <h4>Improvements</h4>
            <ul class="mini-list">${ai.resumeReview.improvements.map((item) => `<li>${item}</li>`).join("")}</ul>
          </article>
          <article class="ai-card wide">
            <h4>Best-fit jobs</h4>
            <div class="recommendation-grid">
              ${ai.jobMatches.map((match) => `
                <div class="recommendation-card">
                  <strong>${match.title}</strong>
                  <span>${match.company}</span>
                  <small>${match.reason}</small>
                  <b>${match.score}% fit</b>
                </div>
              `).join("")}
            </div>
          </article>
          <article class="ai-card wide">
            <h4>Masters suggestions by budget</h4>
            <p>${ai.budgetAdvice}</p>
            <div class="degree-grid">
              ${ai.degreeSuggestions.map((degree) => `
                <div class="degree-card">
                  <strong>${degree.name}</strong>
                  <span>${degree.duration}</span>
                  <small>${degree.budgetRange}</small>
                  <p>${degree.countries.join(" • ")}</p>
                </div>
              `).join("")}
            </div>
          </article>
          <article class="ai-card wide">
            <h4>Ask AI</h4>
            <form id="ai-form" class="stack-form">
              <textarea name="prompt" rows="3" placeholder="Ask for job targets, resume advice, relocation ideas, or budget-friendly masters."></textarea>
              <button class="primary-button" type="submit">Get AI guidance</button>
            </form>
            ${state.aiResponse ? `<div class="ai-answer">${state.aiResponse}</div>` : ""}
          </article>
        </div>
      </section>

      <section class="panel glass reveal-up delay-2">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Applied jobs</span>
            <h3>Your active applications</h3>
          </div>
        </div>
        <div class="job-grid compact-grid">
          ${appliedJobs.length ? jobCards(appliedJobs, true) : `<div class="empty-card">You have not applied yet. Pick a job below and start building momentum.</div>`}
        </div>
      </section>

      <section class="panel glass reveal-up delay-3">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Saved jobs</span>
            <h3>Your shortlist</h3>
          </div>
          <span class="score-pill">${savedJobs.length} saved</span>
        </div>
        <div class="job-grid compact-grid">
          ${savedJobs.length ? jobCards(savedJobs, true) : `<div class="empty-card">Use Save on any strong-fit role to build your shortlist here.</div>`}
        </div>
      </section>

      <section class="panel glass reveal-up delay-4">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Current world trends</span>
            <h3>What is rising in the market</h3>
          </div>
        </div>
        <div class="trend-grid">${trendCards(trends)}</div>
      </section>

      <section class="panel glass reveal-up delay-5">
        <div class="panel-header">
          <div>
            <span class="eyebrow">All jobs</span>
            <h3>Internal openings plus global market roles</h3>
          </div>
        </div>
        ${jobExplorer(jobs, true, { emptyText: "No jobs available right now." })}
      </section>
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
  return `
    <div class="page-frame">
      ${topbar()}
      ${state.message ? `<div class="notice ${state.messageType}">${state.message}</div>` : ""}
      ${state.session.kind === "talent_lead" ? adminDashboard() : memberDashboard()}
      ${profileDrawer()}
      ${passwordDrawer()}
      ${jobDetailModal()}
    </div>
  `;
}

function render() {
  if (state.session?.kind === "talent_lead") {
    window.location.replace("/studio");
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
    const session = await request("/api/register", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    saveSession(session);
    setMessage(`Account created for ${session.viewer.name}.`);
    render();
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
    render();
  });
  document.getElementById("close-job-modal-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "close-job-modal-overlay") {
      state.activeJobId = "";
      render();
    }
  });
  document.getElementById("logout-button")?.addEventListener("click", () => {
    clearSession();
    persistAuthScreen("login");
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
      state.activeJobId = button.dataset.openJob;
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

refreshSession();

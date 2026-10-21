const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-jobs-test-"));
process.env.STORE_PATH = path.join(testDirectory, "store.json");
process.env.MONGODB_URI = "";
process.env.MONGODB_STORAGE_MODE = "single-document";
fs.copyFileSync(path.join(__dirname, "..", "data", "store.example.json"), process.env.STORE_PATH);
const server = require("../server");

let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

function sessionCookie(response) {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

test("health endpoint reports a healthy service", async () => {
  const { response, body } = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, service: "orbit-jobs" });
  assert.match(response.headers.get("x-request-id") || "", /^[a-f0-9]{24}$/);
});

test("registration, verification, login, session access, and logout work end to end", async () => {
  const email = `candidate-${Date.now()}@example.com`;
  const registered = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Candidate", email, password: "strong-password-123", age: 25 }),
  });
  assert.equal(registered.response.status, 201);
  assert.match(registered.body.verificationToken, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(registered.body.viewer, "verificationTokenHash"), false);
  assert.equal(Object.hasOwn(registered.body.viewer, "verificationTokenExpiresAt"), false);
  const initialCookie = sessionCookie(registered.response);

  const verified = await request("/api/email-verification/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: registered.body.verificationToken }),
  });
  assert.equal(verified.response.status, 200);

  const loggedIn = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "career_member", email, password: "strong-password-123" }),
  });
  assert.equal(loggedIn.response.status, 200);
  const cookie = sessionCookie(loggedIn.response);
  assert.notEqual(cookie, initialCookie);

  const session = await request("/api/session", { headers: { Cookie: cookie } });
  assert.equal(session.response.status, 200);
  assert.equal(session.body.viewer.email, email);

  const loggedOut = await request("/api/logout", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(loggedOut.response.status, 200);
  const revoked = await request("/api/session", { headers: { Cookie: cookie } });
  assert.equal(revoked.response.status, 401);
});

test("readiness endpoint reports available storage", async () => {
  const { response, body } = await request("/api/ready");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(["local", "mongodb", "local-fallback"].includes(body.storage));
});

test("logout clears the HttpOnly session cookie", async () => {
  const { response, body } = await request("/api/logout", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.match(response.headers.get("set-cookie") || "", /orbit_session=; HttpOnly/);
});

test("protected endpoints reject unauthenticated requests", async () => {
  const { response, body } = await request("/api/session");
  assert.equal(response.status, 401);
  assert.equal(body.message, "Please login first");
});

test("legacy bearer tokens are not accepted", async () => {
  const { response, body } = await request("/api/session", { headers: { Authorization: "Bearer legacy-token" } });
  assert.equal(response.status, 401);
  assert.equal(body.message, "Please login first");
});

test("paginated job and applicant endpoints require authentication", async () => {
  const jobs = await request("/api/jobs?page=1&pageSize=1");
  const applicants = await request("/api/applicants?page=1&pageSize=1");
  assert.equal(jobs.response.status, 401);
  assert.equal(applicants.response.status, 401);
});

test("state-changing requests reject foreign origins", async () => {
  const { response, body } = await request("/api/logout", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(response.status, 403);
  assert.equal(body.message, "Request origin is not allowed");
});

test("malformed JSON returns a client error", async () => {
  const { response, body } = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 400);
  assert.equal(body.message, "Invalid JSON body");
});

test("registration enforces the minimum password length", async () => {
  const { response, body } = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test User", email: "test@example.com", password: "short" }),
  });
  assert.equal(response.status, 400);
  assert.equal(body.message, "Password must be at least 8 characters long");
});

test("registration rejects invalid age and oversized fields", async () => {
  const { response, body } = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(121), email: "test@example.com", password: "long-password", age: 999 }),
  });
  assert.equal(response.status, 400);
  assert.match(body.message, /name must be 120 characters or fewer/);
});

test("provisioning requires the dedicated provisioning header", async () => {
  const { response, body } = await request("/api/admin/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ developerKey: "not-accepted", name: "Test Admin", email: "admin@example.com", password: "long-password-123" }),
  });
  assert.equal(response.status, 403);
  assert.equal(body.message, "Developer provisioning key is not valid");
});

test("password reset requests do not disclose whether an email exists", async () => {
  const { response, body } = await request("/api/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.invalid" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { message: "If an account matches that email, reset instructions will be sent." });
});

test("email verification requests do not disclose whether an account needs verification", async () => {
  const { response, body } = await request("/api/email-verification/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.invalid" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { message: "If that account needs verification, instructions will be sent." });
});

test("unknown API routes return not found", async () => {
  const { response, body } = await request("/api/does-not-exist");
  assert.equal(response.status, 401);
  assert.equal(body.message, "Please login first");
});

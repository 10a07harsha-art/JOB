# Orbit Jobs + ForgeHire

This project is a role-based hiring platform with two branded workspaces:
- `Orbit Jobs` for public candidates
- `ForgeHire` for protected company users

## Features
- login-first flow
- hashed password storage using Node `crypto.scrypt`
- token-based auth using signed HMAC tokens
- separate admin provisioning flow with a developer key
- editable candidate profile with resume text upload support
- internal jobs plus world-job provider fallback support
- trend provider fallback support
- built-in AI advisor with optional external AI provider hookup
- applicant review and resume verification for admins
- job search, filters, sorting, and detail routes
- candidate and employer notifications
- employer applicant stage controls
- multi-source global job aggregation from Remotive, Jobicy, and Arbeitnow
- cloud-computing radar with cloud job detection, readiness scoring, and hiring signals

## Run
```bash
npm install
npm start
```

Health checks:
- `/api/health` confirms the process is running.
- `/api/ready` confirms the configured storage can be read.

The included `Dockerfile` runs the service with Node 22. For production containers, configure MongoDB and all required environment secrets; container-local JSON storage is not durable.

Paginated API endpoints are available for incremental loading: `GET /api/jobs?page=1&pageSize=24` and `GET /api/applicants?page=1&pageSize=24`. Page sizes are capped at 100.

Open `http://127.0.0.1:8000`

Candidate site:
- `/`

Company site:
- `/studio`

## ForgeHire Access
ForgeHire is login-only for companies.
Admin accounts are issued privately by your platform team using the backend provisioning route and developer key.
Configure the provisioning key only in `.env` using `ADMIN_PROVISION_KEY`.

Provisioning requests must send the configured key in the `X-Provisioning-Key` header. The key is never accepted from the JSON body, and provisioning is limited to five attempts per IP per rate-limit window.

No demo accounts are shown in the UI. Only the candidate side has signup.

## Live Providers
Orbit Jobs pulls live global jobs from multiple public providers by default. Copy `.env.example` to `.env` if you want to override providers or connect your own services:
- `GLOBAL_JOBS_URL`
- `GLOBAL_JOBS_API_KEY`
- `REMOTIVE_JOBS_URL`
- `REMOTIVE_JOBS_API_KEY`
- `JOBICY_JOBS_URL`
- `JOBICY_JOBS_API_KEY`
- `ARBEITNOW_JOBS_URL`
- `ARBEITNOW_JOBS_API_KEY`
- `GLOBAL_TRENDS_URL`
- `GLOBAL_TRENDS_API_KEY`
- `AI_PROVIDER_URL`
- `AI_API_KEY`
- `AI_MODEL`
- `MONGODB_URI`
- `MONGODB_DB`

## AI Provider Shape
The external AI request expects an OpenAI-compatible chat-completions style endpoint:
- accepts `model`
- accepts `messages`
- returns `choices[0].message.content`

If not configured, the app falls back to the built-in local advisor.

## Local configuration and production safety
Copy `.env.example` to `.env` and replace every placeholder secret with a random value. Never commit `.env`, `data/store.json`, `node_modules`, or local database credentials. In production, set `NODE_ENV=production`, `TOKEN_SECRET`, and `ADMIN_PROVISION_KEY`; the server will refuse to start without sufficiently long values.

The checked-in `data/store.example.json` is an empty seed template. Local runtime data is stored in `data/store.json` and is intentionally ignored by Git.

Browser sessions use an `HttpOnly`, `SameSite=Lax` cookie named `orbit_session`; authentication tokens are not persisted in browser storage. Existing tokens from older builds are removed when either frontend loads.
Logout also records the session ID as revoked server-side, so an intercepted session cannot be reused after logout.
State-changing API requests also validate their `Origin` header to reduce cross-site request forgery risk.
Bearer-token authentication has been removed; application authentication now uses the session cookie exclusively.
Responses include an `X-Request-Id` value for support and tracing; unexpected server failures log that ID with the request method, path, and duration.
Password reset requests return the same response whether or not an account exists and are rate-limited. Configure `EMAIL_PROVIDER_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, and `PUBLIC_APP_URL` to deliver production reset links. The provider receives `{ to, from, subject, text, resetUrl }`. In development, a reset token is returned for local testing when no provider is configured.
New candidate accounts require email verification before login. Verification emails use the same provider configuration and receive `{ to, from, subject, text, verificationUrl }`; development returns a verification token when no provider is configured.

Local store writes are atomic and mutating requests are serialized per server process. For a multi-instance production deployment, migrate the remaining single MongoDB state document to separate user, job, application, and notification collections with transactional or atomic updates.
The MongoDB state document now includes an optimistic version check and returns `409` on concurrent write conflicts instead of silently losing one update.

To prepare a normalized MongoDB database, configure `MONGODB_URI` and `MONGODB_DB`, then run `npm run migrate:mongodb`. The migration is non-destructive and upserts records into `app_meta`, `users`, `jobs`, `trends`, and `degrees`; it does not delete the existing `app_state` document. After verifying the migration, set `MONGODB_STORAGE_MODE=normalized` to make the server use those collections transactionally.

Free-tier backup: run `npm run backup:mongodb` regularly. It exports the normalized collections and legacy `app_state` into a local, Git-ignored `backups/` directory. Copy those backup files to another private location; they contain application data and password hashes.

## MongoDB Atlas
If you want the app to use MongoDB Atlas instead of the local JSON file, set `MONGODB_URI` to your cluster connection string and optionally `MONGODB_DB` for the database name.

The app will create and use a single `app_state` collection automatically. If you are replacing an old test cluster such as `project0`, delete that cluster in Atlas manually and point `MONGODB_URI` at the new one.

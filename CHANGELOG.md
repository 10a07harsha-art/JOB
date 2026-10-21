# Project Updates

## 2026-10-21 — Security, MongoDB, and reliability update

### Added

- MongoDB Atlas support with normalized collections for users, jobs, trends, and degrees.
- MongoDB migration and backup commands:
  - `npm run migrate:mongodb`
  - `npm run backup:mongodb`
- Health and readiness endpoints: `/api/health` and `/api/ready`.
- Cookie-based sessions with logout and server-side session revocation.
- Email verification and password reset flows.
- Paginated authenticated jobs and applicants API endpoints.
- Request IDs, structured server error logs, rate limiting, secure headers, and CORS protection.
- Atomic local JSON writes and optimistic MongoDB state versioning.
- Automated API tests and project syntax checks.
- Docker support with `Dockerfile` and `.dockerignore`.
- Example local data template at `data/store.example.json`.

### Security changes

- Removed bearer-token persistence from the browser.
- Added HttpOnly session cookies and safer authentication handling.
- Added request body limits and input validation.
- Added provisioning-key protection through the `X-Provisioning-Key` header.
- Excluded `.env`, local databases, backups, and dependencies from Git.

### Verification

- `npm run check` passes.
- `npm test` passes with 15 tests.
- MongoDB Atlas normalized storage verified through `/api/ready`.

### Configuration note

The free MongoDB Atlas tier is sufficient for this project. Keep real credentials in `.env` only; commit `.env.example` as the configuration template.

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

## Run
```bash
npm start
```

Open `http://127.0.0.1:8000`

Candidate site:
- `/`

Company site:
- `/studio`

## ForgeHire Access
ForgeHire is login-only for companies.
Admin accounts are issued privately by your platform team using the backend provisioning route and developer key.
Default key in local seed data:
- `DEV-CAREERLINK-2026`

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

## AI Provider Shape
The external AI request expects an OpenAI-compatible chat-completions style endpoint:
- accepts `model`
- accepts `messages`
- returns `choices[0].message.content`

If not configured, the app falls back to the built-in local advisor.

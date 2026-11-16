# Afyazuri

**Every department on one system — registration through to claims, without re-keying data between systems.**

Afyazuri is a hospital management system for Kenyan health facilities (Level 2–5: dispensaries, health centres, sub-county, county and private hospitals). It is a modular monolith: one Node.js service, one PostgreSQL database and one installable web app that keeps working on slow and intermittent connections.

> **Status:** Phase 1 (foundation) of 10 is complete. See [Delivery status](#delivery-status).

## Requirements

- **Node.js 20.12 or newer** (22 LTS recommended), on Windows, Linux or macOS
- No Docker and no separate PostgreSQL install: Afyazuri runs PostgreSQL 16 itself through
  [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres). An existing PostgreSQL 16 server can be used instead (`EXTERNAL_DATABASE_URL`).

## Quick start (development)

```bash
npm install          # on npm 11+, approve native packages if asked: npm install-scripts approve
npm run dev          # creates .env with fresh secrets, starts PostgreSQL, migrates, seeds demo data,
                     # and runs the API (http://localhost:4000) and web app (http://localhost:5173)
```

Open http://localhost:5173 and sign in with a demo account below. Press Ctrl+C to stop everything.

### Demo accounts

All demo accounts use the password **`Afyazuri#2026`**. They exist only when demo data is seeded (`npm run dev`, or `SEED_DEMO=true`). Demo seeding never runs when `NODE_ENV=production` unless `SEED_DEMO=true` is set. The two demo facilities use the fictitious KMHFL codes 99001 and 99002.

| Username                       | Role                              | Scope                                               |
| ------------------------------ | --------------------------------- | --------------------------------------------------- |
| `admin`                        | Super Admin                       | All facilities, no clinical access                  |
| `facadmin`                     | Facility Admin                    | Demo County Hospital                                |
| `records`                      | Records Clerk                     | Health Records                                      |
| `triage`                       | Triage Nurse                      | Outpatient                                          |
| `doctor`                       | Clinician / Doctor                | Whole hospital                                      |
| `clinofficer`                  | Clinical Officer                  | Outpatient                                          |
| `wardnurse`                    | Nurse (Ward)                      | Inpatient                                           |
| `pharmacist` / `pharmtech`     | Pharmacist / Pharmacy Tech        | Pharmacy                                            |
| `labtech` / `labsup`           | Lab Technologist / Lab Supervisor | Laboratory                                          |
| `radiographer` / `radiologist` | Radiographer / Radiologist        | Radiology                                           |
| `cashier` / `billing`          | Cashier / Billing Officer         | Billing                                             |
| `claims`                       | Claims Officer                    | Claims                                              |
| `storekeeper`                  | Storekeeper                       | Stores                                              |
| `accountant`                   | Accountant                        | Whole hospital                                      |
| `manager`                      | Facility Manager (read-only)      | Whole hospital                                      |
| `locum`                        | Clinician / Doctor                | **Both** demo facilities (shows facility switching) |

## Running in production (on-premise or cloud, no Docker)

```bash
npm ci
npm run build                  # build the web app
npm run secrets                # create .env with strong secrets — back up the keys it prints about
npm start                      # PostgreSQL + API + web app on port 4000, supervised
npm run admin:create -- --username jdoe --name "Jane Doe"   # first Super Admin
```

`npm start` runs PostgreSQL bound to localhost only and the API, which also serves the web app. LAN clients connect to `http://<server>:4000` (or HTTPS with `TLS_CERT_FILE`/`TLS_KEY_FILE`). Clinical work on the LAN continues when the internet is down. To start on boot, see [docs/onprem-install.md](docs/onprem-install.md): it covers a systemd unit for Linux and a startup task for Windows.

Nightly encrypted backups run automatically when `BACKUP_KEY` and `BACKUP_DIR` are set. See [docs/backup-restore.md](docs/backup-restore.md).

## Scripts

| Command                                                       | What it does                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                                                 | Full local stack with demo data and auto-reload                               |
| `npm start`                                                   | Production runtime (embedded PostgreSQL + API + built web app)                |
| `npm run build`                                               | Build the PWA into `apps/web/dist`                                            |
| `npm run secrets`                                             | Create/complete `.env` with random secrets (never overwrites existing values) |
| `npm run admin:create -- --username u --name "Full Name"`     | Create the first Super Admin                                                  |
| `npm run icd:import -- <SimpleTabulation file>`               | Load the official WHO ICD-11 code list (a small starter set ships by default) |
| `npm run backup`                                              | Encrypted backup now, verify it, apply retention, copy off-site               |
| `npm run backup -- verify <file>`                             | Check a backup decrypts and is intact                                         |
| `npm run backup -- restore <file> --database-url <url> --yes` | Restore (destructive)                                                         |
| `npm run db:local`                                            | Just the development PostgreSQL server                                        |
| `npm run db:migrate` / `db:rollback` / `db:seed`              | Knex migrations and seeds against `DATABASE_URL`                              |
| `npm test`                                                    | Unit + integration tests (integration uses a throwaway embedded PostgreSQL)   |
| `npm run test:e2e`                                            | Build, then Playwright end-to-end tests (desktop, phone, 256 kbps / 300 ms)   |
| `npm run lint` / `npm run format`                             | ESLint / Prettier                                                             |
| `npm run docs:permissions`                                    | Regenerate [docs/permission-matrix.md](docs/permission-matrix.md)             |

## Configuration

All configuration is environment variables, read from `.env` at the repository root. [`.env.example`](.env.example) documents each one. The API validates them at startup and lists every missing or invalid value.

| Variable                                 | Default                      | Purpose                                                   |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `JWT_SECRET`                             | — (required)                 | Signs access tokens                                       |
| `ENCRYPTION_KEY`                         | — (required)                 | AES-256-GCM key for sensitive columns (base64, 32 bytes)  |
| `BLIND_INDEX_KEY`                        | — (required)                 | HMAC key for searching encrypted values                   |
| `PG_PASSWORD`                            | — (required for `npm start`) | Embedded PostgreSQL superuser password                    |
| `BACKUP_KEY` / `BACKUP_DIR`              | — / `backups`                | Enable nightly encrypted backups                          |
| `BACKUP_OFFSITE_DIR`                     | —                            | Second copy (network share, USB disk)                     |
| `EXTERNAL_DATABASE_URL`                  | —                            | Use an existing PostgreSQL 16 instead of the embedded one |
| `PORT`                                   | `4000`                       | HTTP(S) port                                              |
| `TLS_CERT_FILE` / `TLS_KEY_FILE`         | —                            | Serve HTTPS directly                                      |
| `SESSION_IDLE_MINUTES`                   | `15`                         | Sign out after inactivity                                 |
| `LOGIN_MAX_ATTEMPTS` / `LOCKOUT_MINUTES` | `5` / `15`                   | Account lockout                                           |
| `REQUIRE_2FA_PRIVILEGED`                 | `false`                      | Require TOTP for admin and finance roles                  |
| `CORS_ORIGINS`                           | `http://localhost:5173`      | Allowed browser origins (comma-separated)                 |
| `LOG_LEVEL`                              | `info`                       | pino log level                                            |

> ⚠️ Keep copies of `ENCRYPTION_KEY`, `BLIND_INDEX_KEY` and `BACKUP_KEY` somewhere safe and **separate from the backups**. Without them, encrypted patient fields and backups cannot be recovered.

## Project layout

```
apps/api        Node.js API (Express 5): src/modules/<domain>/{routes,service,repository}.js
apps/web        React 18 PWA (Vite, TanStack Query, React Hook Form, Tailwind)
packages/shared Zod schemas, enums, permission catalogue and role matrix (used by API and web)
db/migrations   Knex migrations (PostgreSQL 16)
db/seeds        Reference data (roles, permissions, counties) and demo data
scripts/        dev, start, backup, secrets, admin, e2e and docs tooling
deploy/         systemd unit, Windows startup task, optional Nginx front end
docs/           Architecture, API, data protection, install, backup and demo guides
e2e/            Playwright tests
```

## Documentation

- [Architecture](docs/architecture.md): modules, data flow, auth, sync design
- [API](docs/api.md) and the [OpenAPI spec](docs/openapi.yaml)
- [Permission matrix](docs/permission-matrix.md)
- [Data protection](docs/data-protection.md): how the Kenya Data Protection Act 2019 and the Digital Health Act 2023 are addressed
- [On-premise install](docs/onprem-install.md)
- [Backup and restore](docs/backup-restore.md)
- [Phase 1 demo script](docs/demo-phase-1.md)

## Delivery status

| Phase | Scope                                                                        | Status                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Foundation: auth, users, roles, facilities, audit log, UI shell, CI, backups | ✅ Done                                                                                                                                     |
| 2     | Patients and OPD: registration, duplicates, search, queues, triage, EMR      | In progress: patients ✅, OPD queues ✅, EMR ✅ (vitals, signed notes, ICD-11 diagnoses, allergies, timeline); demo data and hardening next |
| 3     | Billing core, M-Pesa (mocked Daraja), receipts, cashier shifts               | Planned                                                                                                                                     |
| 4     | Pharmacy and inventory                                                       | Planned                                                                                                                                     |
| 5     | Lab and imaging                                                              | Planned                                                                                                                                     |
| 6     | Inpatient                                                                    | Planned                                                                                                                                     |
| 7     | Claims and SHA (mock SHA server)                                             | Planned                                                                                                                                     |
| 8     | Reports and dashboard                                                        | Planned                                                                                                                                     |
| 9     | Offline and low-bandwidth hardening                                          | Planned                                                                                                                                     |
| 10    | Data protection and ops hardening                                            | Planned                                                                                                                                     |

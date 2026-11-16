# Build Prompt: MediHealth — Integrated Hospital Management System

## 1. Your role

You are a senior full-stack engineer and health-informatics architect. Build **MediHealth**, a production-grade Hospital Management System (HMS) for Kenyan health facilities (Level 2–5: dispensaries, health centres, sub-county and county hospitals, private hospitals). The core promise is **"Every department on one system — registration through to claims, without re-keying data between systems."**

Work incrementally, in the phases defined in section 10. At the start, produce a short architecture plan and the database schema, then build phase by phase. Each phase must run, pass its tests, and be demonstrable before you move on. Don't leave TODO stubs in core flows. Where an external integration can't be reached (SHA, M-Pesa), build it behind an adapter interface with a working mock implementation.

---

## 2. Tech stack (fixed)

- **Language:** JavaScript only (ES2022+, ES modules). No TypeScript. Use JSDoc type annotations on public functions, and validate all input at runtime with **Zod**.
- **Frontend:** React 18 + Vite, React Router, TanStack Query for server state, React Hook Form + Zod for forms, Tailwind CSS for styling. Installable PWA with a service worker (Workbox).
- **Backend:** Node.js 20 LTS + Express (or Fastify), organised as a modular monolith (one deployable service, with clearly separated domain modules).
- **Database:** PostgreSQL 16. Use **Knex.js** for migrations, seeds and queries. Use `uuid` primary keys (`gen_random_uuid()`), `timestamptz` for all timestamps, and `numeric(14,2)` for money, never floats.
- **Background jobs:** pg-boss (a Postgres-backed queue, so there's no extra Redis dependency on-prem).
- **Auth:** Argon2id password hashing. Short-lived JWT access tokens plus rotating refresh tokens in httpOnly, Secure, SameSite cookies. Optional TOTP 2FA for admin and finance roles.
- **Testing:** Vitest (unit), Supertest (API), Playwright (critical end-to-end flows).
- **Tooling:** ESLint + Prettier, Docker + Docker Compose, GitHub Actions CI.

---

## 3. Repository structure

```
medihealth/
  apps/
    web/                 # React PWA
    api/                 # Node.js API
  packages/
    shared/              # Zod schemas, enums, permission constants shared by web + api
  db/
    migrations/
    seeds/               # roles, permissions, demo facility, ICD codes, drug list, lab test catalogue
  deploy/
    docker-compose.cloud.yml
    docker-compose.onprem.yml
    nginx/
    backup/
  docs/
    architecture.md
    api.md               # OpenAPI 3 spec, generated or hand-maintained
    data-protection.md
```

Backend module layout (each module owns its routes, service, repository, validators and tests):
`auth, users, facilities, patients, emr, opd, ipd, pharmacy, lab, imaging, billing, claims, inventory, reports, audit, sync, notifications`.

Modules talk to each other through service functions or domain events (an internal event bus plus an outbox table), never by reaching into another module's tables directly.

---

## 4. Core principles

1. **One patient identity.** A patient is registered once and gets a facility MRN (medical record number). Every visit, admission, order, bill and claim links back to that one `patient_id`.
2. **Capture once, reuse everywhere.** A prescription becomes a dispensing task, then a stock movement, then a bill line. A lab order becomes a sample, then a result, then a bill line. Staff never re-key data between departments.
3. **Charges post automatically.** Every billable clinical action (consultation, drug dispensed, test performed, imaging, bed-day, procedure) creates a charge on the patient's open bill, using the facility price list and the patient's payer scheme.
4. **Encounter-centric model.** Clinical and billing activity hangs off an `encounter` (OPD visit, IPD admission, emergency visit), and an encounter belongs to a patient.
5. **Everything is audited.** Every create, update and delete, plus every **view** of a patient's clinical record, is written to an append-only audit log.
6. **Works on bad networks.** Low bandwidth and intermittent connectivity are the normal case, not an edge case.

---

## 5. Data model (minimum entities)

Design normalised tables with foreign keys, indexes on lookup columns, `created_at / updated_at / created_by / updated_by`, and soft delete (`deleted_at`) where clinically appropriate. Clinical records are **never hard-deleted**. Corrections create amendments that keep the original.

- **Organisation:** `facilities` (with KMHFL facility code), `departments`, `wards`, `beds`, `service_points`.
- **Identity & access:** `users`, `roles`, `permissions`, `role_permissions`, `user_roles` (scoped by facility and department), `sessions`, `refresh_tokens`.
- **Patients:** `patients` (MRN, names, sex, date of birth or estimated age, national ID / birth certificate / passport / alien ID, SHA number, phone, county / sub-county / ward, next of kin), `patient_identifiers`, `patient_payer_schemes`, `patient_merges` (for duplicate resolution).
- **Clinical:** `encounters`, `triage_vitals`, `clinical_notes` (SOAP), `diagnoses` (ICD-11, with ICD-10 mapping allowed), `allergies`, `problem_list`, `procedures`, `referrals`, `attachments`.
- **OPD:** `queues`, `queue_tickets` (status: waiting → called → in-service → done / referred / no-show).
- **IPD:** `admissions`, `bed_assignments`, `transfers`, `ward_rounds`, `nursing_notes`, `medication_administration` (MAR), `discharge_summaries`.
- **Pharmacy:** `drugs` (generic, brand, form, strength, KEML flag), `prescriptions`, `prescription_items`, `dispensations`.
- **Lab:** `lab_test_catalogue` (with reference ranges by sex and age), `lab_orders`, `lab_order_items`, `samples` (barcode), `lab_results`, `result_verifications`.
- **Imaging:** `imaging_catalogue`, `imaging_orders` (clinical indication required), `imaging_reports`.
- **Billing:** `price_lists`, `price_list_items`, `bills`, `bill_items`, `payments` (cash, M-Pesa, card, bank, insurance, waiver), `receipts`, `deposits`, `refunds`, `cashier_shifts`, `waivers`.
- **Claims:** `payers` (SHA, private insurers), `schemes`, `eligibility_checks`, `preauthorizations`, `claims`, `claim_items`, `claim_submissions`, `claim_responses`, `remittances`, `remittance_lines`.
- **Inventory:** `stores`, `items`, `item_batches` (batch number, expiry date), `stock_levels`, `reorder_levels`, `requisitions`, `requisition_items`, `goods_received_notes`, `stock_movements` (an immutable ledger), `suppliers`, `purchase_orders`, `stock_takes`.
- **Platform:** `audit_log` (append-only), `outbox_events`, `sync_changes`, `notifications`, `system_settings`.

Stock levels are **derived from the `stock_movements` ledger** (or kept consistent with it by transactional updates). Never adjust stock without writing a movement row.

---

## 6. Functional modules and acceptance criteria

### 6.1 Patient Registration and Records
- Register with required demographics. Generate an MRN in a configurable format, e.g. `{facility_code}-{year}-{seq}`.
- **Duplicate detection** before save: fuzzy match on name plus DOB/phone/ID, with a Postgres `pg_trgm` index. Show likely matches and require an explicit "create new anyway" with a reason.
- Patient merge workflow (supervisor role). Repoint all child records, keep a merge audit trail, and allow unmerge.
- Search by MRN, name, phone, national ID or SHA number in under 300 ms on 500k patients.
- Print or reprint a patient card with a barcode/QR code of the MRN.
- Patient banner (name, age, sex, MRN, allergies, payer) shown on every clinical screen.

### 6.2 Electronic Medical Records (EMR)
- Triage vitals (BP, pulse, temperature, respiratory rate, SpO2, weight, height, BMI auto-calculated, MUAC for children). Flag abnormal values.
- SOAP clinical notes with templates per department. Diagnoses coded with ICD-11 search (seed a searchable code table).
- Allergies (drug, food, other; severity) and a problem list. **Allergy alerts block or warn at prescribing.**
- Chronological patient timeline across all encounters: notes, vitals, results, prescriptions, admissions.
- Notes are signed and locked on save. Later changes are addenda, with author and timestamp.
- Attach scanned documents and images (stored in object storage or the filesystem, with metadata in the DB).

### 6.3 Outpatient (OPD)
- Check-in creates an encounter and a queue ticket at the first service point (e.g. triage).
- Configurable routing: Registration → Cashier (if cash, pay-first) → Triage → Consultation → Lab/Imaging/Pharmacy → back to Consultation → Exit.
- Queue board per service point (waiting, called, in service), with wait-time display. A "call next" button and an optional TV display mode.
- Clinicians order labs, imaging and prescriptions from within the consultation, then refer internally or externally (with a referral letter).
- Configurable pay-before-service vs. bill-at-exit, per payer type.

### 6.4 Inpatient and Bed Management
- Admission from OPD/emergency or direct, with admitting diagnosis, ward and bed.
- Live bed board per ward (available, occupied, reserved, cleaning, out of service).
- Transfers between beds and wards, with history.
- Ward rounds, nursing notes, vitals charting, and a medication administration record (MAR) driven by active prescriptions.
- **Daily bed-day charges** posted automatically by a scheduled job at a configurable cut-off time, plus nursing/doctor daily fees per the price list.
- Discharge workflow: discharge summary (diagnoses, procedures, meds on discharge, follow-up), a final bill check, clearance, then bed release.
- Inpatient deposit tracking, with alerts when the running bill exceeds the deposit.

### 6.5 Pharmacy and Dispensing
- Prescriptions arrive in a pharmacy worklist from OPD or IPD.
- Dispense with **FEFO batch selection** (first-expiry, first-out). Support partial dispensing and substitution (with a reason).
- Each dispensation creates a stock movement and a bill line in the same database transaction.
- Checks: allergy, duplicate therapy, and basic dose-range checks (configurable rules table).
- Walk-in/OTC sales for non-registered customers (a lightweight customer record).
- Expiry dashboard: items expiring in 30/60/90 days, expired stock quarantined from dispensing.

### 6.6 Laboratory Information System (LIS)
- Order → sample collection (generate a barcode label) → receive in lab → result entry → verification → release.
- Result entry per test type: numeric with reference ranges and auto H/L/critical flags, text, panels, and culture/sensitivity.
- **Critical results** trigger an immediate notification to the ordering clinician.
- Only verified results are visible on the patient record. Amended results keep the history.
- Turnaround-time (TAT) tracking from order to release, per test.
- Printable/PDF result report with the facility letterhead.

### 6.7 Imaging and Radiology Orders
- Imaging order requires a **clinical indication** field (mandatory).
- Statuses: ordered → scheduled → performed → reported → released, with TAT tracking.
- Radiologist report entry with templates. Attach report PDFs/images. Store a DICOM study reference (accession number) for future PACS integration. Full PACS isn't in scope.

### 6.8 Billing and Revenue
- One open bill per encounter. Lines are auto-posted from clinical modules, and manual lines are allowed with permission.
- Payer resolution per line: **cash, insurance, or split** (e.g. SHA covers a package amount, the patient pays the balance; insurer co-pays).
- Payments: cash, **M-Pesa (Daraja STK Push + C2B confirmation callback)**, card, bank transfer, and waivers (with an approval workflow).
- Receipts with sequential numbering per facility. Invoices for insurance. Credit notes and refunds with approval.
- Cashier shifts: open with a float, close with declared vs. system totals by payment method, and record the variance.
- Daily revenue reconciliation report by department, payer and payment method.
- Outstanding balances and debtor ageing (0–30, 31–60, 61–90, 90+ days).
- All amounts in KES. Configurable tax handling (most medical services are VAT-exempt). eTIMS integration via an adapter, mocked for now.

### 6.9 Claims and SHA Integration
Build a **payer integration layer** with a common interface, plus an `SHAAdapter` and a `PrivateInsurerAdapter` (generic, configurable per insurer):

```js
/** @interface PayerAdapter */
checkEligibility(patient, scheme)        // → { eligible, coverage, reason }
requestPreauth(encounter, items)         // → { preauthRef, status, approvedAmount }
submitClaim(claim)                       // → { submissionRef, status }
getClaimStatus(submissionRef)
fetchRemittances(dateRange)
```

- **Eligibility verification** at registration/check-in using the patient's ID/SHA number, with the result and timestamp stored on the encounter.
- **Preauthorization** for services that need it (configurable per scheme and service), with status tracking and a link to the claim.
- **Claim assembly** from the encounter: diagnoses (ICD-11), services and items mapped to payer tariff/intervention codes (a mapping table), attachments, and clinician details.
- A validation step before submission that catches missing diagnosis, unmapped codes, missing preauth or missing signatures.
- Submission queue with retries (pg-boss). Works offline: claims are queued and sent when connectivity returns.
- **Rejection handling:** capture rejection reasons, send the claim back to a correction worklist, and resubmit, keeping version history.
- **Payment reconciliation:** import or fetch remittances, auto-match against claims, flag short-payments and unmatched lines, and post payments to bills.
- Claims dashboard: draft, submitted, approved, rejected, paid, with KES amounts and ageing.
- The real SHA API needs facility accreditation and credentials. Implement the adapter against a **configurable base URL and credentials**, and ship a **mock SHA server** (a small Express app in `deploy/mocks`) that simulates eligibility, preauth, claim responses and rejections, so the whole flow is testable end to end.

### 6.10 Inventory and Stock Control
- Multiple stores (main store, pharmacy, lab, wards, theatre).
- Item master with units of measure and pack-size conversion.
- Reorder levels per store, with low-stock alerts and suggested reorder quantities.
- Internal requisitions (ward → main store): request → approve → issue → receive, with variances recorded.
- Purchase orders → Goods Received Notes (batch and expiry captured) → stock in.
- Stock takes with variance adjustment (approval required).
- Consumption reports by department and item. Stock valuation (weighted average cost).

### 6.11 Reports and Facility Dashboard
- Role-aware dashboard: today's patient volumes (OPD/IPD/emergency), bed occupancy, revenue collected vs. billed, claims by status and value, low stock and expiring items, lab TAT.
- Standard reports, filterable by date, department and payer, with CSV/Excel/PDF export: patient attendance, morbidity (top diagnoses), revenue, cashier, debtors, claims, stock, and pharmacy consumption.
- Include MOH-aligned summary outputs (e.g. outpatient morbidity summaries by age group <5 / ≥5) structured so they can feed KHIS/DHIS2 later.
- Heavy reports run against materialized views refreshed by background jobs, never blocking clinical transactions.

### 6.12 User Roles and Access Control
- Seeded roles: Super Admin, Facility Admin, Records Clerk, Triage Nurse, Clinician/Doctor, Clinical Officer, Nurse (Ward), Pharmacist, Pharmacy Tech, Lab Technologist, Lab Supervisor, Radiographer, Radiologist, Cashier, Billing Officer, Claims Officer, Storekeeper, Accountant, Facility Manager (read-only reports).
- Permissions are granular strings (`patients.read`, `emr.notes.sign`, `billing.waiver.approve`, `claims.submit`, …), assigned to roles, and **roles are scoped to facility and department**.
- Enforce permissions in the API (middleware on every route) **and** hide or disable UI elements accordingly. The API is the source of truth.
- Clinical data access is limited to roles with a clinical need. Billing staff see billing data, not clinical notes.
- "Break-the-glass" emergency access to a restricted record requires a reason, is time-limited and is flagged for review.
- Session timeout after inactivity (configurable). Force logout and disable users. Password policy and account lockout after failed attempts.

---

## 7. Cross-cutting requirements

### 7.1 Data protection (Kenya Data Protection Act 2019 / ODPC expectations; Digital Health Act 2023)
- **Audit trail:** an append-only `audit_log` table (no UPDATE/DELETE privileges for the app role, enforced by DB grants and a trigger). Record actor, role, facility, action, entity, entity ID, before/after diff for writes, IP, user agent and timestamp. **Log reads of patient clinical records.**
- Audit viewer for admins: filter by user, patient, date or action. Export for investigations.
- **Encryption:** TLS everywhere. Encrypt sensitive columns (national ID, phone, and optionally diagnoses for sensitive conditions) using `pgcrypto` or app-level AES-256-GCM, with keys from environment/KMS and never in the repo. Encrypted backups.
- **Data minimisation and consent:** record patient consent for data processing and for sharing (e.g. claims to payers, referrals). Store the consent version and timestamp.
- **Data subject rights:** an admin workflow to export a patient's full record (access request) and to log rectification requests.
- **Retention policy** config per record type. Clinical records are archived, not deleted.
- **Breach readiness:** detect anomalies (e.g. a user viewing an unusually high number of records) and alert admins.
- Write `docs/data-protection.md` mapping each control to the relevant requirement.

### 7.2 Low-bandwidth and offline operation
- **Offline-first PWA:** cache the app shell and reference data (drug list, price list, ICD codes, lab catalogue) in IndexedDB.
- Offline-capable workflows at minimum: patient registration and search (on locally cached recent patients), triage vitals, clinical notes, queue updates, and cash receipting. Writes go to a local **outbox queue** with client-generated UUIDs and are synced when back online.
- **Sync protocol:** delta sync using `updated_at` plus a monotonic server change sequence (the `sync_changes` table). Idempotent writes (keyed on client UUID). Conflict handling: last-write-wins for simple fields. Clinical notes and payments are append-only, so they don't conflict. Real conflicts surface to the user.
- Clear UI connectivity indicator (online / offline / syncing, with a pending count).
- **Payload discipline:** gzip/brotli compression, paginated APIs (cursor-based), field selection on list endpoints, no N+1 requests, initial JS bundle under 250 KB gzipped, route-level code splitting, no heavy UI libraries, system fonts, and images lazy-loaded and compressed.
- Target: core screens usable on a **256 kbps connection with 300 ms latency**. Add a Playwright test profile with network throttling.

### 7.3 Deployment: cloud or on-premise
- The same Docker images serve both modes, configured purely through environment variables.
- `docker-compose.onprem.yml`: API, web (served by Nginx), Postgres, scheduled backup container. Runs on a single modest server (4 vCPU, 8 GB RAM) on the facility LAN, with a local TLS certificate. Clients on the LAN work even when the internet is down. Payer and M-Pesa calls queue until connectivity returns.
- `docker-compose.cloud.yml`: same services, behind a reverse proxy with Let's Encrypt, managed Postgres optional.
- **Backups:** nightly `pg_dump` (encrypted, compressed) with configurable retention (e.g. 7 daily, 4 weekly, 12 monthly), optional off-site copy (S3-compatible). WAL archiving for point-in-time recovery in cloud mode. A documented and tested **restore script**.
- Health check endpoints (`/health`, `/ready`), structured JSON logging (pino) with patient identifiers redacted, and basic metrics.
- Multi-facility ready: every business table carries `facility_id`. Support a hospital group with several facilities in one deployment, with data isolation enforced in the repository layer.

### 7.4 Kenyan context
- Currency KES. Timezone Africa/Nairobi. Phone format +254.
- Admin units: seed counties, sub-counties and wards.
- Identifiers: national ID, birth certificate number, passport, alien ID, SHA number, KMHFL facility code. Practitioner licence numbers (KMPDC, NCK, PPB, KMLTTB) stored on clinician user profiles and included in claims.
- SMS notifications via an adapter (e.g. Africa's Talking), mocked by default: appointment reminders, "your results are ready", payment confirmations.
- UI in English, with an i18n framework in place (react-i18next) and Kiswahili strings for patient-facing outputs (receipts, SMS).

---

## 8. API standards

- REST, versioned under `/api/v1`, JSON, with an OpenAPI 3 spec in `docs/api.md` (or `openapi.yaml`).
- Consistent error shape: `{ error: { code, message, details } }`. Validate every request body, query and params with Zod schemas from `packages/shared`.
- Cursor pagination: `?limit=&cursor=`. Filtering and sorting via whitelisted params.
- Idempotency keys on payment, dispensing, claim submission and all offline-synced writes.
- Rate limiting on auth endpoints. Helmet security headers. Strict CORS.
- All multi-step operations (dispense + stock + bill, payment + receipt + bill update) run in **a single DB transaction**.

---

## 9. Frontend standards

- Layout: a sidebar of modules filtered by permission, the patient banner on clinical screens, and global patient search (keyboard shortcut `/`).
- Designed for busy clinics: keyboard-friendly forms, large touch targets for tablets, minimal clicks for high-volume actions (check-in, triage, receipt).
- Works on desktop (1366×768 minimum) and tablet. Key worklists are usable on phones.
- Accessible (WCAG 2.1 AA): labels, focus states, contrast.
- Print stylesheets for patient cards, receipts, lab reports, discharge summaries and prescriptions, and support for 80 mm thermal receipt printers.
- Loading, empty and error states on every screen. Optimistic updates where safe.

---

## 10. Delivery phases

Build in this order. Each phase ends with migrations, seeds, tests and a short demo script in `docs/`.

1. **Foundation:** monorepo, Docker setup, DB connection, migrations framework, auth, users, roles/permissions, facilities/departments, audit log, base UI shell, CI.
2. **Patients and OPD:** registration, duplicate detection, search, encounters, queues, triage, EMR notes/diagnoses/allergies, patient timeline.
3. **Billing core:** price lists, auto-posted charges, bills, cash and M-Pesa payments (mocked Daraja), receipts, cashier shifts.
4. **Pharmacy and Inventory:** drug master, stores, batches, GRN, FEFO dispensing, requisitions, reorder alerts, expiry tracking.
5. **Lab and Imaging:** catalogues, orders, samples, results, verification, critical alerts, imaging orders/reports, TAT.
6. **Inpatient:** admissions, bed board, transfers, ward rounds, MAR, daily charges, deposits, discharge.
7. **Claims and SHA:** payer adapters, mock SHA server, eligibility, preauth, claim assembly/validation/submission, rejections, remittance reconciliation.
8. **Reports and Dashboard:** materialized views, dashboard, standard reports, exports.
9. **Offline and low-bandwidth hardening:** PWA caching, outbox sync, conflict handling, throttled-network tests, bundle budget.
10. **Data protection and ops hardening:** column encryption, consent, data subject request export, anomaly alerts, backup/restore scripts, on-prem install guide.

---

## 11. Testing and quality bar

- Unit tests for business rules: pricing and split billing, FEFO selection, stock ledger, claim validation, permission checks, sync conflict rules.
- API integration tests against a real Postgres (Docker) for every module's main flows.
- Playwright end-to-end tests for these golden paths:
  1. Register a cash patient → triage → consult → lab order → result → prescription → dispense → pay → receipt.
  2. SHA patient → eligibility check → consult → claim assembled → submitted to the mock SHA → rejected → corrected → resubmitted → approved → remittance reconciled.
  3. Admit → transfer bed → two days of auto bed charges → discharge summary → final bill → bed released.
  4. Go offline → register patient and record vitals → come back online → data syncs with no duplicates.
- Seed a realistic demo dataset: one facility, about 20 staff across roles, 500 patients, a price list, a drug list with batches, a lab catalogue and sample encounters.
- CI must run lint, unit, integration and end-to-end tests on every push.

---

## 12. Deliverables

- Working source code in the structure above.
- `README.md` with local setup (single `docker compose up`), environment variables, seeding and demo logins per role.
- `docs/architecture.md` (module diagram, data flow from order → charge → claim, sync design), `docs/api.md` / OpenAPI spec, `docs/data-protection.md`, `docs/onprem-install.md`, `docs/backup-restore.md`.
- Mock servers for SHA, M-Pesa Daraja and SMS, so the whole system runs end to end without external credentials.

**Start now with:** (1) the architecture plan, (2) the full Postgres schema as Knex migrations for Phase 1–2 entities, (3) the permission matrix, then (4) implement Phase 1.

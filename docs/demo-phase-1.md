# Phase 1 demo script

This takes about 15 minutes and shows the foundation: secure sign-in, role-based access, facility setup, staff administration, the audit trail and backups.

**Setup:** run `npm run dev` and open http://localhost:5173. All demo passwords are `Afyazuri#2026`.

## 1. Sign-in and session security (3 min)

1. Sign in as **`doctor`** with a wrong password. The message is _"Incorrect username or password"_, the same wording as for an unknown username.
2. Sign in correctly. The header shows the facility (_Afyazuri Demo County Hospital_), an **Online** indicator and the EN/SW switch. Switch to **SW** to show the Kiswahili shell.
3. Under **Your access here**, the role is _doctor_. The menu shows only Home and My account. A doctor has no staff or audit administration rights.
4. Sign out. Sign in as **`cashier`** and open `/admin/users` directly: _"You do not have access to this page."_ The API refuses it too (403), not just the UI.

## 2. Facility setup (3 min)

1. Sign in as **`facadmin`** and go to **Facility setup**.
2. **Departments:** 12 seeded departments. Add _Dental Unit_ with code `DENT` and type `opd`.
3. **Service points:** Registration, Cashier, Triage, Consultation Rooms, Lab, Radiology, Pharmacy and Exit, each with its own queue, ready for Phase 2.
4. **Wards & beds:** open _Male Medical Ward_ (20 beds) and set one bed to **cleaning**. "Occupied" isn't offered, because only admissions can occupy a bed.

## 3. Staff administration (4 min)

1. Go to **Staff**, search for _mwangi_ and filter by role.
2. **Add staff:** _Wairimu Njoroge_, username `wnjoroge`, licensing body NCK, licence number `NCK-12345`, role **Triage Nurse**, department **Outpatient**. Try the weak password `password12` first to show the policy message, then use a strong one.
3. In a private window, sign in as `wnjoroge`. You are forced to set a new password before anything else.
4. Back as `facadmin`, open Wairimu's record: add a second role, **Force sign-out** (the private window is signed out on its next action), then **Disable** with a reason. She can no longer sign in.
5. Wrong password five times for any test account gives _Account locked_. **Unlock** it from the staff record.

## 4. Multi-facility (1 min)

Sign in as **`locum`**. A facility switcher appears in the header. Switch to _Afyazuri Demo Health Centre_; departments and wards now belong to the health centre. The `facadmin` of the hospital can't see or edit the health centre's records.

## 5. Two-factor authentication (1 min)

As `accountant`, go to **My account → Two-factor authentication → Set up**. Scan the QR code with any authenticator app (Google Authenticator, Microsoft Authenticator, Aegis) and confirm. The next sign-in asks for the 6-digit code.

## 6. Audit trail (2 min)

1. As `facadmin`, open **Audit log**. Everything above is there: sign-ins, failed sign-ins, the lockout, the user creation (with the password shown only as `[redacted]`), role changes and the disable with its reason. **Show** displays field-level changes, for example `full_name: from → to`.
2. Filter by action `login_failed`, then **Export CSV**. The export itself now appears in the log.
3. Point out that the log is append-only _in the database_: even direct SQL `UPDATE`/`DELETE` on `audit_log` is rejected (covered by tests).

## 7. Backups (1 min)

```bash
npm run backup
npm run backup -- verify backups/<the file just written>
```

The file is encrypted, so no names are readable in it. Verify confirms that it is intact. The restore path is tested end to end in `apps/api/test/integration/backup.test.js`.

## What's tested

| Suite            | Command                    | Covers                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (39)        | `npm run test:unit`        | Permission matrix rules, scoping logic, password policy, phone normalisation, field encryption, audit diffs, cursors, config, backup retention                                                                                                                                                                                     |
| Integration (45) | `npm run test:integration` | Real PostgreSQL 16: sign-in, lockout, rate limit, CSRF, refresh rotation and reuse detection, idle timeout, forced password change, TOTP, disable/force-logout, user admin and escalation limits, idempotency, facility setup, facility isolation, audit immutability, export, outbox, signed-note lock, backup → tamper → restore |
| End to end       | `npm run test:e2e`         | Browser flows on desktop and phone, plus sign-in and staff list at 256 kbps / 300 ms                                                                                                                                                                                                                                               |

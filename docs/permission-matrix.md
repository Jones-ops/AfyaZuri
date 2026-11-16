# Permission matrix

> Generated from `packages/shared/src/permissions.js` by `npm run docs:permissions`. Do not edit by hand.

Permissions are granted to roles; roles are assigned to users **per facility**, optionally narrowed to one
department. The API checks the permission on every request (the UI only hides what you cannot use).
Clinical permissions (`emr.*`, `orders.*`) are held only by clinical roles.

## Roles

| Code | Role | Clinical | 2FA expected | Permissions | Purpose |
| --- | --- | :---: | :---: | ---: | --- |
| `super_admin` | Super Admin |  | ✔ | 74 | System administrator for the whole deployment. No clinical access by default. |
| `facility_admin` | Facility Admin |  | ✔ | 29 | Administers one facility: staff, setup, catalogues and price lists. |
| `records_clerk` | Records Clerk |  |  | 8 | Registers patients and checks them in. |
| `triage_nurse` | Triage Nurse | ✔ |  | 10 | Records vitals and routes patients from triage. |
| `doctor` | Clinician / Doctor | ✔ |  | 28 | Consults, diagnoses, orders and prescribes. |
| `clinical_officer` | Clinical Officer | ✔ |  | 28 | Consults, diagnoses, orders and prescribes. |
| `ward_nurse` | Nurse (Ward) | ✔ |  | 17 | Inpatient nursing care, vitals and medication administration. |
| `pharmacist` | Pharmacist | ✔ |  | 14 | Dispenses, manages pharmacy rules and pharmacy stock. |
| `pharmacy_tech` | Pharmacy Tech |  |  | 9 | Dispenses under pharmacist supervision and sells OTC. |
| `lab_technologist` | Lab Technologist | ✔ |  | 10 | Collects and receives samples and enters results. |
| `lab_supervisor` | Lab Supervisor | ✔ |  | 16 | Verifies and releases results; manages the catalogue. |
| `radiographer` | Radiographer | ✔ |  | 6 | Schedules and performs imaging. |
| `radiologist` | Radiologist | ✔ |  | 8 | Reports and releases imaging. |
| `cashier` | Cashier |  |  | 8 | Receives payments and runs a cashier shift. |
| `billing_officer` | Billing Officer |  | ✔ | 13 | Manages bills, invoices, manual charges and approvals. |
| `claims_officer` | Claims Officer |  | ✔ | 12 | Eligibility, preauthorization, claims and remittances. |
| `storekeeper` | Storekeeper |  |  | 11 | Runs the main store: GRNs, issues, purchase orders and stock takes. |
| `accountant` | Accountant |  | ✔ | 11 | Finance oversight: approvals, reconciliation and financial reports. |
| `facility_manager` | Facility Manager |  |  | 5 | Read-only access to the dashboard and reports. |

## Matrix

Column keys: **1** Super Admin · **2** Facility Admin · **3** Records Clerk · **4** Triage Nurse · **5** Clinician / Doctor · **6** Clinical Officer · **7** Nurse (Ward) · **8** Pharmacist · **9** Pharmacy Tech · **10** Lab Technologist · **11** Lab Supervisor · **12** Radiographer · **13** Radiologist · **14** Cashier · **15** Billing Officer · **16** Claims Officer · **17** Storekeeper · **18** Accountant · **19** Facility Manager

### admin

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `facilities.read` — View facilities, departments, wards, beds and service points | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `facilities.manage` — Create and edit facilities, departments, wards, beds and service points | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `users.read` — View staff accounts | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `users.manage` — Create and edit staff accounts and role assignments | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `users.disable` — Disable accounts and force logout | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `roles.read` — View roles and permissions | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `roles.manage` — Edit role permissions | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `audit.read` — View the audit trail | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `audit.export` — Export audit records for investigations | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `settings.manage` — Change facility and system settings | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `dashboard.read` — View the facility dashboard | ● | ● |  | ● | ● | ● | ● | ● |  |  | ● |  | ● |  | ● | ● | ● | ● | ● |

### patients

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `patients.read` — Search and view patient demographics | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  |  |
| `patients.create` — Register patients | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `patients.update` — Edit patient demographics | ● |  | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `patients.merge` — Merge and unmerge duplicate patients | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `patients.restrict` — Mark a record restricted (VIP or sensitive); clinical access then needs break-the-glass | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `patients.export` — Export a full patient record (data subject access request) | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `patients.consent.manage` — Record patient consent | ● |  | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |

### emr

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `emr.read` — View clinical records (notes, vitals, diagnoses, results) |  |  |  | ● | ● | ● | ● | ● |  |  | ● |  | ● |  |  |  |  |  |  |
| `emr.vitals.write` — Record triage vitals |  |  |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.notes.write` — Write clinical notes |  |  |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.notes.sign` — Sign and lock clinical notes |  |  |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.diagnoses.write` — Record diagnoses |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.allergies.write` — Record allergies and problem list |  |  |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.attachments.write` — Attach documents and images |  |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `emr.break_glass` — Emergency access to restricted records (reason required, reviewed) |  |  |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |

### opd

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `opd.checkin` — Check patients in and create encounters | ● |  | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `opd.queue.read` — View queues | ● |  | ● | ● | ● | ● |  | ● | ● | ● | ● | ● |  | ● |  |  |  |  |  |
| `opd.queue.manage` — Call, serve and route queue tickets | ● |  | ● | ● | ● | ● |  | ● | ● | ● | ● | ● |  | ● |  |  |  |  |  |
| `opd.referrals.write` — Create internal and external referrals | ● |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |

### orders

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `orders.lab.create` — Order lab tests |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `orders.imaging.create` — Order imaging |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `orders.prescription.create` — Prescribe medicines |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |

### ipd

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `ipd.read` — View admissions and bed board | ● | ● |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.admit` — Admit patients | ● |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.transfer` — Transfer patients between beds and wards | ● |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.discharge` — Discharge patients | ● |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.nursing.write` — Write nursing notes and ward-round entries | ● |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.mar.write` — Record medication administration | ● |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `ipd.beds.manage` — Change bed status (cleaning, out of service) | ● | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |

### pharmacy

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `pharmacy.read` — View the pharmacy worklist | ● |  |  |  | ● | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |
| `pharmacy.dispense` — Dispense prescriptions | ● |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |
| `pharmacy.otc.sell` — Sell over-the-counter to walk-in customers | ● |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |
| `pharmacy.rules.manage` — Manage dose-range and interaction rules | ● | ● |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |

### lab

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `lab.read` — View the lab worklist | ● |  |  |  | ● | ● |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `lab.samples.collect` — Collect samples and print labels | ● |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `lab.samples.receive` — Receive samples in the lab | ● |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `lab.results.enter` — Enter results | ● |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `lab.results.verify` — Verify and release results | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |
| `lab.catalogue.manage` — Manage the lab test catalogue | ● | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |

### imaging

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `imaging.read` — View the imaging worklist | ● |  |  |  | ● | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |
| `imaging.schedule` — Schedule imaging | ● |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |
| `imaging.perform` — Mark imaging as performed | ● |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |
| `imaging.report` — Write and release imaging reports | ● |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |
| `imaging.catalogue.manage` — Manage the imaging catalogue | ● | ● |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |

### billing

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `billing.read` — View bills and payments | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● | ● |  | ● |  |
| `billing.charge.manual` — Add manual bill lines | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |
| `billing.payment.receive` — Receive payments and issue receipts | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |
| `billing.invoice.create` — Raise insurance invoices | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |
| `billing.refund.request` — Request refunds and credit notes | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |
| `billing.refund.approve` — Approve refunds and credit notes | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |
| `billing.waiver.request` — Request waivers | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |
| `billing.waiver.approve` — Approve waivers | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  | ● |  |
| `billing.shift.manage` — Open and close cashier shifts | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |
| `billing.pricelist.manage` — Manage price lists | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### claims

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `claims.read` — View claims (includes coded diagnoses on the claim) | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  | ● |  |
| `claims.eligibility.check` — Check payer eligibility | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |
| `claims.preauth.request` — Request preauthorization | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |
| `claims.create` — Assemble and correct claims | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |
| `claims.submit` — Submit claims to payers | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |
| `claims.remittance.reconcile` — Import and reconcile remittances | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  | ● |  |
| `claims.payers.manage` — Manage payers, schemes and tariff mappings | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### inventory

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `inventory.read` — View stock | ● | ● |  |  |  |  | ● | ● | ● | ● | ● |  |  |  |  |  | ● | ● |  |
| `inventory.items.manage` — Manage the item master and reorder levels | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |
| `inventory.requisition.create` — Raise requisitions | ● |  |  |  |  |  | ● | ● | ● | ● | ● |  |  |  |  |  | ● |  |  |
| `inventory.requisition.approve` — Approve requisitions | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |
| `inventory.issue` — Issue stock against requisitions | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |
| `inventory.receive` — Receive stock (GRN, requisition receipt) | ● |  |  |  |  |  | ● | ● | ● | ● | ● |  |  |  |  |  | ● |  |  |
| `inventory.po.manage` — Manage suppliers and purchase orders | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |
| `inventory.stocktake.perform` — Perform stock takes | ● |  |  |  |  |  |  | ● |  |  | ● |  |  |  |  |  | ● |  |  |
| `inventory.stocktake.approve` — Approve stock-take adjustments | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |

### reports

| Permission | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `reports.clinical.read` — Clinical and MOH reports (aggregate) | ● | ● |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● |
| `reports.financial.read` — Revenue, cashier, debtor and claims reports | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  | ● | ● |
| `reports.operational.read` — Attendance, stock and consumption reports | ● | ● |  |  |  |  |  | ● |  |  | ● |  |  |  |  |  | ● | ● | ● |
| `reports.export` — Export reports to CSV/Excel/PDF | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● | ● | ● | ● |

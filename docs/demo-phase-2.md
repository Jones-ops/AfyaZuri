# Phase 2 demo script: patients, OPD and EMR

This takes about 20 minutes and follows one patient from the front desk to the doctor and out. It also shows duplicate protection, restricted records and the audit trail.

**Setup:** run `npm run dev` and open http://localhost:5173. All demo passwords are `Afyazuri#2026`. The demo hospital has 500 fictitious patients, 60 past visits, and a few patients already waiting in today's queues.

## 1. Find or register a patient (Records clerk, 5 min)

1. Sign in as **`records`**. Press **`/`** anywhere to jump to patient search.
2. Search the way the desk does:
   - a name, e.g. `akinyi`, or part of two names, `wanj kam`;
   - a misspelling, `otieno onyngo`, which gives _"showing similar names"_;
   - a phone number in any format, e.g. `0712 345 678` or `254712345678`;
   - a national ID or SHA number. Matches are labelled with how they were found, and phones are masked in the list.
3. **Register patient:**
   - Enter a name, sex and date of birth, or switch to **Estimate age** for someone who doesn't know their birthday.
   - Add a national ID, phone and county → sub-county → ward, choose **Social Health Authority — SHIF** with a member number, and tick consent.
   - On submit an MRN such as `99001-2026-000501` is assigned. Open **Print patient card**: the QR code contains only the MRN.
4. **Duplicate protection:** register the same name and date of birth again. You're shown the existing record with the reasons ("Same name", "Same date of birth"). **Create new anyway** stays disabled until you give a reason.
5. **Check in:** on the record, under **Visit**, choose _Bill to: SHA_, then **Check in**. The ticket reads _"T-00x · please go to Triage"_. A cash patient goes to the **Cashier** first; this is configurable under Facility setup → OPD routes.

## 2. Triage (Triage nurse, 3 min)

1. Sign in as **`triage`** and open **Queues → Triage**.
   - Emergencies sit at the top, then the longest waiting.
   - Open **TV display** in a new tab: it shows ticket numbers only, never names.
2. **Call next** or **Start** on your patient, then **Open visit**.
3. Enter BP **184/104**, weight and height. **BMI** and the red **"Systolic BP ≥ 180: hypertensive urgency"** flag appear as you type. **Save vitals**.
4. Back on the board, **Send to: Consultation**.

## 3. Consultation (Doctor, 5 min)

1. Sign in as **`doctor`** → **Queues → Consultation Room** → **Start** → **Open visit**.
2. Pick the **General outpatient consultation** template; each SOAP box shows prompts. Write the note and **Save and sign**. The note is now locked and shows your KMPDC licence number.
3. **Add addendum** to show how a signed note is corrected without being edited.
4. **Diagnoses:** type `hypertension` and pick **BA00 Essential hypertension**; the ICD-10 mapping I10 is shown.
5. **Send to: Laboratory**. The lab technologist (**`labtech`**) runs the Laboratory queue, and **Send to: Back to referring room** returns the patient to the same consultation room. The final **Exit** ends the visit.
6. **Full chart:** allergies, problem list and a timeline across every visit. Add an allergy (e.g. _Penicillin, severe_); it appears at once in the red banner on every clinical screen.

## 4. Privacy controls (Facility admin, 4 min)

1. Sign in as **`cashier`** and open the same patient. Demographics are visible, but the clinical chart isn't: there's no menu entry, and the API refuses it.
2. As **`facadmin`**, open the patient → **Restricted record** → give a reason → **Restrict record**.
3. As **`doctor`**, the banner now says clinical details are restricted. **Request emergency access**, give a clinical reason, and the record opens for 4 hours.
4. As **`facadmin`**, open **Emergency access** (the review queue) and mark the access _Justified_.
5. Open **Audit log**:
   - Each record you opened appears as a `view`, and clinical reads appear as `clinical_record`.
   - The break-glass event includes its reason.
   - The registration entry has the phone shown as `[redacted]`, and the update entry lists which sensitive fields changed.
6. **Merge:** on a record, **Merge a duplicate into this record** → search → choose → give a reason. The duplicate's visits and notes move to the survivor, and opening the duplicate redirects there. **Unmerge** from the merge history puts everything back.

## What's tested

| Suite                            |                  Count | Covers                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                             |                     76 | Vitals rules (adult, WHO IMCI, MUAC), BMI, MRN format, search classification, duplicate scoring, masking, ages, ticket transitions, ICD import parser, schemas                                                                                                                                                                         |
| Integration (real PostgreSQL 16) |                     92 | Registration and encryption, duplicates, concurrent MRNs, search (exact, partial, typo, Unicode names), merge/unmerge including signed notes, restricted records and break-the-glass, OPD routing and detours, department-scoped queues, vitals/notes/diagnoses/allergies/timeline, access denial for non-clinical roles, demo dataset |
| End to end                       |                      9 | Front desk registration and card, OPD check-in to consultation, triage-to-doctor documentation, plus the Phase 1 flows                                                                                                                                                                                                                 |
| Benchmark                        | `npm run bench:search` | 500 000 patients, every search type under 300 ms p95 (see [performance.md](performance.md))                                                                                                                                                                                                                                            |

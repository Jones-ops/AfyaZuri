// Demo patients and visits for the demo hospital (KMHFL 99001). Never runs in production.
//
// 500 fictitious patients with realistic Kenyan names, ages, phones and identifiers
// (encrypted exactly as the API would), 60 past visits with vitals, signed notes and
// ICD-11 diagnoses, and a handful of open visits waiting in today's queues.
// The generator is seeded, so every installation gets the same data.
// Needs ENCRYPTION_KEY and BLIND_INDEX_KEY (from .env) — the same keys the API uses.
import { FieldCrypto } from '../../apps/api/src/lib/crypto.js';
import { bmi, evaluateVitals } from '../../packages/shared/src/vitals.js';

const COUNT = 500;

const FEMALE = [
  'Akinyi',
  'Atieno',
  'Achieng',
  'Adhiambo',
  'Awino',
  'Wanjiru',
  'Wambui',
  'Njeri',
  'Nyambura',
  'Wairimu',
  'Muthoni',
  'Chebet',
  'Jepkosgei',
  'Jeptoo',
  'Chepkemoi',
  'Mwende',
  'Mutheu',
  'Nduku',
  'Kerubo',
  'Moraa',
  'Nyaboke',
  'Halima',
  'Amina',
  'Fatuma',
  'Zawadi',
  'Neema',
  'Faith',
  'Grace',
  'Mercy',
  'Esther',
  'Mary',
  'Ruth',
  'Lucy',
  'Joyce',
  'Sharon',
  'Brenda',
  'Diana',
  'Wambũi',
  'Njĩrũ',
];
const MALE = [
  'Otieno',
  'Ochieng',
  'Odhiambo',
  'Omondi',
  'Onyango',
  'Kamau',
  'Mwangi',
  'Njoroge',
  'Kariuki',
  'Kimani',
  'Kiprop',
  'Kipchumba',
  'Cheruiyot',
  'Mutua',
  'Musyoka',
  'Kioko',
  'Ouma',
  'Wekesa',
  'Wafula',
  'Barasa',
  'Juma',
  'Hassan',
  'Ali',
  'Omar',
  'Brian',
  'Kevin',
  'Dennis',
  'Collins',
  'John',
  'Peter',
  'James',
  'Joseph',
  'Daniel',
  'Samuel',
  'David',
  'Paul',
];
const SURNAMES = [
  'Odhiambo',
  'Otieno',
  'Ochieng',
  'Onyango',
  'Owino',
  'Okoth',
  'Oduor',
  'Ouma',
  'Opiyo',
  'Okello',
  'Kamau',
  'Mwangi',
  'Njoroge',
  'Kariuki',
  'Kimani',
  'Gitau',
  'Kiprotich',
  'Kiptoo',
  'Rotich',
  'Koech',
  'Mutua',
  'Musyoka',
  'Kioko',
  'Wafula',
  'Wekesa',
  'Barasa',
  'Simiyu',
  'Nyamweya',
  'Ondieki',
  'Mohamed',
  'Abdi',
  'Hassan',
  'Achieng',
  'Anyango',
  'Wanyama',
];

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') return;
  const facility = await knex('facilities').where({ kmhfl_code: '99001' }).first();
  if (!facility) return;
  const { n } = await knex('patients').where({ facility_id: facility.id }).count({ n: '*' }).first();
  if (Number(n) >= COUNT) return; // already seeded

  if (!process.env.ENCRYPTION_KEY || !process.env.BLIND_INDEX_KEY) {
    console.warn('Skipping demo patients: ENCRYPTION_KEY and BLIND_INDEX_KEY are not set (run `npm run secrets`).');
    return;
  }
  const crypto = new FieldCrypto({
    encryptionKey: process.env.ENCRYPTION_KEY,
    blindIndexKey: process.env.BLIND_INDEX_KEY,
  });
  const r = rng(20260117);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const year = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric' }).format(new Date()),
  );
  const today = new Date();

  const sha = await knex('schemes').where({ code: 'SHIF' }).first('id');
  const subCounties = await knex('sub_counties').where({ county_code: '042' }).select('id');
  const wards = await knex('admin_wards')
    .whereIn(
      'sub_county_id',
      subCounties.map((s) => s.id),
    )
    .select('id', 'sub_county_id');
  const users = Object.fromEntries(
    (
      await knex('users').whereIn('username', ['records', 'triage', 'doctor', 'clinofficer']).select('id', 'username')
    ).map((u) => [u.username, u.id]),
  );
  const { last_value: lastSeq = 0 } =
    (await knex('mrn_sequences').where({ facility_id: facility.id, year }).first()) ?? {};

  // ---- Patients --------------------------------------------------------------
  const patients = [];
  const identifiers = [];
  const schemes = [];
  for (let i = 0; i < COUNT; i++) {
    const sex = r() < 0.53 ? 'female' : 'male';
    const band = r();
    const ageYears = band < 0.15 ? int(0, 4) : band < 0.3 ? int(5, 17) : band < 0.85 ? int(18, 59) : int(60, 88);
    const dob = new Date(Date.UTC(today.getUTCFullYear() - ageYears, int(0, 11), int(1, 28)));
    if (dob > today) dob.setUTCFullYear(dob.getUTCFullYear() - 1);
    const estimated = ageYears >= 60 && r() < 0.4;
    const phone = r() < (ageYears < 18 ? 0.3 : 0.85) ? `+2547${String(int(0, 99999999)).padStart(8, '0')}` : null;
    const ward = r() < 0.8 ? pick(wards) : null;
    const seq = lastSeq + i + 1;
    patients.push({
      facility_id: facility.id,
      mrn: `${facility.kmhfl_code}-${year}-${String(seq).padStart(6, '0')}`,
      first_name: pick(sex === 'female' ? FEMALE : MALE),
      middle_name: r() < 0.6 ? pick(sex === 'female' ? FEMALE : MALE) : null,
      last_name: pick(SURNAMES),
      sex,
      date_of_birth: dob.toISOString().slice(0, 10),
      dob_estimated: estimated,
      phone_enc: crypto.encrypt(phone),
      phone_hash: phone ? crypto.blindIndex('phone', phone) : null,
      county_code: '042',
      sub_county_id: ward?.sub_county_id ?? null,
      admin_ward_id: ward?.id ?? null,
      created_by: users.records,
      updated_by: users.records,
      _adult: ageYears >= 18,
      _child: ageYears < 18,
      _sha: r() < 0.45,
    });
  }
  // Insert in batches and read back ids in order.
  const inserted = [];
  for (let i = 0; i < patients.length; i += 100) {
    const batch = patients.slice(i, i + 100).map(({ _adult, _child, _sha, ...p }) => p);
    inserted.push(
      ...(await knex('patients').insert(batch).returning(['id', 'mrn', 'date_of_birth', 'first_name', 'last_name'])),
    );
  }
  await knex('mrn_sequences')
    .insert({ facility_id: facility.id, year, last_value: lastSeq + COUNT })
    .onConflict(['facility_id', 'year'])
    .merge();

  inserted.forEach((p, i) => {
    const meta = patients[i];
    const add = (type, value) =>
      identifiers.push({
        facility_id: facility.id,
        patient_id: p.id,
        type,
        value_enc: crypto.encrypt(value),
        value_hash: crypto.blindIndex('id', value),
        value_last4: value.slice(-4),
      });
    if (meta._adult) add('national_id', String(20000000 + i * 7919).slice(0, 8));
    if (meta._child && r() < 0.7) add('birth_certificate', `BC${String(1000000 + i * 37).slice(0, 7)}`);
    if (meta._sha) {
      const number = `SHA${String(700000000 + i * 104729).slice(0, 9)}`;
      add('sha_number', number);
      if (sha)
        schemes.push({
          facility_id: facility.id,
          patient_id: p.id,
          scheme_id: sha.id,
          member_number: number,
          is_primary: true,
        });
    }
  });
  for (let i = 0; i < identifiers.length; i += 200)
    await knex('patient_identifiers').insert(identifiers.slice(i, i + 200));
  if (schemes.length) await knex('patient_payer_schemes').insert(schemes);
  await knex('patient_consents').insert(
    inserted.map((p) => ({
      facility_id: facility.id,
      patient_id: p.id,
      consent_type: 'data_processing',
      granted: true,
      consent_version: '2026-01',
      method: 'verbal',
      captured_by: users.records,
    })),
  );

  // A few known allergies.
  await knex('allergies').insert(
    inserted
      .filter((_, i) => i % 23 === 0)
      .map((p, k) => ({
        facility_id: facility.id,
        patient_id: p.id,
        category: 'drug',
        allergen: ['Penicillin', 'Sulfonamides (co-trimoxazole)', 'Aspirin'][k % 3],
        severity: ['severe', 'moderate', 'mild'][k % 3],
        reaction: ['Rash and swelling', 'Rash', 'Stomach upset'][k % 3],
        created_by: users.doctor,
        updated_by: users.doctor,
      })),
  );

  // ---- Past visits --------------------------------------------------------------
  const CASES = [
    {
      dx: '1F40',
      s: 'Fever, headache and joint pains for 3 days',
      a: 'Uncomplicated falciparum malaria (mRDT positive)',
      p: 'Artemether-lumefantrine 6-dose course; paracetamol; review if not better in 48 hours',
      v: { temperatureC: 38.6, pulse: 104 },
    },
    {
      dx: 'CA00',
      s: 'Runny nose, sore throat and mild cough for 2 days',
      a: 'Common cold',
      p: 'Supportive care, fluids, paracetamol',
      v: { temperatureC: 37.4, pulse: 84 },
    },
    {
      dx: 'CA02',
      s: 'Painful swallowing and fever',
      a: 'Acute pharyngitis',
      p: 'Amoxicillin 5 days; analgesia',
      v: { temperatureC: 38.1, pulse: 96 },
    },
    {
      dx: 'BA00',
      s: 'Review clinic; occasional headaches',
      a: 'Essential hypertension, poorly controlled',
      p: 'Continue amlodipine, add hydrochlorothiazide; salt reduction; review 4 weeks',
      v: { systolic: 158, diastolic: 98, pulse: 80 },
    },
    {
      dx: '5A11',
      s: 'Polyuria and thirst; known diabetic on metformin',
      a: 'Type 2 diabetes mellitus',
      p: 'Continue metformin; HbA1c; diet counselling; review 4 weeks',
      v: { systolic: 132, diastolic: 84, pulse: 78 },
    },
    {
      dx: 'GC08',
      s: 'Burning on passing urine for 3 days',
      a: 'Urinary tract infection',
      p: 'Nitrofurantoin 5 days; urinalysis; fluids',
      v: { temperatureC: 37.6, pulse: 88 },
    },
    {
      dx: 'CA40',
      s: 'Cough and difficulty breathing for 4 days',
      a: 'Community-acquired pneumonia',
      p: 'Amoxicillin; review in 48 hours; return if worse',
      v: { temperatureC: 38.9, pulse: 110, respRate: 26, spo2: 93 },
    },
    {
      dx: '1A07',
      s: 'Fever for a week with abdominal pain',
      a: 'Suspected typhoid fever',
      p: 'Blood culture; ciprofloxacin; hydration',
      v: { temperatureC: 38.8, pulse: 98 },
    },
  ];
  const visitPatients = inserted.filter((_, i) => i % 8 === 1).slice(0, 60);
  for (const [k, p] of visitPatients.entries()) {
    const c = CASES[k % CASES.length];
    const started = new Date(today.getTime() - int(2, 90) * 86_400_000 - int(0, 8) * 3_600_000);
    const ended = new Date(started.getTime() + int(40, 180) * 60_000);
    const [enc] = await knex('encounters')
      .insert({
        facility_id: facility.id,
        patient_id: p.id,
        type: 'opd',
        status: 'closed',
        started_at: started,
        ended_at: ended,
        billing_mode: schemes.some((s) => s.patient_id === p.id) ? 'bill_at_exit' : 'pay_first',
        route_payer_type: schemes.some((s) => s.patient_id === p.id) ? 'sha' : 'cash',
        attending_user_id: users.doctor,
        created_by: users.records,
        updated_by: users.records,
      })
      .returning(['id']);
    const ageMonths = Math.max(0, Math.round((today - new Date(p.date_of_birth)) / (30.44 * 86_400_000)));
    const vit = {
      weightKg: ageMonths < 60 ? 12 : int(50, 90),
      heightCm: ageMonths < 60 ? 88 : int(150, 182),
      respRate: 18,
      spo2: 98,
      ...c.v,
    };
    if (ageMonths < 144) (delete vit.systolic, delete vit.diastolic);
    await knex('triage_vitals').insert({
      facility_id: facility.id,
      encounter_id: enc.id,
      patient_id: p.id,
      recorded_by: users.triage,
      recorded_at: new Date(started.getTime() + 10 * 60_000),
      systolic: vit.systolic ?? null,
      diastolic: vit.diastolic ?? null,
      pulse: vit.pulse ?? null,
      temperature_c: vit.temperatureC ?? null,
      resp_rate: vit.respRate,
      spo2: vit.spo2,
      weight_kg: vit.weightKg,
      height_cm: vit.heightCm,
      bmi: ageMonths >= 144 ? bmi(vit.weightKg, vit.heightCm) : null,
      flags: JSON.stringify(evaluateVitals(vit, { ageMonths })),
    });
    const author = k % 3 === 0 ? users.clinofficer : users.doctor;
    const signedAt = new Date(started.getTime() + 35 * 60_000);
    await knex('clinical_notes').insert({
      facility_id: facility.id,
      encounter_id: enc.id,
      patient_id: p.id,
      note_type: 'soap',
      template_code: 'opd_general',
      subjective: c.s,
      objective: 'Alert, not in distress. Findings as per vitals.',
      assessment: c.a,
      plan: c.p,
      status: 'signed',
      author_id: author,
      signed_by: author,
      signed_at: signedAt,
      created_at: signedAt,
      created_by: author,
      updated_by: author,
    });
    await knex('diagnoses').insert({
      facility_id: facility.id,
      encounter_id: enc.id,
      patient_id: p.id,
      icd_system: 'icd11',
      icd_code: c.dx,
      description: (await knex('icd_codes').where({ system: 'icd11', code: c.dx }).first('title')).title,
      certainty: 'confirmed',
      rank: 'primary',
      recorded_by: author,
      created_at: signedAt,
      created_by: author,
      updated_by: author,
    });
    if (c.dx === 'BA00' || c.dx === '5A11')
      await knex('problem_list').insert({
        facility_id: facility.id,
        patient_id: p.id,
        icd_code: c.dx,
        description: c.dx === 'BA00' ? 'Hypertension' : 'Type 2 diabetes',
        created_by: author,
        updated_by: author,
      });
  }

  // ---- Today's queues ---------------------------------------------------------
  const queues = Object.fromEntries(
    (
      await knex('queues as q')
        .join('service_points as sp', 'sp.id', 'q.service_point_id')
        .where('q.facility_id', facility.id)
        .select('q.id', 'q.ticket_prefix', 'sp.name', 'sp.type', 'sp.department_id')
    ).map((q) => [q.name, q]),
  );
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(today);
  const waiting = [
    ['Triage', 2, 'sha'],
    ['Triage', 2, 'sha'],
    ['Triage', 2, 'cash'],
    ['Consultation Room 1', 3, 'sha'],
    ['Consultation Room 2', 3, 'cash'],
    ['Cashier', 1, 'cash'],
    ['Cashier', 1, 'cash'],
    ['Laboratory', 3, 'sha'],
  ];
  const numbers = {};
  const openPatients = inserted.filter((_, i) => i % 8 === 5).slice(0, waiting.length);
  for (const [k, [queueName, step, payerType]] of waiting.entries()) {
    const q = queues[queueName];
    const p = openPatients[k];
    if (!q || !p) continue;
    const started = new Date(today.getTime() - int(10, 70) * 60_000);
    const [enc] = await knex('encounters')
      .insert({
        facility_id: facility.id,
        patient_id: p.id,
        type: k === 0 ? 'emergency' : 'opd',
        status: 'open',
        started_at: started,
        department_id: q.department_id,
        billing_mode: payerType === 'sha' ? 'bill_at_exit' : 'pay_first',
        route_payer_type: payerType,
        priority: k === 0 ? 2 : 0,
        created_by: users.records,
        updated_by: users.records,
      })
      .returning(['id']);
    const max =
      (await knex('queue_tickets').where({ queue_id: q.id, ticket_date: todayYmd }).max({ m: 'ticket_number' }).first())
        .m ?? 0;
    numbers[q.id] = Math.max(numbers[q.id] ?? 0, max) + 1;
    await knex('queue_tickets').insert({
      facility_id: facility.id,
      queue_id: q.id,
      encounter_id: enc.id,
      patient_id: p.id,
      ticket_date: todayYmd,
      ticket_number: numbers[q.id],
      priority: k === 0 ? 2 : 0,
      status: 'waiting',
      enqueued_at: started,
      route_step: step,
      created_by: users.records,
      updated_by: users.records,
    });
  }
}

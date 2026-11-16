// Demo facilities and one staff account per role. Never runs in production.
// The KMHFL codes 99001/99002 are fictitious placeholders, not real facilities.
import argon2 from 'argon2';

export const DEMO_PASSWORD = 'Afyazuri#2026';

const DEPARTMENTS = [
  ['Administration', 'ADMIN', 'administration'],
  ['Health Records', 'REC', 'records'],
  ['Outpatient', 'OPD', 'opd'],
  ['Emergency', 'EMER', 'emergency'],
  ['Inpatient', 'IPD', 'ipd'],
  ['Maternity', 'MAT', 'maternity'],
  ['Pharmacy', 'PHARM', 'pharmacy'],
  ['Laboratory', 'LAB', 'laboratory'],
  ['Radiology', 'RAD', 'imaging'],
  ['Billing & Revenue', 'BILL', 'billing'],
  ['Claims', 'CLAIMS', 'claims'],
  ['Stores', 'STORES', 'stores'],
];

const SERVICE_POINTS = [
  ['Registration', 'REC', 'registration', 'R'],
  ['Cashier', 'BILL', 'cashier', 'C'],
  ['Triage', 'OPD', 'triage', 'T'],
  ['Consultation Room 1', 'OPD', 'consultation', 'A'],
  ['Consultation Room 2', 'OPD', 'consultation', 'B'],
  ['Laboratory', 'LAB', 'laboratory', 'L'],
  ['Radiology', 'RAD', 'imaging', 'X'],
  ['Pharmacy', 'PHARM', 'pharmacy', 'P'],
  ['Exit', 'OPD', 'exit', 'E'],
];

const WARDS = [
  ['Male Medical Ward', 'MMW', 'IPD', 'male', 20],
  ['Female Medical Ward', 'FMW', 'IPD', 'female', 20],
  ['Paediatric Ward', 'PAED', 'IPD', 'mixed', 12],
  ['Maternity Ward', 'MATW', 'MAT', 'female', 15],
];

// [username, full name, role, department code | null, licence body, licence no., cadre]
const STAFF = [
  ['admin', 'System Administrator', 'super_admin', null, null, null, 'ICT'],
  ['facadmin', 'Grace Achieng', 'facility_admin', null, null, null, 'Hospital Administrator'],
  ['records', 'Peter Otieno', 'records_clerk', 'REC', null, null, 'Health Records Officer'],
  ['triage', 'Mary Wanjiru', 'triage_nurse', 'OPD', 'NCK', 'NCK-DEMO-1001', 'Registered Nurse'],
  ['doctor', 'Dr. James Mwangi', 'doctor', null, 'KMPDC', 'KMPDC-DEMO-2001', 'Medical Officer'],
  ['clinofficer', 'Faith Chebet', 'clinical_officer', 'OPD', 'COC', 'COC-DEMO-3001', 'Clinical Officer'],
  ['wardnurse', 'Esther Njeri', 'ward_nurse', 'IPD', 'NCK', 'NCK-DEMO-1002', 'Registered Nurse'],
  ['pharmacist', 'Daniel Kiprop', 'pharmacist', 'PHARM', 'PPB', 'PPB-DEMO-4001', 'Pharmacist'],
  ['pharmtech', 'Lucy Akinyi', 'pharmacy_tech', 'PHARM', 'PPB', 'PPB-DEMO-4002', 'Pharmaceutical Technologist'],
  ['labtech', 'Brian Omondi', 'lab_technologist', 'LAB', 'KMLTTB', 'KMLTTB-DEMO-5001', 'Medical Lab Technologist'],
  ['labsup', 'Agnes Mutua', 'lab_supervisor', 'LAB', 'KMLTTB', 'KMLTTB-DEMO-5002', 'Lab Supervisor'],
  ['radiographer', 'Kevin Mutiso', 'radiographer', 'RAD', 'OTHER', 'SRK-DEMO-6001', 'Radiographer'],
  ['radiologist', 'Dr. Amina Hassan', 'radiologist', 'RAD', 'KMPDC', 'KMPDC-DEMO-2002', 'Radiologist'],
  ['cashier', 'John Kamau', 'cashier', 'BILL', null, null, 'Cashier'],
  ['billing', 'Ruth Wambui', 'billing_officer', 'BILL', null, null, 'Billing Officer'],
  ['claims', 'Samuel Ouma', 'claims_officer', 'CLAIMS', null, null, 'Claims Officer'],
  ['storekeeper', 'Joseph Kiplagat', 'storekeeper', 'STORES', null, null, 'Storekeeper'],
  ['accountant', 'Nancy Moraa', 'accountant', null, null, null, 'Accountant'],
  ['manager', 'Dr. Paul Odhiambo', 'facility_manager', null, null, null, 'Medical Superintendent'],
];

/**
 * @param {import('knex').Knex} knex
 * @param {{name: string, kmhfl_code: string, level: string, ownership: string, county_code: string, sub_county: string}} f
 */
async function setupFacility(knex, f) {
  const [facility] = await knex('facilities').insert(f).returning('*');
  const depts = await knex('departments')
    .insert(DEPARTMENTS.map(([name, code, type]) => ({ facility_id: facility.id, name, code, type })))
    .returning(['id', 'code']);
  const dept = Object.fromEntries(depts.map((d) => [d.code, d.id]));

  for (const [name, d, type, prefix] of SERVICE_POINTS) {
    const [sp] = await knex('service_points')
      .insert({ facility_id: facility.id, department_id: dept[d], name, type })
      .returning('id');
    await knex('queues').insert({ facility_id: facility.id, service_point_id: sp.id, name, ticket_prefix: prefix });
  }
  for (const [name, code, d, gender, beds] of WARDS) {
    const [w] = await knex('wards')
      .insert({ facility_id: facility.id, department_id: dept[d], name, code, gender })
      .returning('id');
    await knex('beds').insert(
      Array.from({ length: beds }, (_, i) => ({
        facility_id: facility.id,
        ward_id: w.id,
        label: `${code}-${String(i + 1).padStart(2, '0')}`,
      })),
    );
  }
  const route = (payerType, steps) =>
    steps.map((t, i) => ({
      facility_id: facility.id,
      payer_type: payerType,
      step_order: i + 1,
      service_point_type: t,
    }));
  await knex('opd_routes').insert([
    ...route('cash', ['registration', 'cashier', 'triage', 'consultation', 'exit']),
    ...route(null, ['registration', 'triage', 'consultation', 'exit']),
  ]);
  return { facility, dept };
}

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production') return;
  if (await knex('facilities').where({ kmhfl_code: '99001' }).first('id')) return; // already seeded

  const main = await setupFacility(knex, {
    name: 'Afyazuri Demo County Hospital',
    kmhfl_code: '99001',
    level: 'level_4',
    ownership: 'county',
    county_code: '042',
    sub_county: 'Kisumu Central',
  });
  const hc = await setupFacility(knex, {
    name: 'Afyazuri Demo Health Centre',
    kmhfl_code: '99002',
    level: 'level_3',
    ownership: 'county',
    county_code: '042',
    sub_county: 'Kisumu East',
  });

  const [cash] = await knex('payers').insert({ code: 'CASH', name: 'Cash / Self-pay', type: 'cash' }).returning('id');
  const [sha] = await knex('payers')
    .insert({ code: 'SHA', name: 'Social Health Authority', type: 'sha' })
    .returning('id');
  const [ins] = await knex('payers')
    .insert({ code: 'DEMO-INS', name: 'Demo Private Insurer', type: 'private_insurer' })
    .returning('id');
  await knex('schemes').insert([
    { payer_id: cash.id, code: 'CASH', name: 'Cash', billing_mode: 'pay_first' },
    { payer_id: sha.id, code: 'PHC', name: 'Primary Healthcare Fund', billing_mode: 'bill_at_exit' },
    {
      payer_id: sha.id,
      code: 'SHIF',
      name: 'Social Health Insurance Fund',
      billing_mode: 'bill_at_exit',
      requires_preauth: true,
    },
    {
      payer_id: sha.id,
      code: 'ECCIF',
      name: 'Emergency, Chronic & Critical Illness Fund',
      billing_mode: 'bill_at_exit',
      requires_preauth: true,
    },
    {
      payer_id: ins.id,
      code: 'DEMO-GOLD',
      name: 'Demo Gold Cover',
      billing_mode: 'bill_at_exit',
      requires_preauth: true,
    },
  ]);

  const password_hash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const roles = Object.fromEntries((await knex('roles').select('id', 'code')).map((r) => [r.code, r.id]));

  for (const [username, full_name, role, d, licence_body, licence_number, cadre] of STAFF) {
    const global = role === 'super_admin';
    const [u] = await knex('users')
      .insert({
        username,
        full_name,
        password_hash,
        must_change_password: false,
        licence_body,
        licence_number,
        cadre,
        default_facility_id: main.facility.id,
        email: `${username}@demo.afyazuri.local`,
      })
      .returning('id');
    await knex('user_roles').insert({
      user_id: u.id,
      role_id: roles[role],
      facility_id: global ? null : main.facility.id,
      department_id: d ? main.dept[d] : null,
    });
  }

  // A clinician who works at both facilities, to demonstrate facility switching.
  const [locum] = await knex('users')
    .insert({
      username: 'locum',
      full_name: 'Dr. Halima Abdi',
      password_hash,
      must_change_password: false,
      licence_body: 'KMPDC',
      licence_number: 'KMPDC-DEMO-2003',
      cadre: 'Medical Officer',
      default_facility_id: main.facility.id,
      email: 'locum@demo.afyazuri.local',
    })
    .returning('id');
  await knex('user_roles').insert([
    { user_id: locum.id, role_id: roles.doctor, facility_id: main.facility.id },
    { user_id: locum.id, role_id: roles.doctor, facility_id: hc.facility.id },
  ]);
}

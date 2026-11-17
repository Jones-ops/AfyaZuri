// Demo charge catalogue and price lists for both demo facilities, and bills for the demo
// visits already waiting in today's queues. Prices are illustrative, not real tariffs.
// Never runs in production. Idempotent per facility.

const ITEMS = [
  // code, name, category, department code, unit, cash price
  ['REG-NEW', 'Registration (new patient)', 'registration', 'REC', 'visit', '200.00'],
  ['CONS-OPD', 'Outpatient consultation', 'consultation', 'OPD', 'visit', '500.00'],
  ['CONS-EMER', 'Emergency consultation', 'consultation', 'EMER', 'visit', '1000.00'],
  ['CONS-SPEC', 'Specialist consultation', 'consultation', 'OPD', 'visit', '1500.00'],
  ['PROC-DRESS', 'Wound dressing', 'procedure', 'OPD', 'procedure', '300.00'],
  ['PROC-SUTURE', 'Suturing (minor)', 'procedure', 'OPD', 'procedure', '800.00'],
  ['PROC-NEB', 'Nebulisation', 'procedure', 'OPD', 'session', '400.00'],
  ['MISC', 'Miscellaneous charge', 'other', null, 'each', null],
];

// scheme code → [item code, unit price | null (= cash price), cover type, cover value]
const SCHEME_LISTS = {
  PHC: [
    ['REG-NEW', null, 'full', '0'],
    ['CONS-OPD', null, 'full', '0'],
  ],
  SHIF: [
    ['CONS-OPD', '500.00', 'fixed', '400.00'],
    ['CONS-EMER', '1000.00', 'full', '0'],
    ['PROC-DRESS', null, 'percent', '80'],
    ['PROC-SUTURE', null, 'percent', '80'],
    ['PROC-NEB', null, 'percent', '80'],
  ],
  'DEMO-GOLD': [
    ['CONS-OPD', '600.00', 'percent', '90'],
    ['CONS-SPEC', '1800.00', 'percent', '90'],
  ],
};

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') return;
  for (const kmhfl of ['99001', '99002']) {
    const facility = await knex('facilities').where({ kmhfl_code: kmhfl }).first('id');
    if (!facility || (await knex('charge_items').where({ facility_id: facility.id }).first('id'))) continue;
    const depts = Object.fromEntries(
      (await knex('departments').where({ facility_id: facility.id }).select('id', 'code')).map((d) => [d.code, d.id]),
    );

    const items = {};
    for (const [code, name, category, dept, unit] of ITEMS) {
      const [row] = await knex('charge_items')
        .insert({
          facility_id: facility.id,
          code,
          name,
          category,
          department_id: dept ? depts[dept] : null,
          unit,
        })
        .returning('id');
      items[code] = row.id;
    }
    const [cash] = await knex('price_lists')
      .insert({ facility_id: facility.id, code: 'CASH', name: 'Cash prices', is_default: true })
      .returning('id');
    const cashPrice = {};
    for (const [code, , , , , price] of ITEMS) {
      if (!price) continue;
      cashPrice[code] = price;
      await knex('price_list_items').insert({
        facility_id: facility.id,
        price_list_id: cash.id,
        charge_item_id: items[code],
        unit_price: price,
      });
    }
    for (const [schemeCode, rows] of Object.entries(SCHEME_LISTS)) {
      const scheme = await knex('schemes').where({ code: schemeCode }).first('id', 'name');
      if (!scheme) continue;
      const [pl] = await knex('price_lists')
        .insert({
          facility_id: facility.id,
          code: schemeCode,
          name: `${scheme.name} tariff`,
          scheme_id: scheme.id,
        })
        .returning('id');
      await knex('price_list_items').insert(
        rows.map(([code, price, coverType, coverValue]) => ({
          facility_id: facility.id,
          price_list_id: pl.id,
          charge_item_id: items[code],
          unit_price: price ?? cashPrice[code],
          cover_type: coverType,
          cover_value: coverValue,
        })),
      );
    }
  }

  // Bills for demo visits that are already open (they were seeded directly, not checked in).
  const { onEncounterOpened } = await import('../../apps/api/src/modules/billing/service.js');
  const system = await knex('users').where({ username: 'records' }).first('id', 'username');
  if (!system) return;
  const open = await knex('encounters as e')
    .leftJoin('bills as b', 'b.encounter_id', 'e.id')
    .where('e.status', 'open')
    .whereNull('b.id')
    .select('e.*');
  for (const enc of open) {
    // Link SHA patients' visits to their scheme so cover applies.
    if (!enc.patient_payer_scheme_id && enc.route_payer_type === 'sha') {
      const link = await knex('patient_payer_schemes').where({ patient_id: enc.patient_id, active: true }).first('id');
      if (link) {
        await knex('encounters').where({ id: enc.id }).update({ patient_payer_scheme_id: link.id });
        enc.patient_payer_scheme_id = link.id;
      }
    }
    await knex.transaction((trx) =>
      onEncounterOpened(
        trx,
        { userId: system.id, username: system.username, roles: [], facilityId: enc.facility_id },
        enc,
      ),
    );
  }
}

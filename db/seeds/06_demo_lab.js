// Demo laboratory catalogue for both demo facilities: common tests with components, reference
// ranges (by sex and age where it matters) and critical limits, priced on the cash list. SHA covers
// the primary-care tests in full. Ranges are typical adult values for demonstration; each lab must
// set its own validated ranges. Never runs in production. Idempotent per facility.

const POS = ['Negative', 'Positive'];
const GRADE = ['Negative', 'Trace', '+', '++', '+++'];
const Y = 365;

// code, name, section, specimen, container, TAT minutes, cash price, SHA covers, components
// component: [code, name, type, unit, decimals, options | null, abnormal | null, ranges]
// range: [sex | null, ageMinDays, ageMaxDays | null, low, high, criticalLow, criticalHigh]
const TESTS = [
  [
    'FBC',
    'Full blood count',
    'haematology',
    'blood',
    'EDTA (purple top)',
    120,
    '800.00',
    true,
    [
      [
        'HB',
        'Haemoglobin',
        'numeric',
        'g/dL',
        1,
        null,
        null,
        [
          ['male', 12 * Y, null, 13, 17, 7, 20],
          ['female', 12 * Y, null, 12, 15, 7, 20],
          [null, Y, 12 * Y - 1, 11, 14.5, 7, 20],
        ],
      ],
      ['WBC', 'White cell count', 'numeric', '×10⁹/L', 1, null, null, [[null, 0, null, 4, 11, 2, 30]]],
      ['PLT', 'Platelets', 'numeric', '×10⁹/L', 0, null, null, [[null, 0, null, 150, 400, 50, 1000]]],
    ],
  ],
  [
    'MRDT',
    'Malaria rapid diagnostic test',
    'parasitology',
    'blood',
    'EDTA (purple top)',
    30,
    '300.00',
    true,
    [
      [
        'MRDT',
        'Malaria RDT',
        'options',
        null,
        0,
        ['Negative', 'Positive (P. falciparum)', 'Positive (non-falciparum)'],
        ['Positive (P. falciparum)', 'Positive (non-falciparum)'],
        [],
      ],
    ],
  ],
  [
    'BS',
    'Blood slide for malaria parasites',
    'parasitology',
    'blood',
    'EDTA (purple top)',
    60,
    '300.00',
    true,
    [
      [
        'BS',
        'Malaria parasites',
        'options',
        null,
        0,
        ['No parasites seen', 'Parasites seen +', 'Parasites seen ++', 'Parasites seen +++'],
        ['Parasites seen +', 'Parasites seen ++', 'Parasites seen +++'],
        [],
      ],
    ],
  ],
  [
    'RBS',
    'Random blood sugar',
    'biochemistry',
    'blood',
    'Fluoride (grey top)',
    30,
    '200.00',
    true,
    [['GLU', 'Glucose (random)', 'numeric', 'mmol/L', 1, null, null, [[null, 0, null, 3.9, 7.8, 2.5, 25]]]],
  ],
  [
    'UE',
    'Urea and electrolytes',
    'biochemistry',
    'serum',
    'Plain (red top)',
    240,
    '1500.00',
    false,
    [
      ['NA', 'Sodium', 'numeric', 'mmol/L', 0, null, null, [[null, 0, null, 135, 145, 120, 160]]],
      ['K', 'Potassium', 'numeric', 'mmol/L', 1, null, null, [[null, 0, null, 3.5, 5.1, 2.5, 6.5]]],
      ['UREA', 'Urea', 'numeric', 'mmol/L', 1, null, null, [[null, 0, null, 2.5, 7.8, null, 30]]],
      [
        'CREAT',
        'Creatinine',
        'numeric',
        'µmol/L',
        0,
        null,
        null,
        [
          ['male', 12 * Y, null, 62, 106, null, 500],
          ['female', 12 * Y, null, 44, 80, null, 500],
        ],
      ],
    ],
  ],
  [
    'URINALYSIS',
    'Urinalysis',
    'urinalysis',
    'urine',
    'Sterile urine container',
    60,
    '300.00',
    true,
    [
      ['PROT', 'Protein', 'options', null, 0, GRADE, GRADE.slice(1), []],
      ['UGLU', 'Glucose', 'options', null, 0, GRADE, GRADE.slice(1), []],
      ['LEU', 'Leucocytes', 'options', null, 0, GRADE, GRADE.slice(1), []],
      ['NIT', 'Nitrite', 'options', null, 0, POS, ['Positive'], []],
      ['MICRO', 'Microscopy', 'text', null, 0, null, null, []],
    ],
  ],
  [
    'UPT',
    'Urine pregnancy test',
    'serology',
    'urine',
    'Sterile urine container',
    30,
    '200.00',
    true,
    [['HCG', 'hCG', 'options', null, 0, POS, [], []]],
  ],
  [
    'STOOL',
    'Stool for ova and cysts',
    'parasitology',
    'stool',
    'Stool container',
    120,
    '300.00',
    true,
    [['OC', 'Ova and cysts', 'text', null, 0, null, null, []]],
  ],
  [
    'CRP',
    'C-reactive protein',
    'biochemistry',
    'serum',
    'Plain (red top)',
    240,
    '1000.00',
    false,
    [['CRP', 'CRP', 'numeric', 'mg/L', 1, null, null, [[null, 0, null, 0, 5, null, null]]]],
  ],
  [
    'HBA1C',
    'HbA1c',
    'biochemistry',
    'blood',
    'EDTA (purple top)',
    1440,
    '1500.00',
    false,
    [['A1C', 'HbA1c', 'numeric', '%', 1, null, null, [[null, 0, null, 4, 5.6, null, null]]]],
  ],
  [
    'URINE-CS',
    'Urine culture and sensitivity',
    'microbiology',
    'urine',
    'Sterile urine container',
    4320,
    '2000.00',
    false,
    [['CS', 'Culture', 'culture', null, 0, null, null, []]],
  ],
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') return;
  for (const kmhfl of ['99001', '99002']) {
    const facility = await knex('facilities').where({ kmhfl_code: kmhfl }).first('id');
    if (!facility || (await knex('lab_tests').where({ facility_id: facility.id }).first('id'))) continue;
    const f = facility.id;
    const lab = await knex('departments').where({ facility_id: f, code: 'LAB' }).first('id');
    const cash = await knex('price_lists').where({ facility_id: f, is_default: true }).first('id');
    const shif = await knex('price_lists').where({ facility_id: f, code: 'SHIF' }).first('id');
    for (const [code, name, section, specimen, container, tat, price, sha, components] of TESTS) {
      const [charge] = await knex('charge_items')
        .insert({
          facility_id: f,
          code: `LAB-${code}`,
          name,
          category: 'laboratory',
          department_id: lab?.id ?? null,
          unit: 'test',
        })
        .returning('id');
      if (cash)
        await knex('price_list_items').insert({
          facility_id: f,
          price_list_id: cash.id,
          charge_item_id: charge.id,
          unit_price: price,
        });
      if (shif && sha)
        await knex('price_list_items').insert({
          facility_id: f,
          price_list_id: shif.id,
          charge_item_id: charge.id,
          unit_price: price,
          cover_type: 'full',
          cover_value: '0',
        });
      const [test] = await knex('lab_tests')
        .insert({
          facility_id: f,
          code,
          name,
          section,
          specimen_type: specimen,
          container,
          tat_minutes: tat,
          charge_item_id: charge.id,
        })
        .returning('id');
      for (const [i, [cCode, cName, type, unit, decimals, options, abnormal, ranges]] of components.entries()) {
        const [c] = await knex('lab_test_components')
          .insert({
            test_id: test.id,
            code: cCode,
            name: cName,
            result_type: type,
            unit,
            decimals,
            options: options ? JSON.stringify(options) : null,
            abnormal_options: abnormal ? JSON.stringify(abnormal) : null,
            sort: i,
          })
          .returning('id');
        for (const [sex, ageMin, ageMax, low, high, critLow, critHigh] of ranges)
          await knex('lab_reference_ranges').insert({
            component_id: c.id,
            sex,
            age_min_days: ageMin,
            age_max_days: ageMax,
            low,
            high,
            critical_low: critLow,
            critical_high: critHigh,
          });
      }
    }
  }
}

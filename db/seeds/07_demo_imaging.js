// Demo imaging catalogue and report templates for both demo facilities, priced on the cash list
// (SHA covers plain X-rays and obstetric ultrasound in full). Illustrative prices.
// Never runs in production. Idempotent per facility.

// code, name, modality, body part, TAT minutes, cash price, SHA covers, preparation
const STUDIES = [
  ['CXR', 'Chest X-ray (PA)', 'xray', 'chest', 240, '1000.00', true, null],
  ['XR-LIMB', 'X-ray of a limb (2 views)', 'xray', 'limb', 240, '1200.00', true, null],
  [
    'US-ABD',
    'Abdominal ultrasound',
    'ultrasound',
    'abdomen',
    1440,
    '2500.00',
    false,
    'Nothing to eat for 6 hours before',
  ],
  ['US-OBS', 'Obstetric ultrasound', 'ultrasound', 'pelvis', 1440, '2000.00', true, 'Full bladder for early pregnancy'],
  ['US-PELVIS', 'Pelvic ultrasound', 'ultrasound', 'pelvis', 1440, '2000.00', false, 'Full bladder'],
  ['CT-HEAD', 'CT head (plain)', 'ct', 'head', 240, '8000.00', false, null],
  [
    'CT-ABD',
    'CT abdomen and pelvis with contrast',
    'ct',
    'abdomen',
    1440,
    '15000.00',
    false,
    'Fasting 4 hours; kidney function before contrast',
  ],
];

// modality, study code | null, name, findings, impression
const TEMPLATES = [
  [
    'xray',
    'CXR',
    'Normal chest X-ray',
    'The trachea is central. The heart size is within normal limits (CTR < 0.5). Both lung fields are clear with no focal consolidation, effusion or pneumothorax. The costophrenic angles are sharp. The bony thorax is intact.',
    'Normal chest radiograph.',
  ],
  [
    'ultrasound',
    'US-OBS',
    'Obstetric ultrasound',
    'Single live intrauterine fetus in ___ presentation. Fetal heart rate ___ bpm. BPD ___ mm, HC ___ mm, AC ___ mm, FL ___ mm, corresponding to ___ weeks ___ days. Placenta ___, grade ___. Amniotic fluid adequate (AFI ___ cm).',
    'Single live intrauterine pregnancy of ___ weeks ___ days by biometry. EDD ___.',
  ],
  [
    'ultrasound',
    'US-ABD',
    'Normal abdominal ultrasound',
    'The liver is normal in size and echotexture with no focal lesion. The gallbladder is well distended with no calculi; the CBD is not dilated. The pancreas, spleen and both kidneys are normal. No free fluid.',
    'Normal abdominal ultrasound.',
  ],
  [
    'ct',
    'CT-HEAD',
    'Normal CT head',
    'No intracranial haemorrhage, mass effect or midline shift. Grey–white matter differentiation is preserved. The ventricles and sulci are normal for age. No fracture.',
    'No acute intracranial abnormality.',
  ],
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') return;
  for (const kmhfl of ['99001', '99002']) {
    const facility = await knex('facilities').where({ kmhfl_code: kmhfl }).first('id');
    if (!facility || (await knex('imaging_studies').where({ facility_id: facility.id }).first('id'))) continue;
    const f = facility.id;
    const rad = await knex('departments').where({ facility_id: f, code: 'RAD' }).first('id');
    const cash = await knex('price_lists').where({ facility_id: f, is_default: true }).first('id');
    const shif = await knex('price_lists').where({ facility_id: f, code: 'SHIF' }).first('id');
    const ids = {};
    for (const [code, name, modality, bodyPart, tat, price, sha, prep] of STUDIES) {
      const [charge] = await knex('charge_items')
        .insert({
          facility_id: f,
          code: `IMG-${code}`,
          name,
          category: 'imaging',
          department_id: rad?.id ?? null,
          unit: 'study',
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
      const [s] = await knex('imaging_studies')
        .insert({
          facility_id: f,
          code,
          name,
          modality,
          body_part: bodyPart,
          tat_minutes: tat,
          preparation: prep,
          charge_item_id: charge.id,
        })
        .returning('id');
      ids[code] = s.id;
    }
    for (const [modality, study, name, findings, impression] of TEMPLATES)
      await knex('imaging_report_templates').insert({
        facility_id: f,
        modality,
        study_id: study ? ids[study] : null,
        name,
        findings,
        impression,
      });
  }
}

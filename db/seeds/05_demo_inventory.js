// Demo stores, suppliers, items (common Kenya Essential Medicines List drugs, consumables and a
// reagent) and opening stock for both demo facilities. Opening stock is written as GRNs with
// ledger rows, exactly as a real delivery would be. A few batches are near expiry or expired so
// the expiry dashboard and FEFO have something to show. Prices and costs are illustrative.
// Never runs in production. Idempotent per facility.

const STORES = [
  // code, name, type, department code, dispensing
  ['MAIN', 'Main Store', 'main', 'STORES', false],
  ['PHARM', 'Pharmacy', 'pharmacy', 'PHARM', true],
  ['LAB', 'Laboratory Store', 'lab', 'LAB', false],
  ['WARD', 'Ward Store', 'ward', 'IPD', false],
];

const SUPPLIERS = [
  ['Kenya Medical Supplies Authority (KEMSA)', 'P051100001A', 'Embakasi, Nairobi'],
  ['Mission for Essential Drugs and Supplies (MEDS)', 'P051100002B', 'Mombasa Road, Nairobi'],
  ['Afya Distributors Ltd', 'P051100003C', 'Industrial Area, Nairobi'],
];

// code, name, category, base unit, sell price per unit (null = not sold), unit cost,
// drug: [generic, form, strength, value, unit, route, keml, atc] | null, pack: [name, qty] | null
const ITEMS = [
  [
    'PARA500',
    'Paracetamol 500 mg tablets',
    'drug',
    'tablet',
    '5.00',
    '0.80',
    ['Paracetamol', 'tablet', '500 mg', 500, 'mg', 'oral', true, 'N02BE01'],
    ['Box of 100', 100],
  ],
  [
    'AMOX500',
    'Amoxicillin 500 mg capsules',
    'drug',
    'capsule',
    '10.00',
    '2.50',
    ['Amoxicillin', 'capsule', '500 mg', 500, 'mg', 'oral', true, 'J01CA04'],
    ['Box of 100', 100],
  ],
  [
    'AMOX125S',
    'Amoxicillin 125 mg/5 ml suspension 100 ml',
    'drug',
    'bottle',
    '150.00',
    '55.00',
    ['Amoxicillin', 'suspension', '125 mg/5 ml', 25, 'mg/ml', 'oral', true, 'J01CA04'],
    null,
  ],
  [
    'AL2012',
    'Artemether/Lumefantrine 20/120 mg tablets',
    'drug',
    'tablet',
    '15.00',
    '4.00',
    ['Artemether + Lumefantrine', 'tablet', '20/120 mg', 20, 'mg', 'oral', true, 'P01BF01'],
    ['Pack of 24', 24],
  ],
  [
    'MET500',
    'Metformin 500 mg tablets',
    'drug',
    'tablet',
    '4.00',
    '0.90',
    ['Metformin', 'tablet', '500 mg', 500, 'mg', 'oral', true, 'A10BA02'],
    ['Box of 100', 100],
  ],
  [
    'AMLO5',
    'Amlodipine 5 mg tablets',
    'drug',
    'tablet',
    '5.00',
    '0.70',
    ['Amlodipine', 'tablet', '5 mg', 5, 'mg', 'oral', true, 'C08CA01'],
    ['Box of 100', 100],
  ],
  [
    'IBU400',
    'Ibuprofen 400 mg tablets',
    'drug',
    'tablet',
    '5.00',
    '0.60',
    ['Ibuprofen', 'tablet', '400 mg', 400, 'mg', 'oral', true, 'M01AE01'],
    ['Box of 100', 100],
  ],
  [
    'METRO400',
    'Metronidazole 400 mg tablets',
    'drug',
    'tablet',
    '4.00',
    '0.70',
    ['Metronidazole', 'tablet', '400 mg', 400, 'mg', 'oral', true, 'P01AB01'],
    ['Box of 100', 100],
  ],
  [
    'CTX960',
    'Cotrimoxazole 960 mg tablets',
    'drug',
    'tablet',
    '4.00',
    '0.80',
    ['Sulfamethoxazole + Trimethoprim', 'tablet', '800/160 mg', 960, 'mg', 'oral', true, 'J01EE01'],
    ['Box of 100', 100],
  ],
  [
    'OMEP20',
    'Omeprazole 20 mg capsules',
    'drug',
    'capsule',
    '8.00',
    '1.50',
    ['Omeprazole', 'capsule', '20 mg', 20, 'mg', 'oral', true, 'A02BC01'],
    ['Box of 28', 28],
  ],
  [
    'ORS',
    'Oral rehydration salts sachet',
    'drug',
    'sachet',
    '20.00',
    '6.00',
    ['Oral rehydration salts', 'powder', '20.5 g', 20.5, 'g', 'oral', true, 'A07CA'],
    ['Box of 50', 50],
  ],
  [
    'ZINC20',
    'Zinc sulphate 20 mg dispersible tablets',
    'drug',
    'tablet',
    '5.00',
    '1.00',
    ['Zinc sulphate', 'tablet', '20 mg', 20, 'mg', 'oral', true, 'A12CB01'],
    ['Pack of 10', 10],
  ],
  [
    'CEFT1G',
    'Ceftriaxone 1 g injection',
    'drug',
    'vial',
    '150.00',
    '45.00',
    ['Ceftriaxone', 'injection', '1 g', 1000, 'mg', 'IV/IM', true, 'J01DD04'],
    ['Box of 10', 10],
  ],
  [
    'SALB-INH',
    'Salbutamol 100 mcg inhaler',
    'drug',
    'inhaler',
    '350.00',
    '180.00',
    ['Salbutamol', 'inhaler', '100 mcg/dose', 100, 'mcg', 'inhaled', true, 'R03AC02'],
    null,
  ],
  [
    'DICLO50',
    'Diclofenac 50 mg tablets',
    'drug',
    'tablet',
    '5.00',
    '0.50',
    ['Diclofenac', 'tablet', '50 mg', 50, 'mg', 'oral', true, 'M01AB05'],
    ['Box of 100', 100],
  ],
  ['SYR5', 'Syringe 5 ml with needle', 'consumable', 'piece', '20.00', '6.00', null, ['Box of 100', 100]],
  ['GLOVE-M', 'Examination gloves (medium)', 'consumable', 'pair', '20.00', '7.00', null, ['Box of 50 pairs', 50]],
  ['CANN20', 'IV cannula 20G', 'consumable', 'piece', '60.00', '25.00', null, ['Box of 50', 50]],
  ['COTTON', 'Cotton wool 400 g', 'consumable', 'roll', null, '180.00', null, null],
  ['MRDT', 'Malaria rapid diagnostic test kit', 'reagent', 'test', null, '60.00', null, ['Box of 25', 25]],
];

// store, item code, reorder level, reorder qty, max
const REORDER = [
  ['PHARM', 'PARA500', 500, 1000, 2000],
  ['PHARM', 'AMOX500', 300, 500, 1000],
  ['PHARM', 'AL2012', 240, 480, 960],
  ['PHARM', 'MET500', 300, 600, 1200],
  ['PHARM', 'ORS', 50, 100, 200],
  ['PHARM', 'CEFT1G', 20, 50, 100],
  ['PHARM', 'SALB-INH', 10, 20, 40],
  ['MAIN', 'PARA500', 2000, 5000, 10000],
  ['MAIN', 'AMOX500', 1000, 3000, 5000],
  ['MAIN', 'GLOVE-M', 500, 1000, 2000],
  ['MAIN', 'SYR5', 500, 1000, 2000],
];

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// store, supplier index, [item code, batch, expiry offset in days, quantity]
const OPENING = [
  [
    'MAIN',
    0,
    [
      ['PARA500', 'PCM2401', 540, 8000],
      ['AMOX500', 'AMX2402', 400, 4000],
      ['AL2012', 'ALU2403', 365, 2400],
      ['MET500', 'MTF2404', 500, 3000],
      ['AMLO5', 'AML2405', 600, 2000],
      ['IBU400', 'IBU2406', 300, 2000],
      ['METRO400', 'MTZ2407', 420, 2000],
      ['CTX960', 'CTX2408', 380, 2000],
      ['OMEP20', 'OMP2409', 330, 1120],
      ['ORS', 'ORS2410', 700, 500],
      ['ZINC20', 'ZNC2411', 450, 500],
      ['CEFT1G', 'CEF2412', 250, 200],
      ['SALB-INH', 'SAL2413', 520, 60],
      ['DICLO50', 'DCF2414', 480, 1000],
    ],
  ],
  [
    'MAIN',
    1,
    [
      ['SYR5', 'SYR2415', 1200, 2000],
      ['GLOVE-M', 'GLV2416', 900, 400], // below the reorder level: shows as low
      ['CANN20', 'CAN2417', 1000, 300],
      ['COTTON', 'CTN2418', 1500, 20],
    ],
  ],
  [
    'PHARM',
    0,
    [
      ['PARA500', 'PCM2390', 20, 300], // expires in 20 days: dispensed first (FEFO)
      ['PARA500', 'PCM2401', 540, 900],
      ['AMOX500', 'AMX2402', 400, 600],
      ['AMOX125S', 'AMS2419', 200, 40],
      ['AL2012', 'ALU2390', 55, 96], // expires within 60 days
      ['AL2012', 'ALU2403', 365, 480],
      ['MET500', 'MTF2404', 500, 200], // below the reorder level
      ['AMLO5', 'AML2405', 600, 500],
      ['IBU400', 'IBU2380', -10, 100], // already expired: quarantined
      ['IBU400', 'IBU2406', 300, 400],
      ['METRO400', 'MTZ2407', 420, 300],
      ['CTX960', 'CTX2408', 380, 300],
      ['OMEP20', 'OMP2409', 330, 280],
      ['ORS', 'ORS2410', 700, 120],
      ['ZINC20', 'ZNC2411', 450, 100],
      ['CEFT1G', 'CEF2412', 250, 30],
      ['SALB-INH', 'SAL2413', 520, 8], // below the reorder level
      ['DICLO50', 'DCF2414', 480, 300],
    ],
  ],
  ['LAB', 2, [['MRDT', 'RDT2420', 85, 100]]],
];

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') return;
  for (const kmhfl of ['99001', '99002']) {
    const facility = await knex('facilities').where({ kmhfl_code: kmhfl }).first('id');
    if (!facility || (await knex('stores').where({ facility_id: facility.id }).first('id'))) continue;
    const f = facility.id;
    const depts = Object.fromEntries(
      (await knex('departments').where({ facility_id: f }).select('id', 'code')).map((d) => [d.code, d.id]),
    );
    const storekeeper = await knex('users').where({ username: 'storekeeper' }).first('id');
    const stores = {};
    for (const [code, name, type, dept, dispensing] of STORES) {
      if (!depts[dept]) continue;
      const [s] = await knex('stores')
        .insert({ facility_id: f, code, name, type, department_id: depts[dept], dispensing })
        .returning('id');
      stores[code] = s.id;
    }
    const suppliers = [];
    for (const [name, kra_pin, address] of SUPPLIERS) {
      const [s] = await knex('suppliers').insert({ facility_id: f, name, kra_pin, address }).returning('id');
      suppliers.push(s.id);
    }

    const cash = await knex('price_lists').where({ facility_id: f, is_default: true }).first('id');
    const shif = await knex('price_lists').where({ facility_id: f, code: 'SHIF' }).first('id');
    const items = {};
    for (const [code, name, category, unit, price, cost, drug, pack] of ITEMS) {
      let chargeItemId = null;
      if (price) {
        const [c] = await knex('charge_items')
          .insert({ facility_id: f, code: `RX-${code}`, name, category: 'pharmacy', department_id: depts.PHARM, unit })
          .onConflict(['facility_id', 'code'])
          .ignore()
          .returning('id');
        chargeItemId =
          c?.id ??
          (
            await knex('charge_items')
              .where({ facility_id: f, code: `RX-${code}` })
              .first('id')
          ).id;
        if (cash)
          await knex('price_list_items')
            .insert({ facility_id: f, price_list_id: cash.id, charge_item_id: chargeItemId, unit_price: price })
            .onConflict(['price_list_id', 'charge_item_id'])
            .ignore();
        // SHA covers essential medicines in full; the patient pays nothing for them.
        if (shif && drug?.[6])
          await knex('price_list_items')
            .insert({
              facility_id: f,
              price_list_id: shif.id,
              charge_item_id: chargeItemId,
              unit_price: price,
              cover_type: 'full',
              cover_value: '0',
            })
            .onConflict(['price_list_id', 'charge_item_id'])
            .ignore();
      }
      const [item] = await knex('items')
        .insert({
          facility_id: f,
          code,
          name,
          category,
          base_unit: unit,
          charge_item_id: chargeItemId,
          average_cost: cost,
        })
        .returning('id');
      items[code] = { id: item.id, cost };
      if (drug) {
        const [generic_name, form, strength, strength_value, strength_unit, default_route, keml, atc_code] = drug;
        await knex('drugs').insert({
          item_id: item.id,
          generic_name,
          form,
          strength,
          strength_value,
          strength_unit,
          default_route,
          keml,
          atc_code,
        });
      }
      if (pack) await knex('item_pack_sizes').insert({ item_id: item.id, name: pack[0], base_qty: pack[1] });
    }

    for (const [store, code, level, qty, max] of REORDER)
      if (stores[store])
        await knex('reorder_levels').insert({
          store_id: stores[store],
          item_id: items[code].id,
          reorder_level: level,
          reorder_qty: qty,
          max_level: max,
        });

    let grnSeq = 0;
    const year = new Date().getFullYear();
    for (const [store, supplierIdx, lines] of OPENING) {
      if (!stores[store]) continue;
      grnSeq += 1;
      const [grn] = await knex('goods_received_notes')
        .insert({
          facility_id: f,
          grn_number: `GRN-${year}-${String(grnSeq).padStart(6, '0')}`,
          supplier_id: suppliers[supplierIdx],
          store_id: stores[store],
          notes: 'Opening stock (demo)',
          received_by: storekeeper.id,
        })
        .returning('id');
      let total = 0;
      for (const [code, batchNo, offset, qty] of lines) {
        const it = items[code];
        await knex('item_batches')
          .insert({
            facility_id: f,
            item_id: it.id,
            batch_number: batchNo,
            expiry_date: day(offset),
            supplier_id: suppliers[supplierIdx],
            unit_cost: it.cost,
          })
          .onConflict(['item_id', 'batch_number', 'expiry_date'])
          .ignore();
        const batch = await knex('item_batches').where({ item_id: it.id, batch_number: batchNo }).first('id');
        await knex('grn_items').insert({
          grn_id: grn.id,
          item_id: it.id,
          batch_id: batch.id,
          quantity: qty,
          unit_cost: it.cost,
        });
        await knex('stock_levels').insert({
          store_id: stores[store],
          batch_id: batch.id,
          item_id: it.id,
          quantity: qty,
        });
        await knex('stock_movements').insert({
          facility_id: f,
          store_id: stores[store],
          item_id: it.id,
          batch_id: batch.id,
          movement_type: 'grn',
          quantity: qty,
          balance_after: qty,
          unit_cost: it.cost,
          reference_type: 'grn',
          reference_id: grn.id,
          reason: 'Opening stock',
          created_by: storekeeper.id,
        });
        total += qty * Number(it.cost);
      }
      await knex('goods_received_notes')
        .where({ id: grn.id })
        .update({ total_amount: total.toFixed(2) });
    }
    await knex('document_sequences').insert({ facility_id: f, prefix: 'GRN', year, last_value: grnSeq });
  }
}

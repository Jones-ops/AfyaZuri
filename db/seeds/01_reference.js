// Reference data every deployment needs: permissions, roles and their permissions,
// and Kenyan administrative units. Idempotent — safe to re-run after upgrades.
import { existsSync, readFileSync } from 'node:fs';
import { PERMISSION_GROUPS, ROLES } from '../../packages/shared/src/permissions.js';

export const COUNTIES = [
  ['001', 'Mombasa'],
  ['002', 'Kwale'],
  ['003', 'Kilifi'],
  ['004', 'Tana River'],
  ['005', 'Lamu'],
  ['006', 'Taita Taveta'],
  ['007', 'Garissa'],
  ['008', 'Wajir'],
  ['009', 'Mandera'],
  ['010', 'Marsabit'],
  ['011', 'Isiolo'],
  ['012', 'Meru'],
  ['013', 'Tharaka-Nithi'],
  ['014', 'Embu'],
  ['015', 'Kitui'],
  ['016', 'Machakos'],
  ['017', 'Makueni'],
  ['018', 'Nyandarua'],
  ['019', 'Nyeri'],
  ['020', 'Kirinyaga'],
  ['021', "Murang'a"],
  ['022', 'Kiambu'],
  ['023', 'Turkana'],
  ['024', 'West Pokot'],
  ['025', 'Samburu'],
  ['026', 'Trans Nzoia'],
  ['027', 'Uasin Gishu'],
  ['028', 'Elgeyo-Marakwet'],
  ['029', 'Nandi'],
  ['030', 'Baringo'],
  ['031', 'Laikipia'],
  ['032', 'Nakuru'],
  ['033', 'Narok'],
  ['034', 'Kajiado'],
  ['035', 'Kericho'],
  ['036', 'Bomet'],
  ['037', 'Kakamega'],
  ['038', 'Vihiga'],
  ['039', 'Bungoma'],
  ['040', 'Busia'],
  ['041', 'Siaya'],
  ['042', 'Kisumu'],
  ['043', 'Homa Bay'],
  ['044', 'Migori'],
  ['045', 'Kisii'],
  ['046', 'Nyamira'],
  ['047', 'Nairobi'],
];

// Built-in sample of sub-counties and wards. For the full national list, place a CSV at
// db/seeds/data/admin-units.csv with columns: county_code,sub_county,ward
const SAMPLE_UNITS = {
  '042': {
    'Kisumu Central': ['Railways', 'Migosi', 'Shaurimoyo Kaloleni', 'Market Milimani', 'Kondele', 'Nyalenda B'],
    'Kisumu East': ['Kajulu', 'Kolwa East', 'Manyatta B', 'Nyalenda A', 'Kolwa Central'],
    'Kisumu West': ['South West Kisumu', 'Central Kisumu', 'Kisumu North', 'West Kisumu', 'North West Kisumu'],
    Seme: ['West Seme', 'Central Seme', 'East Seme', 'North Seme'],
    Nyando: ['East Kano/Wawidhi', 'Awasi/Onjiko', 'Ahero', 'Kabonyo/Kanyagwal', 'Kobura'],
    Muhoroni: ['Miwani', 'Ombeyi', "Masogo/Nyang'oma", 'Chemelil', 'Muhoroni/Koru'],
    Nyakach: ['South West Nyakach', 'North Nyakach', 'Central Nyakach', 'West Nyakach', 'South East Nyakach'],
  },
  '047': Object.fromEntries(
    [
      'Westlands',
      'Dagoretti North',
      'Dagoretti South',
      "Lang'ata",
      'Kibra',
      'Roysambu',
      'Kasarani',
      'Ruaraka',
      'Embakasi South',
      'Embakasi North',
      'Embakasi Central',
      'Embakasi East',
      'Embakasi West',
      'Makadara',
      'Kamukunji',
      'Starehe',
      'Mathare',
    ].map((s) => [s, []]),
  ),
};

/** @param {import('knex').Knex} knex */
async function seedAdminUnits(knex, units) {
  for (const [county, subs] of Object.entries(units)) {
    for (const [sub, wards] of Object.entries(subs)) {
      const [row] = await knex('sub_counties')
        .insert({ county_code: county, name: sub })
        .onConflict(['county_code', 'name'])
        .merge()
        .returning('id');
      if (wards.length)
        await knex('admin_wards')
          .insert(wards.map((w) => ({ sub_county_id: row.id, name: w })))
          .onConflict(['sub_county_id', 'name'])
          .ignore();
    }
  }
}

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  // Permissions: upsert all, then remove any no longer defined.
  const perms = Object.entries(PERMISSION_GROUPS).flatMap(([group, map]) =>
    Object.entries(map).map(([code, description]) => ({ code, group_name: group, description })),
  );
  await knex('permissions').insert(perms).onConflict('code').merge();
  await knex('permissions')
    .whereNotIn(
      'code',
      perms.map((p) => p.code),
    )
    .delete();

  // System roles mirror packages/shared/src/permissions.js exactly.
  for (const [code, role] of Object.entries(ROLES)) {
    const [r] = await knex('roles')
      .insert({ code, name: role.name, description: role.description, is_clinical: role.clinical, is_system: true })
      .onConflict('code')
      .merge(['name', 'description', 'is_clinical'])
      .returning('id');
    await knex('role_permissions').where({ role_id: r.id }).delete();
    if (role.permissions.length)
      await knex('role_permissions').insert(role.permissions.map((p) => ({ role_id: r.id, permission_code: p })));
  }

  await knex('counties')
    .insert(COUNTIES.map(([code, name]) => ({ code, name })))
    .onConflict('code')
    .merge();
  await seedAdminUnits(knex, SAMPLE_UNITS);

  const csv = new URL('./data/admin-units.csv', import.meta.url);
  if (existsSync(csv)) {
    const units = {};
    for (const line of readFileSync(csv, 'utf8').split(/\r?\n/).slice(1)) {
      const [county, sub, ward] = line.split(',').map((s) => s?.trim());
      if (!county || !sub) continue;
      (units[county] ??= {})[sub] ??= [];
      if (ward) units[county][sub].push(ward);
    }
    await seedAdminUnits(knex, units);
  }

  // Deployment-wide default settings.
  const defaults = {
    'opd.billing_mode.cash': 'pay_first',
    'opd.billing_mode.insurance': 'bill_at_exit',
    'consent.current_version': '2026-01',
    'retention.clinical_years': 20,
    'locale.patient_outputs': 'sw',
  };
  for (const [key, value] of Object.entries(defaults)) {
    const exists = await knex('system_settings').whereNull('facility_id').andWhere({ key }).first('id');
    if (!exists) await knex('system_settings').insert({ facility_id: null, key, value: JSON.stringify(value) });
  }
}

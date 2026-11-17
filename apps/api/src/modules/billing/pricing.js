// Price resolution: what a charge item costs for this patient, and who pays it.
//
// 1. The patient's scheme has a price list containing the item → that price and its
//    cover rule (full / fixed per unit / percent) split the line between payer and patient.
// 2. Otherwise the facility's default (cash) price list → the patient pays it all.
// 3. Not priced anywhere → posted at 0 and flagged `unpriced` for the billing office,
//    so a clinical action is never blocked by a missing price.
import { toCents } from '@afyazuri/shared';

const activeOn = (q, today) =>
  q
    .where('pl.active', true)
    .andWhere((w) => w.whereNull('pl.valid_from').orWhere('pl.valid_from', '<=', today))
    .andWhere((w) => w.whereNull('pl.valid_to').orWhere('pl.valid_to', '>=', today));

/**
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {{facilityId: string, chargeItemId: string, schemeId: string|null}} p
 * @returns {Promise<{unitPriceCents: number, coverType: string, coverValue: string, priceListId: string|null, unpriced: boolean}>}
 */
export async function resolvePrice(db, { facilityId, chargeItemId, schemeId }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const base = () =>
    activeOn(
      db('price_list_items as i')
        .join('price_lists as pl', 'pl.id', 'i.price_list_id')
        .where({ 'pl.facility_id': facilityId, 'i.charge_item_id': chargeItemId }),
      today,
    ).first('i.unit_price', 'i.cover_type', 'i.cover_value', 'pl.id as price_list_id');

  if (schemeId) {
    const s = await base().andWhere('pl.scheme_id', schemeId);
    if (s)
      return {
        unitPriceCents: toCents(s.unit_price),
        coverType: s.cover_type,
        coverValue: s.cover_value,
        priceListId: s.price_list_id,
        unpriced: false,
      };
  }
  const cash = await base().andWhere('pl.is_default', true);
  if (cash)
    return {
      unitPriceCents: toCents(cash.unit_price),
      coverType: 'none',
      coverValue: '0',
      priceListId: cash.price_list_id,
      unpriced: false,
    };
  return { unitPriceCents: 0, coverType: 'none', coverValue: '0', priceListId: null, unpriced: true };
}

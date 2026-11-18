import { Router } from 'express';
import { z } from 'zod';
import {
  billsQuery,
  chargeItemBody,
  chargeItemUpdateBody,
  idParams,
  manualChargeBody,
  priceListBody,
  priceListItemBody,
  priceListUpdateBody,
  voidItemBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const catalogueQuery = z.object({
  q: z.string().trim().max(60).optional(),
  active: z.enum(['true', 'false']).optional(),
});

/** @param {import('../../app.js').Deps} deps */
export function billingRoutes(deps) {
  const r = Router();
  const m = requestMeta;
  const id = validate({ params: idParams });
  const manage = requirePermission('billing.pricelist.manage');
  const read = requirePermission(['billing.read', 'billing.pricelist.manage']);
  // Item managers read the catalogue (names and codes only) to link stock items to what the patient is billed.
  const readCatalogue = requirePermission(['billing.read', 'billing.pricelist.manage', 'inventory.items.manage']);

  // Catalogue and price lists
  r.get('/charge-items', readCatalogue, validate({ query: catalogueQuery }), async (req, res) =>
    res.json({
      data: await svc.listChargeItems(deps, req.auth, {
        q: req.valid.query.q,
        active: req.valid.query.active === undefined ? undefined : req.valid.query.active === 'true',
      }),
    }),
  );
  r.post('/charge-items', manage, validate({ body: chargeItemBody }), async (req, res) =>
    res.status(201).json(await svc.createChargeItem(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/charge-items/:id', manage, validate({ params: idParams, body: chargeItemUpdateBody }), async (req, res) =>
    res.json(await svc.updateChargeItem(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.get('/price-lists', read, async (req, res) => res.json({ data: await svc.listPriceLists(deps, req.auth) }));
  r.post('/price-lists', manage, validate({ body: priceListBody }), async (req, res) =>
    res.status(201).json(await svc.createPriceList(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/price-lists/:id', manage, validate({ params: idParams, body: priceListUpdateBody }), async (req, res) =>
    res.json(await svc.updatePriceList(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/price-lists/:id/items', read, id, async (req, res) =>
    res.json({ data: await svc.listPriceListItems(deps, req.auth, req.valid.params.id) }),
  );
  r.put('/price-lists/:id/items', manage, validate({ params: idParams, body: priceListItemBody }), async (req, res) =>
    res.json(await svc.setPriceListItem(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.delete('/price-lists/:id/items/:itemId', manage, validate({ params: itemParams }), async (req, res) => {
    await svc.removePriceListItem(deps, req.auth, req.valid.params.id, req.valid.params.itemId, m(req));
    res.json({ ok: true });
  });

  // Bills
  r.get('/bills', requirePermission('billing.read'), validate({ query: billsQuery }), async (req, res) =>
    res.json(await svc.listBills(deps, req.auth, req.valid.query)),
  );
  r.get('/bills/:id', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await svc.getBill(deps, req.auth, req.valid.params.id)),
  );
  r.get('/encounters/:id/bill', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await svc.getEncounterBill(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/bills/:id/items',
    requirePermission('billing.charge.manual'),
    validate({ params: idParams, body: manualChargeBody }),
    async (req, res) =>
      res.status(201).json(await svc.addManualCharge(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/bill-items/:id/void',
    requirePermission('billing.charge.manual'),
    validate({ params: idParams, body: voidItemBody }),
    async (req, res) =>
      res.json(await svc.voidBillItem(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );

  return r;
}

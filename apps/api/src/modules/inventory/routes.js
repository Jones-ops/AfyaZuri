import { Router } from 'express';
import { z } from 'zod';
import {
  grnBody,
  idParams,
  itemBody,
  itemUpdateBody,
  itemsQuery,
  movementsQuery,
  purchaseOrderBody,
  reorderBody,
  stockQuery,
  storeBody,
  storeUpdateBody,
  supplierBody,
  supplierUpdateBody,
} from '@afyazuri/shared';
import { requestMeta as m, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as po from './purchasing.js';
import * as inv from './service.js';

const storeItemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const poStatusQuery = z.object({
  status: z.enum(['draft', 'sent', 'partially_received', 'received', 'cancelled']).optional(),
});
const expiryQuery = z.object({ storeId: z.string().uuid().optional() });

/** @param {import('../../app.js').Deps} deps */
export function inventoryRoutes(deps) {
  const r = Router();
  const read = requirePermission('inventory.read');
  const manage = requirePermission('inventory.items.manage');
  const buy = requirePermission('inventory.po.manage');
  const id = validate({ params: idParams });

  // Stores
  r.get('/stores', read, async (req, res) => res.json({ data: await inv.listStores(deps, req.auth) }));
  r.post('/stores', manage, validate({ body: storeBody }), async (req, res) =>
    res.status(201).json(await inv.createStore(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/stores/:id', manage, validate({ params: idParams, body: storeUpdateBody }), async (req, res) =>
    res.json(await inv.updateStore(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/stores/:id/stock', read, validate({ params: idParams, query: stockQuery }), async (req, res) =>
    res.json(await inv.storeStock(deps, req.auth, req.valid.params.id, req.valid.query)),
  );
  r.get('/stores/:id/stock/:itemId', read, validate({ params: storeItemParams }), async (req, res) =>
    res.json({ data: await inv.itemBatches(deps, req.auth, req.valid.params.id, req.valid.params.itemId) }),
  );
  r.put(
    '/stores/:id/reorder-levels/:itemId',
    manage,
    validate({ params: storeItemParams, body: reorderBody }),
    async (req, res) =>
      res.json(
        await inv.setReorderLevel(deps, req.auth, req.valid.params.id, req.valid.params.itemId, req.valid.body, m(req)),
      ),
  );

  // Item master
  r.get('/items', read, validate({ query: itemsQuery }), async (req, res) =>
    res.json({ data: await inv.listItems(deps, req.auth, req.valid.query) }),
  );
  r.get('/items/:id', read, id, async (req, res) => res.json(await inv.getItem(deps, req.auth, req.valid.params.id)));
  r.post('/items', manage, validate({ body: itemBody }), async (req, res) =>
    res.status(201).json(await inv.createItem(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/items/:id', manage, validate({ params: idParams, body: itemUpdateBody }), async (req, res) =>
    res.json(await inv.updateItem(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Suppliers
  r.get('/suppliers', read, async (req, res) => res.json({ data: await inv.listSuppliers(deps, req.auth) }));
  r.post('/suppliers', buy, validate({ body: supplierBody }), async (req, res) =>
    res.status(201).json(await inv.createSupplier(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/suppliers/:id', buy, validate({ params: idParams, body: supplierUpdateBody }), async (req, res) =>
    res.json(await inv.updateSupplier(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Purchase orders
  r.get('/purchase-orders', read, validate({ query: poStatusQuery }), async (req, res) =>
    res.json({ data: await po.listPurchaseOrders(deps, req.auth, req.valid.query) }),
  );
  r.get('/purchase-orders/:id', read, id, async (req, res) =>
    res.json(await po.getPurchaseOrder(deps, req.auth, req.valid.params.id)),
  );
  r.post('/purchase-orders', buy, validate({ body: purchaseOrderBody }), async (req, res) =>
    res.status(201).json(await po.createPurchaseOrder(deps, req.auth, req.valid.body, m(req))),
  );
  r.post('/purchase-orders/:id/send', buy, id, async (req, res) =>
    res.json(await po.setPurchaseOrderStatus(deps, req.auth, req.valid.params.id, 'sent', m(req))),
  );
  r.post('/purchase-orders/:id/cancel', buy, id, async (req, res) =>
    res.json(await po.setPurchaseOrderStatus(deps, req.auth, req.valid.params.id, 'cancelled', m(req))),
  );

  // Goods received (stock in). The store's department is checked in the service.
  r.get('/grns', read, async (req, res) => res.json({ data: await po.listGrns(deps, req.auth) }));
  r.get('/grns/:id', read, id, async (req, res) => res.json(await po.getGrn(deps, req.auth, req.valid.params.id)));
  r.post(
    '/grns',
    requirePermission('inventory.receive'),
    idempotent(deps.db, { required: true }),
    validate({ body: grnBody }),
    async (req, res) => res.status(201).json(await po.receiveGoods(deps, req.auth, req.valid.body, m(req))),
  );

  // Alerts and the ledger
  r.get('/inventory/low-stock', read, async (req, res) => res.json({ data: await inv.lowStock(deps, req.auth) }));
  r.get('/inventory/expiry', read, validate({ query: expiryQuery }), async (req, res) =>
    res.json(await inv.expiryReport(deps, req.auth, req.valid.query)),
  );
  r.get('/stock-movements', read, validate({ query: movementsQuery }), async (req, res) =>
    res.json({ data: await inv.listMovements(deps, req.auth, req.valid.query) }),
  );
  return r;
}

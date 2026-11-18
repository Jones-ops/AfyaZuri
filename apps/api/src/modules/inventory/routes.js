import { Router } from 'express';
import { z } from 'zod';
import {
  consumptionQuery,
  expiryWriteoffBody,
  hasPermission,
  requisitionBody,
  requisitionDecisionBody,
  requisitionReceiveBody,
  requisitionsQuery,
  stockCountBody,
  stockTakeBody,
  stockTakeDecisionBody,
  valuationQuery,
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
import { toCsv } from '../../lib/csv.js';
import { forbidden } from '../../lib/errors.js';
import { requestMeta as m, validate } from '../../lib/http.js';
import { actorOf } from '../../middleware/auth.js';
import { recordAudit } from '../audit/service.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as po from './purchasing.js';
import * as rep from './reports.js';
import * as req_ from './requisitions.js';
import * as st from './stocktakes.js';
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
  // Requisitions (department and approval checks are per store, in the service)
  r.get('/requisitions', read, validate({ query: requisitionsQuery }), async (req, res) =>
    res.json({ data: await req_.listRequisitions(deps, req.auth, req.valid.query) }),
  );
  r.get('/requisitions/:id', read, id, async (req, res) =>
    res.json(await req_.getRequisition(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/requisitions',
    requirePermission('inventory.requisition.create'),
    idempotent(deps.db, { required: true }),
    validate({ body: requisitionBody }),
    async (req, res) => res.status(201).json(await req_.createRequisition(deps, req.auth, req.valid.body, m(req))),
  );
  r.post(
    '/requisitions/:id/decision',
    requirePermission('inventory.requisition.approve'),
    validate({ params: idParams, body: requisitionDecisionBody }),
    async (req, res) =>
      res.json(await req_.decideRequisition(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/requisitions/:id/issue', requirePermission('inventory.issue'), id, async (req, res) =>
    res.json(await req_.issueRequisition(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post(
    '/requisitions/:id/receive',
    requirePermission('inventory.receive'),
    validate({ params: idParams, body: requisitionReceiveBody }),
    async (req, res) =>
      res.json(await req_.receiveRequisition(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/requisitions/:id/cancel', requirePermission('inventory.requisition.create'), id, async (req, res) =>
    res.json(await req_.cancelRequisition(deps, req.auth, req.valid.params.id, m(req))),
  );

  // Stock takes and expiry write-offs
  const count = requirePermission('inventory.stocktake.perform');
  r.get('/stock-takes', read, async (req, res) => res.json({ data: await st.listStockTakes(deps, req.auth) }));
  r.get('/stock-takes/:id', read, id, async (req, res) =>
    res.json(await st.getStockTake(deps, req.auth, req.valid.params.id)),
  );
  r.post('/stock-takes', count, validate({ body: stockTakeBody }), async (req, res) =>
    res.status(201).json(await st.startStockTake(deps, req.auth, req.valid.body, m(req))),
  );
  r.put('/stock-takes/:id/counts', count, validate({ params: idParams, body: stockCountBody }), async (req, res) =>
    res.json(await st.recordCounts(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/stock-takes/:id/submit', count, id, async (req, res) =>
    res.json(await st.submitStockTake(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post('/stock-takes/:id/cancel', count, id, async (req, res) =>
    res.json(await st.cancelStockTake(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post(
    '/stock-takes/:id/decision',
    requirePermission('inventory.stocktake.approve'),
    validate({ params: idParams, body: stockTakeDecisionBody }),
    async (req, res) => res.json(await st.decideStockTake(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/stores/:id/expiry-writeoff',
    count,
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: expiryWriteoffBody }),
    async (req, res) => res.json(await st.writeOffExpired(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Reports (CSV needs reports.export and is audited)
  const reports = requirePermission(['reports.operational.read', 'reports.financial.read']);
  const csv = async (req, res, name, [header, rows], entityType, metadata) => {
    if (!hasPermission(req.auth.grants, 'reports.export', { facilityId: req.auth.facilityId }))
      throw forbidden('You do not have permission to export reports', { required: ['reports.export'] });
    await recordAudit(deps.db, actorOf(req), m(req), {
      action: 'export',
      entityType,
      metadata: { ...metadata, rows: rows.length },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(toCsv(header, rows));
  };
  r.get('/inventory/reports/consumption', reports, validate({ query: consumptionQuery }), async (req, res) => {
    const q = req.valid.query;
    const report = await rep.consumptionReport(deps, req.auth, q);
    if (q.format !== 'csv') return res.json(report);
    return csv(req, res, `consumption-${q.from}-to-${q.to}.csv`, rep.consumptionCsv(report), 'consumption_report', {
      from: q.from,
      to: q.to,
    });
  });
  r.get('/inventory/reports/valuation', reports, validate({ query: valuationQuery }), async (req, res) => {
    const q = req.valid.query;
    const report = await rep.valuationReport(deps, req.auth, q);
    if (q.format !== 'csv') return res.json(report);
    return csv(req, res, `stock-valuation-${report.asOf}.csv`, rep.valuationCsv(report), 'valuation_report', {
      asOf: report.asOf,
    });
  });
  return r;
}

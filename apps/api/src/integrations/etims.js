// KRA eTIMS (electronic Tax Invoice Management System) adapter.
//
// Every receipt and credit note is reported to KRA, which returns a control-unit invoice
// number and a signature that are printed on the document. Most medical services are
// VAT-exempt (tax category "E"); a line with a VAT rate is reported under "B" (16%).
//
// Only the mock is implemented: the real OSCU/VSCU integration needs a KRA-issued device
// serial and certification, and slots in behind the same interface.
import { createHmac } from 'node:crypto';
import { fromCents, toCents } from '@afyazuri/shared';

/**
 * @typedef {Object} EtimsDocument
 * @property {'sale'|'credit_note'} kind
 * @property {string} documentNumber   our receipt / credit note number (unique per facility)
 * @property {string} issuedAt         ISO timestamp
 * @property {{name: string, kmhflCode: string, kraPin: string|null}} seller
 * @property {{name: string|null, kraPin?: string|null}} buyer
 * @property {Array<{description: string, quantity: number, unitPrice: string, amount: string, vatRate: number}>} lines
 * @property {string} total
 * @property {string|null} [originalInvoiceNumber] the sale a credit note reverses
 *
 * @typedef {Object} EtimsResult
 * @property {string} invoiceNumber    control-unit invoice number, printed on the document
 * @property {string} controlUnitId
 * @property {string} signature        internal data / receipt signature
 * @property {string|null} verifyUrl   printed as a QR code so anyone can check the invoice with KRA
 * @property {string} submittedAt
 * @property {Record<string, string>} taxSummary  taxable amount per tax category
 *
 * @typedef {{submit(doc: EtimsDocument): Promise<EtimsResult>, readonly enabled: boolean, readonly mode: string}} EtimsAdapter
 */

/** KRA tax category for a VAT rate: E = exempt, B = 16 % standard, Z = zero-rated. */
export const taxCategory = (vatRate) => (Number(vatRate) === 0 ? 'E' : Number(vatRate) === 16 ? 'B' : 'Z');

/** Validate a document before it leaves the building; returns the tax summary. @param {EtimsDocument} doc */
export function checkDocument(doc) {
  if (!doc.documentNumber) throw new Error('eTIMS: document number missing');
  if (!doc.lines.length) throw new Error('eTIMS: a document needs at least one line');
  if (doc.kind === 'credit_note' && !doc.originalInvoiceNumber)
    throw new Error('eTIMS: a credit note must reference the original invoice');
  const summary = {};
  let sum = 0;
  for (const l of doc.lines) {
    const c = taxCategory(l.vatRate);
    summary[c] = (summary[c] ?? 0) + toCents(l.amount);
    sum += toCents(l.amount);
  }
  if (sum !== toCents(doc.total)) throw new Error('eTIMS: lines do not add up to the total');
  return Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, fromCents(v)]));
}

/** In-process stand-in for KRA. Deterministic per document, so retries return the same invoice number. */
export class MockEtimsAdapter {
  /** @param {{secret?: string, failNext?: number}} [opts] */
  constructor(opts = {}) {
    this.secret = opts.secret ?? 'afyazuri-mock-etims';
    this.mode = 'mock';
    this.enabled = true;
    /** Tests can make the next N submissions fail, to exercise retries. */
    this.failNext = opts.failNext ?? 0;
    /** @type {EtimsDocument[]} */
    this.submitted = [];
  }

  /** @param {EtimsDocument} doc @returns {Promise<EtimsResult>} */
  async submit(doc) {
    const taxSummary = checkDocument(doc);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('eTIMS mock: control unit unavailable');
    }
    const controlUnitId = `KRACU${createHmac('sha256', this.secret).update(doc.seller.kmhflCode).digest('hex').slice(0, 10).toUpperCase()}`;
    const h = createHmac('sha256', this.secret).update(`${doc.seller.kmhflCode}|${doc.kind}|${doc.documentNumber}`);
    const digest = h.digest('hex').toUpperCase();
    const seq = parseInt(digest.slice(0, 8), 16) % 1e8;
    const invoiceNumber = `${controlUnitId}/${String(seq).padStart(8, '0')}`;
    this.submitted.push(doc);
    return {
      invoiceNumber,
      controlUnitId,
      signature: digest.slice(8, 24).match(/.{4}/g).join('-'),
      verifyUrl: null, // the live integration returns KRA's verification link; the mock has none
      submittedAt: new Date().toISOString(),
      taxSummary,
    };
  }
}

/** eTIMS switched off (e.g. a facility not yet registered): documents are marked "not required". */
export class DisabledEtimsAdapter {
  mode = 'off';
  enabled = false;
  async submit() {
    throw new Error('eTIMS is switched off');
  }
}

/** @param {import('../config.js').Config} config @returns {EtimsAdapter} */
export function etimsFromConfig(config) {
  return config.ETIMS_ENV === 'off' ? new DisabledEtimsAdapter() : new MockEtimsAdapter();
}

import '../../lib/db-types.js';
// Patient SMS: Kiswahili by default (English per facility setting), sent only to patients who
// gave SMS consent. Each message is logged once per (template, event) so a re-delivered outbox
// event never texts the patient twice. Messages carry no clinical details.
import { fromCents, toCents } from '@afyazuri/shared';
import { maskPhone, smsParts } from '../../integrations/sms.js';
import { getSetting } from '../../lib/settings.js';

/**
 * @typedef {{db: import('knex').Knex, crypto: import('../../lib/crypto.js').FieldCrypto,
 *            sms: import('../../integrations/sms.js').AfricasTalkingAdapter, logger?: import('pino').Logger}} Deps
 */

const METHOD = {
  sw: { cash: 'pesa taslimu', mpesa: 'M-Pesa', card: 'kadi', bank: 'benki' },
  en: { cash: 'cash', mpesa: 'M-Pesa', card: 'card', bank: 'bank' },
};
const kes = (v) => {
  const c = toCents(v);
  return c % 100 === 0
    ? (c / 100).toLocaleString('en-KE')
    : Number(fromCents(c)).toLocaleString('en-KE', { minimumFractionDigits: 2 });
};

/** Templates. Keep each under 160 characters so it goes as one SMS part. */
export const TEMPLATES = {
  payment_received: {
    sw: (v) =>
      `${v.facility}: Tumepokea KES ${kes(v.amount)} kwa ${METHOD.sw[v.method]}. Stakabadhi ${v.receipt}. Salio KES ${kes(v.balance)}. Asante, pona haraka.`,
    en: (v) =>
      `${v.facility}: We received KES ${kes(v.amount)} by ${METHOD.en[v.method]}. Receipt ${v.receipt}. Balance KES ${kes(v.balance)}. Thank you, get well soon.`,
  },
  refund_paid: {
    sw: (v) =>
      `${v.facility}: Umerejeshewa KES ${kes(v.amount)} kwa ${METHOD.sw[v.method]}. Kumbukumbu ${v.document}. Asante.`,
    en: (v) =>
      `${v.facility}: KES ${kes(v.amount)} has been refunded to you by ${METHOD.en[v.method]}. Ref ${v.document}. Thank you.`,
  },
};

/** Facility names can be long; the sender line is cut so templates stay one part. */
const shortName = (name) => (name.length > 32 ? `${name.slice(0, 31)}…` : name);

/** Does the patient currently consent to SMS? The latest decision wins; a withdrawal revokes it. */
export async function smsConsent(db, patientId) {
  const c = await db('patient_consents')
    .where({ patient_id: patientId, consent_type: 'sms' })
    .orderBy('captured_at', 'desc')
    .first('granted', 'withdrawn_at');
  return Boolean(c?.granted && !c.withdrawn_at);
}

/**
 * Send a templated SMS to a patient, at most once per (template, relatedId).
 * Throws when the provider fails, so the outbox retries.
 * @param {Deps} deps
 * @param {{facilityId: string, patientId: string|null, template: keyof typeof TEMPLATES, relatedType: string,
 *          relatedId: string, vars: Record<string, any>}} m
 * @returns {Promise<string>} the message's final status
 */
export async function sendPatientSms(deps, m) {
  const { db, crypto, sms } = deps;
  let row = await db('sms_messages').where({ template: m.template, related_id: m.relatedId }).first();
  if (!row) {
    if (!m.patientId) return 'skipped_no_phone';
    const p = await db('patients').where({ id: m.patientId }).first('phone_enc', 'phone_hash', 'deceased_at');
    const phone = p?.phone_enc ? crypto.decrypt(p.phone_enc) : null;
    const language = (await getSetting(db, m.facilityId, 'notifications.sms_language', 'sw')) === 'en' ? 'en' : 'sw';
    const facility = await db('facilities').where({ id: m.facilityId }).first('name');
    const body = TEMPLATES[m.template][language]({ ...m.vars, facility: shortName(facility.name) });
    let status = 'queued';
    if (!sms.enabled) status = 'disabled';
    else if (!phone || p.deceased_at) status = 'skipped_no_phone';
    else if (!(await smsConsent(db, m.patientId))) status = 'skipped_no_consent';
    await db('sms_messages')
      .insert({
        facility_id: m.facilityId,
        patient_id: m.patientId,
        template: m.template,
        related_type: m.relatedType,
        related_id: m.relatedId,
        language,
        phone_enc: phone ? crypto.encrypt(phone) : null,
        phone_hash: p?.phone_hash ?? null,
        body,
        status,
        provider: sms.mode,
      })
      .onConflict(['template', 'related_id'])
      .ignore();
    row = await db('sms_messages').where({ template: m.template, related_id: m.relatedId }).first();
  }
  if (row.status !== 'queued' && row.status !== 'failed') return row.status;

  // Claim the send so two workers never text the same message.
  const claimed = await db('sms_messages')
    .where({ id: row.id, attempts: row.attempts })
    .whereIn('status', ['queued', 'failed'])
    .update({ attempts: row.attempts + 1 })
    .returning('id');
  if (!claimed.length) return 'queued';
  const to = crypto.decrypt(row.phone_enc);
  try {
    const res = await sms.send(to, row.body);
    await db('sms_messages')
      .where({ id: row.id })
      .update({ status: 'sent', provider_message_id: res.messageId, sent_at: db.fn.now(), last_error: null });
    deps.logger?.info({ template: m.template, to: maskPhone(to), parts: smsParts(row.body) }, 'sms sent');
    return 'sent';
  } catch (err) {
    await db('sms_messages')
      .where({ id: row.id })
      .update({ status: 'failed', last_error: String(err?.message ?? err).slice(0, 300) });
    throw err;
  }
}

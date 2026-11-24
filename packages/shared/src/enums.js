/** Shared enumerations. Stored as text in Postgres with CHECK constraints. */

export const SEX = ['male', 'female', 'intersex', 'unknown'];

export const IDENTIFIER_TYPES = [
  'national_id',
  'birth_certificate',
  'passport',
  'alien_id',
  'sha_number',
  'nhif_legacy',
  'other',
];

export const FACILITY_LEVELS = ['level_2', 'level_3', 'level_4', 'level_5', 'level_6'];

export const FACILITY_OWNERSHIP = ['moh', 'county', 'faith_based', 'private', 'ngo'];

export const DEPARTMENT_TYPES = [
  'administration',
  'records',
  'opd',
  'emergency',
  'ipd',
  'maternity',
  'pharmacy',
  'laboratory',
  'imaging',
  'theatre',
  'billing',
  'claims',
  'stores',
  'other',
];

export const SERVICE_POINT_TYPES = [
  'registration',
  'cashier',
  'triage',
  'consultation',
  'laboratory',
  'imaging',
  'pharmacy',
  'procedure',
  'exit',
  'other',
];

export const BED_STATUS = ['available', 'occupied', 'reserved', 'cleaning', 'out_of_service'];

export const ENCOUNTER_TYPES = ['opd', 'ipd', 'emergency'];
export const ENCOUNTER_STATUS = ['open', 'closed', 'cancelled'];

export const QUEUE_TICKET_STATUS = ['waiting', 'called', 'in_service', 'done', 'referred', 'no_show'];

export const ALLERGY_CATEGORIES = ['drug', 'food', 'environment', 'other'];
export const ALLERGY_SEVERITY = ['mild', 'moderate', 'severe', 'life_threatening'];

export const NOTE_TYPES = ['soap', 'triage', 'nursing', 'ward_round', 'procedure', 'discharge', 'other'];

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'view',
  'export',
  'login',
  'login_failed',
  'logout',
  'token_reuse',
  'lockout',
  'break_glass',
  'merge',
  'unmerge',
  'sign',
  'amend',
  'approve',
  'reject',
];

export const PAYER_TYPES = ['cash', 'sha', 'private_insurer', 'corporate', 'waiver'];

export const CONSENT_TYPES = ['data_processing', 'share_with_payer', 'share_for_referral', 'sms'];
export const CONSENT_METHODS = ['verbal', 'signed', 'digital', 'guardian'];

export const MARITAL_STATUS = ['single', 'married', 'divorced', 'separated', 'widowed', 'cohabiting', 'unknown'];

export const KIN_RELATIONSHIPS = [
  'spouse',
  'parent',
  'child',
  'sibling',
  'guardian',
  'relative',
  'friend',
  'employer',
  'other',
];

export const CHARGE_CATEGORIES = [
  'registration',
  'consultation',
  'procedure',
  'laboratory',
  'imaging',
  'pharmacy',
  'bed',
  'nursing',
  'theatre',
  'other',
];
export const PAYMENT_METHODS = ['cash', 'mpesa', 'card', 'bank'];
export const COVER_TYPES = ['none', 'full', 'fixed', 'percent'];

// ---- Inventory and pharmacy ----------------------------------------------------------
export const STORE_TYPES = ['main', 'pharmacy', 'lab', 'ward', 'theatre', 'other'];
export const INVENTORY_CATEGORIES = ['drug', 'consumable', 'reagent', 'other'];
export const DRUG_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'suppository',
  'powder',
  'other',
];
/** Signed ledger entries: receipts and returns add stock, everything else takes it away. */
export const MOVEMENT_TYPES = [
  'grn',
  'issue_out',
  'issue_in',
  'dispense',
  'dispense_return',
  'otc_sale',
  'adjustment',
  'stocktake',
  'expiry_writeoff',
];

/** Dosing frequencies and how many doses a day each means (null: as needed or a single dose). */
export const FREQUENCIES = {
  OD: { label: 'Once daily', perDay: 1 },
  BD: { label: 'Twice daily', perDay: 2 },
  TDS: { label: 'Three times daily', perDay: 3 },
  QID: { label: 'Four times daily', perDay: 4 },
  Q4H: { label: 'Every 4 hours', perDay: 6 },
  Q6H: { label: 'Every 6 hours', perDay: 4 },
  Q8H: { label: 'Every 8 hours', perDay: 3 },
  NOCTE: { label: 'At night', perDay: 1 },
  MANE: { label: 'In the morning', perDay: 1 },
  WEEKLY: { label: 'Once a week', perDay: 1 / 7 },
  STAT: { label: 'Once, now', perDay: null },
  PRN: { label: 'When needed', perDay: null },
};
export const ROUTES = [
  'oral',
  'IV',
  'IM',
  'IV/IM',
  'SC',
  'topical',
  'inhaled',
  'rectal',
  'vaginal',
  'eye',
  'ear',
  'nasal',
  'sublingual',
];

// ---- Laboratory --------------------------------------------------------------------------
export const LAB_SECTIONS = [
  'haematology',
  'biochemistry',
  'microbiology',
  'parasitology',
  'serology',
  'urinalysis',
  'other',
];
export const SPECIMEN_TYPES = ['blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other'];
export const LAB_RESULT_TYPES = ['numeric', 'text', 'options', 'culture'];
export const LAB_PRIORITIES = ['routine', 'urgent', 'stat'];
/** Life of an ordered test. Results become visible on the record only when 'verified'. */
export const LAB_ITEM_STATUS = ['ordered', 'collected', 'received', 'resulted', 'verified', 'cancelled'];

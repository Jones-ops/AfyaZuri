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

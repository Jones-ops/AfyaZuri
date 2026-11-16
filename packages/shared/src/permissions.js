/**
 * Permission catalogue and role → permission matrix.
 * This file is the single source of truth: the DB seed, API middleware and UI
 * all read from it. docs/permission-matrix.md is generated from it
 * (`node scripts/gen-permission-matrix.js`).
 */

/** @type {Record<string, Record<string, string>>} grouped permission codes → description */
export const PERMISSION_GROUPS = {
  admin: {
    'facilities.read': 'View facilities, departments, wards, beds and service points',
    'facilities.manage': 'Create and edit facilities, departments, wards, beds and service points',
    'users.read': 'View staff accounts',
    'users.manage': 'Create and edit staff accounts and role assignments',
    'users.disable': 'Disable accounts and force logout',
    'roles.read': 'View roles and permissions',
    'roles.manage': 'Edit role permissions',
    'audit.read': 'View the audit trail',
    'audit.export': 'Export audit records for investigations',
    'settings.manage': 'Change facility and system settings',
    'dashboard.read': 'View the facility dashboard',
  },
  patients: {
    'patients.read': 'Search and view patient demographics',
    'patients.create': 'Register patients',
    'patients.update': 'Edit patient demographics',
    'patients.merge': 'Merge and unmerge duplicate patients',
    'patients.restrict': 'Mark a record restricted (VIP or sensitive); clinical access then needs break-the-glass',
    'patients.export': 'Export a full patient record (data subject access request)',
    'patients.consent.manage': 'Record patient consent',
  },
  emr: {
    'emr.read': 'View clinical records (notes, vitals, diagnoses, results)',
    'emr.vitals.write': 'Record triage vitals',
    'emr.notes.write': 'Write clinical notes',
    'emr.notes.sign': 'Sign and lock clinical notes',
    'emr.diagnoses.write': 'Record diagnoses',
    'emr.allergies.write': 'Record allergies and problem list',
    'emr.attachments.write': 'Attach documents and images',
    'emr.break_glass': 'Emergency access to restricted records (reason required, reviewed)',
  },
  opd: {
    'opd.checkin': 'Check patients in and create encounters',
    'opd.queue.read': 'View queues',
    'opd.queue.manage': 'Call, serve and route queue tickets',
    'opd.referrals.write': 'Create internal and external referrals',
  },
  orders: {
    'orders.lab.create': 'Order lab tests',
    'orders.imaging.create': 'Order imaging',
    'orders.prescription.create': 'Prescribe medicines',
  },
  ipd: {
    'ipd.read': 'View admissions and bed board',
    'ipd.admit': 'Admit patients',
    'ipd.transfer': 'Transfer patients between beds and wards',
    'ipd.discharge': 'Discharge patients',
    'ipd.nursing.write': 'Write nursing notes and ward-round entries',
    'ipd.mar.write': 'Record medication administration',
    'ipd.beds.manage': 'Change bed status (cleaning, out of service)',
  },
  pharmacy: {
    'pharmacy.read': 'View the pharmacy worklist',
    'pharmacy.dispense': 'Dispense prescriptions',
    'pharmacy.otc.sell': 'Sell over-the-counter to walk-in customers',
    'pharmacy.rules.manage': 'Manage dose-range and interaction rules',
  },
  lab: {
    'lab.read': 'View the lab worklist',
    'lab.samples.collect': 'Collect samples and print labels',
    'lab.samples.receive': 'Receive samples in the lab',
    'lab.results.enter': 'Enter results',
    'lab.results.verify': 'Verify and release results',
    'lab.catalogue.manage': 'Manage the lab test catalogue',
  },
  imaging: {
    'imaging.read': 'View the imaging worklist',
    'imaging.schedule': 'Schedule imaging',
    'imaging.perform': 'Mark imaging as performed',
    'imaging.report': 'Write and release imaging reports',
    'imaging.catalogue.manage': 'Manage the imaging catalogue',
  },
  billing: {
    'billing.read': 'View bills and payments',
    'billing.charge.manual': 'Add manual bill lines',
    'billing.payment.receive': 'Receive payments and issue receipts',
    'billing.invoice.create': 'Raise insurance invoices',
    'billing.refund.request': 'Request refunds and credit notes',
    'billing.refund.approve': 'Approve refunds and credit notes',
    'billing.waiver.request': 'Request waivers',
    'billing.waiver.approve': 'Approve waivers',
    'billing.shift.manage': 'Open and close cashier shifts',
    'billing.pricelist.manage': 'Manage price lists',
  },
  claims: {
    'claims.read': 'View claims (includes coded diagnoses on the claim)',
    'claims.eligibility.check': 'Check payer eligibility',
    'claims.preauth.request': 'Request preauthorization',
    'claims.create': 'Assemble and correct claims',
    'claims.submit': 'Submit claims to payers',
    'claims.remittance.reconcile': 'Import and reconcile remittances',
    'claims.payers.manage': 'Manage payers, schemes and tariff mappings',
  },
  inventory: {
    'inventory.read': 'View stock',
    'inventory.items.manage': 'Manage the item master and reorder levels',
    'inventory.requisition.create': 'Raise requisitions',
    'inventory.requisition.approve': 'Approve requisitions',
    'inventory.issue': 'Issue stock against requisitions',
    'inventory.receive': 'Receive stock (GRN, requisition receipt)',
    'inventory.po.manage': 'Manage suppliers and purchase orders',
    'inventory.stocktake.perform': 'Perform stock takes',
    'inventory.stocktake.approve': 'Approve stock-take adjustments',
  },
  reports: {
    'reports.clinical.read': 'Clinical and MOH reports (aggregate)',
    'reports.financial.read': 'Revenue, cashier, debtor and claims reports',
    'reports.operational.read': 'Attendance, stock and consumption reports',
    'reports.export': 'Export reports to CSV/Excel/PDF',
  },
};

/** Flat map of permission code → description. */
export const PERMISSIONS = Object.freeze(Object.assign({}, ...Object.values(PERMISSION_GROUPS)));

/** @type {readonly string[]} */
export const ALL_PERMISSIONS = Object.freeze(Object.keys(PERMISSIONS));

/** Permissions that expose clinical content. Never granted to non-clinical roles. */
export const CLINICAL_PERMISSIONS = Object.freeze(
  ALL_PERMISSIONS.filter((p) => p.startsWith('emr.') || p.startsWith('orders.')),
);

/**
 * Expand a list of exact codes and `prefix.` wildcards into permission codes.
 * @param {string[]} items
 */
const pick = (items) => ALL_PERMISSIONS.filter((p) => items.some((x) => (x.endsWith('.') ? p.startsWith(x) : p === x)));

const CLINICIAN = [
  'dashboard.read',
  'patients.read',
  'patients.update',
  'patients.consent.manage',
  'emr.',
  'opd.',
  'orders.',
  'ipd.read',
  'ipd.admit',
  'ipd.transfer',
  'ipd.discharge',
  'ipd.nursing.write',
  'lab.read',
  'imaging.read',
  'pharmacy.read',
  'reports.clinical.read',
];

/**
 * Roles seeded into every deployment.
 * `clinical: true` marks roles with a legitimate clinical need to see records.
 * @type {Record<string, {name: string, description: string, clinical: boolean, permissions: string[]}>}
 */
export const ROLES = {
  super_admin: {
    name: 'Super Admin',
    description: 'System administrator for the whole deployment. No clinical access by default.',
    clinical: false,
    permissions: ALL_PERMISSIONS.filter((p) => !CLINICAL_PERMISSIONS.includes(p)),
  },
  facility_admin: {
    name: 'Facility Admin',
    description: 'Administers one facility: staff, setup, catalogues and price lists.',
    clinical: false,
    permissions: pick([
      'facilities.',
      'users.',
      'roles.read',
      'audit.',
      'settings.manage',
      'dashboard.read',
      'patients.read',
      'patients.merge',
      'patients.restrict',
      'patients.export',
      'ipd.read',
      'ipd.beds.manage',
      'billing.read',
      'billing.pricelist.manage',
      'lab.catalogue.manage',
      'imaging.catalogue.manage',
      'pharmacy.rules.manage',
      'inventory.read',
      'inventory.items.manage',
      'claims.read',
      'claims.payers.manage',
      'reports.',
    ]),
  },
  records_clerk: {
    name: 'Records Clerk',
    description: 'Registers patients and checks them in.',
    clinical: false,
    permissions: pick([
      'patients.read',
      'patients.create',
      'patients.update',
      'patients.consent.manage',
      'opd.checkin',
      'opd.queue.read',
      'opd.queue.manage',
      'claims.eligibility.check',
    ]),
  },
  triage_nurse: {
    name: 'Triage Nurse',
    description: 'Records vitals and routes patients from triage.',
    clinical: true,
    permissions: pick([
      'dashboard.read',
      'patients.read',
      'emr.read',
      'emr.vitals.write',
      'emr.notes.write',
      'emr.notes.sign',
      'emr.allergies.write',
      'emr.break_glass',
      'opd.queue.read',
      'opd.queue.manage',
    ]),
  },
  doctor: {
    name: 'Clinician / Doctor',
    description: 'Consults, diagnoses, orders and prescribes.',
    clinical: true,
    permissions: pick(CLINICIAN),
  },
  clinical_officer: {
    name: 'Clinical Officer',
    description: 'Consults, diagnoses, orders and prescribes.',
    clinical: true,
    permissions: pick(CLINICIAN),
  },
  ward_nurse: {
    name: 'Nurse (Ward)',
    description: 'Inpatient nursing care, vitals and medication administration.',
    clinical: true,
    permissions: pick([
      'dashboard.read',
      'patients.read',
      'emr.read',
      'emr.vitals.write',
      'emr.notes.write',
      'emr.notes.sign',
      'emr.allergies.write',
      'emr.attachments.write',
      'emr.break_glass',
      'ipd.read',
      'ipd.transfer',
      'ipd.nursing.write',
      'ipd.mar.write',
      'ipd.beds.manage',
      'inventory.read',
      'inventory.requisition.create',
      'inventory.receive',
    ]),
  },
  pharmacist: {
    name: 'Pharmacist',
    description: 'Dispenses, manages pharmacy rules and pharmacy stock.',
    clinical: true,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'dashboard.read',
      'patients.read',
      'emr.read',
      'pharmacy.',
      'inventory.read',
      'inventory.requisition.create',
      'inventory.receive',
      'inventory.stocktake.perform',
      'reports.operational.read',
    ]),
  },
  pharmacy_tech: {
    name: 'Pharmacy Tech',
    description: 'Dispenses under pharmacist supervision and sells OTC.',
    clinical: false,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'patients.read',
      'pharmacy.read',
      'pharmacy.dispense',
      'pharmacy.otc.sell',
      'inventory.read',
      'inventory.requisition.create',
      'inventory.receive',
    ]),
  },
  lab_technologist: {
    name: 'Lab Technologist',
    description: 'Collects and receives samples and enters results.',
    clinical: true,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'patients.read',
      'lab.read',
      'lab.samples.collect',
      'lab.samples.receive',
      'lab.results.enter',
      'inventory.read',
      'inventory.requisition.create',
      'inventory.receive',
    ]),
  },
  lab_supervisor: {
    name: 'Lab Supervisor',
    description: 'Verifies and releases results; manages the catalogue.',
    clinical: true,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'dashboard.read',
      'patients.read',
      'emr.read',
      'lab.',
      'inventory.read',
      'inventory.requisition.create',
      'inventory.receive',
      'inventory.stocktake.perform',
      'reports.operational.read',
    ]),
  },
  radiographer: {
    name: 'Radiographer',
    description: 'Schedules and performs imaging.',
    clinical: true,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'patients.read',
      'imaging.read',
      'imaging.schedule',
      'imaging.perform',
    ]),
  },
  radiologist: {
    name: 'Radiologist',
    description: 'Reports and releases imaging.',
    clinical: true,
    permissions: pick(['dashboard.read', 'patients.read', 'emr.read', 'imaging.']),
  },
  cashier: {
    name: 'Cashier',
    description: 'Receives payments and runs a cashier shift.',
    clinical: false,
    permissions: pick([
      'opd.queue.read',
      'opd.queue.manage',
      'patients.read',
      'billing.read',
      'billing.payment.receive',
      'billing.shift.manage',
      'billing.refund.request',
      'billing.waiver.request',
    ]),
  },
  billing_officer: {
    name: 'Billing Officer',
    description: 'Manages bills, invoices, manual charges and approvals.',
    clinical: false,
    permissions: pick([
      'dashboard.read',
      'patients.read',
      'billing.read',
      'billing.charge.manual',
      'billing.invoice.create',
      'billing.refund.request',
      'billing.waiver.request',
      'billing.waiver.approve',
      'billing.payment.receive',
      'claims.read',
      'claims.eligibility.check',
      'reports.financial.read',
      'reports.export',
    ]),
  },
  claims_officer: {
    name: 'Claims Officer',
    description: 'Eligibility, preauthorization, claims and remittances.',
    clinical: false,
    permissions: pick([
      'dashboard.read',
      'patients.read',
      'billing.read',
      'billing.invoice.create',
      'claims.read',
      'claims.eligibility.check',
      'claims.preauth.request',
      'claims.create',
      'claims.submit',
      'claims.remittance.reconcile',
      'reports.financial.read',
      'reports.export',
    ]),
  },
  storekeeper: {
    name: 'Storekeeper',
    description: 'Runs the main store: GRNs, issues, purchase orders and stock takes.',
    clinical: false,
    permissions: pick([
      'dashboard.read',
      'inventory.read',
      'inventory.items.manage',
      'inventory.requisition.create',
      'inventory.requisition.approve',
      'inventory.issue',
      'inventory.receive',
      'inventory.po.manage',
      'inventory.stocktake.perform',
      'reports.operational.read',
      'reports.export',
    ]),
  },
  accountant: {
    name: 'Accountant',
    description: 'Finance oversight: approvals, reconciliation and financial reports.',
    clinical: false,
    permissions: pick([
      'dashboard.read',
      'billing.read',
      'billing.refund.approve',
      'billing.waiver.approve',
      'claims.read',
      'claims.remittance.reconcile',
      'inventory.read',
      'inventory.stocktake.approve',
      'reports.financial.read',
      'reports.operational.read',
      'reports.export',
    ]),
  },
  facility_manager: {
    name: 'Facility Manager',
    description: 'Read-only access to the dashboard and reports.',
    clinical: false,
    permissions: pick(['dashboard.read', 'reports.']),
  },
};

/** @type {readonly string[]} */
export const ROLE_CODES = Object.freeze(Object.keys(ROLES));

/** Roles that must enrol TOTP 2FA before using the system. */
export const TWO_FACTOR_ROLES = Object.freeze([
  'super_admin',
  'facility_admin',
  'accountant',
  'billing_officer',
  'claims_officer',
]);

/**
 * @typedef {Object} Grant
 * @property {string} role
 * @property {string|null} facilityId   null = every facility in the deployment
 * @property {string|null} departmentId null = every department in the facility
 * @property {string[]} permissions
 */

/**
 * Decide whether a set of role grants allows a permission in a scope.
 * - Facility: a grant applies when its facility is null (deployment-wide) or
 *   equals the scope's facility.
 * - Department: when the check names a department, the grant's department
 *   must be null or equal to it. When the check names no department
 *   (`departmentId` undefined), department-scoped grants also count; the
 *   caller then narrows data with {@link grantedDepartments}.
 * @param {Grant[]} grants
 * @param {string} permission
 * @param {{facilityId?: string|null, departmentId?: string|null}} [scope]
 * @returns {boolean}
 */
export function hasPermission(grants, permission, scope = {}) {
  const { facilityId = null, departmentId } = scope;
  return grants.some((g) => {
    if (!g.permissions.includes(permission)) return false;
    if (g.facilityId !== null && g.facilityId !== facilityId) return false;
    if (departmentId !== undefined && g.departmentId !== null && g.departmentId !== departmentId) return false;
    return true;
  });
}

/**
 * Departments in which a permission is held at a facility.
 * @param {Grant[]} grants
 * @param {string} permission
 * @param {string|null} facilityId
 * @returns {string[]|null} null = every department; [] = none
 */
export function grantedDepartments(grants, permission, facilityId) {
  const depts = new Set();
  for (const g of grants) {
    if (!g.permissions.includes(permission)) continue;
    if (g.facilityId !== null && g.facilityId !== facilityId) continue;
    if (g.departmentId === null) return null;
    depts.add(g.departmentId);
  }
  return [...depts];
}

/**
 * True when the user holds a deployment-wide grant (facility_id NULL) for the
 * permission — e.g. a Super Admin creating facilities.
 * @param {Grant[]} grants
 * @param {string} permission
 */
export function hasGlobalPermission(grants, permission) {
  return grants.some((g) => g.facilityId === null && g.permissions.includes(permission));
}

/**
 * Permission codes available at a facility from any grant there, including
 * department-scoped ones. Drives what the UI shows; the API still checks
 * every request with the department in scope.
 * @param {Grant[]} grants
 * @param {string|null} facilityId
 * @returns {string[]}
 */
export function effectivePermissions(grants, facilityId) {
  const set = new Set();
  for (const g of grants) {
    if (g.facilityId === null || g.facilityId === facilityId) g.permissions.forEach((p) => set.add(p));
  }
  return [...set].sort();
}

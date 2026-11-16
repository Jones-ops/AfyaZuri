import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  CLINICAL_PERMISSIONS,
  ROLES,
  effectivePermissions,
  grantedDepartments,
  hasGlobalPermission,
  hasPermission,
} from '../src/permissions.js';

const F1 = 'f1';
const F2 = 'f2';
const LAB = 'dept-lab';
const OPD = 'dept-opd';

describe('role matrix', () => {
  it('only references defined permissions', () => {
    for (const [code, role] of Object.entries(ROLES))
      for (const p of role.permissions) expect(ALL_PERMISSIONS, `${code} → ${p}`).toContain(p);
  });

  it('never gives clinical permissions to non-clinical roles', () => {
    for (const [code, role] of Object.entries(ROLES)) {
      if (role.clinical) continue;
      const leaked = role.permissions.filter((p) => CLINICAL_PERMISSIONS.includes(p));
      expect(leaked, code).toEqual([]);
    }
  });

  it('keeps billing staff away from clinical notes', () => {
    for (const r of ['cashier', 'billing_officer', 'claims_officer', 'accountant'])
      expect(ROLES[r].permissions).not.toContain('emr.read');
  });

  it('makes the facility manager read-only', () => {
    expect(ROLES.facility_manager.permissions.every((p) => p.endsWith('.read') || p === 'reports.export')).toBe(true);
  });

  it('seeds all 19 required roles', () => {
    expect(Object.keys(ROLES)).toHaveLength(19);
  });
});

describe('hasPermission', () => {
  const grants = [
    {
      role: 'lab_technologist',
      facilityId: F1,
      departmentId: LAB,
      permissions: ['lab.results.enter', 'patients.read'],
    },
    { role: 'doctor', facilityId: F2, departmentId: null, permissions: ['emr.read'] },
  ];

  it('applies facility scope', () => {
    expect(hasPermission(grants, 'emr.read', { facilityId: F2 })).toBe(true);
    expect(hasPermission(grants, 'emr.read', { facilityId: F1 })).toBe(false);
  });

  it('applies department scope when the check names a department', () => {
    expect(hasPermission(grants, 'lab.results.enter', { facilityId: F1, departmentId: LAB })).toBe(true);
    expect(hasPermission(grants, 'lab.results.enter', { facilityId: F1, departmentId: OPD })).toBe(false);
  });

  it('accepts department-scoped grants when no department is named', () => {
    expect(hasPermission(grants, 'lab.results.enter', { facilityId: F1 })).toBe(true);
  });

  it('lets deployment-wide grants apply at any facility', () => {
    const g = [{ role: 'super_admin', facilityId: null, departmentId: null, permissions: ['users.manage'] }];
    expect(hasPermission(g, 'users.manage', { facilityId: F1 })).toBe(true);
    expect(hasGlobalPermission(g, 'users.manage')).toBe(true);
    expect(hasGlobalPermission(grants, 'emr.read')).toBe(false);
  });

  it('denies unknown permissions', () => {
    expect(hasPermission(grants, 'billing.waiver.approve', { facilityId: F1 })).toBe(false);
  });
});

describe('grantedDepartments and effectivePermissions', () => {
  it('lists the departments a permission is held in', () => {
    const g = [
      { role: 'a', facilityId: F1, departmentId: LAB, permissions: ['x'] },
      { role: 'b', facilityId: F1, departmentId: OPD, permissions: ['x'] },
    ];
    expect(grantedDepartments(g, 'x', F1).sort()).toEqual([LAB, OPD].sort());
    expect(grantedDepartments(g, 'x', F2)).toEqual([]);
    expect(
      grantedDepartments([...g, { role: 'c', facilityId: F1, departmentId: null, permissions: ['x'] }], 'x', F1),
    ).toBeNull();
  });

  it('unions permissions at a facility', () => {
    const g = [
      { role: 'a', facilityId: F1, departmentId: null, permissions: ['b', 'a'] },
      { role: 'b', facilityId: F2, departmentId: null, permissions: ['c'] },
      { role: 'c', facilityId: null, departmentId: null, permissions: ['a', 'd'] },
    ];
    expect(effectivePermissions(g, F1)).toEqual(['a', 'b', 'd']);
  });
});

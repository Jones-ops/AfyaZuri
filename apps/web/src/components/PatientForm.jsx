import { useQuery } from '@tanstack/react-query';
import { KIN_RELATIONSHIPS, MARITAL_STATUS } from '@afyazuri/shared';
import { api } from '../api.js';
import { Field } from './ui.jsx';

export const ID_FIELDS = [
  ['national_id', 'National ID'],
  ['sha_number', 'SHA number'],
  ['birth_certificate', 'Birth certificate no.'],
  ['passport', 'Passport no.'],
  ['alien_id', 'Alien ID'],
];

/** Convert form values to the API's patient body (identifiers array, empty strings dropped). */
export function toPatientBody(v) {
  const identifiers = ID_FIELDS.map(([type]) => ({ type, value: (v.ids?.[type] ?? '').trim() })).filter((i) => i.value);
  const body = {
    firstName: v.firstName,
    middleName: v.middleName || null,
    lastName: v.lastName,
    sex: v.sex,
    phone: v.phone || null,
    email: v.email || null,
    countyCode: v.countyCode || null,
    subCountyId: v.subCountyId ? Number(v.subCountyId) : null,
    adminWardId: v.adminWardId ? Number(v.adminWardId) : null,
    village: v.village || null,
    occupation: v.occupation || null,
    maritalStatus: v.maritalStatus || null,
    nextOfKin: v.kinName
      ? { name: v.kinName, relationship: v.kinRelationship || 'relative', phone: v.kinPhone || null }
      : null,
    identifiers,
  };
  if (v.ageMode === 'estimated')
    body.estimatedAge = { years: Number(v.ageYears || 0), months: Number(v.ageMonths || 0) };
  else body.dateOfBirth = v.dateOfBirth;
  return body;
}

/** Patient API object → form values. */
export function fromPatient(p) {
  const ids = Object.fromEntries((p.identifiers ?? []).map((i) => [i.type, i.value]));
  return {
    firstName: p.firstName,
    middleName: p.middleName ?? '',
    lastName: p.lastName,
    sex: p.sex,
    ageMode: 'dob',
    dateOfBirth: p.dateOfBirth,
    phone: p.phone ?? '',
    email: p.email ?? '',
    countyCode: p.countyCode ?? '',
    subCountyId: p.subCountyId ?? '',
    adminWardId: p.adminWardId ?? '',
    village: p.village ?? '',
    occupation: p.occupation ?? '',
    maritalStatus: p.maritalStatus ?? '',
    kinName: p.nextOfKin?.name ?? '',
    kinRelationship: p.nextOfKin?.relationship ?? '',
    kinPhone: p.nextOfKin?.phone ?? '',
    ids,
  };
}

/** Issues from a 400 response keyed by form path, for inline messages. */
export function issueMap(error) {
  const out = {};
  for (const i of error?.details?.issues ?? []) out[i.path] = i.message;
  return out;
}

/**
 * Shared demographics fields for registration and editing.
 * @param {{form: import('react-hook-form').UseFormReturn<any>, issues?: Record<string, string>}} props
 */
export default function PatientFields({ form, issues = {} }) {
  const { register, watch } = form;
  const ageMode = watch('ageMode');
  const county = watch('countyCode');
  const sub = watch('subCountyId');
  const counties = useQuery({
    queryKey: ['counties'],
    queryFn: () => api.get('/admin-units/counties'),
    staleTime: Infinity,
  });
  const subs = useQuery({
    queryKey: ['subcounties', county],
    queryFn: () => api.get(`/admin-units/counties/${county}/sub-counties`),
    enabled: !!county,
    staleTime: Infinity,
  });
  const wards = useQuery({
    queryKey: ['wards-admin', sub],
    queryFn: () => api.get(`/admin-units/sub-counties/${sub}/wards`),
    enabled: !!sub,
    staleTime: Infinity,
  });

  return (
    <>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Name and sex</legend>
        <Field label="First name" required error={issues.firstName}>
          <input className="input" autoFocus {...register('firstName', { required: true })} />
        </Field>
        <Field label="Middle name" error={issues.middleName}>
          <input className="input" {...register('middleName')} />
        </Field>
        <Field label="Last name" required error={issues.lastName}>
          <input className="input" {...register('lastName', { required: true })} />
        </Field>
        <Field label="Sex" required error={issues.sex}>
          <select className="input" {...register('sex', { required: true })}>
            <option value="">Choose…</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="intersex">Intersex</option>
            <option value="unknown">Unknown</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Age</legend>
        <div className="flex items-center gap-4 sm:col-span-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="dob" {...register('ageMode')} /> Date of birth known
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="estimated" {...register('ageMode')} /> Estimate age
          </label>
        </div>
        {ageMode === 'estimated' ? (
          <>
            <Field label="Years" error={issues['estimatedAge.years']}>
              <input className="input" type="number" min="0" max="120" inputMode="numeric" {...register('ageYears')} />
            </Field>
            <Field label="Months" error={issues['estimatedAge.months']}>
              <input className="input" type="number" min="0" max="11" inputMode="numeric" {...register('ageMonths')} />
            </Field>
          </>
        ) : (
          <Field label="Date of birth" required error={issues.dateOfBirth}>
            <input className="input" type="date" {...register('dateOfBirth')} />
          </Field>
        )}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Identification</legend>
        {ID_FIELDS.map(([type, label]) => (
          <Field key={type} label={label}>
            <input className="input" autoCapitalize="characters" {...register(`ids.${type}`)} />
          </Field>
        ))}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Contact and residence</legend>
        <Field label="Phone" hint="e.g. 0712 345 678" error={issues.phone}>
          <input className="input" inputMode="tel" {...register('phone')} />
        </Field>
        <Field label="Email" error={issues.email}>
          <input className="input" type="email" {...register('email')} />
        </Field>
        <Field label="County">
          <select className="input" {...register('countyCode')}>
            <option value="">—</option>
            {counties.data?.data.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sub-county">
          <select className="input" {...register('subCountyId')} disabled={!county}>
            <option value="">—</option>
            {subs.data?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ward">
          <select className="input" {...register('adminWardId')} disabled={!sub}>
            <option value="">—</option>
            {wards.data?.data.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Village / estate">
          <input className="input" {...register('village')} />
        </Field>
        <Field label="Occupation">
          <input className="input" {...register('occupation')} />
        </Field>
        <Field label="Marital status">
          <select className="input" {...register('maritalStatus')}>
            <option value="">—</option>
            {MARITAL_STATUS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Next of kin</legend>
        <Field label="Name" error={issues['nextOfKin.name']}>
          <input className="input" {...register('kinName')} />
        </Field>
        <Field label="Relationship">
          <select className="input" {...register('kinRelationship')}>
            <option value="">—</option>
            {KIN_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phone" error={issues['nextOfKin.phone']}>
          <input className="input" inputMode="tel" {...register('kinPhone')} />
        </Field>
      </fieldset>
    </>
  );
}

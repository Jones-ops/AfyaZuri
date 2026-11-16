import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('triage records vitals, the doctor documents and codes the visit, and the chart shows it', async ({
  page,
  browser,
}) => {
  // Setup through the API as the records clerk: an SHA patient checked in (goes to triage).
  await signIn(page, 'records');
  const scheme = (await (await page.request.get('/api/v1/schemes')).json()).data.find((s) => s.code === 'SHIF');
  const name = `${cap(letters(7))} ${cap(letters(8))}`;
  const [firstName, lastName] = name.split(' ');
  const patient = await (
    await page.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName,
        lastName,
        sex: 'female',
        dateOfBirth: '1975-02-20',
        payerScheme: { schemeId: scheme.id, memberNumber: `SHA-${letters(6)}` },
      },
    })
  ).json();
  const visit = await (
    await page.request.post('/api/v1/encounters', {
      headers: H,
      data: { patientId: patient.id, patientPayerSchemeId: patient.payerSchemes[0].id },
    })
  ).json();

  // Triage nurse opens the visit and records vitals; flags appear before saving.
  const nurseCtx = await browser.newContext();
  const nurse = await nurseCtx.newPage();
  await signIn(nurse, 'triage');
  await nurse.goto(`/encounters/${visit.id}`);
  await expect(nurse.getByRole('region', { name: 'Patient' })).toContainText(name);
  await nurse.getByLabel('BP systolic (mmHg)').fill('184');
  await nurse.getByLabel('BP diastolic (mmHg)').fill('104');
  await nurse.getByLabel('Temperature (°C)').fill('37.0');
  await nurse.getByLabel('Weight (kg)').fill('78');
  await nurse.getByLabel('Height (cm)').fill('165');
  await expect(nurse.getByText('BMI 28.7', { exact: true })).toBeVisible();
  await expect(nurse.getByText('BMI 28.7: overweight')).toBeVisible();
  await expect(nurse.getByText('Systolic BP ≥ 180: hypertensive urgency').first()).toBeVisible();
  await nurse.getByRole('button', { name: 'Save vitals' }).click();
  await expect(nurse.getByText(/BP 184\/104 · T 37°C · Wt 78 kg · Ht 165 cm · BMI 28\.7/)).toBeVisible();
  await nurseCtx.close();

  // Doctor writes and signs a note, then codes the diagnosis.
  const docCtx = await browser.newContext();
  const doc = await docCtx.newPage();
  await signIn(doc, 'doctor');
  await doc.goto(`/encounters/${visit.id}`);
  await doc.getByLabel('Subjective').fill('Headache and dizziness for 2 days');
  await doc.getByLabel('Assessment').fill('Hypertensive urgency');
  await doc.getByLabel('Plan').fill('Oral antihypertensive, review in 1 hour');
  await doc.getByRole('button', { name: 'Save and sign' }).click();
  await expect(doc.getByText('signed', { exact: true })).toBeVisible();
  await expect(doc.getByText('KMPDC KMPDC-DEMO-2001')).toBeVisible();

  await doc.getByRole('button', { name: 'Add addendum' }).click();
  await doc.getByLabel('Addendum').fill('BP after 1 hour: 158/96');
  await doc.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(doc.getByText('BP after 1 hour: 158/96')).toBeVisible();

  await doc.getByLabel('Search ICD-11 (name or code)').fill('hypertension');
  await doc.getByRole('listbox', { name: 'ICD-11 matches' }).getByRole('button', { name: /BA00/ }).click();
  await expect(doc.getByText('Essential hypertension')).toBeVisible();
  await expect(doc.getByText('(ICD-10 I10)')).toBeVisible();

  // The chart's timeline brings it together.
  await doc.getByRole('link', { name: 'Full chart' }).click();
  const timeline = doc.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toContainText('BA00');
  await expect(timeline).toContainText('Hypertensive urgency');
  await expect(timeline).toContainText('BP 184/104');
  await docCtx.close();
});

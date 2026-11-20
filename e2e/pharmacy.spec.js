import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('doctor prescribes past a mild-allergy warning; the pharmacy dispenses FEFO and bills', async ({ browser }) => {
  // Records registers and checks in; the doctor records a mild ibuprofen allergy.
  const rec = await (await browser.newContext()).newPage();
  await signIn(rec, 'records');
  const patient = await (
    await rec.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1980-07-04',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  const visit = await (
    await rec.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();

  const docCtx = await browser.newContext();
  const doc = await docCtx.newPage();
  await signIn(doc, 'doctor');
  await doc.request.post(`/api/v1/patients/${patient.id}/allergies`, {
    headers: H,
    data: { category: 'drug', allergen: 'Ibuprofen', severity: 'mild', reaction: 'Itchy rash' },
  });

  await doc.goto(`/encounters/${visit.id}`);
  const rx = doc.getByRole('region', { name: 'Prescriptions' });
  await rx.getByRole('button', { name: 'Prescribe' }).click();
  await rx.getByLabel('Add a drug').fill('paraceta');
  await doc.getByRole('option', { name: /Paracetamol 500 mg tablets/ }).click();
  await rx.getByLabel('Dose').fill('1000');
  await rx.getByLabel('How often').selectOption('QID');
  await rx.getByLabel('Days').fill('3');
  await rx.getByLabel('Add a drug').fill('ibupro');
  await doc.getByRole('option', { name: /Ibuprofen 400 mg tablets/ }).click();

  await rx.getByRole('button', { name: 'Check safety' }).click();
  const warning = rx.getByRole('alert').filter({ hasText: /allergy to Ibuprofen/ });
  await expect(warning).toBeVisible();
  await expect(rx.getByRole('button', { name: 'Prescribe' }).last()).toBeDisabled();
  await warning.getByRole('textbox').fill('Rash was mild; short course with antihistamine cover');
  await rx.getByRole('button', { name: 'Prescribe' }).last().click();
  await expect(rx.getByText(/RX-\d{4}-\d{6}/)).toBeVisible();
  await expect(rx).toContainText('ALLERGY acknowledged');

  // Pharmacy technician dispenses.
  const tech = await (await browser.newContext()).newPage();
  await signIn(tech, 'pharmtech');
  await tech.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pharmacy' }).click();
  await tech.getByLabel('Find').fill(patient.mrn);
  await tech
    .getByRole('region', { name: 'Worklist' })
    .getByRole('button', { name: new RegExp(patient.mrn) })
    .click();
  await expect(tech.getByLabel('Allergies')).toContainText('Ibuprofen (mild)');
  await expect(tech.getByText(/Prescriber overrode/)).toBeVisible();
  await expect(tech.getByLabel('Quantity of Paracetamol 500 mg tablets')).toHaveValue('24');
  await tech.getByRole('button', { name: 'Dispense and bill' }).click();
  const done = tech.getByRole('status').filter({ hasText: /^Dispensed for/ });
  await expect(done).toContainText('Paracetamol 500 mg tablets × 24');
  await expect(done).toContainText('Added to the patient’s bill');

  await docCtx.close();
});

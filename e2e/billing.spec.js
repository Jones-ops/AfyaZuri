import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('check-in posts charges automatically; the billing office adjusts the bill', async ({ page, browser }) => {
  // Records clerk checks in a new cash patient (via the API to keep the test short).
  await signIn(page, 'records');
  const patient = await (
    await page.request.post('/api/v1/patients', {
      headers: H,
      data: { firstName: cap(letters(7)), lastName: cap(letters(8)), sex: 'female', dateOfBirth: '1991-06-02' },
    })
  ).json();
  await page.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } });

  // The queue board warns that this pay-first patient has not paid.
  const nurseCtx = await browser.newContext();
  const nurse = await nurseCtx.newPage();
  await signIn(nurse, 'cashier');
  await nurse.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Queues' }).click();
  await nurse
    .getByRole('main')
    .getByRole('link', { name: /^Cashier/ })
    .click();
  await expect(nurse.getByRole('listitem').filter({ hasText: patient.fullName })).toContainText('Unpaid KES 700.00');
  await nurseCtx.close();

  // Billing officer finds the bill and adjusts it.
  const ctx = await browser.newContext();
  const billing = await ctx.newPage();
  await signIn(billing, 'billing');
  await billing.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Billing', exact: true }).click();
  await billing.getByLabel('Search bills').fill(patient.mrn);
  await billing.getByRole('row').filter({ hasText: patient.mrn }).getByRole('link', { name: /^BIL-/ }).click();
  await expect(billing.getByTestId('balance')).toHaveText('KES 700.00');
  await expect(billing.getByRole('region', { name: 'Totals' })).toBeVisible();

  await billing.getByLabel('Add a charge').selectOption({ label: 'Wound dressing (KES 300.00)' });
  await billing.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(billing.getByTestId('balance')).toHaveText('KES 1,000.00');

  billing.once('dialog', (d) => d.accept('Returning patient, already registered'));
  await billing
    .getByRole('row', { name: /Registration \(new patient\)/ })
    .getByRole('button', { name: 'Void' })
    .click();
  await expect(billing.getByTestId('balance')).toHaveText('KES 800.00');
  await expect(billing.getByText('voided: Returning patient, already registered')).toBeVisible();
  await ctx.close();
});

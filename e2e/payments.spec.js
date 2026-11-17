import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

async function checkInCashPatient(page) {
  const patient = await (
    await page.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1984-02-11',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  const visit = await (
    await page.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();
  return { patient, visit };
}

test('cashier takes cash and M-Pesa, prints a receipt, and the patient moves on to triage', async ({
  page,
  browser,
}) => {
  await signIn(page, 'records');
  const a = await checkInCashPatient(page);
  const b = await checkInCashPatient(page);

  const ctx = await browser.newContext();
  const cashier = await ctx.newPage();
  await signIn(cashier, 'cashier');

  // Open the shift.
  await cashier.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Cashier desk' }).click();
  await cashier.getByLabel('Opening float (cash in the drawer, KES)').fill('1000');
  await cashier.getByRole('button', { name: 'Open shift' }).click();
  await expect(cashier.getByRole('region', { name: 'Current shift' })).toBeVisible();

  // Cash: from the cashier queue straight to the bill.
  await cashier
    .getByRole('main')
    .getByRole('link', { name: /waiting to pay/ })
    .click();
  await cashier
    .getByRole('listitem')
    .filter({ hasText: a.patient.fullName })
    .getByRole('link', { name: 'Take payment' })
    .click();
  await expect(cashier.getByTestId('balance')).toHaveText('KES 700.00');
  await cashier.getByLabel('Cash handed over').fill('1000');
  await expect(cashier.getByText('Change: KES 300.00')).toBeVisible();
  await cashier.getByRole('button', { name: 'Receive cash' }).click();
  const notice = cashier.getByRole('status').filter({ hasText: 'Paid KES 700.00' });
  await expect(notice).toContainText('Change due KES 300.00');
  await expect(notice).toContainText('patient sent to Triage');
  await expect(cashier.getByTestId('balance')).toHaveText('KES 0.00');

  await notice.getByRole('link', { name: /^RCT-/ }).click();
  await expect(cashier.getByText('OFFICIAL RECEIPT / STAKABADHI')).toBeVisible();
  await expect(cashier.getByText(a.patient.mrn)).toBeVisible();
  await expect(cashier.getByText('Pesa taslimu')).toBeVisible();

  // M-Pesa via the mock Daraja server.
  const bill = await (await cashier.request.get(`/api/v1/encounters/${b.visit.id}/bill`)).json();
  await cashier.goto(`/billing/bills/${bill.id}`);
  await cashier.getByRole('tab', { name: 'M-Pesa' }).click();
  await expect(cashier.getByLabel('Phone number')).toHaveValue(/^07\d{8}$/); // prefilled from the record
  await cashier.getByRole('button', { name: 'Send M-Pesa prompt' }).click();
  await expect(cashier.getByRole('status').filter({ hasText: 'Paid KES 700.00' })).toBeVisible({ timeout: 15_000 });
  await expect(cashier.getByTestId('balance')).toHaveText('KES 0.00');

  // Close the shift: 1000 float + 700 cash expected.
  await cashier.goto('/cashier');
  const shift = cashier.getByRole('region', { name: 'Current shift' });
  await expect(shift.getByRole('row', { name: /^Cash/ })).toContainText('1,700.00');
  await shift.getByLabel('Cash counted').fill('1700');
  await shift.getByLabel('M-Pesa counted').fill('700');
  cashier.once('dialog', (d) => d.accept());
  await shift.getByRole('button', { name: 'Close shift' }).click();
  await expect(cashier.getByRole('button', { name: 'Open shift' })).toBeVisible();
  await ctx.close();
});

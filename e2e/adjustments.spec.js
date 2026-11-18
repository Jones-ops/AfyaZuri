import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('credit note and refund need a second person, reach eTIMS, and the patient gets an SMS', async ({
  page,
  browser,
}) => {
  // Records: an SMS-consenting cash patient, checked in.
  await signIn(page, 'records');
  const patient = await (
    await page.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'female',
        dateOfBirth: '1990-05-14',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        consents: [{ consentType: 'sms', granted: true, method: 'verbal' }],
      },
    })
  ).json();
  const visit = await (
    await page.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();

  // Cashier: takes 700 in cash.
  const cashierCtx = await browser.newContext();
  const cashier = await cashierCtx.newPage();
  await signIn(cashier, 'cashier');
  await cashier.request.post('/api/v1/shifts', { headers: H, data: { openingFloat: '1000' } }); // 409 if already open
  const bill = await (await cashier.request.get(`/api/v1/encounters/${visit.id}/bill`)).json();
  const paid = await cashier.request.post(`/api/v1/bills/${bill.id}/payments`, {
    headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'cash', amount: '700' },
  });
  expect(paid.status()).toBe(201);

  // The receipt reaches eTIMS and the patient is texted (both run after the payment commits).
  await cashier.goto(`/billing/bills/${bill.id}`);
  const payments = cashier.getByRole('region', { name: 'Payments' });
  await expect(async () => {
    await cashier.reload();
    await expect(payments.getByText(/^KRACU/)).toBeVisible({ timeout: 1000 });
    await expect(payments.getByRole('cell', { name: 'Sent' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  // Billing officer: raises a credit note for the wrong registration fee.
  const billingCtx = await browser.newContext();
  const billing = await billingCtx.newPage();
  await signIn(billing, 'billing');
  await billing.goto(`/billing/bills/${bill.id}`);
  const adj = billing.getByRole('region', { name: 'Waivers, credit notes and refunds' });
  await adj.getByRole('tab', { name: 'Credit note' }).click();
  await adj.getByLabel('Amount (KES)').fill('200');
  await adj.getByLabel('Reason').fill('Returning patient charged the new-patient fee');
  await adj.getByRole('button', { name: 'Request approval' }).click();
  await expect(adj.getByText('Credit note of KES 200.00 sent for approval.')).toBeVisible();
  await expect(adj.getByRole('button', { name: 'Approve' })).toHaveCount(0); // cannot approve credit notes

  // Accountant: approves it from the inbox.
  const accCtx = await browser.newContext();
  const acc = await accCtx.newPage();
  await signIn(acc, 'accountant');
  await acc.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals' }).click();
  const item = acc.getByRole('listitem').filter({ hasText: bill.billNumber }).filter({ hasText: 'Credit note' });
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toHaveCount(0);

  // Cashier: the bill now shows the overpayment; asks for the refund.
  await cashier.reload();
  await expect(cashier.getByTestId('balance')).toHaveText('KES -200.00');
  await expect(cashier.getByText('Overpaid (refund due)')).toBeVisible();
  const cAdj = cashier.getByRole('region', { name: 'Waivers, credit notes and refunds' });
  await expect(cAdj.getByText(/^CRN-\d{4}-\d{6}$/)).toBeVisible();
  await cAdj.getByRole('tab', { name: 'Refund' }).click();
  await cAdj.getByLabel('From payment').selectOption({ index: 1 });
  await cAdj.getByLabel('Amount (KES)').fill('200');
  await cAdj.getByLabel('Reason').fill('Refund of the registration fee credited');
  await cAdj.getByRole('button', { name: 'Request approval' }).click();
  await expect(cAdj.getByText('Refund of KES 200.00 sent for approval.')).toBeVisible();

  // Accountant approves; cashier pays it out of the drawer.
  await acc.reload();
  await acc
    .getByRole('listitem')
    .filter({ hasText: bill.billNumber })
    .filter({ hasText: 'Refund' })
    .getByRole('button', { name: 'Approve' })
    .click();
  await cashier.reload();
  await cAdj.getByRole('button', { name: 'Pay out KES 200.00' }).click();
  await expect(cashier.getByTestId('balance')).toHaveText('KES 0.00');
  await expect(cAdj.getByText(/Paid out by cash/)).toBeVisible();

  // Leave the drawer as other tests expect it: no open shift.
  await cashier.request.post('/api/v1/shifts/current/close', {
    headers: H,
    data: { declared: { cash: '0', mpesa: '0', card: '0', bank: '0' } },
  });
  await Promise.all([cashierCtx.close(), billingCtx.close(), accCtx.close()]);
});

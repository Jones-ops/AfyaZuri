import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('the accountant reconciles today’s takings and exports the debtor list', async ({ page, browser }) => {
  // Records checks a patient in; the visit's 700 stays unpaid, so they are a debtor.
  const recCtx = await browser.newContext();
  const rec = await recCtx.newPage();
  await signIn(rec, 'records');
  const patient = await (
    await rec.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1979-03-21',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  await rec.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } });
  await recCtx.close();

  await signIn(page, 'accountant');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance reports' }).click();
  await expect(page.getByRole('heading', { name: 'Finance reports' })).toBeVisible();

  // Daily revenue: today by default, with the method table and its total row.
  const methods = page.getByRole('region', { name: 'Collections by payment method' });
  await expect(methods.getByRole('row', { name: /^Cash/ })).toBeVisible();
  await expect(methods.getByRole('row', { name: /^Total/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Billed by department' })).toBeVisible();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page.getByRole('region', { name: 'Day by day' }).getByRole('row')).toHaveCount(8); // header + 7 days

  const download = page.waitForEvent('download');
  await methods.getByRole('link', { name: 'CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  expect(csv.replace(/^\s*/u, '').split('\r\n')[0]).toBe('Method,Payments,Received,Refunded,Net');

  // Debtor ageing: the new patient is in 0-30 days.
  await page.getByRole('tab', { name: 'Debtor ageing' }).click();
  await page.getByRole('button', { name: /^0-30 days/ }).click();
  const debtors = page.getByRole('region', { name: /Patients owing \(0-30 days\)/ });
  await expect(debtors.getByRole('row').filter({ hasText: patient.mrn })).toContainText('700.00');

  const dl = page.waitForEvent('download');
  await debtors.getByRole('link', { name: 'CSV' }).click();
  const list = await readFile(await (await dl).path(), 'utf8');
  expect(list).toContain(patient.mrn);
});

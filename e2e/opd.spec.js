import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

test('SHA patient is checked in, routed to triage, and sent on to consultation', async ({ page, browser }) => {
  const first = cap(letters(7));
  const last = cap(letters(8));

  // Records clerk registers an SHA member and checks them in.
  await signIn(page, 'records');
  await page.goto('/patients/new');
  await page.getByLabel(/^First name/).fill(first);
  await page.getByLabel(/^Last name/).fill(last);
  await page.getByLabel(/^Sex/).selectOption('male');
  await page.getByLabel(/^Date of birth/).fill('1979-08-02');
  await page.getByLabel('Scheme').selectOption({ label: 'Social Health Authority — Social Health Insurance Fund' });
  await page.getByLabel(/SHA member number/).fill(`SHA-${letters(6).toUpperCase()}`);
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByText(/Registered with MRN/)).toBeVisible();

  const visit = page.getByRole('region', { name: 'Visit' });
  await visit.getByLabel('Bill to').selectOption({ index: 1 }); // the SHA scheme
  await visit.getByRole('button', { name: 'Check in' }).click();
  await expect(visit.getByText(/please go to Triage/)).toBeVisible();
  const label = (await visit.locator('strong.font-mono').first().textContent()).trim();
  expect(label).toMatch(/^T-\d{3}$/);

  // Triage nurse works the triage queue.
  const nurseCtx = await browser.newContext();
  const nurse = await nurseCtx.newPage();
  await signIn(nurse, 'triage');
  await nurse.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Queues' }).click();
  await nurse.getByRole('link', { name: /^Triage/ }).click();
  const waiting = nurse.getByRole('region', { name: 'Waiting' });
  const ticket = waiting.getByRole('listitem').filter({ hasText: `${first} ${last}` });
  await expect(ticket).toContainText(label);
  await expect(ticket).toContainText('SHA');
  await ticket.getByRole('button', { name: 'Start' }).click();

  const inService = nurse
    .getByRole('region', { name: 'In service' })
    .getByRole('listitem')
    .filter({ hasText: `${first} ${last}` });
  await inService.getByRole('button', { name: 'Send to: Consultation' }).click();
  await expect(nurse.getByText(/Sent on: ticket A-\d{3}|Sent on: ticket B-\d{3}/)).toBeVisible();

  // The public display never shows names.
  const triageUrl = nurse.url();
  await nurse.goto(triageUrl.replace('/opd/queues/', '/opd/display/'));
  await expect(nurse.getByText('Now serving · Anayehudumiwa sasa')).toBeVisible();
  await expect(nurse.getByText(`${first} ${last}`)).toHaveCount(0);
  await nurseCtx.close();

  // Back at the desk, the visit shows the patient is now at consultation.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Visit' })).toContainText(/Consultation Room/);
});

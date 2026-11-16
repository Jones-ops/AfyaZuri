import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

test('records clerk registers a patient, prints a card, finds them, and is warned about a duplicate', async ({
  page,
}) => {
  const first = cap(letters(7));
  const last = cap(letters(8));
  const nationalId = String(30000000 + Math.floor(Math.random() * 9e6));

  await signIn(page, 'records');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Patients' }).click();
  await page.getByRole('link', { name: 'Register patient' }).click();

  await page.getByLabel(/^First name/).fill(first);
  await page.getByLabel(/^Last name/).fill(last);
  await page.getByLabel(/^Sex/).selectOption('female');
  await page.getByLabel(/^Date of birth/).fill('1988-03-14');
  await page.getByLabel('National ID').fill(nationalId);
  await page
    .getByLabel(/^Phone/)
    .first()
    .fill('0711 222 333');
  await page.getByLabel('County', { exact: true }).selectOption({ label: 'Kisumu' });
  await page.getByLabel('Sub-county').selectOption({ label: 'Kisumu Central' });
  await page.getByLabel('Ward', { exact: true }).selectOption({ label: 'Kondele' });
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  const registered = page.getByText(/Registered with MRN/);
  await expect(registered).toBeVisible();
  const mrn = (await registered.locator('strong').textContent()).trim();
  expect(mrn).toMatch(/^99001-\d{4}-\d{6}$/);
  await expect(page.getByRole('region', { name: 'Patient' })).toContainText(`${first} ${last}`);

  await page.getByRole('link', { name: 'Print patient card' }).click();
  await expect(page.getByAltText(`QR code for MRN ${mrn}`)).toBeVisible();

  // "/" jumps to search from anywhere.
  await page.getByRole('link', { name: 'Back to record' }).click();
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/\/patients$/);
  await page.getByLabel('Search patients').fill(mrn);
  await expect(page.getByRole('link', { name: `${first} ${last}` })).toBeVisible();
  await page.getByLabel('Search patients').fill(nationalId);
  await expect(page.getByText('Matched by ID number')).toBeVisible();

  // Same person again: the clerk is shown the existing record.
  await page.goto('/patients/new');
  await page.getByLabel(/^First name/).fill(first);
  await page.getByLabel(/^Last name/).fill(last);
  await page.getByLabel(/^Sex/).selectOption('female');
  await page.getByLabel(/^Date of birth/).fill('1988-03-14');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This patient may already be registered' })).toBeVisible();
  await expect(page.getByText(mrn)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create new anyway' })).toBeDisabled();
  await page.getByRole('link', { name: 'Open this record' }).first().click();
  await expect(page.getByRole('region', { name: 'Patient' })).toContainText(mrn);
});

import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test('facility admin creates a staff account, and the action is audited', async ({ page }) => {
  await signIn(page, 'facadmin');
  await expect(page.getByRole('heading', { name: /Karibu/ })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('heading', { name: 'Staff' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dr. James Mwangi' })).toBeVisible();

  const username = `e2e.nurse.${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'Add staff' }).click();
  await page.getByLabel('Full name').fill('Wairimu E2E');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Initial password').fill('Str0ng!Passw0rd');
  await page.getByLabel('Licensing body').selectOption('NCK');
  await page.getByLabel('Licence number').fill('NCK-E2E-1');
  await page.getByLabel(/^Role/).selectOption('triage_nurse');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Wairimu E2E' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Triage Nurse' })).toBeVisible();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await page.getByLabel('Entity type').fill('user');
  await page.getByLabel('Action').selectOption('create');
  await expect(page.getByRole('cell', { name: 'facadmin' }).first()).toBeVisible();
});

test('a new user must set their own password before using the system', async ({ page, browser }) => {
  await signIn(page, 'facadmin');
  await page.goto('/admin/users');
  const username = `e2e.clerk.${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'Add staff' }).click();
  await page.getByLabel('Full name').fill('Otieno E2E');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Initial password').fill('Temp!Passw0rd1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Otieno E2E' })).toBeVisible();

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signIn(p2, username, 'Temp!Passw0rd1');
  await expect(p2.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  await p2.getByLabel('Current password').fill('Temp!Passw0rd1');
  await p2.getByLabel('New password').fill('Mine!0wnPassword');
  await p2.getByRole('button', { name: 'Change password' }).click();
  await expect(p2.getByRole('heading', { name: /Karibu, Otieno E2E/ })).toBeVisible();
  await ctx.close();
});

test('navigation only offers what the role can use', async ({ page }) => {
  await signIn(page, 'cashier');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Staff' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByText('You do not have access to this page.')).toBeVisible();
});

test('wrong passwords are refused with a clear message', async ({ page }) => {
  await signIn(page, 'doctor', 'not-the-password', { expectSuccess: false });
  await expect(page.getByRole('alert')).toContainText('Incorrect username or password');
});

test('core screens work on a phone @phone', async ({ page }) => {
  await signIn(page, 'facadmin');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Facility setup' }).click();
  await expect(page.getByRole('heading', { name: 'Facility setup' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('sign-in and the staff list are usable at 256 kbps with 300 ms latency @slow-network', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 300,
    downloadThroughput: (256 * 1024) / 8,
    uploadThroughput: (256 * 1024) / 8,
  });

  const t0 = Date.now();
  await signIn(page, 'facadmin');
  await expect(page.getByRole('heading', { name: /Karibu/ })).toBeVisible({ timeout: 30_000 });
  const signInMs = Date.now() - t0;

  const t1 = Date.now();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('link', { name: 'Dr. James Mwangi' })).toBeVisible({ timeout: 15_000 });
  const listMs = Date.now() - t1;

  test.info().annotations.push({ type: 'timing', description: `cold sign-in ${signInMs} ms, staff list ${listMs} ms` });
  expect(signInMs).toBeLessThan(30_000);
  expect(listMs).toBeLessThan(10_000);
});

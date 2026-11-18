import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

const asUser = async (browser, username) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, username);
  return { ctx, page };
};

test('ward requisition: request → approve → issue → receive with a shortfall', async ({ browser }) => {
  const nurse = await asUser(browser, 'wardnurse');
  const n = nurse.page;
  await n.goto('/inventory/requisitions');
  await n.getByRole('button', { name: 'New requisition' }).click();
  await n.getByLabel('For store (yours)').selectOption({ label: 'Ward Store' });
  await n.getByLabel('Request from').selectOption({ label: 'Main Store' });
  await n.getByLabel('Add an item').fill('cannula');
  await n.getByRole('option', { name: /IV cannula/ }).click();
  await n.getByLabel(/Quantity/).fill('20');
  await n.getByRole('button', { name: 'Send requisition' }).click();
  const req = n.getByRole('region', { name: 'Requisitions' }).getByRole('listitem').first();
  await expect(req).toContainText('requested');
  const number = (await req.locator('.font-mono').first().innerText()).trim();

  const keeper = await asUser(browser, 'storekeeper');
  const k = keeper.page;
  await k.goto('/inventory/requisitions');
  const row = k.getByRole('listitem').filter({ hasText: number });
  await row.getByRole('button', { name: new RegExp(number) }).click();
  await row.getByLabel('Approve quantity of IV cannula 20G').fill('15');
  await row.getByRole('button', { name: 'Approve' }).click();
  await row.getByRole('button', { name: 'Issue stock (earliest expiry first)' }).click();
  await expect(row).toContainText('issued');

  await n.reload();
  const mine = n.getByRole('listitem').filter({ hasText: number });
  await mine.getByRole('button', { name: new RegExp(number) }).click();
  await mine.getByLabel('Received').fill('14');
  await mine.getByLabel('Why less?').fill('One cannula packet damaged');
  await mine.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(mine).toContainText('received');
  await expect(mine.getByRole('status').or(mine.getByText(/14 of 15 — One cannula packet damaged/))).toBeVisible();

  await Promise.all([nurse.ctx.close(), keeper.ctx.close()]);
});

test('stock take: blind count, explained variance, approved by someone else', async ({ browser }) => {
  const lab = await asUser(browser, 'labsup');
  const l = lab.page;
  await l.goto('/inventory/stock-takes');
  await l.getByLabel('Store').selectOption({ label: 'Laboratory Store' });
  await l.getByRole('button', { name: 'Start a count' }).click();
  // Blind count: the system quantity is not shown while counting.
  await expect(l.getByRole('columnheader', { name: 'System' })).toHaveCount(0);
  await l.getByLabel(/^Count of Malaria rapid diagnostic test kit/).fill('97');
  await l.getByLabel(/^Reason for Malaria rapid diagnostic test kit/).fill('Three kits used for training');
  await l.getByRole('button', { name: 'Save counts' }).click();
  await l.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(l.getByRole('cell', { name: '-3' })).toBeVisible();

  const acc = await asUser(browser, 'accountant');
  const a = acc.page;
  await a.goto('/inventory/stock-takes');
  await a
    .getByRole('listitem')
    .filter({ hasText: 'Laboratory Store' })
    .filter({ hasText: 'submitted' })
    .getByRole('button')
    .first()
    .click();
  await a.getByRole('button', { name: 'Approve and post variances' }).click();
  await expect(a.getByText('approved').first()).toBeVisible();

  await Promise.all([lab.ctx.close(), acc.ctx.close()]);
});

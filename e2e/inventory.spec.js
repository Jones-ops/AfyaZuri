import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test('storekeeper orders low stock, receives the delivery with batch and expiry, and sees it on the shelf', async ({
  page,
}) => {
  await signIn(page, 'storekeeper');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Stock' }).click();
  await page.getByLabel('Store').selectOption({ label: 'Main Store' });

  // Gloves are below their reorder level.
  await page.getByRole('button', { name: 'Low / out' }).click();
  const stock = page.getByRole('region', { name: 'Stock on hand' });
  const gloves = stock.getByRole('row').filter({ hasText: 'Examination gloves' });
  await expect(gloves).toContainText('low');
  const before = Number(await gloves.getByRole('cell').nth(1).innerText());

  // Order them.
  await page.getByRole('navigation', { name: 'Inventory' }).getByRole('link', { name: 'Purchase orders' }).click();
  await page.getByRole('button', { name: 'New order' }).click();
  await page.getByLabel('Deliver to').selectOption({ label: 'Main Store' });
  await page.getByLabel('Supplier').selectOption({ index: 1 });
  await page.getByLabel('Add an item').fill('gloves');
  await page.getByRole('option', { name: /Examination gloves/ }).click();
  await page.getByLabel('Quantity').fill('1000');
  await page.getByRole('button', { name: 'Create order' }).click();
  await page.getByRole('button', { name: 'Mark as sent to supplier' }).click();
  await page.getByRole('link', { name: 'Receive delivery' }).click();

  // Receive against the order: lines come prefilled with what is outstanding.
  const line = page
    .getByRole('region', { name: 'Lines' })
    .getByRole('listitem')
    .filter({ hasText: 'Examination gloves' });
  await expect(line.getByLabel('Quantity')).toHaveValue('1000');
  await line.getByLabel('Batch no.').fill('GLV-E2E');
  await line.getByLabel('Expiry').fill(inDays(400));
  await page.getByRole('button', { name: 'Receive into stock' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Received as GRN-\d{4}-\d{6}/ })).toBeVisible();

  // On the shelf and in the ledger.
  await page.getByRole('navigation', { name: 'Inventory' }).getByRole('link', { name: 'Stock on hand' }).click();
  await page.getByLabel('Store').selectOption({ label: 'Main Store' });
  await page.getByLabel('Search').fill('gloves');
  const row = page
    .getByRole('region', { name: 'Stock on hand' })
    .getByRole('row')
    .filter({ hasText: 'Examination gloves' });
  await expect(row.getByRole('cell').nth(1)).toHaveText(String(before + 1000));
  await row.getByRole('button', { name: 'Examination gloves (medium)' }).click();
  await expect(page.getByText('GLV-E2E')).toBeVisible();
  await page.getByRole('link', { name: 'Ledger for this item →' }).click();
  await expect(page.getByRole('region', { name: 'Movements' }).getByRole('row').nth(1)).toContainText('+1000');

  // Expired stock is shown as quarantined.
  await page.getByRole('navigation', { name: 'Inventory' }).getByRole('link', { name: 'Expiry' }).click();
  await page.getByRole('button', { name: /^Expired/ }).click();
  await expect(page.getByRole('region', { name: 'Batches' })).toContainText('IBU2380');
});

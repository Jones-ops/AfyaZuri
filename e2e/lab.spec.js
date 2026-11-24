import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };

test('doctor orders tests; the lab collects with barcode labels and receives by scanning', async ({ browser }) => {
  const rec = await (await browser.newContext()).newPage();
  await signIn(rec, 'records');
  const patient = await (
    await rec.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'female',
        dateOfBirth: '1992-03-14',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  const visit = await (
    await rec.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();

  // Doctor orders from the visit.
  const doc = await (await browser.newContext()).newPage();
  await signIn(doc, 'doctor');
  await doc.goto(`/encounters/${visit.id}`);
  const lab = doc.getByRole('region', { name: 'Lab tests' });
  await lab.getByRole('button', { name: 'Order tests' }).click();
  await lab.getByLabel('Full blood count').check();
  await lab.getByLabel('Random blood sugar').check();
  await lab.getByLabel('Priority').selectOption('urgent');
  await lab.getByLabel('Clinical notes for the lab').fill('Fatigue, pallor');
  await lab.getByRole('button', { name: 'Order 2 tests' }).click();
  await expect(lab.getByText(/LAB-\d{4}-\d{6}/)).toBeVisible();
  await expect(lab).toContainText('Full blood count: ordered');

  // Lab technician collects: two tubes (EDTA and fluoride), labels with barcodes.
  const tech = await (await browser.newContext()).newPage();
  await signIn(tech, 'labtech');
  await tech.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Laboratory' }).click();
  await tech.getByLabel('Find').fill(patient.mrn);
  const card = tech
    .getByRole('region', { name: 'Lab worklist' })
    .getByRole('listitem')
    .filter({ hasText: patient.mrn });
  await expect(card).toContainText('urgent');
  await card.getByRole('button', { name: 'Collect samples and print labels' }).click();
  const barcodes = tech.getByRole('img', { name: /^Barcode L-\d{4}-\d{6}$/ });
  await expect(barcodes).toHaveCount(2);
  const accession = (await barcodes.first().getAttribute('aria-label')).replace('Barcode ', '');

  // Receive one tube by scanning its barcode.
  await tech.getByRole('link', { name: 'Back to the lab' }).click();
  await tech.getByRole('tab', { name: 'In transit' }).click();
  await tech.getByLabel('Scan a sample barcode').fill(accession);
  await tech.keyboard.press('Enter');
  await expect(tech.getByRole('status').filter({ hasText: `Received ${accession}` })).toContainText(patient.mrn);

  await doc.reload();
  await expect(doc.getByRole('region', { name: 'Lab tests' })).toContainText('received');
});

test('critical result: entered, verified by someone else, and the doctor is alerted', async ({ browser }) => {
  const rec = await (await browser.newContext()).newPage();
  await signIn(rec, 'records');
  const patient = await (
    await rec.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1970-09-09',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  const visit = await (
    await rec.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();

  const doc = await (await browser.newContext()).newPage();
  await signIn(doc, 'doctor');
  const tests = (await (await doc.request.get('/api/v1/lab/orderable-tests')).json()).data;
  const rbs = tests.find((t) => t.code === 'RBS');
  const order = await (
    await doc.request.post(`/api/v1/encounters/${visit.id}/lab-orders`, {
      headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
      data: { tests: [rbs.id], priority: 'stat' },
    })
  ).json();

  // Lab technician collects, receives and enters a critically high glucose.
  const tech = await (await browser.newContext()).newPage();
  await signIn(tech, 'labtech');
  const [label] = (
    await (await tech.request.post(`/api/v1/lab-orders/${order.id}/collect`, { headers: H, data: {} })).json()
  ).data;
  await tech.request.post('/api/v1/lab-samples/receive', { headers: H, data: { accession: label.accession } });
  await tech.goto('/lab?stage=result');
  const card = tech.getByRole('listitem').filter({ hasText: order.orderNumber });
  await card.getByRole('button', { name: 'Enter results: Random blood sugar' }).click();
  await card.getByLabel('Glucose (random) (mmol/L)').fill('28.4');
  await expect(card.getByText('Critically high')).toBeVisible(); // live preview
  await card.getByRole('button', { name: 'Save results' }).click();
  await expect(card).toHaveCount(0); // moved on to verification

  // The supervisor verifies and releases.
  const sup = await (await browser.newContext()).newPage();
  await signIn(sup, 'labsup');
  await sup.goto('/lab?stage=verify');
  const toVerify = sup.getByRole('listitem').filter({ hasText: order.orderNumber });
  await expect(toVerify.getByRole('alert')).toContainText('Critical value');
  await toVerify.getByRole('button', { name: 'Verify and release' }).click();
  await expect(toVerify).toHaveCount(0);

  // The doctor's bell lights up; following it opens the visit with the flagged result.
  await doc.goto('/');
  const bell = doc.getByRole('button', { name: /^Notifications, \d+ unread/ });
  await expect(bell).toBeVisible({ timeout: 35_000 });
  await bell.click();
  await doc
    .getByRole('dialog', { name: 'Notifications' })
    .getByRole('button', { name: new RegExp(`CRITICAL: Random blood sugar`) })
    .first()
    .click();
  await expect(doc).toHaveURL(new RegExp(`/encounters/${visit.id}`));
  const lab = doc.getByRole('region', { name: 'Lab tests' });
  await expect(lab).toContainText('28.4');
  await expect(lab).toContainText('Critically high');
});

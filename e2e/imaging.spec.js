import { expect, test } from '@playwright/test';
import { cap, letters, signIn } from './helpers.js';

const H = { 'X-Afyazuri-Client': '1' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('chest X-ray: requested with an indication, performed, reported from a template and released', async ({
  browser,
}) => {
  const rec = await (await browser.newContext()).newPage();
  await signIn(rec, 'records');
  const patient = await (
    await rec.request.post('/api/v1/patients', {
      headers: H,
      data: {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1966-12-01',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
    })
  ).json();
  const visit = await (
    await rec.request.post('/api/v1/encounters', { headers: H, data: { patientId: patient.id } })
  ).json();

  // Doctor requests the study; the indication is mandatory.
  const doc = await (await browser.newContext()).newPage();
  await signIn(doc, 'doctor');
  await doc.goto(`/encounters/${visit.id}`);
  const img = doc.getByRole('region', { name: 'Imaging' });
  await img.getByRole('button', { name: 'Request imaging' }).click();
  await img.getByLabel('Study').selectOption({ label: 'Chest X-ray (PA) (xray)' });
  await expect(img.getByRole('button', { name: 'Request study' })).toBeDisabled();
  await img.getByLabel(/Clinical indication/).fill('Cough for 3 weeks, weight loss');
  await img.getByRole('button', { name: 'Request study' }).click();
  await expect(img).toContainText('ordered');

  // Radiographer performs and attaches the image.
  const rg = await (await browser.newContext()).newPage();
  await signIn(rg, 'radiographer');
  await rg.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Imaging' }).click();
  const row = rg
    .getByRole('region', { name: 'Imaging worklist' })
    .getByRole('listitem')
    .filter({ hasText: patient.mrn });
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: 'Mark as performed' }).click();
  await expect(row).toHaveCount(0); // moves to reporting
  await rg.goto('/imaging?stage=report');
  const toReport = rg.getByRole('listitem').filter({ hasText: patient.mrn });
  await toReport.getByRole('button').first().click();
  await toReport
    .getByLabel('Attach a PDF or image')
    .setInputFiles({ name: 'cxr.png', mimeType: 'image/png', buffer: PNG });
  await expect(toReport.getByText('Attached: cxr.png')).toBeVisible();

  // Radiologist reports from a template and releases.
  const rl = await (await browser.newContext()).newPage();
  await signIn(rl, 'radiologist');
  await rl.goto('/imaging?stage=report');
  const card = rl.getByRole('listitem').filter({ hasText: patient.mrn });
  await card.getByRole('button').first().click();
  await card.getByLabel('Start from a template').selectOption({ label: 'Normal chest X-ray' });
  await expect(card.getByLabel('Impression')).toHaveValue('Normal chest radiograph.');
  await card.getByRole('button', { name: 'Save report' }).click();
  await card.getByRole('button', { name: 'Release report' }).click();
  await expect(card).toHaveCount(0);

  // The doctor sees the released report and the attachment.
  await doc.reload();
  await expect(img).toContainText('released');
  await expect(img).toContainText('Impression: Normal chest radiograph.');
  await expect(img.getByRole('link', { name: 'cxr.png' })).toBeVisible();
});

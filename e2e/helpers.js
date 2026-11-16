export const PASSWORD = 'Afyazuri#2026';

/**
 * Sign in and, unless told otherwise, wait until the app has left the login page.
 * @param {import('@playwright/test').Page} page
 * @param {string} username
 */
export async function signIn(page, username, password = PASSWORD, { expectSuccess = true } = {}) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (expectSuccess) await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** Random letters, so generated names never collide with demo data. */
export const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

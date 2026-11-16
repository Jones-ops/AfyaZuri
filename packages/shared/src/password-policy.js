/**
 * Password policy: at least 10 characters with upper, lower, digit and symbol,
 * and not containing the username.
 * @param {string} password
 * @param {{username?: string}} [ctx]
 * @returns {string[]} unmet rules (empty = acceptable)
 */
export function checkPassword(password, ctx = {}) {
  const pw = typeof password === 'string' ? password : '';
  const problems = [];
  if (pw.length < 10) problems.push('At least 10 characters');
  if (!/[a-z]/.test(pw)) problems.push('A lowercase letter');
  if (!/[A-Z]/.test(pw)) problems.push('An uppercase letter');
  if (!/\d/.test(pw)) problems.push('A number');
  if (!/[^A-Za-z0-9]/.test(pw)) problems.push('A symbol');
  if (ctx.username && pw.toLowerCase().includes(ctx.username.toLowerCase()))
    problems.push('Must not contain your username');
  return problems;
}

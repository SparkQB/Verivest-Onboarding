import { ALLOWED_DOMAIN, isAllowedEmail, checkPassword, createSession } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SITE_PASSWORD) {
    return res.status(503).json({ error: 'Sign-in is not configured yet. Ask an admin to set SITE_PASSWORD in Vercel.' });
  }

  const { email, password } = req.body || {};
  if (!isAllowedEmail(email)) {
    return res.status(401).json({ error: `Use your @${ALLOWED_DOMAIN} email address.` });
  }
  if (!checkPassword(password)) {
    // Slow down password guessing
    await new Promise(r => setTimeout(r, 1000));
    console.warn(`[login] wrong password for ${String(email).trim().toLowerCase()}`);
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const normalized = email.trim().toLowerCase();
  console.log(`[login] ${normalized} signed in`);
  return res.status(200).json({ token: createSession(normalized), email: normalized });
}

// Shared sign-in for the handover app: an @verivest.com email plus one team
// password (SITE_PASSWORD in Vercel). Files starting with "_" in /api are not
// deployed as endpoints; this module is imported by them.
import crypto from 'node:crypto';

export const ALLOWED_DOMAIN = 'verivest.com';
const SESSION_DAYS = 30;

// The signing key is derived from the password, so changing SITE_PASSWORD
// signs everyone out.
function signingKey() {
  const password = process.env.SITE_PASSWORD;
  if (!password) return null;
  return crypto.createHash('sha256').update(`verivest-handover-session:${password}`).digest();
}

export function isAllowedEmail(email) {
  return typeof email === 'string'
    && new RegExp(`^[^\\s@]+@${ALLOWED_DOMAIN.replace('.', '\\.')}$`, 'i').test(email.trim());
}

export function checkPassword(candidate) {
  const password = process.env.SITE_PASSWORD;
  if (!password || typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSession(email) {
  const key = signingKey();
  const payload = Buffer.from(JSON.stringify({
    email: email.trim().toLowerCase(),
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns { email } for a valid, unexpired token, otherwise null.
export function verifySession(token) {
  const key = signingKey();
  if (!key || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!isAllowedEmail(email) || !(exp > Date.now())) return null;
    return { email };
  } catch {
    return null;
  }
}

// For protected endpoints: returns the signed-in user, or sends 401/503 and returns null.
export function requireSession(req, res) {
  if (!process.env.SITE_PASSWORD) {
    res.status(503).json({ error: 'Sign-in is not configured (SITE_PASSWORD is not set in Vercel).', code: 'auth_not_configured' });
    return null;
  }
  const header = req.headers['authorization'] || '';
  const user = verifySession(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!user) {
    res.status(401).json({ error: 'Please sign in again.', code: 'signed_out' });
    return null;
  }
  return user;
}

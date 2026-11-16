import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requireSession } from './_auth.js';

// Issues a one-time signed upload URL for one file. Only signed-in users get
// one, so the public anon key no longer needs any storage access at all.
// The server chooses the path; the browser only supplies the folder and name.
const BUCKET = 'onboarding-docs';
const FOLDERS = new Set(['fund', 'brownfield', 'agora', 'syndication', 'transcripts']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = requireSession(req, res);
  if (!user) return;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase environment variables' });
  }

  const { folder, name } = req.body || {};
  if (!FOLDERS.has(folder)) return res.status(400).json({ error: 'Unknown upload folder' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Missing file name' });

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150);
  const path = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`;

  try {
    const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).storage.from(BUCKET);
    const { data, error } = await storage.createSignedUploadUrl(path);
    if (error) throw error;
    console.log(`[upload] ${user.email} → ${path}`);
    return res.status(200).json({ path: data.path, token: data.token });
  } catch (err) {
    console.error('[upload] could not create signed upload URL:', err);
    return res.status(500).json({ error: 'Could not prepare the upload' });
  }
}

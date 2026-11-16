import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

// Uploads are normally deleted right after their ClickUp task is created
// (api/handover.js). This daily job is the safety net for anything left over,
// e.g. files uploaded to a form that was never submitted.
const BUCKET = 'onboarding-docs';
const RETENTION_DAYS = 3;
const PAGE_SIZE = 1000;

// Lists every file in the bucket, walking into folders (fund/, transcripts/, …).
async function listAllFiles(storage, prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await storage.list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Failed to list "${prefix || '/'}": ${error.message}`);
    for (const item of data || []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      // Folders come back without an id
      if (item.id === null) files.push(...await listAllFiles(storage, path));
      else files.push({ path, createdAt: item.created_at });
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return files;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Vercel sends "Authorization: Bearer <CRON_SECRET>" on scheduled and
  // manually triggered runs. Refuse to run at all if the secret isn't set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set in Vercel' });
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase environment variables' });
  }

  try {
    const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).storage.from(BUCKET);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const files = await listAllFiles(storage);
    const toDelete = files.filter(f => !f.createdAt || new Date(f.createdAt).getTime() < cutoff).map(f => f.path);

    // The Storage API accepts up to 1000 paths per remove call
    for (let i = 0; i < toDelete.length; i += PAGE_SIZE) {
      const { error } = await storage.remove(toDelete.slice(i, i + PAGE_SIZE));
      if (error) throw new Error('Failed to delete files: ' + error.message);
    }

    console.log(`[cleanup] checked ${files.length} files, deleted ${toDelete.length} older than ${RETENTION_DAYS} days`);
    return res.status(200).json({ message: 'Cleanup complete', retentionDays: RETENTION_DAYS, checked: files.length, deleted: toDelete.length });
  } catch (err) {
    console.error('[cleanup] failed:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

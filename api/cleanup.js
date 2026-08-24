import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Only allow GET requests from Vercel Cron
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify cron secret to prevent unauthorized calls
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase environment variables' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const BUCKET = 'onboarding-docs';
    const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - FIFTEEN_DAYS_MS);

    // List all files in the bucket
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET)
      .list('', { limit: 1000 });

    if (listError) throw new Error('Failed to list files: ' + listError.message);
    if (!files || files.length === 0) {
      return res.status(200).json({ message: 'No files found', deleted: 0 });
    }

    // Filter files older than 15 days
    const toDelete = files.filter(file => {
      const createdAt = new Date(file.created_at);
      return createdAt < cutoff;
    });

    if (toDelete.length === 0) {
      return res.status(200).json({ 
        message: 'No files older than 15 days', 
        checked: files.length,
        deleted: 0 
      });
    }

    // Delete old files
    const filePaths = toDelete.map(f => f.name);
    const { error: deleteError } = await supabase.storage
      .from(BUCKET)
      .remove(filePaths);

    if (deleteError) throw new Error('Failed to delete files: ' + deleteError.message);

    return res.status(200).json({
      message: `Cleanup complete`,
      checked: files.length,
      deleted: toDelete.length,
      files: filePaths
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

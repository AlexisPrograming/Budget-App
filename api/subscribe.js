// Saves a browser push subscription to Supabase
// Called from the app when the user enables notifications

import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role key — can bypass RLS
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { subscription, user_id } = req.body;
  if (!subscription || !user_id) return res.status(400).json({ error: 'Missing fields' });

  // Upsert so re-subscribing the same device just updates it
  const { error } = await sb
    .from('push_subscriptions')
    .upsert({ user_id, subscription, updated_at: new Date().toISOString() },
             { onConflict: 'user_id,endpoint' });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ ok: true });
}

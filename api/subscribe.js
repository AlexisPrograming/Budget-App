// Saves a browser push subscription for the signed-in user.
//
// Security model: the caller must send their Supabase session token (Authorization: Bearer <access_token>).
// We verify it with Supabase and take the user id from the verified token, never from the request body.
// The write runs AS that user with the public anon key, so the table's row-level security
// (auth.uid() = user_id) is enforced by the database. No service-role key is used here.

import { createClient } from '@supabase/supabase-js';

const MAX_ENDPOINT = 2048;

export function makeHandler({ createClient: make }) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!url || !anon) return res.status(500).json({ error: 'Server is not configured' });

    const m = /^Bearer\s+(\S+)$/.exec(req.headers['authorization'] || '');
    if (!m) return res.status(401).json({ error: 'Sign in first' });
    const token = m[1];

    const sb = make(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: auth, error: authErr } = await sb.auth.getUser(token);
    const userId = auth && auth.user && auth.user.id;
    if (authErr || !userId) return res.status(401).json({ error: 'Invalid session' });

    const sub = req.body && req.body.subscription;
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const keys = sub && sub.keys;
    if (!/^https:\/\//.test(endpoint) || endpoint.length > MAX_ENDPOINT
        || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    // Re-subscribing the same device just updates it
    const { error } = await sb
      .from('push_subscriptions')
      .upsert({ user_id: userId, endpoint, subscription: sub, updated_at: new Date().toISOString() },
              { onConflict: 'user_id,endpoint' });

    if (error) return res.status(500).json({ error: 'Could not save the subscription' });
    res.status(200).json({ ok: true });
  };
}

export default makeHandler({ createClient });

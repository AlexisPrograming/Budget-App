// Daily cron function — runs at 9 AM UTC
// Finds all bills due tomorrow for every user and sends push notifications

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

webpush.setVapidDetails(
  'mailto:alexis97maga@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Tomorrow's day-of-month
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDay = tomorrow.getDate();

  // Get all push subscriptions
  const { data: subs, error: subErr } = await sb
    .from('push_subscriptions')
    .select('user_id, subscription');

  if (subErr || !subs?.length) return res.status(200).json({ sent: 0 });

  let sent = 0;
  const results = await Promise.allSettled(subs.map(async ({ user_id, subscription }) => {
    // Get this user's fixed bills
    const { data: row } = await sb
      .from('budget_store')
      .select('value')
      .eq('user_id', user_id)
      .eq('key', 'budget:fixed_bills')
      .maybeSingle();

    if (!row?.value) return;

    let bills;
    try { bills = JSON.parse(row.value); } catch { return; }

    const due = bills.filter(b => b.dueDay === dueDay && b.amount > 0);
    if (!due.length) return;

    const total = due.reduce((s, b) => s + b.amount, 0);
    const names = due.map(b => b.name).join(', ');
    const fmt = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const payload = JSON.stringify({
      title: `Bill due tomorrow — ${fmt(total)}`,
      body: names,
      url: '/'
    });

    await webpush.sendNotification(subscription, payload);
    sent++;
  }));

  const failed = results.filter(r => r.status === 'rejected').length;
  res.status(200).json({ sent, failed });
}

// Vercel serverless function — serves Supabase keys from env vars
// Keys are set in Vercel Dashboard → Project → Settings → Environment Variables
// They are NEVER in the codebase or GitHub

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`
const SUPABASE_URL = "${process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''}";
const SUPABASE_KEY = "${process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || ''}";
  `.trim());
}

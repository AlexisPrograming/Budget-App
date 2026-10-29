// Builds ./www for the Capacitor iOS app.
// The Vercel web deploy is untouched — it keeps serving budget.html directly.
//
// Usage:  BUDGET_URL=https://your-app.vercel.app npm run build:ios
// BUDGET_URL is only used to read the public Supabase settings from /config.js.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'www';
const NM = 'node_modules';
const baseUrl = (process.env.BUDGET_URL || '').replace(/\/$/, '');

if (!baseUrl) {
  console.error('Falta BUDGET_URL. Ejemplo:\n  BUDGET_URL=https://tu-app.vercel.app npm run build:ios');
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/vendor/fonts`, { recursive: true });
await mkdir(`${OUT}/vendor/tabler/fonts`, { recursive: true });

// ── Supabase client ──
await cp(`${NM}/@supabase/supabase-js/dist/umd/supabase.js`, `${OUT}/vendor/supabase.js`);

// ── Tabler icons (outline set only) ──
await cp(`${NM}/@tabler/icons-webfont/dist/tabler-icons.min.css`, `${OUT}/vendor/tabler/tabler-icons.min.css`);
const tablerFonts = `${NM}/@tabler/icons-webfont/dist/fonts`;
await cp(tablerFonts, `${OUT}/vendor/tabler/fonts`, {
  recursive: true,
  filter: src => !/tabler-icons-(200|300|filled)/.test(src) && !/\.(ttf|woff|eot|svg)$/.test(src) || src === tablerFonts,
});

// ── App fonts ──
const faces = [];
const fontFiles = [
  ['plus-jakarta-sans', 'Plus Jakarta Sans', [400, 500, 600, 700]],
  ['dm-mono', 'DM Mono', [400, 500]],
];
for (const [pkg, family, weights] of fontFiles) {
  for (const w of weights) {
    const file = `${pkg}-latin-${w}-normal.woff2`;
    await cp(`${NM}/@fontsource/${pkg}/files/${file}`, `${OUT}/vendor/fonts/${file}`);
    faces.push(
      `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${w};src:url(./fonts/${file}) format('woff2')}`
    );
  }
}
await writeFile(`${OUT}/vendor/fonts.css`, faces.join('\n') + '\n');

// ── Page: swap CDN references for local copies ──
let html = await readFile('budget.html', 'utf8');
const swaps = [
  [/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@tabler[^>]*>/, '<link rel="stylesheet" href="vendor/tabler/tabler-icons.min.css">'],
  [/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]*><\/script>/, '<script src="vendor/supabase.js"></script>'],
  [/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/, ''],
  [/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="vendor/fonts.css">'],
  [/<script src="\/config\.js"><\/script>/, '<script src="config.js"></script>'],
];
for (const [pattern, replacement] of swaps) {
  if (!pattern.test(html)) throw new Error(`No encontré en budget.html: ${pattern}`);
  html = html.replace(pattern, replacement);
}
// Push registration talks to the hosted API
html = html.replace("fetch('/api/subscribe'", `fetch('${baseUrl}/api/subscribe'`);
await writeFile(`${OUT}/index.html`, html);

// ── Public Supabase settings, read from the live deployment ──
const res = await fetch(`${baseUrl}/config.js`);
if (!res.ok) throw new Error(`No pude leer ${baseUrl}/config.js (${res.status})`);
const config = await res.text();
if (!/SUPABASE_URL = "https?:/.test(config)) throw new Error('config.js no trae SUPABASE_URL; revisa BUDGET_URL');
await writeFile(`${OUT}/config.js`, config);

// ── Static assets ──
for (const f of ['manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon.svg', 'icon-maskable.svg']) {
  if (existsSync(f)) await cp(f, `${OUT}/${f}`);
}

console.log(`✓ www/ listo (config desde ${baseUrl})`);

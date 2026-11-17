import { test } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey,
});
delete process.env.CRON_SECRET;

const { makeHandler } = await import('../api/subscribe.js');
const notify = (await import('../api/notify.js')).default;

const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const goodSub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

function fake({ user = { id: 'user-1' }, upsertError = null } = {}) {
  const calls = { upserts: [], clientArgs: null };
  const create = (url, key, opts) => {
    calls.clientArgs = { url, key, opts };
    return {
      auth: { getUser: async t => (t === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
      from: () => ({ upsert: async (row, o) => { calls.upserts.push({ row, o }); return { error: upsertError }; } }),
    };
  };
  return { handler: makeHandler({ createClient: create }), calls };
}
const post = (h, headers, body) => { const res = mkRes(); return h({ method: 'POST', headers, body }, res).then(() => res); };

test('subscribe: rejects a missing or malformed Authorization header', async () => {
  const { handler, calls } = fake();
  assert.equal((await post(handler, {}, { subscription: goodSub })).code, 401);
  assert.equal((await post(handler, { authorization: 'Basic abc' }, { subscription: goodSub })).code, 401);
  assert.equal(calls.upserts.length, 0);
});

test('subscribe: rejects a token Supabase does not accept', async () => {
  const { handler, calls } = fake();
  assert.equal((await post(handler, { authorization: 'Bearer forged' }, { subscription: goodSub })).code, 401);
  assert.equal(calls.upserts.length, 0);
});

test('subscribe: uses the verified user, ignores a user_id sent in the body', async () => {
  const { handler, calls } = fake();
  const r = await post(handler, { authorization: 'Bearer good' }, { subscription: goodSub, user_id: 'victim-999' });
  assert.equal(r.code, 200);
  assert.equal(calls.upserts[0].row.user_id, 'user-1');
  assert.equal(calls.upserts[0].row.endpoint, goodSub.endpoint);
  assert.equal(calls.upserts[0].o.onConflict, 'user_id,endpoint');
});

test('subscribe: runs as the user with the anon key, never the service role', async () => {
  const { handler, calls } = fake();
  await post(handler, { authorization: 'Bearer good' }, { subscription: goodSub });
  assert.equal(calls.clientArgs.key, 'anon');
  assert.equal(calls.clientArgs.opts.global.headers.Authorization, 'Bearer good');
});

test('subscribe: validates the subscription', async () => {
  const { handler, calls } = fake();
  const h = { authorization: 'Bearer good' };
  for (const bad of [undefined, {}, { endpoint: 'http://insecure', keys: goodSub.keys }, { endpoint: goodSub.endpoint }, { endpoint: 'https://x/' + 'a'.repeat(3000), keys: goodSub.keys }])
    assert.equal((await post(handler, h, { subscription: bad })).code, 400);
  assert.equal(calls.upserts.length, 0);
});

test('subscribe: database errors are not leaked to the caller', async () => {
  const { handler } = fake({ upsertError: { message: 'secret internal detail' } });
  const r = await post(handler, { authorization: 'Bearer good' }, { subscription: goodSub });
  assert.equal(r.code, 500);
  assert.ok(!JSON.stringify(r.body).includes('secret'));
});

test('subscribe: only POST', async () => {
  const { handler } = fake(); const res = mkRes();
  await handler({ method: 'GET', headers: {} }, res); assert.equal(res.code, 405);
});

test('notify: fails closed when CRON_SECRET is not set ("Bearer undefined" must not pass)', async () => {
  const res = mkRes(); await notify({ headers: { authorization: 'Bearer undefined' } }, res);
  assert.equal(res.code, 500);
});

test('notify: wrong or missing secret is rejected; right secret passes the gate', async () => {
  process.env.CRON_SECRET = 's3cret';
  let res = mkRes(); await notify({ headers: {} }, res); assert.equal(res.code, 401);
  res = mkRes(); await notify({ headers: { authorization: 'Bearer wrong' } }, res); assert.equal(res.code, 401);
  res = mkRes(); await notify({ headers: { authorization: 'Bearer s3cret1' } }, res); assert.equal(res.code, 401);
  delete process.env.CRON_SECRET;
});

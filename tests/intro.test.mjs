import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { self: {} };
vm.runInNewContext(readFileSync(join(here, '..', 'intro.js'), 'utf8'), sandbox);
const I = sandbox.self.Intro;
const plain = o => JSON.parse(JSON.stringify(o));
const SIZES = [[390, 844], [430, 932], [320, 568], [1024, 1366], [1200, 800]];

test('module loads and exposes the API', () => {
  for (const k of ['frame', 'draw', 'start', 'ready']) assert.equal(typeof I[k], 'function');
});

test('four drops start just outside the four corners', () => {
  const f = I.frame(0, 390, 844, Infinity);
  assert.equal(f.drops.length, 4);
  const [a, b, c, d] = f.drops;
  assert.ok(a.x < 0 && a.y < 0);
  assert.ok(b.x > 390 && b.y < 0);
  assert.ok(c.x > 390 && c.y > 844);
  assert.ok(d.x < 0 && d.y > 844);
});

test('they spiral inward (distance to the centre only shrinks) and turn about a full circle', () => {
  const W = 390, H = 844; let prev = Infinity, turned = 0, lastAng = null;
  for (let t = 120; t <= I.MERGE_AT - 1; t += 10) {
    const d = I.frame(t, W, H, Infinity).drops[0];
    const dist = Math.hypot(d.x - W / 2, d.y - H / 2);
    assert.ok(dist <= prev + 1e-6, 'distance grew at t=' + t); prev = dist;
    const ang = Math.atan2(d.y - H / 2, d.x - W / 2);
    if (lastAng !== null) { let da = ang - lastAng; while (da < -Math.PI) da += 2 * Math.PI; while (da > Math.PI) da -= 2 * Math.PI; turned += da; }
    lastAng = ang;
  }
  assert.ok(turned > Math.PI * 1.5, 'only turned ' + turned);
});

test('all four reach the centre with the ball radius, so the merge has no jump', () => {
  for (const [W, H] of SIZES) {
    const before = I.frame(I.MERGE_AT - 1, W, H, Infinity), after = I.frame(I.MERGE_AT + 1, W, H, Infinity);
    for (const d of before.drops) {
      assert.ok(Math.hypot(d.x - W / 2, d.y - H / 2) < 1.5);
      assert.ok(Math.abs(d.r - after.ball.r) < after.ball.r * 0.05, `${W}x${H}: drop ${d.r} vs ball ${after.ball.r}`);
    }
  }
});

test('necks only appear between drops that are close', () => {
  assert.equal(I.frame(0, 390, 844, Infinity).bridges.length, 0);
  assert.ok(I.frame(I.MERGE_AT - 1, 390, 844, Infinity).bridges.length > 0);
});

test('the ball exists only after the merge; the drops only before it', () => {
  const pre = I.frame(I.MERGE_AT - 5, 390, 844, Infinity), post = I.frame(I.MERGE_AT + 5, 390, 844, Infinity);
  assert.equal(pre.ball, null); assert.equal(pre.drops.length, 4);
  assert.ok(post.ball && post.ball.a === 1); assert.equal(post.drops.length, 0);
});

test('without a pop time the bubble just waits and never finishes', () => {
  for (let t = I.MERGE_AT; t < 6000; t += 97) {
    const f = I.frame(t, 390, 844, Infinity);
    assert.equal(f.done, false); assert.equal(f.ring, null); assert.equal(f.bgAlpha, 1);
  }
});

test('the pop never starts before the wobble is over', () => {
  const f = I.frame(I.MERGE_AT + 50, 390, 844, 0);   // asked to pop "now", but it is too early
  assert.equal(f.ring, null); assert.equal(f.bgAlpha, 1);
});

test('pop: ball swells, bursts into a ring that covers the screen, Home is revealed, then done', () => {
  const W = 390, H = 844, pa = I.EARLIEST_POP;
  const swell = I.frame(pa + I.T.popAnt, W, H, pa);
  assert.ok(swell.ball.r > 0.17 * W * 1.1);                      // inflated
  let bg = 1, ringR = 0;
  for (let t = pa + I.T.popAnt; t <= pa + I.T.popAnt + I.T.popBurst; t += 10) {
    const f = I.frame(t, W, H, pa);
    assert.ok(f.bgAlpha <= bg + 1e-9, 'background came back'); bg = f.bgAlpha;
    assert.ok(f.ring.r >= ringR - 1e-6); ringR = f.ring.r;
    assert.equal(f.sparks.length, 10);
  }
  assert.equal(bg, 0);
  assert.ok(ringR >= Math.hypot(W, H) / 2);
  assert.equal(I.frame(pa + I.T.popAnt + I.T.popBurst + 60, W, H, pa).done, true);
});

test('the whole show is short', () => {
  assert.ok(I.EARLIEST_POP + I.T.popAnt + I.T.popBurst + 40 <= 1500, 'total ' + (I.EARLIEST_POP + I.T.popAnt + I.T.popBurst + 40));
  assert.ok(I.T.maxPop <= 2400);
});

test('no NaN or negative radius at any moment, on any screen size', () => {
  for (const [W, H] of SIZES) for (const pa of [Infinity, I.EARLIEST_POP, 2000]) {
    for (let t = 0; t <= 3500; t += 7) {
      const f = I.frame(t, W, H, pa), nums = [];
      for (const d of [...f.drops, ...f.trails, ...f.sparks]) nums.push(d.x, d.y, d.r);
      if (f.ball) nums.push(f.ball.r, f.ball.sx, f.ball.sy, f.ball.a);
      if (f.ring) nums.push(f.ring.r, f.ring.w, f.ring.a);
      nums.push(f.bgAlpha, f.iconAlpha, f.iconScale);
      for (const n of nums) assert.ok(Number.isFinite(n), `NaN at ${W}x${H} t=${t}`);
      for (const d of [...f.drops, ...f.trails, ...f.sparks]) assert.ok(d.r >= 0);
    }
  }
});

test('the launch icon fades out and is gone before the drops arrive', () => {
  assert.equal(I.frame(0, 390, 844, Infinity).iconAlpha, 1);
  assert.equal(I.frame(I.T.iconOut, 390, 844, Infinity).iconAlpha, 0);
});

// Launch intro: four liquid drops leave the corners, spiral into the centre, merge into a bubble,
// the bubble pops and Home appears. Classic <script> (global `Intro`); the maths in frame() is pure
// so it can be tested in Node. Nothing here touches app data, and every path ends by removing the overlay.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Intro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  // Timeline in milliseconds
  const T = {
    iconOut: 450,      // the launch-screen icon fades and shrinks
    spiralStart: 80,   // drops start moving
    spiral: 820,       // time to reach the centre
    wobble: 180,       // jelly wobble after merging
    popAnt: 70,        // the bubble swells
    popBurst: 180,     // it bursts into a ring and droplets, Home shows through
    maxPop: 2400,      // never wait longer than this for the app
  };
  const MERGE_AT = T.spiralStart + T.spiral;
  const EARLIEST_POP = MERGE_AT + T.wobble;
  const END_PAD = 40;

  // Position and size of drop i at time t (corner order: top-left, top-right, bottom-right, bottom-left)
  function drop(i, t, W, H) {
    const m = Math.min(W, H), R = 0.17 * m;
    const u = clamp((t - T.spiralStart) / T.spiral, 0, 1), p = easeInOut(u);
    const sx = i === 0 || i === 3 ? -1 : 1, sy = i < 2 ? -1 : 1;
    const phi = Math.atan2(sy * H / 2, sx * W / 2);
    const D = Math.hypot(W, H) / 2 * 1.08;                 // starts just outside the corner
    const theta = phi + TAU * 1.15 * p;                    // about one full turn on the way in
    const rho = D * (1 - p);
    return {
      x: W / 2 + rho * Math.cos(theta), y: H / 2 + rho * Math.sin(theta),
      r: lerp(0.045 * m, R * 0.98, Math.pow(p, 2.2)),
    };
  }

  // Everything to draw at time t. popAt = when the pop starts (ms), or Infinity while we wait for the app.
  function frame(t, W, H, popAt) {
    const m = Math.min(W, H), R = 0.17 * m, cx = W / 2, cy = H / 2;
    const pa = popAt == null ? Infinity : Math.max(popAt, EARLIEST_POP);
    const f = { t, W, H, R, cx, cy, bgAlpha: 1, iconAlpha: 0, iconScale: 1, drops: [], trails: [], bridges: [], ball: null, ring: null, sparks: [], done: false };

    const ip = clamp(t / T.iconOut, 0, 1);
    f.iconAlpha = 1 - easeOut(ip); f.iconScale = 1 - 0.5 * easeOut(ip);

    if (t < MERGE_AT) {
      for (let i = 0; i < 4; i++) {
        f.drops.push(drop(i, t, W, H));
        for (let k = 1; k <= 5; k++) {                    // liquid streak behind each drop
          const tk = t - k * 26; if (tk < T.spiralStart) break;
          const d = drop(i, tk, W, H);
          f.trails.push({ x: d.x, y: d.y, r: d.r * (1 - k * 0.14), a: 0.55 * (1 - k / 6) });
        }
      }
      for (let i = 0; i < 4; i++) {                       // necks between drops that are close enough
        for (let j = i + 1; j < 4; j++) {
          const a = f.drops[i], b = f.drops[j], d = Math.hypot(a.x - b.x, a.y - b.y), reach = (a.r + b.r) * 1.25;
          if (d < reach) f.bridges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: Math.min(a.r, b.r) * 1.6 * (1 - d / reach) });
        }
      }
    } else {
      const tau = t - MERGE_AT;
      let sx = 1, sy = 1, scale = 1;
      const wob = 0.07 * Math.exp(-tau / 110) * Math.sin(tau / 24);
      sx = 1 + wob; sy = 1 - wob;
      scale = 1 + 0.015 * Math.sin(t / 160) * clamp(tau / T.wobble, 0, 1);
      let alpha = 1;
      const pt = t - pa;
      if (pt > 0) {
        const ant = clamp(pt / T.popAnt, 0, 1);
        scale *= 1 + 0.14 * easeOut(ant);
        if (pt >= T.popAnt) {
          const b = clamp((pt - T.popAnt) / T.popBurst, 0, 1), e = easeOut(b);
          alpha = Math.max(0, 1 - b * 5);
          f.bgAlpha = 1 - clamp(b * 1.6, 0, 1);
          const rmax = Math.hypot(W, H) / 2 * 1.05;
          f.ring = { r: lerp(R * 1.14, rmax, e), w: lerp(R * 0.35, 4, e), a: 1 - b * b };
          for (let k = 0; k < 10; k++) {
            const ang = (k / 10) * TAU + (k % 3) * 0.21;
            const dist = R * 1.1 + e * 0.55 * m * (0.7 + 0.15 * (k % 3));
            f.sparks.push({ x: cx + dist * Math.cos(ang), y: cy + dist * Math.sin(ang), r: 0.035 * m * (1 - b) * (1 + 0.5 * (k % 2)), a: 1 - b });
          }
        }
      }
      f.ball = { r: R * scale, sx, sy, a: alpha };
      if (pt >= T.popAnt + T.popBurst + END_PAD) f.done = true;
    }
    return f;
  }

  function draw(ctx, f, k) {
    const { W, H, cx, cy, R } = f;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, cy - R * 1.3, 0, cy + R * 1.3);
    g.addColorStop(0, '#ffb066'); g.addColorStop(1, '#e5584f');
    ctx.fillStyle = g; ctx.strokeStyle = g; ctx.lineCap = 'round';
    for (const tr of f.trails) { ctx.globalAlpha = tr.a; ctx.beginPath(); ctx.arc(tr.x, tr.y, Math.max(0.1, tr.r), 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
    for (const b of f.bridges) { ctx.lineWidth = Math.max(0.1, b.w); ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke(); }
    for (const d of f.drops) { ctx.beginPath(); ctx.arc(d.x, d.y, Math.max(0.1, d.r), 0, TAU); ctx.fill(); }
    if (f.ball && f.ball.a > 0) {
      const b = f.ball;
      ctx.save(); ctx.globalAlpha = b.a; ctx.translate(cx, cy); ctx.scale(b.sx, b.sy);
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.beginPath(); ctx.ellipse(-b.r * 0.34, -b.r * 0.42, b.r * 0.36, b.r * 0.19, -0.55, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = g;
    if (f.ring) { ctx.globalAlpha = f.ring.a; ctx.lineWidth = Math.max(0.5, f.ring.w); ctx.strokeStyle = g; ctx.beginPath(); ctx.arc(cx, cy, f.ring.r, 0, TAU); ctx.stroke(); }
    for (const s of f.sparks) { ctx.globalAlpha = Math.max(0, s.a); ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(0.1, s.r), 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  // ---------- runtime (browser only) ----------
  let run = null, earlyReady = false, status = 'not started';
  const buzz = kind => { try { if (typeof haptic !== 'undefined') haptic[kind](); } catch {} };

  function cleanup(el) {
    try { (el || document.getElementById('intro')).remove(); } catch {}
    try { document.documentElement.classList.remove('intro-on'); } catch {}
  }
  function finish() {
    if (!run) return;
    const r = run; run = null;
    try { cancelAnimationFrame(r.raf); clearTimeout(r.fail); } catch {}
    cleanup(r.el);
    if (status === 'running') status = r.tapped ? 'finished: skipped by a tap' : (r.buzzPop ? 'finished: played fully' : 'finished: ended early');
    try { console.log('[intro] ' + status + ' (' + Math.round(performance.now() - r.t0) + ' ms)'); } catch {}
  }

  function tick(now) {
    if (!run) return;
    const r = run;
    try {
      const t = now - r.t0;
      if (r.leaving) return;
      if (r.tapped) {                                   // tap = skip: quick fade, no waiting
        r.leaving = true; r.el.style.transition = 'opacity 160ms'; r.el.style.opacity = '0';
        setTimeout(finish, 190); return;
      }
      let popAt = r.readyAt == null ? Infinity : Math.max(EARLIEST_POP, r.readyAt);
      popAt = Math.min(popAt, T.maxPop);
      const f = frame(t, r.W, r.H, popAt);
      draw(r.ctx, f, r.k);
      r.el.style.backgroundColor = 'rgba(14,12,9,' + f.bgAlpha.toFixed(3) + ')';
      r.icon.style.opacity = String(f.iconAlpha);
      r.icon.style.transform = 'translate(-50%,-50%) scale(' + f.iconScale.toFixed(3) + ')';
      if (!r.buzzMerge && t >= MERGE_AT) { r.buzzMerge = true; buzz('tap'); }
      if (!r.buzzPop && f.ring) { r.buzzPop = true; r.el.style.pointerEvents = 'none'; buzz('ok'); }
      if (f.done) { finish(); return; }
      r.raf = requestAnimationFrame(tick);
    } catch (e) { finish(); }
  }

  // Shown only when <html> has .intro-on (native app, or ?splash=1 for testing). Reduce Motion skips it.
  function start(opts) {
    if (run || typeof document === 'undefined') return false;
    const force = !!(opts && opts.force);
    const el = document.getElementById('intro');
    if (!el || !document.documentElement.classList.contains('intro-on')) { status = 'off: not the native app (add ?splash=1 on the web to test)'; return false; }
    try {
      // Plays on every cold start. It does not follow "Liquid motion" or the iOS Reduce Motion setting; a tap skips it.
      const cv = document.getElementById('intro-cv'), icon = document.getElementById('intro-icon');
      const W = window.innerWidth, H = window.innerHeight, k = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(W * k); cv.height = Math.round(H * k);
      icon.style.width = Math.round(H * 0.1574) + 'px';            // same size as the launch-screen icon
      run = { el, icon, ctx: cv.getContext('2d'), W, H, k, t0: performance.now(), readyAt: null, raf: 0,
              tapped: false, leaving: false, buzzMerge: false, buzzPop: false, fail: setTimeout(finish, 4200) };
      if (earlyReady) run.readyAt = 0;
      el.addEventListener('pointerdown', () => { if (run) run.tapped = true; });
      run.raf = requestAnimationFrame(tick);
      status = 'running';
      return true;
    } catch (e) { run = null; status = 'error: ' + String(e && e.message || e).slice(0, 60); cleanup(el); return false; }
  }

  // The app has drawn its first screen (Home or the login): the bubble may pop.
  function ready() {
    earlyReady = true;
    if (run && run.readyAt == null) run.readyAt = performance.now() - run.t0;
  }

  // Menu button: play it again on demand (also works when the cover was already removed). Ignores the calm switch.
  function replay() {
    if (run || typeof document === 'undefined') return false;
    try {
      if (!document.getElementById('intro')) {
        const el = document.createElement('div');
        el.id = 'intro'; el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<img id="intro-icon" src="/icon-512.png" alt=""><canvas id="intro-cv"></canvas>';
        document.body.appendChild(el);
      }
      document.documentElement.classList.add('intro-on');
      earlyReady = true;
      const el = document.getElementById('intro');
      el.style.cssText = ''; el.style.backgroundColor = 'rgb(14,12,9)';
      return start({ force: true });
    } catch (e) { status = 'replay error: ' + String(e && e.message || e).slice(0, 60); cleanup(); return false; }
  }

  return { T, frame, draw, start, replay, ready, EARLIEST_POP, MERGE_AT, active: () => !!run, status: () => status };
});

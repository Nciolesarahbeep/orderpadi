// Small shared helpers for every OrderPadi page: light/dark choice,
// confetti, counting numbers, scroll reveal and a little vibration.
// Each page also runs a two-line snippet in <head> so the saved
// light/dark choice applies before anything is drawn.
(function () {
  'use strict';
  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('IntersectionObserver' in window && !reduced) root.classList.add('reveal-on');

  function getMode() {
    try { var m = localStorage.getItem('op_mode'); return m === 'light' || m === 'dark' ? m : 'auto'; } catch (e) { return 'auto'; }
  }
  function isDark() {
    var m = getMode();
    if (m !== 'auto') return m === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"][data-auto]');
    if (meta) meta.setAttribute('content', isDark() ? '#15102A' : '#F3EFFF');
  }
  function setMode(mode) {
    try {
      if (mode === 'light' || mode === 'dark') localStorage.setItem('op_mode', mode);
      else localStorage.removeItem('op_mode');
    } catch (e) { /* private mode: applies to this visit only */ }
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
    syncThemeColor();
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', syncThemeColor);
  }
  syncThemeColor();

  // Confetti from a point (or the top of the screen). Cleans up after itself.
  var COLOURS = ['#12B76A', '#FFD23F', '#FF8A7A', '#6CCFF6', '#CDB8FF', '#6A4CE0'];
  function confetti(from, count) {
    if (reduced) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    var x0 = w / 2, y0 = h * 0.35;
    if (from && from.getBoundingClientRect) {
      var r = from.getBoundingClientRect();
      x0 = r.left + r.width / 2; y0 = r.top + r.height / 2;
    }
    var bits = [];
    var n = count || 90;
    for (var i = 0; i < n; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 4 + Math.random() * 9;
      bits.push({
        x: x0, y: y0,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 7,
        size: 6 + Math.random() * 7, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        colour: COLOURS[i % COLOURS.length], shape: i % 3
      });
    }
    var start = performance.now();
    function frame(now) {
      var t = now - start;
      ctx.clearRect(0, 0, w, h);
      bits.forEach(function (b) {
        b.vy += 0.32; b.vx *= 0.985; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y); ctx.rotate(b.rot);
        ctx.globalAlpha = Math.max(0, 1 - t / 1800);
        ctx.fillStyle = b.colour; ctx.strokeStyle = '#1B1530'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (b.shape === 0) ctx.rect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
        else if (b.shape === 1) ctx.arc(0, 0, b.size / 2.4, 0, Math.PI * 2);
        else { ctx.moveTo(0, -b.size / 2); ctx.lineTo(b.size / 2, b.size / 2); ctx.lineTo(-b.size / 2, b.size / 2); ctx.closePath(); }
        ctx.fill(); ctx.stroke();
        ctx.restore();
      });
      if (t < 1800) requestAnimationFrame(frame); else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  // Counts a number up to its new value. format(value) gives the text.
  function countUp(el, to, format, ms) {
    if (!el) return;
    format = format || function (v) { return String(Math.round(v)); };
    var from = Number(el.dataset.value || 0);
    el.dataset.value = String(to);
    if (reduced || from === to || document.hidden) { el.textContent = format(to); return; }
    var dur = ms || 700;
    var start = performance.now();
    function step(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step); else el.textContent = format(to);
    }
    requestAnimationFrame(step);
  }

  // Re-runs a CSS animation class on an element.
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* not supported */ } }

  // Elements with .reveal fade up as they scroll into view.
  function reveal(scope) {
    var els = (scope || document).querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window) || reduced) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (e) { io.observe(e); });
  }

  // Shows a photo once it has loaded, so empty frames don't flash.
  function fadeImage(img) {
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
    else img.addEventListener('load', function () { img.classList.add('loaded'); }, { once: true });
  }

  // Opening animation. The page's <head> adds html.splashing on the first
  // open in a visit (not on refresh, not with reduced motion). The page
  // calls OP.endSplash() once it's ready; it plays for at least ~1.3s,
  // a tap skips it, and it never stays longer than 3.5s.
  var splashStart = (window.performance && performance.now()) || 0;
  var splashDone = false;
  function endSplash(minMs) {
    if (splashDone || !root.classList.contains('splashing')) return;
    var left = Math.max(0, (minMs == null ? 1300 : minMs) - (performance.now() - splashStart));
    setTimeout(function () {
      if (splashDone) return;
      splashDone = true;
      var el = document.getElementById('splash');
      if (!el) { root.classList.remove('splashing'); return; }
      el.classList.add('out');
      setTimeout(function () { root.classList.remove('splashing'); el.remove(); }, 460);
    }, left);
  }
  if (root.classList.contains('splashing')) {
    setTimeout(function () { endSplash(0); }, 3500);
    document.addEventListener('DOMContentLoaded', function () {
      var el = document.getElementById('splash');
      if (el) el.addEventListener('click', function () { endSplash(0); });
      else root.classList.remove('splashing');
    });
  }

  window.OP = { getMode: getMode, setMode: setMode, isDark: isDark, confetti: confetti, countUp: countUp, replay: replay, buzz: buzz, reveal: reveal, fadeImage: fadeImage, endSplash: endSplash, reducedMotion: reduced };
  if (document.readyState !== 'loading') reveal(); else document.addEventListener('DOMContentLoaded', function () { reveal(); });
})();

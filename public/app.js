// iPad client. ES5 only: Safari 9 has no arrow functions, let/const or template strings.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var screenEl = $('screen');
  var front = $('frameA');
  var back = $('frameB');
  var address = $('address');
  var typebar = $('typebar');
  var typeInput = $('typeInput');
  var statusEl = $('status');
  var toastEl = $('toast');
  var progress = $('progress');

  var URLs = window.URL || window.webkitURL;
  var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame ||
    function (fn) { return setTimeout(fn, 16); };
  var now = Date.now;

  var ws = null;
  var retries = 0;
  var replaced = false;
  var viewW = 0;
  var viewH = 0;
  var editingAddress = false;

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // ------------------------------------------------------------ connection

  function connect() {
    replaced = false;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.binaryType = 'blob';
    ws.onopen = function () {
      retries = 0;
      showStatus(null);
      sendSize(true);
    };
    ws.onmessage = function (e) {
      if (typeof e.data === 'string') handle(JSON.parse(e.data));
      else showFrame(e.data, frameMetaY);
    };
    ws.onclose = function (e) {
      ws = null;
      if (e.code === 4000) {
        replaced = true;
        showStatus('Başka bir cihazda açıldı. Buraya dönmek için dokun.');
        return;
      }
      // Repeated failures usually mean the Cloudflare login expired; a reload goes through it again.
      if (retries >= 4) {
        showStatus('Bağlanılamıyor. Sayfayı yenilemek için dokun.');
        return;
      }
      showStatus('Bağlantı koptu, yeniden bağlanılıyor…');
      setTimeout(connect, Math.min(8000, 500 * Math.pow(2, retries++)));
    };
  }

  statusEl.addEventListener('click', function () {
    if (ws) return;
    if (replaced) connect();
    else location.reload();
  }, false);

  function handle(m) {
    if (m.t === 'f') {
      frameMetaY = m.y;
    } else if (m.t === 'state') {
      if (!editingAddress && m.url) address.value = m.url;
      if (m.title) document.title = m.title;
      if (m.loading) resetPrediction();
      setLoading(m.loading);
    } else if (m.t === 'focus') {
      if (m.field) openTypebar(m.field);
      else if (document.activeElement !== typeInput) closeTypebar();
    } else if (m.t === 'toast') {
      toast(m.text);
    }
  }

  // ---------------------------------------------------------------- frames

  // Decode one JPEG at a time and keep only the newest waiting one, so a slow iPad skips frames instead of lagging.
  var decoding = false;
  var next = null; // { blob, y }
  var shownUrl = null;
  var frameMetaY = 0; // scroll offset the server announced for the next binary frame
  var frameScrollY = 0; // scroll offset of the frame on screen

  function showFrame(blob, y) {
    if (decoding) {
      next = { blob: blob, y: y };
      return;
    }
    decoding = true;
    var url = URLs.createObjectURL(blob);
    back.onload = back.onerror = function () {
      // Swap the decoded frame in and position it in the same task, so no frame paints unaligned.
      var shown = back;
      back = front;
      front = shown;
      onFrameShown(y);
      front.style.visibility = 'visible';
      back.style.visibility = 'hidden';
      if (shownUrl) URLs.revokeObjectURL(shownUrl);
      shownUrl = url;
      decoding = false;
      if (next) {
        var n = next;
        next = null;
        showFrame(n.blob, n.y);
      }
    };
    back.src = url;
  }

  // ------------------------------------------------------ scroll prediction

  // The finger moves the current frame at once; each new frame carries the page's real scroll offset,
  // so the remaining shift shrinks to zero as the server catches up.
  var predictY = null; // where the remote page should end up; null when idle
  var gesture = null; // { startY, sent, staleFrames, off }
  var settleTimer = null;

  function beginGesture() {
    clearTimeout(settleTimer);
    if (!gesture) {
      gesture = { startY: frameScrollY, sent: 0, staleFrames: 0, off: false };
      predictY = null;
    }
  }

  // Once the server has had time to catch up, drop whatever shift is left (end of page, inner scroller).
  function endGesture() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(resetPrediction, 500);
  }

  function resetPrediction() {
    clearTimeout(settleTimer);
    gesture = null;
    predictY = null;
    renderOffset();
  }

  function predict(dy) {
    if (!gesture || gesture.off) return;
    if (predictY === null) predictY = frameScrollY;
    predictY = Math.max(0, predictY + dy);
    gesture.sent += Math.abs(dy);
    renderOffset();
  }

  function onFrameShown(y) {
    frameScrollY = y;
    // The root never moved although we scrolled: an inner element scrolls, so stop shifting the frame.
    if (gesture && !gesture.off && gesture.sent > 80 && y === gesture.startY && ++gesture.staleFrames >= 3) {
      gesture.off = true;
    }
    renderOffset();
  }

  function renderOffset() {
    var off = predictY === null || !gesture || gesture.off ? 0 : (predictY - frameScrollY) / pageScale();
    var max = screenEl.clientHeight * 0.4;
    off = Math.round(Math.max(-max, Math.min(max, off)));
    var t = off ? 'translate3d(0,' + -off + 'px,0)' : '';
    front.style.webkitTransform = t;
    front.style.transform = t;
  }

  function sendSize(force) {
    var w = screenEl.clientWidth;
    var h = screenEl.clientHeight;
    if (!force && w === viewW && h === viewH) return;
    viewW = w;
    viewH = h;
    send({ t: 'resize', w: w, h: h });
  }

  var onResize = debounce(function () { sendSize(false); }, 300);
  window.addEventListener('resize', onResize, false);
  window.addEventListener('orientationchange', onResize, false);

  // Page pixels per screen pixel. The server caps the remote width, so a wide desktop window
  // shows an upscaled frame; on the iPad this is 1.
  function pageScale() {
    return front.naturalWidth ? front.naturalWidth / screenEl.clientWidth : 1;
  }

  function toPage(clientX, clientY) {
    var rect = screenEl.getBoundingClientRect();
    var scale = pageScale();
    return {
      x: Math.round((clientX - rect.left) * scale),
      y: Math.round((clientY - rect.top) * scale)
    };
  }

  // ---------------------------------------------------------------- scroll

  var scrollDX = 0;
  var scrollDY = 0;
  var scrollAt = null;
  var flushTimer = null;

  // dx/dy are screen pixels; the page moves by the same visual distance as the finger.
  function queueScroll(x, y, dx, dy) {
    var scale = pageScale();
    scrollDX += dx * scale;
    scrollDY += dy * scale;
    scrollAt = { x: x, y: y };
    predict(dy * scale);
    if (!flushTimer) flushTimer = setTimeout(flushScroll, 33);
  }

  function flushScroll() {
    flushTimer = null;
    var dx = Math.round(scrollDX);
    var dy = Math.round(scrollDY);
    scrollDX -= dx;
    scrollDY -= dy;
    if (dx || dy) send({ t: 'scroll', x: scrollAt.x, y: scrollAt.y, dx: dx, dy: dy });
  }

  var momentum = null;

  function startMomentum(x, y, vx, vy) {
    if (Math.abs(vx) < 0.2 && Math.abs(vy) < 0.2) {
      endGesture();
      return;
    }
    var m = { vx: vx, vy: vy, last: now() };
    momentum = m;
    function step() {
      if (momentum !== m) return;
      var t = now();
      var dt = t - m.last;
      m.last = t;
      var decay = Math.pow(0.997, dt);
      m.vx *= decay;
      m.vy *= decay;
      queueScroll(x, y, m.vx * dt, m.vy * dt);
      if (Math.abs(m.vx) < 0.03 && Math.abs(m.vy) < 0.03) {
        momentum = null;
        endGesture();
        return;
      }
      raf(step);
    }
    raf(step);
  }

  // ----------------------------------------------------------------- touch

  var touch = null;

  screenEl.addEventListener('touchstart', function (e) {
    e.preventDefault();
    momentum = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (e.touches.length !== 1) {
      touch = null;
      return;
    }
    var t = e.touches[0];
    var p = toPage(t.clientX, t.clientY);
    beginGesture();
    touch = {
      sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY,
      px: p.x, py: p.y, start: now(), lt: now(), vx: 0, vy: 0, moved: false
    };
  }, false);

  screenEl.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (!touch || e.touches.length !== 1) return;
    var t = e.touches[0];
    if (!touch.moved && Math.abs(t.clientX - touch.sx) + Math.abs(t.clientY - touch.sy) < 10) return;
    touch.moved = true;
    var dx = touch.lx - t.clientX;
    var dy = touch.ly - t.clientY;
    var tn = now();
    var dt = Math.max(1, tn - touch.lt);
    touch.vx = 0.7 * (dx / dt) + 0.3 * touch.vx;
    touch.vy = 0.7 * (dy / dt) + 0.3 * touch.vy;
    touch.lx = t.clientX;
    touch.ly = t.clientY;
    touch.lt = tn;
    queueScroll(touch.px, touch.py, dx, dy);
  }, false);

  screenEl.addEventListener('touchend', function (e) {
    e.preventDefault();
    var t = touch;
    touch = null;
    if (!t) return;
    if (!t.moved) {
      endGesture();
      if (now() - t.start < 800) send({ t: 'tap', x: t.px, y: t.py });
      return;
    }
    // A finger that rested before lifting should not fling.
    if (now() - t.lt < 100) startMomentum(t.px, t.py, t.vx, t.vy);
    else endGesture();
  }, false);

  screenEl.addEventListener('touchcancel', function () { touch = null; }, false);

  // Mouse and wheel, for testing from a desktop browser.
  screenEl.addEventListener('click', function (e) {
    var p = toPage(e.clientX, e.clientY);
    send({ t: 'tap', x: p.x, y: p.y });
  }, false);

  screenEl.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = toPage(e.clientX, e.clientY);
    beginGesture();
    queueScroll(p.x, p.y, e.deltaX, e.deltaY);
    endGesture();
  }, false);

  // Stop iOS rubber-banding the whole app. Newer engines treat document touch listeners as passive
  // unless told otherwise; Safari 9 reads the object as useCapture, which is harmless here.
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

  // --------------------------------------------------------------- toolbar

  function onClick(id, fn) { $(id).addEventListener('click', fn, false); }

  onClick('back', function () { send({ t: 'back' }); });
  onClick('forward', function () { send({ t: 'forward' }); });
  onClick('reload', function () { send({ t: 'reload' }); });
  onClick('home', function () { send({ t: 'home' }); });

  // Focusing inside the click handler is what lets iOS open the keyboard in one tap.
  onClick('keyboard', function () {
    openTypebar({ value: '', type: 'text', label: '' });
    typeInput.focus();
    send({ t: 'focus' });
  });

  address.addEventListener('focus', function () {
    editingAddress = true;
    // Select now, and again once iOS has placed the caret (it drops the first selection), unless typing started.
    var focusedValue = address.value;
    address.select();
    setTimeout(function () {
      if (address.value === focusedValue) address.setSelectionRange(0, focusedValue.length);
    }, 0);
  }, false);

  address.addEventListener('blur', function () {
    editingAddress = false;
    window.scrollTo(0, 0);
  }, false);

  $('addressForm').addEventListener('submit', function (e) {
    e.preventDefault();
    send({ t: 'nav', url: address.value });
    address.blur();
  }, false);

  // --------------------------------------------------------------- typebar

  var typeTimer = null;
  var lastSent = '';

  function openTypebar(field) {
    typebar.className = '';
    var safeTypes = { password: 1, email: 1, url: 1, tel: 1, search: 1 };
    typeInput.type = safeTypes[field.type] ? field.type : 'text';
    if (document.activeElement !== typeInput || !typeInput.value) {
      typeInput.value = field.value || '';
      lastSent = typeInput.value;
    }
    typeInput.placeholder = field.label || 'Yazmak için dokun';
  }

  function closeTypebar() {
    clearTimeout(typeTimer);
    typeInput.blur();
    typebar.className = 'hidden';
    window.scrollTo(0, 0);
  }

  function flushType() {
    clearTimeout(typeTimer);
    typeTimer = null;
    if (typeInput.value === lastSent) return;
    lastSent = typeInput.value;
    send({ t: 'type', value: lastSent });
  }

  typeInput.addEventListener('input', function () {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(flushType, 200);
  }, false);

  typebar.addEventListener('submit', function (e) {
    e.preventDefault();
    flushType();
    send({ t: 'key', key: 'Enter' });
    closeTypebar();
  }, false);

  onClick('typeClose', function () {
    flushType();
    closeTypebar();
  });

  // ------------------------------------------------------------ indicators

  var loadingTimer = null;

  function setLoading(on) {
    clearTimeout(loadingTimer);
    if (on) {
      progress.className = '';
      progress.offsetWidth; // restart the transition
      progress.className = 'on';
      // Single-page apps navigate without a load event; don't spin forever.
      loadingTimer = setTimeout(function () { setLoading(false); }, 10000);
    } else if (progress.className === 'on') {
      progress.className = 'done';
      loadingTimer = setTimeout(function () { progress.className = ''; }, 700);
    }
  }

  function showStatus(text) {
    if (text) {
      statusEl.textContent = text;
      statusEl.className = '';
    } else {
      statusEl.className = 'hidden';
    }
  }

  var toastTimer = null;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'hidden'; }, 4000);
  }

  connect();
})();

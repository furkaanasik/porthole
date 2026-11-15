'use strict';

// One Chromium tab, streamed over a WebSocket to a single client: as H.264 video to browsers with
// WebCodecs, as JPEG/PNG frames to the old iPad. The client sends taps, scrolls and text back.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const audio = require('./audio');
const video = require('./video');
const i18n = require('./i18n');
const vstream = require('./vstream');

const PORT = Number(process.env.PORT) || 8091;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Google shows a captcha to datacenter IPs, so search defaults to DuckDuckGo.
const HOME_URL = process.env.HOME_URL || 'https://duckduckgo.com/';
const SEARCH_URL = process.env.SEARCH_URL || 'https://duckduckgo.com/?q=';
// While the user scrolls, taps or types, frames are small and fast (QUALITY, at most STREAM_WIDTH
// wide). Otherwise the stream runs at full size and IDLE_QUALITY, and once the screen is still,
// one lossless PNG frame follows.
const QUALITY = Number(process.env.QUALITY) || 60;
const IDLE_QUALITY = Number(process.env.IDLE_QUALITY) || 85;
const STREAM_WIDTH = Number(process.env.STREAM_WIDTH) || 1280;
const MAX_TABS = 5;
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
// The browser's language: Accept-Language and navigator.language, which sites localize by.
const LOCALE = process.env.LOCALE || 'en-US';
const MAX_WIDTH = Number(process.env.MAX_WIDTH) || 1920;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Fingerprint of the client files. The client reconnects on its own after a server restart and
// would keep running old code; when this changes, it reloads.
const CLIENT_VERSION = require('crypto')
  .createHash('sha1')
  .update(['index.html', 'app.js', 'style.css'].map((f) => fs.readFileSync(path.join(PUBLIC_DIR, f))).join('\n') + i18n.LANG)
  .digest('hex')
  .slice(0, 12);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  // Only desktop browsers load this: Safari plays HLS natively.
  '/hls.js': [require.resolve('hls.js/dist/hls.min.js'), 'application/javascript; charset=utf-8'],
};

let context;
let page; // the tab currently shown on the iPad
let viewport = { width: 1024, height: 690 };
let mode = 'idle'; // 'fast' while the user is interacting
let hd = false; // the client asked for full quality even while scrolling
let client = null; // { ws, cdp }
let streamToken = 0;
let userAgent;
let chrome; // the Chromium process

const log = (...args) => console.log(new Date().toISOString(), ...args);

function toUrl(input) {
  const text = String(input || '').trim();
  if (!text) return HOME_URL;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[^\s]+\.[^\s]{2,}$/.test(text) && !/^[a-z]+:/i.test(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function send(msg) {
  if (client && client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

async function sendState(loading) {
  if (!page) return;
  const title = await page.title().catch(() => '');
  send({ t: 'state', url: page.url(), title, loading: !!loading });
}

// ---------------------------------------------------------------- streaming

const frameStats = { count: 0, bytes: 0 };
if (process.env.DEBUG) {
  setInterval(() => {
    if (!frameStats.count) return;
    const kb = Math.round(frameStats.bytes / frameStats.count / 1024);
    log(`frames: ${(frameStats.count / 5).toFixed(1)}/s, avg ${kb} KB, ${viewport.width}x${viewport.height}`);
    frameStats.count = frameStats.bytes = 0;
  }, 5000);
}

async function stopStream() {
  vstream.stop();
  if (!client || !client.cdp) return;
  const cdp = client.cdp;
  client.cdp = null;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
}

function startVideo() {
  const ws = client.ws;
  vstream.start(
    ws,
    viewport.width,
    viewport.height,
    (cfg) => send({ t: 'vconfig', codec: cfg.codec, w: viewport.width, h: viewport.height, cw: cfg.width, ch: cfg.height }),
    (code) => {
      log('video stream stopped:', code);
      // Fall back to frames rather than leave a dead screen.
      if (client && client.ws === ws && client.video) {
        client.video = false;
        send({ t: 'vfail' });
        startStream();
      }
    },
  );
}

async function startStream() {
  if (!client || !page) return;
  const token = ++streamToken;
  if (client.video) {
    // Kiosk mode shows the front tab at the top-left of the virtual screen; capture that.
    if (client.cdp) await stopScreencastOnly();
    return startVideo();
  }
  await stopStream();
  const ws = client.ws;
  const cdp = await context.newCDPSession(page);
  if (token !== streamToken || !client || client.ws !== ws) {
    await cdp.detach().catch(() => {});
    return;
  }
  client.cdp = cdp;
  let lastData = null;
  cdp.on('Page.screencastFrame', (frame) => {
    const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (ws.readyState !== ws.OPEN) return ack();
    // Repaints that change nothing would replace the sharp frame with a blurrier copy of it.
    if (frame.data === lastData) return ack();
    lastData = frame.data;
    lastSharp = null; // the screen no longer shows the last sharp frame
    // The scroll offset lets the client line up its own scroll prediction with this frame.
    // w is the page width in CSS pixels; motion frames may be scaled down from it.
    ws.send(JSON.stringify({ t: 'f', y: Math.round(frame.metadata.scrollOffsetY || 0), w: viewport.width }));
    sharpSoon();
    // Ack only once the frame has left the socket, so a slow link gets fewer frames instead of a backlog.
    const jpeg = Buffer.from(frame.data, 'base64');
    frameStats.count++;
    frameStats.bytes += jpeg.length;
    ws.send(jpeg, ack);
  });
  await cdp.send('Page.startScreencast', screencastParams());
  // The screencast only emits on repaint; push one frame so a still page is not blank.
  if (token === streamToken) await sendSnapshot();
}

function screencastParams() {
  const fast = mode === 'fast' && !hd;
  return {
    format: 'jpeg',
    quality: fast ? QUALITY : IDLE_QUALITY,
    maxWidth: fast ? Math.min(viewport.width, STREAM_WIDTH) : viewport.width,
    maxHeight: viewport.height,
  };
}

// Input switches the stream to fast mode; 350 ms after the last input it goes back to full quality.
// Page animations alone never cost sharpness this way.
let modeTimer = null;
function inputActivity() {
  inputSinceSharp = true;
  clearTimeout(modeTimer);
  modeTimer = setTimeout(() => setMode('idle'), 350);
  setMode('fast');
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  if (!hd) restartScreencast();
}

function restartScreencast() {
  const cdp = client && client.cdp;
  if (!cdp) return;
  cdp
    .send('Page.stopScreencast')
    .then(() => cdp.send('Page.startScreencast', screencastParams()))
    .catch(() => {});
}

async function stopScreencastOnly() {
  const cdp = client.cdp;
  client.cdp = null;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
}

// Raw CDP rather than page.screenshot: Playwright injects a caret-hiding style for screenshots,
// and that repaint set off new screencast frames and another snapshot, round and round.
let lastSharp = null;
async function sendSnapshot() {
  if (!client || !client.cdp || !page) return;
  const { ws, cdp } = client;
  const y = await withTimeout(page.evaluate(() => Math.round(window.scrollY)), 500).catch(() => null);
  // PNG is lossless, so text comes out exactly as Chromium drew it.
  const res = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }), 3000).catch(() => null);
  if (!res || ws.readyState !== ws.OPEN || res.data === lastSharp) return;
  lastSharp = res.data;
  lastSharpAt = Date.now();
  inputSinceSharp = false;
  const shot = Buffer.from(res.data, 'base64');
  if (DEBUG) log(`sharp frame: ${Math.round(shot.length / 1024)} KB`);
  ws.send(JSON.stringify({ t: 'f', y: y || 0, w: viewport.width }));
  ws.send(shot);
}

// Once the screen has been still for a moment (no input, no screencast frames), send one sharp
// full-size frame. This also covers the screencast skipping repaints while a frame is unacked
// and never sending them later, which left the screen behind the page after a scroll.
// After input it comes right away; for the page's own animations (a blinking caret, a pulsing
// badge) at most every 2 s, since a PNG can be a few hundred KB.
let sharpTimer = null;
let lastSharpAt = 0;
let inputSinceSharp = true;
function sharpSoon() {
  clearTimeout(sharpTimer);
  const wait = inputSinceSharp ? 400 : Math.max(400, lastSharpAt + 2000 - Date.now());
  sharpTimer = setTimeout(() => sendSnapshot().catch(() => {}), wait);
}

// --------------------------------------------------------------------- tabs

function wirePage(p) {
  p.on('dialog', (d) => {
    send({ t: 'toast', text: d.message() });
    d.accept().catch(() => {});
  });
  p.on('framenavigated', (f) => {
    if (p === page && f === p.mainFrame()) sendState(true);
  });
  p.on('load', () => {
    if (p === page) sendState(false);
  });
  p.on('crash', () => {
    log('tab crashed:', p.url());
    p.reload().catch(() => {});
  });
  p.on('close', () => {
    if (p !== page) return;
    const rest = context.pages();
    if (rest.length) setActive(rest[rest.length - 1]);
    else newTab(HOME_URL);
  });
}

async function setActive(p) {
  page = p;
  await p.setViewportSize(viewport).catch(() => {});
  await p.bringToFront().catch(() => {});
  await startStream().catch((err) => log('stream:', err.message));
  sendState(false);
}

async function newTab(url) {
  const p = await context.newPage();
  await p.goto(url, { waitUntil: 'commit' }).catch((err) => log('goto:', err.message));
}

// Popups and target=_blank links become the visible tab; closing them returns to the previous one.
function onNewPage(p) {
  wirePage(p);
  page = p; // before closing old tabs, so their close handlers don't pick a different tab
  const pages = context.pages();
  for (let i = 0; pages.length - i > MAX_TABS; i++) pages[i].close().catch(() => {});
  setActive(p);
}

// -------------------------------------------------------------------- input

const DEBUG = !!process.env.DEBUG;

let inputQueue = Promise.resolve();
function enqueue(fn, label) {
  const queuedAt = Date.now();
  inputQueue = inputQueue
    .then(async () => {
      const startedAt = Date.now();
      await fn();
      if (DEBUG && label) log(`input ${label}: waited ${startedAt - queuedAt} ms, ran ${Date.now() - startedAt} ms`);
    })
    .catch((err) => log('input:', err.message));
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

// Scrolling bypasses the input queue. Playwright's mouse waits for the page to handle each event,
// and a page busy with ads takes 200-700 ms per wheel, which stalled taps behind it. Raw CDP wheel
// events go out at once; at most two are in flight and the rest merge into one.
const inputSessions = new WeakMap();
function inputSession(p) {
  if (!inputSessions.has(p)) inputSessions.set(p, context.newCDPSession(p));
  return inputSessions.get(p);
}

function rawMouse(params) {
  const p = page;
  return inputSession(p).then((s) => s.send('Input.dispatchMouseEvent', params));
}

// A mouse left resting over the content fires hover previews and menus, so move it off the page
// once scrolling stops.
let parkTimer = null;
function parkMouseSoon() {
  clearTimeout(parkTimer);
  parkTimer = setTimeout(() => rawMouse({ type: 'mouseMoved', x: -1, y: -1 }).catch(() => {}), 250);
}

let wheelsInFlight = 0;
let pendingWheel = null;
function queueScroll(m) {
  if (wheelsInFlight >= 2) {
    if (pendingWheel) {
      pendingWheel.dx += m.dx;
      pendingWheel.dy += m.dy;
    } else {
      pendingWheel = { x: m.x, y: m.y, dx: m.dx, dy: m.dy };
    }
    return;
  }
  wheelsInFlight++;
  const sentAt = Date.now();
  rawMouse({ type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy })
    .catch(() => {})
    .finally(() => {
      if (DEBUG) log(`wheel acked after ${Date.now() - sentAt} ms`);
      wheelsInFlight--;
      if (pendingWheel) {
        const next = pendingWheel;
        pendingWheel = null;
        queueScroll(next);
      }
    });
  parkMouseSoon();
  sharpSoon();
}

// The client sends the scroll offset of the frame it shows. If the page has moved on since,
// scroll it back first, so the tap hits what the user saw.
async function alignScroll(sy) {
  if (typeof sy !== 'number') return;
  const current = await withTimeout(page.evaluate(() => Math.round(window.scrollY)), 300).catch(() => null);
  if (current === null || Math.abs(current - sy) <= 2) return;
  if (DEBUG) log(`tap: page at ${current}, frame at ${sy}; realigning`);
  await withTimeout(page.evaluate((y) => window.scrollTo(window.scrollX, y), sy), 300).catch(() => {});
}

// Runs inside each frame; reports the focused text field, if any.
function focusedField() {
  if (!document.hasFocus()) return null;
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return null;
  const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : 'text';
  const editable =
    el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && textTypes.includes(type)) || el.isContentEditable;
  if (!editable) return null;
  return {
    value: el.isContentEditable ? el.innerText : el.value,
    type,
    multiline: el.tagName !== 'INPUT',
    label: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
  };
}

// Runs outside the input queue with timeouts: ad iframes that are still loading can take
// seconds to answer, and taps must not wait for them.
async function reportFocus() {
  const p = page;
  const probe = (frame) => withTimeout(frame.evaluate(focusedField), 400).catch(() => null);
  let field = await probe(p.mainFrame());
  if (!field) {
    const inFrame = await withTimeout(p.evaluate(() => document.activeElement?.tagName === 'IFRAME'), 400).catch(() => false);
    if (inFrame) {
      for (const frame of p.frames().slice(1)) {
        field = await probe(frame);
        if (field) break;
      }
    }
  }
  if (p === page) send({ t: 'focus', field: field || null });
}

const handlers = {
  nav: (m) => page.goto(toUrl(m.url), { waitUntil: 'commit' }),
  back: () => page.goBack({ waitUntil: 'commit' }),
  forward: () => page.goForward({ waitUntil: 'commit' }),
  reload: () => page.reload({ waitUntil: 'commit' }),
  home: () => page.goto(HOME_URL, { waitUntil: 'commit' }),
  scroll: (m) => queueScroll(m),
  tap: (m) =>
    enqueue(async () => {
      await alignScroll(m.sy);
      if (DEBUG) {
        const hit = await withTimeout(
          page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            const a = el && el.closest('a');
            return { scrollY: Math.round(window.scrollY), target: a ? a.href : el && el.tagName };
          }, [m.x, m.y]),
          300,
        ).catch(() => null);
        log('tap', JSON.stringify(m), JSON.stringify(hit));
      }
      await page.mouse.click(m.x, m.y);
      // Give focus handlers a moment, without holding up the next input.
      setTimeout(() => reportFocus().catch(() => {}), 150);
      sharpSoon();
    }, 'tap'),
  focus: () => reportFocus(),
  // The iPad sends the whole field value; replacing the selection keeps it in sync without tracking keystrokes.
  type: (m) =>
    enqueue(async () => {
      await page.keyboard.press('ControlOrMeta+A');
      if (m.value) await page.keyboard.insertText(m.value);
      else await page.keyboard.press('Backspace');
    }),
  key: (m) =>
    enqueue(async () => {
      await page.keyboard.press(m.key);
      sharpSoon();
    }),
  video: async (m) => {
    const p = page;
    // Safari plays HLS natively (the iPad 2, with its tighter limits); others go through hls.js.
    const device = m.native ? 'ipad' : 'desktop';
    send({ t: 'toast', text: i18n.T.videoPreparing });
    try {
      const v = await video.start(p.url(), { cookies: await context.cookies(), userAgent, device });
      // The iPad plays it now; the page's own copy would only burn CPU.
      await withTimeout(p.evaluate(() => document.querySelectorAll('video, audio').forEach((el) => el.pause())), 1000).catch(() => {});
      log(`video: ${v.title} (${device}, ${v.quality}, ${v.transcoding ? 'transcoding' : 'copy'}${v.live ? ', live' : ''})`);
      send({ t: 'video', ...v });
    } catch (err) {
      log('video:', err.message);
      send({ t: 'video', error: err.message });
    }
  },
  videoStop: () => video.stop(),
  // The client says whether it decodes H.264 (WebCodecs); the iPad gets JPEG/PNG frames.
  stream: async (m) => {
    log(`stream mode: ${m.video ? 'h264' : `frames (${m.why || 'decoder failed'})`}`);
    if (client.video === !!m.video) return;
    client.video = !!m.video;
    await stopStream();
    await startStream();
  },
  hd: (m) => {
    if (hd === !!m.on) return;
    hd = !!m.on;
    restartScreencast();
  },
  // Very wide windows get a capped viewport with the same aspect ratio, shown upscaled:
  // every pixel costs CPU on this 2-core server.
  resize: async (m) => {
    let w = Math.round(m.w) || 0;
    let h = Math.round(m.h) || 0;
    if (w > MAX_WIDTH) {
      h = Math.round((h * MAX_WIDTH) / w);
      w = MAX_WIDTH;
    }
    // Even sizes for H.264, and no taller than the 1920x1080 virtual screen.
    const width = Math.max(320, w) & ~1;
    const height = Math.max(240, Math.min(1080, h)) & ~1;
    if (width === viewport.width && height === viewport.height && (client.cdp || vstream.running())) return;
    // Pixel density is not applied (Playwright fixes it per context); logged to see who would need it.
    log(`viewport ${width}x${height}, screen dpr ${m.dpr}`);
    viewport = { width, height };
    await page.setViewportSize(viewport);
    await startStream();
  },
};

const NAV_TYPES = ['nav', 'back', 'forward', 'reload', 'home'];
const INPUT_TYPES = NAV_TYPES.concat(['scroll', 'tap', 'type', 'key']);

function onMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const handler = handlers[m && m.t];
  if (!handler || !page) return;
  if (process.env.DEBUG && m.t !== 'scroll') log('msg', m.t === 'type' ? { t: 'type', len: m.value.length } : m);
  if (INPUT_TYPES.includes(m.t)) inputActivity();
  if (NAV_TYPES.includes(m.t)) send({ t: 'state', url: page.url(), loading: true });
  Promise.resolve(handler(m)).catch((err) => log(m.t + ':', err.message));
}

// ------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  const videoPath = pathname.match(/^\/video\/(\w+)\/([^/]+)$/);
  if (videoPath && req.method === 'GET') return video.serve(videoPath[1], videoPath[2], res);
  if (pathname === '/healthz') {
    res.writeHead(page ? 200 : 503, { 'Content-Type': 'text/plain' });
    return res.end(page ? 'ok' : 'starting');
  }
  const entry = STATIC[pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  fs.readFile(path.resolve(PUBLIC_DIR, entry[0]), (err, body) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
    // Cloudflare caches .js and .css and tells browsers to keep them for 4 hours, whatever the
    // origin says; a version in their URLs makes a new client load new files.
    if (pathname === '/') body = i18n.localizeHtml(String(body)).replace(/(src|href)="(app\.js|style\.css)"/g, `$1="$2?v=${CLIENT_VERSION}"`);
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  // Refuse cross-site pages that would open this socket with the visitor's cookies.
  const origin = req.headers.origin;
  let sameOrigin = false;
  try {
    sameOrigin = !origin || new URL(origin).host === req.headers.host;
  } catch {}
  if (!['/ws', '/audio'].includes(req.url) || !sameOrigin || !page) {
    socket.destroy();
    return;
  }
  // Audio has its own socket so a large frame never holds up sound.
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Every socket answers the keepalive ping below, or it is cut off as dead.
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    if (req.url === '/audio') audio.addListener(ws);
    else onConnection(ws);
  });
});

function onConnection(ws) {
  if (client) {
    const old = client;
    stopStream();
    old.ws.close(4000, 'replaced');
  }
  const me = { ws, cdp: null, video: false };
  hd = false; // the new client says what it wants right after connecting
  client = me;
  log('client connected');
  ws.on('message', (data, isBinary) => {
    if (!isBinary) onMessage(data.toString());
  });
  ws.on('close', () => {
    if (client !== me) return;
    stopStream();
    client = null;
    log('client disconnected');
  });
  send({ t: 'hello', version: CLIENT_VERSION });
  sendState(false);
  // The client sends its size right away; that message starts the stream.
}

// Cloudflare drops WebSockets that stay silent for 100 s.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// Porthole starts Chromium itself rather than through Playwright's launcher: Playwright resizes
// headful windows to fit the viewport, which drops them out of kiosk mode. In kiosk mode (openbox
// applies the fullscreen) every window, popups included, is chromeless at the top-left of the
// virtual screen, which is what vstream.js captures. Playwright then connects over CDP.
function launchChromium(profileDir) {
  const args = [
    '--kiosk',
    '--window-position=0,0',
    '--window-size=1920,1080',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-sandbox',
    `--lang=${LOCALE}`,
    // From Playwright's own launch switches: no first-run UI, infobars, sync or updates.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-component-update',
    '--disable-breakpad',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--password-store=basic',
    '--force-color-profile=srgb',
    '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    // Browser bubbles would be drawn over the page in the video and cannot be clicked.
    '--disable-features=Translate,MediaRouter,LensOverlay,DestroyProfileOnBrowserClose',
    '--deny-permission-prompts',
    '--hide-crash-restore-bubble',
    // Search engines block navigator.webdriver.
    '--disable-blink-features=AutomationControlled',
    // Smooth scrolling animates every wheel step over ~150 ms, which feels like lag remotely.
    '--disable-smooth-scrolling',
    'about:blank',
  ];
  const proc = spawn(chromium.executablePath(), args, { stdio: ['ignore', 'ignore', DEBUG ? 'inherit' : 'ignore'] });
  proc.on('exit', (code) => {
    log('chromium exited:', code);
    process.exit(1);
  });
  return proc;
}

async function connectChromium() {
  for (let i = 0; ; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (err) {
      if (i >= 50) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function main() {
  const profileDir = path.join(DATA_DIR, 'profile');
  // A recreated container has a new hostname, and Chromium refuses a profile whose lock names
  // another host. This process is the profile's only user, so a leftover lock is always stale.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(profileDir, name), { force: true });
  }
  chrome = launchChromium(profileDir);
  const browser = await connectChromium();
  browser.on('disconnected', () => {
    log('browser closed, exiting');
    process.exit(1);
  });
  context = browser.contexts()[0];
  context.on('page', onNewPage);
  for (const p of context.pages()) wirePage(p);
  page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize(viewport).catch(() => {});
  userAgent = await page.evaluate(() => navigator.userAgent);
  await page.goto(HOME_URL, { waitUntil: 'commit' }).catch((err) => log('goto:', err.message));
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => log(`listening on :${PORT}`));
}

process.on('unhandledRejection', (err) => log('unhandled:', err && err.message));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    video.stop();
    vstream.stop();
    chrome?.kill('SIGTERM');
    process.exit(0);
  });
}

main().catch((err) => {
  log('startup failed:', err);
  process.exit(1);
});

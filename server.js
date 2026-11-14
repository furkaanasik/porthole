'use strict';

// One headless Chromium tab, streamed as JPEG frames over a WebSocket to a
// single client (an old iPad). The client sends taps, scrolls and text back.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8091;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Google shows a captcha to datacenter IPs, so search defaults to DuckDuckGo.
const HOME_URL = process.env.HOME_URL || 'https://duckduckgo.com/';
const SEARCH_URL = process.env.SEARCH_URL || 'https://duckduckgo.com/?q=';
const QUALITY = Number(process.env.QUALITY) || 60;
const MAX_TABS = 5;
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

let context;
let page; // the tab currently shown on the iPad
let viewport = { width: 1024, height: 690 };
let client = null; // { ws, cdp }
let streamToken = 0;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Headless Chromium announces itself as "HeadlessChrome", which many sites block.
function realChromeUserAgent() {
  let version = '140.0.0.0';
  try {
    const out = execFileSync(chromium.executablePath(), ['--version'], { encoding: 'utf8' });
    version = (out.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || version;
  } catch (err) {
    log('could not read Chromium version:', err.message);
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

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

async function stopStream() {
  if (!client || !client.cdp) return;
  const cdp = client.cdp;
  client.cdp = null;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
}

async function startStream() {
  if (!client || !page) return;
  const token = ++streamToken;
  await stopStream();
  const ws = client.ws;
  const cdp = await context.newCDPSession(page);
  if (token !== streamToken || !client || client.ws !== ws) {
    await cdp.detach().catch(() => {});
    return;
  }
  client.cdp = cdp;
  cdp.on('Page.screencastFrame', (frame) => {
    const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (ws.readyState !== ws.OPEN) return ack();
    // Ack only once the frame has left the socket, so a slow link gets fewer frames instead of a backlog.
    ws.send(Buffer.from(frame.data, 'base64'), ack);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
  });
  // The screencast only emits on repaint; push one frame so a still page is not blank.
  const shot = await page.screenshot({ type: 'jpeg', quality: QUALITY }).catch(() => null);
  if (shot && ws.readyState === ws.OPEN && token === streamToken) ws.send(shot);
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

let inputQueue = Promise.resolve();
function enqueue(fn) {
  inputQueue = inputQueue.then(fn).catch((err) => log('input:', err.message));
}

let pendingScroll = null;
function queueScroll(m) {
  if (pendingScroll) {
    pendingScroll.dx += m.dx;
    pendingScroll.dy += m.dy;
    return;
  }
  pendingScroll = { x: m.x, y: m.y, dx: m.dx, dy: m.dy };
  enqueue(async () => {
    const s = pendingScroll;
    pendingScroll = null;
    await page.mouse.move(s.x, s.y);
    await page.mouse.wheel(s.dx, s.dy);
  });
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

async function reportFocus() {
  for (const frame of page.frames()) {
    const field = await frame.evaluate(focusedField).catch(() => null);
    if (field) return send({ t: 'focus', field });
  }
  send({ t: 'focus', field: null });
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
      await page.mouse.click(m.x, m.y);
      await new Promise((r) => setTimeout(r, 150));
      await reportFocus();
    }),
  focus: () => enqueue(reportFocus),
  // The iPad sends the whole field value; replacing the selection keeps it in sync without tracking keystrokes.
  type: (m) =>
    enqueue(async () => {
      await page.keyboard.press('ControlOrMeta+A');
      if (m.value) await page.keyboard.insertText(m.value);
      else await page.keyboard.press('Backspace');
    }),
  key: (m) => enqueue(() => page.keyboard.press(m.key)),
  resize: async (m) => {
    const width = Math.max(320, Math.min(1920, Math.round(m.w) || 0));
    const height = Math.max(240, Math.min(1920, Math.round(m.h) || 0));
    if (width === viewport.width && height === viewport.height && client.cdp) return;
    viewport = { width, height };
    await page.setViewportSize(viewport);
    await startStream();
  },
};

const NAV_TYPES = ['nav', 'back', 'forward', 'reload', 'home'];

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
  if (NAV_TYPES.includes(m.t)) send({ t: 'state', url: page.url(), loading: true });
  Promise.resolve(handler(m)).catch((err) => log(m.t + ':', err.message));
}

// ------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/healthz') {
    res.writeHead(page ? 200 : 503, { 'Content-Type': 'text/plain' });
    return res.end(page ? 'ok' : 'starting');
  }
  const entry = STATIC[pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, body) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
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
  if (req.url !== '/ws' || !sameOrigin || !page) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
});

function onConnection(ws) {
  if (client) {
    const old = client;
    stopStream();
    old.ws.close(4000, 'replaced');
  }
  const me = { ws, cdp: null };
  client = me;
  log('client connected');
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) onMessage(data.toString());
  });
  ws.on('close', () => {
    if (client !== me) return;
    stopStream();
    client = null;
    log('client disconnected');
  });
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

async function main() {
  context = await chromium.launchPersistentContext(path.join(DATA_DIR, 'profile'), {
    headless: true,
    // Full Chromium in new headless mode, without the automation flag: search engines block
    // the headless shell and navigator.webdriver.
    channel: 'chromium',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    viewport,
    deviceScaleFactor: 1,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    userAgent: realChromeUserAgent(),
  });
  context.on('close', () => {
    log('browser closed, exiting');
    process.exit(1);
  });
  context.on('page', onNewPage);
  for (const p of context.pages()) wirePage(p);
  page = context.pages()[0] || (await context.newPage());
  await page.goto(HOME_URL, { waitUntil: 'commit' }).catch((err) => log('goto:', err.message));
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => log(`listening on :${PORT}`));
}

process.on('unhandledRejection', (err) => log('unhandled:', err && err.message));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await context?.close().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  log('startup failed:', err);
  process.exit(1);
});

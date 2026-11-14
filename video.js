'use strict';

// Video mode. yt-dlp finds the page's real media streams and ffmpeg repackages them as HLS. The
// iPad's own player decodes H.264 Baseline/Main up to 720p30 in hardware; desktop browsers play any
// H.264 up to 1080p through hls.js. Matching streams are copied as they are; anything else is
// transcoded to 480p, which costs real CPU on this 2-core server.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_DIR = process.env.VIDEO_DIR || '/tmp/pencere-video';
// yt-dlp's ~= regex is case-sensitive and YouTube writes avc1.4D401F; without (?i) every video
// fell through to the 360p fallback.
const IPAD_H264 = "vcodec~='(?i)^avc1\\.(42|4d)'";
const FORMATS = {
  ipad: [
    `bv*[${IPAD_H264}][height<=720][fps<=30]+ba[acodec^=mp4a]`,
    `b[${IPAD_H264}][height<=720][fps<=30]`,
    'bv*[height<=720]+ba',
    'b[height<=720]',
    'b',
  ].join('/'),
  desktop: [
    'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]',
    'b[vcodec^=avc1][height<=1080]',
    'bv*[height<=1080]+ba',
    'b[height<=1080]',
    'b',
  ].join('/'),
};
const COPYABLE = { ipad: /^(avc1\.(42|4d)|h264)/i, desktop: /^(avc1|h264)/i };

let current = null; // { id, dir, ffmpeg, feeders, live }
let startToken = 0;

fs.rmSync(VIDEO_DIR, { recursive: true, force: true });

const lastLine = (text) => String(text || '').trim().split('\n').pop() || '';

function friendlyError(message) {
  if (/Unsupported URL|No video formats|no suitable formats/i.test(message)) {
    return 'Bu sayfada oynatılabilir bir video bulunamadı.';
  }
  if (/confirm you.re not a bot|Sign in to confirm/i.test(message)) {
    return 'YouTube robot kontrolü istedi. Pencere içinde YouTube hesabına giriş yapıp tekrar dene.';
  }
  if (/logged-in|login required|credentials|members only|private video/i.test(message)) {
    return 'Bu video giriş istiyor. Pencere içinde siteye giriş yapıp tekrar dene.';
  }
  return 'Video açılamadı: ' + message.replace(/^ERROR:\s*/, '').slice(0, 200);
}

// yt-dlp reads cookies in Netscape format; these come from the Chromium profile, so a site the
// user is logged into in Pencere is logged in for yt-dlp too.
function writeCookies(file, cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.round(c.expires) : 0;
    lines.push([c.domain, sub, c.path, c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}

function probe(url, cookieFile, userAgent, device) {
  // --flat-playlist: feed and channel pages would otherwise list every entry before failing.
  const args = ['-J', '--no-playlist', '--flat-playlist', '--no-warnings', '-f', FORMATS[device], '--js-runtimes', 'node',
    '--user-agent', userAgent, '--cookies', cookieFile, url];
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: 90000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(lastLine(stderr) || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function ffmpegArgs(info, dir, device, piped) {
  if (info._type === 'playlist') throw new Error('No video formats');
  const formats = info.requested_formats || [info];
  const has = (f, key) => f[key] && f[key] !== 'none';
  const vi = formats.findIndex((f) => has(f, 'vcodec'));
  const ai = formats.findIndex((f) => has(f, 'acodec'));
  if (vi < 0) throw new Error('No video formats');
  const v = formats[vi];
  const a = formats[ai];
  // Some HLS sources do not report codecs; they are almost always H.264/AAC.
  const copyVideo = !v.vcodec || COPYABLE[device].test(v.vcodec);
  const copyAudio = !a || !a.acodec || /^(mp4a|aac)/i.test(a.acodec);
  const live = !!info.is_live;

  const args = ['-loglevel', 'error', '-nostdin'];
  formats.forEach((f, i) => {
    if (piped) return args.push('-i', `pipe:${3 + i}`);
    const headers = Object.entries(f.http_headers || {}).map(([k, val]) => `${k}: ${val}\r\n`).join('');
    if (headers) args.push('-headers', headers);
    args.push('-i', f.url);
  });
  args.push('-map', `${vi}:v:0`);
  if (ai >= 0) args.push('-map', `${ai}:a:0`);
  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'main', '-level', '3.1',
      '-pix_fmt', 'yuv420p', '-vf', 'scale=-2:480', '-r', '30', '-g', '60');
  }
  if (ai >= 0) args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']));
  args.push('-f', 'hls', '-hls_time', '4', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'));
  if (live) args.push('-hls_list_size', '6', '-hls_flags', 'delete_segments+temp_file');
  else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file');
  args.push(path.join(dir, 'index.m3u8'));
  const quality = v.height ? `${v.height}p${Math.round(v.fps || 0) || ''}` : '';
  return { args, formats, live, quality, transcoding: !copyVideo };
}

function waitForPlaylist(dir, proc, errors) {
  const playlist = path.join(dir, 'index.m3u8');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let text = '';
      try {
        text = fs.readFileSync(playlist, 'utf8');
      } catch {}
      if (text.includes('#EXTINF')) {
        clearInterval(timer);
        resolve();
      } else if (proc.exitCode !== null || proc.signalCode) {
        clearInterval(timer);
        reject(new Error(lastLine(errors()) || 'ffmpeg exited'));
      } else if (Date.now() - started > 60000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for the first segment'));
      }
    }, 300);
  });
}

// YouTube answers ffmpeg's plain requests with 403 at times and throttles them; yt-dlp downloads
// the way YouTube expects (in chunks) and feeds ffmpeg through pipes instead.
function feed(proc, formats, infoFile, cookieFile, onError) {
  return formats.map((f, i) => {
    const y = spawn('yt-dlp', ['--load-info-json', infoFile, '-f', f.format_id, '--cookies', cookieFile,
      '--no-warnings', '--quiet', '-o', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = proc.stdio[3 + i];
    sink.on('error', () => {}); // ffmpeg exiting first is not an error here
    y.stdout.pipe(sink);
    y.stderr.on('data', onError);
    return y;
  });
}

async function start(pageUrl, { cookies, userAgent, device }) {
  stop();
  const token = ++startToken;
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(VIDEO_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const cookieFile = path.join(dir, 'cookies.txt');
  try {
    writeCookies(cookieFile, cookies);
    const info = await probe(pageUrl, cookieFile, userAgent, device);
    if (token !== startToken) throw new Error('cancelled');
    const piped = info.extractor_key === 'Youtube';
    const { args, formats, live, quality, transcoding } = ffmpegArgs(info, dir, device, piped);
    let errors = '';
    const onError = (d) => (errors = (errors + d).slice(-4000));
    const stdio = ['ignore', 'ignore', 'pipe'].concat(piped ? formats.map(() => 'pipe') : []);
    const proc = spawn('ffmpeg', args, { stdio });
    proc.stderr.on('data', onError);
    let feeders = [];
    if (piped) {
      const infoFile = path.join(dir, 'info.json');
      fs.writeFileSync(infoFile, JSON.stringify(info));
      feeders = feed(proc, formats, infoFile, cookieFile, onError);
    } else {
      fs.rmSync(cookieFile, { force: true });
    }
    current = { id, dir, ffmpeg: proc, feeders, live };
    await waitForPlaylist(dir, proc, () => errors);
    return { src: `/video/${id}/index.m3u8`, title: info.title || '', live, quality, transcoding };
  } catch (err) {
    if (!current || current.id !== id) fs.rmSync(dir, { recursive: true, force: true });
    else stop();
    throw new Error(friendlyError(err.message));
  }
}

function stop() {
  if (!current) return;
  current.ffmpeg.kill('SIGKILL');
  for (const y of current.feeders) y.kill('SIGKILL');
  fs.rmSync(current.dir, { recursive: true, force: true });
  current = null;
}

function serve(id, file, res) {
  if (!current || current.id !== id || !/^[\w-]+\.(m3u8|ts)$/.test(file)) {
    res.writeHead(404);
    return res.end();
  }
  const full = path.join(current.dir, file);
  if (file.endsWith('.m3u8')) return servePlaylist(full, current.live, res);
  fs.stat(full, (err, st) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(full).pipe(res);
  });
}

// While ffmpeg is still repackaging, the playlist has no end tag, and players treat it as live:
// they start at its newest segment and stall whenever the download lags. EXT-X-START makes them
// start at the beginning and build up a buffer instead.
function servePlaylist(full, live, res) {
  fs.readFile(full, 'utf8', (err, text) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    if (!live) text = text.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
    res.end(text);
  });
}

module.exports = { start, stop, serve };

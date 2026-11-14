'use strict';

// Desktop video stream. Chromium draws on the Xvfb display in kiosk mode, so the page sits at the
// top-left corner. ffmpeg grabs the viewport region and encodes it as H.264 with zero latency.
// Each access unit goes to the client over the WebSocket, prefixed by one flag byte (1 = keyframe),
// and the browser decodes it with WebCodecs. H.264 sends only what changed, so a scrolling page
// stays sharp at 30 fps for a few Mbit/s; JPEG frames needed several times that at lower quality.

const { spawn } = require('child_process');

const DISPLAY = process.env.DISPLAY || ':99';
const FPS = Number(process.env.VIDEO_FPS) || 30;
const CRF = Number(process.env.VIDEO_CRF) || 21;
const PRESET = process.env.VIDEO_PRESET || 'superfast';
const MAX_BUFFERED = 2 * 1024 * 1024;

let current = null; // { ws, width, height, proc }

function findAud(buf, from) {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 9) {
      return buf[i - 1] === 0 ? i - 1 : i;
    }
  }
  return -1;
}

// NAL unit types in an access unit, with the offset of each NAL header byte.
function nalUnits(au) {
  const units = [];
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      units.push({ type: au[i + 3] & 0x1f, at: i + 3 });
      i += 3;
    }
  }
  return units;
}

const hex = (n) => n.toString(16).padStart(2, '0');

function start(ws, width, height, onConfig, onExit) {
  // H.264 with 4:2:0 chroma needs even dimensions.
  const w = width & ~1;
  const h = height & ~1;
  if (current && current.ws === ws && current.width === w && current.height === h) return;
  stop();
  const proc = spawn(
    'ffmpeg',
    ['-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(FPS), '-video_size', `${w}x${h}`, '-i', `${DISPLAY}+0,0`,
      '-c:v', 'libx264', '-preset', PRESET, '-tune', 'zerolatency', '-crf', String(CRF), '-maxrate', '8M', '-bufsize', '4M',
      // A keyframe every 3 s lets the stream recover after frames were dropped on a slow link.
      '-g', String(FPS * 3), '-pix_fmt', 'yuv420p',
      // Access unit delimiters mark frame boundaries in the raw stream; headers repeat with each keyframe.
      '-x264-params', 'aud=1:repeat-headers=1',
      // Write each frame out at once; otherwise small frames wait in a 32 KB output buffer.
      '-flush_packets', '1', '-f', 'h264', '-'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const me = { ws, width: w, height: h, proc };
  current = me;
  let buf = Buffer.alloc(0);
  let configured = false;
  let dropping = false;

  function emit(au) {
    const units = nalUnits(au);
    const key = units.some((u) => u.type === 5);
    const sps = units.find((u) => u.type === 7);
    if (sps && !configured) {
      configured = true;
      onConfig({ codec: 'avc1.' + hex(au[sps.at + 1]) + hex(au[sps.at + 2]) + hex(au[sps.at + 3]), width: w, height: h });
    }
    if (!configured || ws.readyState !== ws.OPEN) return;
    // A backed-up link skips frames until the next keyframe; a decoder cannot skip ahead otherwise.
    if (dropping) {
      if (!key || ws.bufferedAmount > MAX_BUFFERED / 4) return;
      dropping = false;
    } else if (ws.bufferedAmount > MAX_BUFFERED) {
      dropping = true;
      return;
    }
    ws.send(Buffer.concat([Buffer.from([key ? 1 : 0]), au]));
  }

  proc.stdout.on('data', (data) => {
    buf = buf.length ? Buffer.concat([buf, data]) : data;
    // The buffer always starts at an access unit delimiter; the next one ends the unit.
    let end;
    while ((end = findAud(buf, 5)) > 0) {
      emit(buf.subarray(0, end));
      buf = buf.subarray(end);
    }
  });
  proc.on('exit', (code) => {
    if (current !== me) return;
    current = null;
    onExit(code);
  });
}

function stop() {
  if (!current) return;
  const { proc } = current;
  current = null;
  proc.kill('SIGKILL');
}

const running = () => !!current;

module.exports = { start, stop, running };

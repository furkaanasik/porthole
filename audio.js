'use strict';

// Page audio. Chromium plays into the "porthole" PulseAudio null sink (see entrypoint.sh); ffmpeg
// records the sink's monitor as 22.05 kHz mono 16-bit PCM, which goes to listeners in 100 ms
// chunks. Raw PCM needs no decoder on the iPad, and silent chunks are not sent at all.

const { spawn } = require('child_process');

const RATE = 22050;
const CHUNK_BYTES = (RATE / 10) * 2;
const MAX_BUFFERED = 64 * 1024; // a backed-up link drops audio instead of falling behind

const listeners = new Set();
let ffmpeg = null;
let pending = Buffer.alloc(0);

function start() {
  ffmpeg = spawn(
    'ffmpeg',
    // The pulse input's timestamps jitter a little; raw PCM output has no use for them, so only fatal errors print.
    ['-loglevel', 'fatal', '-nostdin', '-f', 'pulse', '-fragment_size', '2048', '-i', 'porthole.monitor',
      '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  ffmpeg.stdout.on('data', onData);
  ffmpeg.on('exit', () => {
    ffmpeg = null;
    pending = Buffer.alloc(0);
    if (listeners.size) setTimeout(() => listeners.size && !ffmpeg && start(), 1000);
  });
}

function isSilent(chunk) {
  for (let i = 0; i < chunk.length; i += 2) {
    if (Math.abs(chunk.readInt16LE(i)) > 16) return false;
  }
  return true;
}

function onData(data) {
  pending = pending.length ? Buffer.concat([pending, data]) : data;
  while (pending.length >= CHUNK_BYTES) {
    const chunk = Buffer.from(pending.subarray(0, CHUNK_BYTES));
    pending = pending.subarray(CHUNK_BYTES);
    if (isSilent(chunk)) continue;
    for (const ws of listeners) {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(chunk);
    }
  }
}

function addListener(ws) {
  listeners.add(ws);
  console.log(new Date().toISOString(), 'audio listener connected');
  if (!ffmpeg) start();
  ws.on('close', () => {
    console.log(new Date().toISOString(), 'audio listener disconnected');
    listeners.delete(ws);
    if (!listeners.size && ffmpeg) ffmpeg.kill();
  });
}

module.exports = { addListener, RATE };

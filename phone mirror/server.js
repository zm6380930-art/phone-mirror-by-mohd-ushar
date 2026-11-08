#!/usr/bin/env node
/*
 * Phone Mirror - tiny local server (zero npm dependencies)
 *
 * Needs: Node 18+  and  adb (Android platform-tools) available in PATH.
 * Run:   node server.js      then open   http://localhost:8080   in Chrome or Edge.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ADB = process.env.ADB || 'adb';
const SERIAL_RE = /^[\w.:\-]{1,64}$/;
let lastError = '';

/* ---------- adb helpers ---------- */

function adb(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || '');
          return reject(err);
        }
        resolve(String(stdout));
      }
    );
  });
}

async function listDevices() {
  const out = await adb(['devices', '-l']);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('List of') && !l.startsWith('*'))
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      const model = ((l.match(/model:(\S+)/) || [])[1] || serial).replace(/_/g, ' ');
      return { serial, state, model };
    });
}

async function deviceInfo(serial) {
  const sh = (cmd) => adb(['-s', serial, 'shell', cmd]).catch(() => '');
  const [model, android, wm, inp, display] = await Promise.all([
    sh('getprop ro.product.model'),
    sh('getprop ro.build.version.release'),
    sh('wm size'),
    sh('dumpsys input | grep -m1 SurfaceOrientation'),
    sh('dumpsys display'),
  ]);

  const m = wm.match(/Override size:\s*(\d+)x(\d+)/) || wm.match(/Physical size:\s*(\d+)x(\d+)/);
  const nativeW = m ? +m[1] : 1080;
  const nativeH = m ? +m[2] : 2400;
  const rot = +((inp.match(/SurfaceOrientation:\s*(\d)/) || [])[1] || 0);
  const landscape = rot % 2 === 1;

  // Best-effort display refresh rate (differs between Android versions / vendors)
  const rf =
    display.match(/renderFrameRate\s+([\d.]+)/) ||
    display.match(/mActiveSfDisplayMode=[^\n]*?(?:fps|refreshRate)=([\d.]+)/) ||
    display.match(/mActiveMode=[^\n]*?(?:fps|refreshRate)=([\d.]+)/);

  return {
    serial,
    model: model.trim(),
    android: android.trim(),
    nativeW,
    nativeH,
    width: landscape ? nativeH : nativeW,
    height: landscape ? nativeW : nativeH,
    landscape,
    refresh: rf ? Math.round(parseFloat(rf[1])) : null,
  };
}

/* ---------- screen streaming (H.264 over a chunked HTTP response) ---------- */

const align8 = (v) => Math.max(8, Math.floor(v / 8) * 8);

function streamScreen(res, serial, extraArgs) {
  let alive = true;
  let child = null;
  let fails = 0;

  res.on('close', () => {
    alive = false;
    if (child) child.kill();
  });

  const run = () => {
    if (!alive) return;
    const started = Date.now();
    let err = '';
    child = spawn(
      ADB,
      [
        '-s', serial, 'exec-out', 'screenrecord',
        '--output-format=h264',
        ...extraArgs,
        '--time-limit', '170', // screenrecord stops at 180s, so we restart seamlessly
        '-',
      ],
      { windowsHide: true }
    );
    child.stdout.pipe(res, { end: false });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      lastError = e.message;
      alive = false;
      res.end();
    });
    child.on('close', (code) => {
      if (!alive) return;
      if (Date.now() - started < 3000) {
        fails++;
        lastError = err.trim() || `screenrecord exited with code ${code}`;
        console.log('[stream]', lastError);
      } else {
        fails = 0;
      }
      if (fails >= 3) {
        res.end();
        return;
      }
      setTimeout(run, 100);
    });
  };
  run();
}

/* ---------- input (persistent `adb shell` per phone = lower latency) ---------- */

const shells = new Map();

function shellFor(serial) {
  let s = shells.get(serial);
  if (s && s.stdin.writable) return s;
  s = spawn(ADB, ['-s', serial, 'shell'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  s.stdin.on('error', () => {});
  s.on('error', () => {});
  s.on('close', () => {
    if (shells.get(serial) === s) shells.delete(serial);
  });
  shells.set(serial, s);
  return s;
}

const int = (v) => Math.round(Number(v));

function buildCommand(b) {
  switch (b.type) {
    case 'tap': {
      const [x, y] = [int(b.x), int(b.y)];
      if (![x, y].every(Number.isFinite)) return null;
      return `input tap ${x} ${y}`;
    }
    case 'swipe': {
      const [x1, y1, x2, y2, d] = [int(b.x1), int(b.y1), int(b.x2), int(b.y2), int(b.dur)];
      if (![x1, y1, x2, y2, d].every(Number.isFinite)) return null;
      return `input swipe ${x1} ${y1} ${x2} ${y2} ${Math.min(Math.max(d, 1), 3000)}`;
    }
    case 'key': {
      const code = int(b.code);
      if (!Number.isInteger(code) || code < 0 || code > 400) return null;
      return `input keyevent ${code}`;
    }
    case 'text': {
      const t = String(b.text || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
      if (!t) return null;
      return `input text '${t.replace(/'/g, "'\\''").replace(/ /g, '%s')}'`;
    }
    case 'notif':
      return 'cmd statusbar expand-notifications';
    default:
      return null;
  }
}

/* ---------- HTTP server ---------- */

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 10000) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

// Blocks other websites from driving your phone through this local server.
function requestAllowed(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/devices') {
      try {
        return json(res, 200, { adb: true, devices: await listDevices() });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { adb: false, devices: [] });
        return json(res, 200, { adb: true, devices: [], error: e.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      const serial = q.get('serial') || '';
      if (!SERIAL_RE.test(serial)) return json(res, 400, { error: 'bad serial' });
      return json(res, 200, await deviceInfo(serial));
    }

    if (req.method === 'GET' && url.pathname === '/api/lasterror') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(lastError);
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const serial = q.get('serial') || '';
      if (!SERIAL_RE.test(serial)) return json(res, 400, { error: 'bad serial' });
      const longSide = Math.min(Math.max(parseInt(q.get('size') || '1280', 10) || 0, 0), 4000);
      const mbps = Math.min(Math.max(parseFloat(q.get('mbps') || '8') || 8, 1), 40);

      const info = await deviceInfo(serial);
      const args = ['--bit-rate', String(Math.round(mbps * 1e6))];
      if (longSide > 0) {
        const scale = Math.min(1, longSide / Math.max(info.width, info.height));
        args.push('--size', `${align8(info.width * scale)}x${align8(info.height * scale)}`);
      }
      lastError = '';
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      return streamScreen(res, serial, args);
    }

    if (req.method === 'POST' && url.pathname === '/api/input') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'json only' });
      }
      const b = JSON.parse(await readBody(req));
      if (!SERIAL_RE.test(String(b.serial || ''))) return json(res, 400, { error: 'bad serial' });
      const cmd = buildCommand(b);
      if (!cmd) return json(res, 400, { error: 'bad command' });
      shellFor(b.serial).stdin.write(cmd + '\n');
      return json(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Try:  PORT=8090 node server.js`);
  else console.error(e);
  process.exit(1);
});

function shutdown() {
  for (const s of shells.values()) s.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

adb(['start-server'])
  .catch((e) => {
    if (e.code === 'ENOENT') {
      console.error('\n!! adb was not found. Install Android "platform-tools" and add it to your PATH.');
      console.error('   https://developer.android.com/tools/releases/platform-tools\n');
    }
  })
  .finally(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\nPhone Mirror running ->  http://localhost:${PORT}   (use Chrome or Edge)\n`);
    });
  });

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS, 'index.html');
const HTTP_PORT = Number(process.env.T15_HTTP_PORT) || 8875;
const CDP_PORT = Number(process.env.T15_CDP_PORT) || 24655;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t15=1`;
const FILE_URL = `${pathToFileURL(INDEX_PATH).href}?t15=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USE_PIPE = process.env.T15_USE_PIPE === '1';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 15000, intervalMs = 25) {
  const started = Date.now();
  let last;
  while (Date.now() - started < limitMs) {
    last = await check();
    if (last) return last;
    await timeout(intervalMs);
  }
  throw new Error(`Timeout esperando ${label}; ultimo=${JSON.stringify(last)}`);
}

function serveDocs() {
  const mime = {
    '.html':'text/html',
    '.js':'text/javascript',
    '.json':'application/json',
    '.png':'image/png',
    '.ttf':'font/ttf',
    '.otf':'font/otf',
  };
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(req.url.split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(DOCS, `.${pathname}`);
    if (!file.startsWith(`${DOCS}${path.sep}`)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once:true });
      this.ws.addEventListener('error', reject, { once:true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
      } else if (message.method) {
        this.sessions.get(message.sessionId)?.events.push(message);
      }
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async createSession() {
    const { targetId } = await this.send('Target.createTarget', { url:'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten:true });
    const session = new CdpSession(this, sessionId, targetId);
    this.sessions.set(sessionId, session);
    return session;
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

class PipeCdp {
  constructor(chrome) {
    this.input = chrome.stdio[3];
    this.output = chrome.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.buffer = '';
  }
  async open() {
    this.output.setEncoding('utf8');
    this.output.on('data', chunk => {
      this.buffer += chunk;
      let separator;
      while ((separator = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
          else pending.resolve(message.result || {});
        } else if (message.method) {
          this.sessions.get(message.sessionId)?.events.push(message);
        }
      }
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  async createSession() {
    const { targetId } = await this.send('Target.createTarget', { url:'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten:true });
    const session = new CdpSession(this, sessionId, targetId);
    this.sessions.set(sessionId, session);
    return session;
  }
  close() {
    try { this.input.destroy(); } catch (_) {}
    try { this.output.destroy(); } catch (_) {}
  }
}

class CdpSession {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.events = [];
  }
  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
  close() {
    this.cdp.sessions.delete(this.sessionId);
    this.cdp.send('Target.closeTarget', { targetId:this.targetId }).catch(() => {});
  }
}

async function evaluate(page, expression) {
  const response = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise:true,
    returnByValue:true,
    userGesture:true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error(`Runtime.evaluate: ${detail}`);
  }
  return response.result?.value;
}

const INIT_SCRIPT = String.raw`
(() => {
  window.__t15 = { warnings:[], errors:[], raf:0 };
  const realSetTimeout = window.setTimeout.bind(window);
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    __t15.raf++;
    cb(performance.now());
  }, 16);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const nativeWarn = console.warn.bind(console);
  const nativeError = console.error.bind(console);
  console.warn = (...args) => {
    __t15.warnings.push(args.map(String).join(' '));
    nativeWarn(...args);
  };
  console.error = (...args) => {
    __t15.errors.push(args.map(String).join(' '));
    nativeError(...args);
  };

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (AudioCtor) {
    const nativeCreateMediaStreamSource = AudioCtor.prototype.createMediaStreamSource;
    AudioCtor.prototype.createMediaStreamSource = function(stream) {
      const mix = this.createGain();
      mix.gain.value = 0.06;
      for (const [frequency, lfoRate] of [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]) {
        const oscillator = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        oscillator.frequency.value = frequency;
        lfo.frequency.value = lfoRate;
        gain.gain.value = 0.15;
        lfoGain.gain.value = 0.12;
        lfo.connect(lfoGain).connect(gain.gain);
        oscillator.connect(gain).connect(mix);
        oscillator.start();
        lfo.start();
      }
      return mix || nativeCreateMediaStreamSource.call(this, stream);
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async constraints => {
    const stream = new MediaStream();
    if (constraints && constraints.video) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#213547';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ff7849';
      ctx.fillRect(40, 36, 140, 110);
      canvas.captureStream(30).getVideoTracks().forEach(track => stream.addTrack(track));
    }
    if (constraints && constraints.audio && AudioCtor) {
      const audio = new AudioCtor();
      const destination = audio.createMediaStreamDestination();
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    }
    return stream;
  };
})()`;

const RUNTIME_PHASE = String.raw`
(async () => {
  const assertLocal = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const nextTask = () => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
  const waitWorkerIdle = async () => {
    let turns = 0;
    while (_asciiWorkerBusy && turns < 200000) {
      turns++;
      await nextTask();
    }
    if (_asciiWorkerBusy) throw new Error('worker ASCII no quedo idle');
  };
  const diff = (a, b) => {
    let changedPixels = 0;
    let totalDelta = 0;
    let maxDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]) +
        Math.abs(a[i + 3] - b[i + 3]);
      if (delta) changedPixels++;
      totalDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
    }
    return {
      changedPixels,
      totalPixels:a.length / 4,
      changedRatio:changedPixels / (a.length / 4),
      meanChannelDelta:totalDelta / a.length,
      maxDelta,
    };
  };
  const hash = data => {
    let value = 2166136261;
    for (let i = 0; i < data.length; i++) value = Math.imul(value ^ data[i], 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const stats = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      frames:sorted.length,
      avgMs:sum / sorted.length,
      medianMs:sorted[Math.floor(sorted.length * 0.5)],
      p95Ms:sorted[Math.floor(sorted.length * 0.95)],
      maxMs:sorted[sorted.length - 1],
    };
  };

  await document.fonts.ready;
  cameraRunning = false;
  asciiRunning = false;
  _asciiLoopAlive = false;
  await waitWorkerIdle();

  const SW = 512, SH = 384, OW = 1024, OH = 768;
  const seed = new Uint8ClampedArray(SW * SH * 4);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      const tile = ((x >> 4) ^ (y >> 4)) & 1;
      seed[i] = (x * 7 + y * 3 + tile * 61) & 255;
      seed[i + 1] = (x * 5 + y * 11 + tile * 29) & 255;
      seed[i + 2] = (x * 13 + y * 2 + tile * 83) & 255;
      seed[i + 3] = 255;
    }
  }
  const workerSettings = {
    cols:160,
    font:'monospace',
    bright:100,
    contrast:100,
    sat:100,
    hue:0,
    gray:0,
    sepia:0,
    invert:0,
    threshOn:false,
    thresh:128,
    sharpOn:false,
    sharp:12,
    edgeOn:false,
    edge:8,
    gradient:'normal',
    space:1,
    frame:0,
    pyMode:'off',
    pyPal:0,
    chaos:0,
    outW:OW,
    outH:OH,
    palInk:[12,18,24],
    palPaper:[238,229,198],
    invertMap:false,
  };
  const workerUrl = () => URL.createObjectURL(new Blob(
    ['(' + _asciiWorkerBody.toString() + ')()'],
    { type:'application/javascript' }
  ));
  const runWorker = (
    useAtlas,
    measuredFrames,
    warmupFrames = 5,
    capturePixels = false,
    useGpuAtlas = true,
    settingsPatch = {}
  ) =>
    new Promise((resolve, reject) => {
      const url = workerUrl();
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      const samples = [];
      const totalFrames = measuredFrames + warmupFrames;
      let completed = 0;
      let buffer = seed.slice().buffer;
      const canvas = capturePixels ? document.createElement('canvas') : null;
      const ctx = canvas ? canvas.getContext('2d', { willReadFrequently:true }) : null;
      if (canvas) {
        canvas.width = OW;
        canvas.height = OH;
      }
      worker.onerror = event => {
        worker.terminate();
        reject(new Error(event.message || 'worker aislado fallo'));
      };
      worker.onmessage = event => {
        const data = event.data;
        if (completed >= warmupFrames) {
          samples.push({
            renderMs:data.renderMs,
            prepMs:data.prepMs,
            gridMs:data.gridMs,
            bitmapMs:data.bitmapMs,
          });
        }
        completed++;
        if (capturePixels && completed === totalFrames) ctx.drawImage(data.bitmap, 0, 0);
        data.bitmap.close();
        buffer = data.buf;
        if (completed >= totalFrames) {
          const pixels = capturePixels ? ctx.getImageData(0, 0, OW, OH).data.slice() : null;
          worker.terminate();
          resolve({ samples, pixels, text:data.text });
          return;
        }
        worker.postMessage({
          type:'render',
          buf:buffer,
          sw:SW,
          sh:SH,
          s:{ ...workerSettings, ...settingsPatch, useAtlas, useGpuAtlas },
          asciiSubMode:'classic',
          OUT_W:OW,
          OUT_H:OH,
        }, [buffer]);
      };
      worker.postMessage({
        type:'render',
        buf:buffer,
        sw:SW,
        sh:SH,
        s:{ ...workerSettings, ...settingsPatch, useAtlas, useGpuAtlas },
        asciiSubMode:'classic',
        OUT_W:OW,
        OUT_H:OH,
      }, [buffer]);
    });

  const workerLegacyParity = await runWorker(false, 1, 0, true);
  const workerCanvasParity = await runWorker(true, 1, 0, true, false);
  const workerAtlasParity = await runWorker(true, 1, 0, true, true);
  const pyCharsLegacy = await runWorker(false, 1, 0, true, false, { pyMode:'chars', chaos:0 });
  const pyCharsAtlas = await runWorker(true, 1, 0, true, true, { pyMode:'chars', chaos:0 });
  const workerParity = {
    canvas:diff(workerLegacyParity.pixels, workerCanvasParity.pixels),
    gpu:diff(workerLegacyParity.pixels, workerAtlasParity.pixels),
    gpuVsCanvas:diff(workerCanvasParity.pixels, workerAtlasParity.pixels),
    textEqual:
      workerLegacyParity.text === workerCanvasParity.text &&
      workerLegacyParity.text === workerAtlasParity.text,
    pyChars:diff(pyCharsLegacy.pixels, pyCharsAtlas.pixels),
  };
  const workerLegacyBench = await runWorker(false, 300, 8, false);
  const workerAtlasBench = await runWorker(true, 300, 8, false);
  const workerPerformance = {
    legacy:stats(workerLegacyBench.samples.map(sample => sample.renderMs)),
    atlas:stats(workerAtlasBench.samples.map(sample => sample.renderMs)),
    phases:{
      legacy:{
        prep:stats(workerLegacyBench.samples.map(sample => sample.prepMs)),
        grid:stats(workerLegacyBench.samples.map(sample => sample.gridMs)),
        bitmap:stats(workerLegacyBench.samples.map(sample => sample.bitmapMs)),
      },
      atlas:{
        prep:stats(workerAtlasBench.samples.map(sample => sample.prepMs)),
        grid:stats(workerAtlasBench.samples.map(sample => sample.gridMs)),
        bitmap:stats(workerAtlasBench.samples.map(sample => sample.bitmapMs)),
      },
    },
  };
  workerPerformance.reductionPct =
    (1 - workerPerformance.atlas.avgMs / workerPerformance.legacy.avgMs) * 100;

  const workerResilience = await new Promise((resolve, reject) => {
    let body = _asciiWorkerBody.toString();
    const hookAt = "self.onmessage = function(e) {";
    assertLocal(body.includes(hookAt), 'hook worker no encontrado');
    body = body
      .replace(
        "if (cached) {",
        "if (cached) { self.__atlasCacheHits=(self.__atlasCacheHits||0)+1;"
      )
      .replace(
        "console.warn(message, error || '');",
        "self.__glyphWarns=(self.__glyphWarns||0)+1;console.warn(message, error || '');"
      );
    const probeCode = [
      "if (e.data.type === 'probe') {",
      "  self.postMessage({ type:'probeResult',",
      "    cacheSize:_atlasCache.size, cacheBytes:_atlasCacheBytes, cacheBudget:ATLAS_CACHE_BUDGET,",
      "    sheetBytes:[..._atlasCache.values()].reduce((n,a)=>n+a.canvas.width*a.canvas.height*4,0),",
      "    cacheHits:self.__atlasCacheHits||0, glyphWarns:self.__glyphWarns||0,",
      "    glDisabled:_glyphGLDisabled, glActive:!!_glyphGL,",
      "  });",
      "  return;",
      "}",
      "if (e.data.type === 'loseGL') {",
      "  let lost=false;",
      "  if (_glyphGL) {",
      "    const ext=_glyphGL.gl.getExtension('WEBGL_lose_context');",
      "    if (ext) { ext.loseContext(); lost=true; }",
      "  }",
      "  self.postMessage({ type:'lostResult', lost });",
      "  return;",
      "}",
    ].join('\n');
    body = body.replace(hookAt, hookAt + probeCode);
    const url = URL.createObjectURL(new Blob(['(' + body + ')()'], { type:'application/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    const pending = [];
    worker.onmessage = event => pending.shift()?.resolve(event.data);
    worker.onerror = event => {
      pending.shift()?.reject(new Error(event.message || 'worker resiliencia fallo'));
    };
    const roundtrip = message => new Promise((resolveMessage, rejectMessage) => {
      pending.push({ resolve:resolveMessage, reject:rejectMessage });
      worker.postMessage(message, message.buf ? [message.buf] : []);
    });
    const render = async settings => {
      const data = await roundtrip({
        type:'render',
        buf:seed.slice().buffer,
        sw:SW,
        sh:SH,
        s:{ ...workerSettings, ...settings, useAtlas:true, useGpuAtlas:true },
        asciiSubMode:'classic',
        OUT_W:OW,
        OUT_H:OH,
      });
      const canvas = new OffscreenCanvas(OW, OH);
      const ctx = canvas.getContext('2d', { willReadFrequently:true });
      ctx.drawImage(data.bitmap, 0, 0);
      data.bitmap.close();
      return ctx.getImageData(0, 0, OW, OH).data;
    };
    (async () => {
      for (let i = 0; i < 20; i++) {
        await render({
          palInk:[i * 12 % 255, (40 + i * 9) % 255, (200 - i * 7 + 255) % 255],
        });
      }
      const cacheAfterChurn = await roundtrip({ type:'probe' });
      const hitsBefore = cacheAfterChurn.cacheHits;
      await render({ palInk:[228,211,67] });
      const cacheAfterHit = await roundtrip({ type:'probe' });
      const reference = await render({ palInk:[255,255,255], palPaper:[8,8,8] });
      const lost = await roundtrip({ type:'loseGL' });
      const afterLoss = await render({ palInk:[255,255,255], palPaper:[8,8,8] });
      await render({ palInk:[255,255,255], palPaper:[8,8,8] });
      const afterLossProbe = await roundtrip({ type:'probe' });
      worker.terminate();
      resolve({
        cache:{
          size:cacheAfterChurn.cacheSize,
          bytes:cacheAfterChurn.cacheBytes,
          sheetBytes:cacheAfterChurn.sheetBytes,
          budget:cacheAfterChurn.cacheBudget,
          hitDelta:cacheAfterHit.cacheHits - hitsBefore,
          sizeAfterHit:cacheAfterHit.cacheSize,
        },
        contextLoss:{
          lost:lost.lost,
          parity:diff(reference, afterLoss),
          warnings:afterLossProbe.glyphWarns,
          glDisabled:afterLossProbe.glDisabled,
          workerResponded:true,
        },
      });
    })().catch(error => {
      worker.terminate();
      reject(error);
    });
  });

  const slhtCanvasLegacy = document.createElement('canvas');
  slhtCanvasLegacy.width = OW;
  slhtCanvasLegacy.height = OH;
  const slhtLegacyCtx = slhtCanvasLegacy.getContext('2d', { willReadFrequently:true });
  const slhtCanvasAtlas = document.createElement('canvas');
  slhtCanvasAtlas.width = OW;
  slhtCanvasAtlas.height = OH;
  const slhtAtlasCtx = slhtCanvasAtlas.getContext('2d', { willReadFrequently:true });
  _slhtFieldOK = true;
  _slhtMaxDist = 18;
  _slhtActiveP = SLHT_MAX_P;
  slhtGlyphSz = 8;
  slhtFillAmt = 70;
  for (let i = 0; i < _slhtMask.length; i++) {
    _slhtMask[i] = (i % 11) < 8 ? 1 : 0;
    _slhtDist[i] = i % 18;
  }
  for (let i = 0; i < SLHT_MAX_P; i++) {
    _slhtPX[i] = ((i * 37) % OW) + 0.35;
    _slhtPY[i] = ((i * 53) % OH) + 0.65;
    const angle = ((i * 29) % 360) * Math.PI / 180;
    _slhtPA[i] = angle;
    _slhtPC[i] = Math.cos(angle);
    _slhtPS[i] = Math.sin(angle);
    _slhtPB[i] = Math.round(angle / (Math.PI * 2) * SLHT_ATLAS_ANGLES) % SLHT_ATLAS_ANGLES;
    _slhtPL[i] = 0.35 + (i % 65) / 100;
    _slhtPG[i] = i % SLHT_NG;
    _slhtPI[i] = _SLHT_GLYPH_UNIQUE_INDEX[_slhtPG[i]] * SLHT_ATLAS_ANGLES + _slhtPB[i];
  }
  const clearSlht = ctx => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OW, OH);
  };
  clearSlht(slhtLegacyCtx);
  _slhtRenderGlyphPhase(slhtLegacyCtx, OW, OH, false);
  clearSlht(slhtAtlasCtx);
  _slhtRenderGlyphPhase(slhtAtlasCtx, OW, OH, true);
  const slhtLegacyPixels = slhtLegacyCtx.getImageData(0, 0, OW, OH).data;
  const slhtAtlasPixels = slhtAtlasCtx.getImageData(0, 0, OW, OH).data;
  const slhtParity = diff(slhtLegacyPixels, slhtAtlasPixels);
  const slhtLegacyTimes = [];
  const slhtAtlasTimes = [];
  for (let i = 0; i < 12; i++) {
    clearSlht(slhtLegacyCtx);
    _slhtRenderGlyphPhase(slhtLegacyCtx, OW, OH, false);
    clearSlht(slhtAtlasCtx);
    _slhtRenderGlyphPhase(slhtAtlasCtx, OW, OH, true);
  }
  for (let i = 0; i < 300; i++) {
    clearSlht(slhtLegacyCtx);
    let started = performance.now();
    _slhtRenderGlyphPhase(slhtLegacyCtx, OW, OH, false);
    slhtLegacyTimes.push(performance.now() - started);
  }
  for (let i = 0; i < 300; i++) {
    clearSlht(slhtAtlasCtx);
    let started = performance.now();
    _slhtRenderGlyphPhase(slhtAtlasCtx, OW, OH, true);
    slhtAtlasTimes.push(performance.now() - started);
  }
  const slhtPerformance = {
    legacy:stats(slhtLegacyTimes),
    atlas:stats(slhtAtlasTimes),
  };
  slhtPerformance.reductionPct =
    (1 - slhtPerformance.atlas.avgMs / slhtPerformance.legacy.avgMs) * 100;
  const clearSlhtAtlases = () => {
    for (const atlas of _slhtGlyphAtlases.values()) atlas.canvas.close?.();
    _slhtGlyphAtlases.clear();
  };
  const slhtBuildMsBySize = {};
  for (let size = 5; size <= 18; size++) {
    clearSlhtAtlases();
    slhtAtlasCtx.font = size + 'px monospace';
    slhtAtlasCtx.fillStyle = '#000000';
    const started = performance.now();
    _slhtGetGlyphAtlas(slhtAtlasCtx, size);
    slhtBuildMsBySize[size] = performance.now() - started;
  }
  const slhtBuild = {
    bySize:slhtBuildMsBySize,
    maxMs:Math.max(...Object.values(slhtBuildMsBySize)),
  };
  clearSlhtAtlases();

  const syncPixels = seed.slice();
  pySubMode = 'off';
  acSharpOn = true;
  acSharpVal = 12;
  acEdgeOn = true;
  acEdgeVal = 8;
  asciiCols = 80;
  const allocsBefore = _asciiFloatPoolAllocs;
  _renderASCIISync(syncPixels, SW, SH, 80, false);
  const grayRef = _asciiGrayPool;
  const tmpRef = _asciiTmpPool;
  const firstHash = hash(ctxAscii.getImageData(0, 0, OUT_W, OUT_H).data);
  const allocsAfterFirst = _asciiFloatPoolAllocs;
  _renderASCIISync(syncPixels, SW, SH, 80, false);
  _renderASCIISync(syncPixels, SW, SH, 80, false);
  const secondHash = hash(ctxAscii.getImageData(0, 0, OUT_W, OUT_H).data);
  const syncPool = {
    allocsBefore,
    allocsAfterFirst,
    allocsAfterThree:_asciiFloatPoolAllocs,
    grayReused:grayRef === _asciiGrayPool,
    tmpReused:tmpRef === _asciiTmpPool,
    grayBytes:_asciiGrayPool.byteLength,
    tmpBytes:_asciiTmpPool.byteLength,
    pixelHashesEqual:firstHash === secondHash,
  };

  await waitWorkerIdle();
  _ensureAsciiWorkerImagePool(SW, SH);
  ctxAS.putImageData(new ImageData(seed.slice(), SW, SH), 0, 0);
  const readbackExpected = ctxAS.getImageData(0, 0, SW, SH).data.slice();
  const readbackProbe = _captureAsciiWorkerImageData(SW, SH);
  const readbackParity = diff(readbackExpected, readbackProbe.data);
  _releaseAsciiWorkerImageData(readbackProbe, SW, SH);
  const raceBefore = { ..._asciiWorkerStats };
  const nativeDrawImage = ctxAscii.drawImage;
  let wrongSubmodePaints = 0;
  let expectedPaintHeight = 0;
  let staleHeightPaints = 0;
  ctxAscii.drawImage = function(...args) {
    if (asciiSubMode !== 'classic') wrongSubmodePaints++;
    if (expectedPaintHeight && OUT_H !== expectedPaintHeight) staleHeightPaints++;
    return nativeDrawImage.apply(this, args);
  };
  const savedCols = asciiCols;
  asciiCols = 40;
  for (let i = 0; i < 20; i++) {
    asciiSubMode = 'classic';
    const imgData = _captureAsciiWorkerImageData(SW, SH);
    assertLocal(!!imgData, 'sin buffer ping-pong en iteracion ' + i);
    _dispatchAsciiWorker(imgData, SW, SH, false);
    asciiSubMode = 'typo';
    await waitWorkerIdle();
  }
  asciiSubMode = 'classic';
  const savedOutW = OUT_W;
  const widthImage = _captureAsciiWorkerImageData(SW, SH);
  _dispatchAsciiWorker(widthImage, SW, SH, false);
  OUT_W = savedOutW + 4;
  await waitWorkerIdle();
  OUT_W = savedOutW;
  const heightDiscardedBefore = _asciiWorkerStats.discardedFrames;
  const savedAspectW = camAspW;
  const savedAspectH = camAspH;
  for (let i = 0; i < 10; i++) {
    applyCamAspect(4, 3);
    expectedPaintHeight = OUT_H;
    const heightImage = _captureAsciiWorkerImageData(SW, SH);
    assertLocal(!!heightImage, 'sin buffer para resize real en iteracion ' + i);
    _dispatchAsciiWorker(heightImage, SW, SH, false);
    applyCamAspect(16, 9);
    await waitWorkerIdle();
    expectedPaintHeight = 0;
  }
  applyCamAspect(savedAspectW, savedAspectH);
  ctxAscii.drawImage = nativeDrawImage;
  asciiCols = savedCols;
  const raceAfter = { ..._asciiWorkerStats };
  const race = {
    iterations:20,
    wrongSubmodePaints,
    acceptedDelta:raceAfter.acceptedFrames - raceBefore.acceptedFrames,
    discardedDelta:raceAfter.discardedFrames - raceBefore.discardedFrames,
    returnedDelta:raceAfter.returnedBuffers - raceBefore.returnedBuffers,
    widthGuardDiscarded:
      heightDiscardedBefore - raceBefore.discardedFrames === 21,
    heightGuard:{
      iterations:10,
      discarded:raceAfter.discardedFrames - heightDiscardedBefore,
      stalePaints:staleHeightPaints,
      outWConstant:savedOutW === OUT_W,
    },
    poolCreatedDelta:raceAfter.poolCreated - raceBefore.poolCreated,
    poolMissesDelta:raceAfter.poolMisses - raceBefore.poolMisses,
    gpuReadbackDelta:raceAfter.gpuReadbacks - raceBefore.gpuReadbacks,
    fallbackReadbackDelta:raceAfter.fallbackReadbacks - raceBefore.fallbackReadbacks,
    readbackParity,
    poolAvailable:_asciiWorkerImagePool.length,
    busy:_asciiWorkerBusy,
    pending:!!_asciiWorkerPend,
  };

  return {
    worker:{ parity:workerParity, performance:workerPerformance, resilience:workerResilience },
    slht:{ parity:slhtParity, performance:slhtPerformance, build:slhtBuild, activeGlyphs:_slhtActiveP },
    syncPool,
    race,
    runtime:{ raf:__t15.raf, warnings:__t15.warnings, errors:__t15.errors },
  };
})()
`;

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const marker = '<script>';
  const scriptStart = html.indexOf(marker);
  const scriptEnd = html.lastIndexOf('</script>');
  assert(scriptStart >= 0 && scriptEnd > scriptStart, 'script inline no encontrado');
  assert(html.indexOf(marker, scriptStart + marker.length) < 0, 'mas de un script inline');
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t15-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, html.slice(scriptStart + marker.length, scriptEnd));
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const idCounts = new Map();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const duplicateIds = [...idCounts].filter(([, count]) => count > 1);
  const staticRefs = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const missingStaticRefs = [...new Set(staticRefs.filter(id => !idCounts.has(id) && id !== 'flipSettingsStyle'))];
  const staticChecks = {
    syntax:true,
    oneInlineScript:true,
    duplicateIds,
    missingStaticRefs,
    workerAtlas:/function getGlyphAtlas\(/.test(html) && /drawAtlasGlyph\(/.test(html),
    workerReturnsBuffer:/\[bitmap,buf\]/.test(html),
    workerRaceGuard:/e\.data\.OUT_W === OUT_W && e\.data\.OUT_H === OUT_H/.test(html),
    workerPendingHeightGuard:/p\.OUT_H === OUT_H/.test(html),
    workerPyGate:/const useAtlas=s\.useAtlas!==false&&s\.pyMode==='off'/.test(html),
    workerByteBudget:/const ATLAS_CACHE_BUDGET = 32 \* 1024 \* 1024/.test(html),
    workerAtlasBatch:/function renderGlyphBatch\(/.test(html) && /gl\.drawArrays\(gl\.TRIANGLES/.test(html),
    directReadback:/const _asciiReadbackEngine/.test(html) && /gl\.readPixels\(0, 0, width, height/.test(html),
    syncPools:/function _ensureAsciiFloatPools\(length\)/.test(html),
    slhtAtlas:/function _slhtRenderGlyphPhase\(/.test(html),
  };
  assert(duplicateIds.length === 0, `ids duplicados=${JSON.stringify(duplicateIds)}`);
  assert(missingStaticRefs.length === 0, `refs sin id=${JSON.stringify(missingStaticRefs)}`);
  assert(staticChecks.workerAtlas, 'atlas worker ausente');
  assert(staticChecks.workerReturnsBuffer, 'worker no devuelve buffer');
  assert(staticChecks.workerRaceGuard, 'guard de carrera ausente');
  assert(staticChecks.workerPendingHeightGuard, 'guard OUT_H del pendiente ausente');
  assert(staticChecks.workerPyGate, 'atlas no esta limitado a pyMode off');
  assert(staticChecks.workerByteBudget, 'presupuesto por bytes del atlas ausente');
  assert(staticChecks.workerAtlasBatch, 'batch WebGL del atlas ausente');
  assert(staticChecks.directReadback, 'readback directo al pool ausente');
  assert(staticChecks.syncPools, 'pools sync ausentes');
  assert(staticChecks.slhtAtlas, 'atlas SLHT ausente');

  const server = USE_PIPE ? null : await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t15-chrome-'));
  const chromeArgs = [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    USE_PIPE ? '--remote-debugging-pipe' : `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ];
  const chrome = spawn(CHROME, chromeArgs, {
    stdio:USE_PIPE ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore',
  });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => {
    chromeExit = { code, signal };
  });

  let cdp;
  let page;
  try {
    if (USE_PIPE) {
      cdp = await new PipeCdp(chrome).open();
    } else {
      const version = await waitFor(async () => {
        if (chromeExit) throw new Error(`Chrome termino antes de CDP: ${JSON.stringify(chromeExit)}`);
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          return response.ok ? response.json() : false;
        } catch (_) {
          return false;
        }
      }, 'Chrome CDP');
      cdp = await new Cdp(version.webSocketDebuggerUrl).open();
    }
    page = await cdp.createSession();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width:1440,
      height:900,
      deviceScaleFactor:1,
      mobile:false,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:USE_PIPE ? FILE_URL : BASE_URL });
    await waitFor(
      () => evaluate(page, `typeof _asciiWorkerBody === 'function' && typeof _slhtRenderGlyphPhase === 'function'`),
      'runtime FLIP'
    );

    const result = await evaluate(page, RUNTIME_PHASE);
    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    if (process.env.T15_VERBOSE === '1') {
      console.error(JSON.stringify({ runtime:result, exceptions:exceptions.length }, null, 2));
    }
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);
    assert(result.worker.parity.textEqual, 'texto ASCII A/B distinto');
    assert(
      result.worker.parity.gpu.meanChannelDelta <= 0.06 && result.worker.parity.gpu.maxDelta <= 3,
      `paridad ASCII delta medio=${result.worker.parity.gpu.meanChannelDelta}, max=${result.worker.parity.gpu.maxDelta}`
    );
    assert(
      result.worker.parity.gpuVsCanvas.changedPixels === 0,
      `batch GPU difiere del atlas drawImage en ${result.worker.parity.gpuVsCanvas.changedPixels} px`
    );
    assert(
      result.worker.parity.pyChars.changedPixels === 0,
      `pyMode chars difiere en ${result.worker.parity.pyChars.changedPixels} px`
    );
    assert(result.worker.performance.legacy.frames === 300, 'worker legacy no midio 300 frames');
    assert(result.worker.performance.atlas.frames === 300, 'worker atlas no midio 300 frames');
    assert(
      result.worker.performance.reductionPct >= 50,
      `worker atlas reduccion ${result.worker.performance.reductionPct.toFixed(2)}% < 50%`
    );
    assert(
      result.worker.resilience.cache.bytes <= result.worker.resilience.cache.budget &&
        result.worker.resilience.cache.sheetBytes <= result.worker.resilience.cache.budget,
      `cache atlas=${result.worker.resilience.cache.bytes}B excede ${result.worker.resilience.cache.budget}B`
    );
    assert(
      result.worker.resilience.cache.hitDelta >= 1 &&
        result.worker.resilience.cache.sizeAfterHit === result.worker.resilience.cache.size,
      'cache atlas perdio el hit LRU normal'
    );
    assert(result.worker.resilience.contextLoss.lost, 'WEBGL_lose_context no disponible');
    assert(
      result.worker.resilience.contextLoss.workerResponded &&
        result.worker.resilience.contextLoss.parity.changedPixels === 0,
      `fallback 2D tras context-loss difiere en ${result.worker.resilience.contextLoss.parity.changedPixels} px`
    );
    assert(
      result.worker.resilience.contextLoss.warnings === 1 &&
        result.worker.resilience.contextLoss.glDisabled,
      `context-loss warnings=${result.worker.resilience.contextLoss.warnings}, disabled=${result.worker.resilience.contextLoss.glDisabled}`
    );
    assert(result.slht.performance.legacy.frames === 300, 'SLHT legacy no midio 300 frames');
    assert(result.slht.performance.atlas.frames === 300, 'SLHT atlas no midio 300 frames');
    assert(
      result.slht.parity.changedRatio <= 0.03 && result.slht.parity.meanChannelDelta <= 0.35,
      `paridad SLHT ratio=${result.slht.parity.changedRatio}, delta=${result.slht.parity.meanChannelDelta}`
    );
    assert(
      result.slht.performance.reductionPct >= 30,
      `SLHT atlas reduccion ${result.slht.performance.reductionPct.toFixed(2)}% < 30%`
    );
    assert(
      result.slht.build.maxMs < 50,
      `SLHT atlas build max ${result.slht.build.maxMs.toFixed(2)}ms >= 50ms`
    );
    assert(result.syncPool.allocsAfterFirst - result.syncPool.allocsBefore <= 2, 'sync asigno mas de dos pools');
    assert(result.syncPool.allocsAfterThree === result.syncPool.allocsAfterFirst, 'sync reasigno pools');
    assert(result.syncPool.grayReused && result.syncPool.tmpReused, 'sync no reutilizo arrays');
    assert(result.syncPool.pixelHashesEqual, 'sync cambio pixeles entre frames identicos');
    assert(result.race.wrongSubmodePaints === 0, `race pinto ${result.race.wrongSubmodePaints} frames incorrectos`);
    assert(result.race.acceptedDelta === 0, `race acepto ${result.race.acceptedDelta} frames`);
    assert(result.race.discardedDelta === 31, `race descarto ${result.race.discardedDelta}/31`);
    assert(result.race.returnedDelta === 31, `worker devolvio ${result.race.returnedDelta}/31 buffers`);
    assert(
      result.race.heightGuard.discarded === 10 &&
        result.race.heightGuard.stalePaints === 0 &&
        result.race.heightGuard.outWConstant,
      `resize OUT_H descarto=${result.race.heightGuard.discarded}/10, paints=${result.race.heightGuard.stalePaints}`
    );
    assert(result.race.poolMissesDelta === 0, `ping-pong tuvo ${result.race.poolMissesDelta} misses`);
    assert(result.race.gpuReadbackDelta === 31, `readback GPU=${result.race.gpuReadbackDelta}/31`);
    assert(result.race.fallbackReadbackDelta === 0, `readback 2D fallback=${result.race.fallbackReadbackDelta}`);
    assert(
      result.race.readbackParity.changedPixels === 0,
      `readPixels difiere de getImageData en ${result.race.readbackParity.changedPixels} px`
    );
    assert(result.race.poolAvailable === 2, `pool final=${result.race.poolAvailable}, esperado=2`);
    assert(!result.race.busy && !result.race.pending, 'worker termino ocupado o con pendiente');

    console.log(JSON.stringify({ static:staticChecks, runtime:result }, null, 2));
  } finally {
    try { page?.close(); } catch (_) {}
    try { cdp?.close(); } catch (_) {}
    chrome.kill('SIGTERM');
    await timeout(200);
    server?.close();
    fs.rmSync(checkDir, { recursive:true, force:true });
    fs.rmSync(profileDir, { recursive:true, force:true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

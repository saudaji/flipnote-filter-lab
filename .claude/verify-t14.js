#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS, 'index.html');
const HTTP_PORT = Number(process.env.T14_HTTP_PORT) || 8874;
const CDP_PORT = Number(process.env.T14_CDP_PORT) || 24654;
const USE_PIPE = process.env.T14_USE_PIPE === '1';
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html`;
const FILE_URL = pathToFileURL(INDEX_PATH).href;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 12000, intervalMs = 25) {
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
  const mime = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png', '.ttf':'font/ttf', '.otf':'font/otf' };
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(req.url.split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(DOCS, `.${pathname}`);
    if (!file.startsWith(`${DOCS}${path.sep}`)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end('not found'); return; }
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
  close() { try { this.ws.close(); } catch (_) {} }
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
  send(method, params = {}) { return this.cdp.send(method, params, this.sessionId); }
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
  window.__t14 = { warnings:[], webglContextCount:0, webglGetContextCalls:0 };
  const webglCanvases = new WeakSet();
  const badProbeContexts = new WeakSet();
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const webgl = type === 'webgl' || type === 'experimental-webgl';
    if (webgl) {
      __t14.webglGetContextCalls++;
      if (location.search.includes('t14-no-webgl')) return null;
    }
    const context = nativeGetContext.call(this, type, ...args);
    if (webgl && context && !webglCanvases.has(this)) {
      webglCanvases.add(this);
      __t14.webglContextCount++;
    }
    if (webgl && context && location.search.includes('t14-bad-probe') && !badProbeContexts.has(context)) {
      badProbeContexts.add(context);
      Object.defineProperty(context, 'readPixels', {
        configurable:true,
        value(...callArgs) {
          const destination = callArgs[6];
          if (destination && typeof destination.fill === 'function') destination.fill(0);
        },
      });
    }
    return context;
  };
  const nativeWarn = console.warn.bind(console);
  console.warn = (...args) => {
    __t14.warnings.push(args.map(String).join(' '));
    nativeWarn(...args);
  };
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('stub only', 'NotAllowedError'); };
})()`;

const HELPERS = String.raw`
  const makeSource = (w = 640, h = 480) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#07131f'); gradient.addColorStop(0.45, '#e1a346'); gradient.addColorStop(1, '#175f78');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f7f3dd'; ctx.fillRect(w * 0.12, h * 0.16, w * 0.27, h * 0.31);
    ctx.fillStyle = '#10151c'; ctx.beginPath(); ctx.arc(w * 0.68, h * 0.43, h * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f4572e'; ctx.lineWidth = 18;
    ctx.beginPath(); ctx.moveTo(w * 0.08, h * 0.82); ctx.bezierCurveTo(w * 0.32, h * 0.54, w * 0.62, h * 0.94, w * 0.92, h * 0.66); ctx.stroke();
    for (let x = 0; x < w; x += 32) {
      ctx.fillStyle = (x / 32) % 2 ? '#292f48' : '#d9d36b';
      ctx.fillRect(x, h * 0.9, 32, h * 0.1);
    }
    return canvas;
  };
  const makeOutput = (w = 480, h = 360) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    return { canvas, ctx:canvas.getContext('2d', { willReadFrequently:true }) };
  };
  const pixels = canvas => canvas.getContext('2d', { willReadFrequently:true }).getImageData(0, 0, canvas.width, canvas.height).data.slice();
  const pixelDiff = (a, b) => {
    let changedPixels = 0, totalDelta = 0, maxDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta) changedPixels++;
      totalDelta += delta;
      maxDelta = Math.max(maxDelta, delta);
    }
    return { changedPixels, totalPixels:a.length / 4, meanChannelDelta:totalDelta / (a.length / 4) / 3, maxDelta };
  };
  const pixelHash = data => {
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const perceptual = (a, b, w, h) => {
    const cols = 40, rows = 30, va = [], vb = [];
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * w / cols), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / cols));
      const y0 = Math.floor(gy * h / rows), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / rows));
      let sa = 0, sb = 0, count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        sa += a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
        sb += b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
        count++;
      }
      va.push(sa / count); vb.push(sb / count);
    }
    const meanA = va.reduce((sum, value) => sum + value, 0) / va.length;
    const meanB = vb.reduce((sum, value) => sum + value, 0) / vb.length;
    let covariance = 0, varianceA = 0, varianceB = 0;
    for (let i = 0; i < va.length; i++) {
      const da = va[i] - meanA, db = vb[i] - meanB;
      covariance += da * db; varianceA += da * da; varianceB += db * db;
    }
    const correlation = covariance / Math.sqrt(Math.max(1e-9, varianceA * varianceB));
    return {
      correlation,
      meanA,
      meanB,
      contrastA:Math.sqrt(varianceA / va.length),
      contrastB:Math.sqrt(varianceB / vb.length),
    };
  };
  const configure = test => {
    camVariant = test.mode === 'STD' ? 'STD' : 'LGCY';
    oscamLegacyMode = test.mode === 'STD' ? 'WAVE' : test.mode;
    oscamColorMode = test.color;
    oscamIntensityVal = test.intensity;
    oscamDetailVal = test.detail;
    oscamPresenceVal = test.presence;
    oscamTraceVal = test.trace;
    oscamDefinitionVal = test.definition;
  };
`;

const AB_PHASE = String.raw`
(async () => {
${HELPERS}
  const source = makeSource();
  const seed = document.createElement('canvas'); seed.width = 64; seed.height = 48;
  const seedCtx = seed.getContext('2d'); seedCtx.fillStyle = '#6c92b4'; seedCtx.fillRect(0, 0, 64, 48);
  _camPaletteWebGLEngine.render(seed, 64, 48, 'dsi-bayer', { palette:[[8,16,8],[80,96,56]] });
  _scrashWebGLEngine.render(seed, 64, 48, 0, null, { chroma:0,drip:0,neon:0,wave:0,crush:0,hue:0,grain:0,chaos:0,audioReact:0,animate:false,speed:5 });
  const contextsBeforeProbe = __t14.webglContextCount;
  const probeFirst = _oscamWebGLEngine.probe();
  const contextsAfterProbe = __t14.webglContextCount;
  const callsBeforeRepeat = __t14.webglGetContextCalls;
  const probeRepeat = [_oscamWebGLEngine.probe(), _oscamWebGLEngine.probe(), _oscamWebGLEngine.probe()];
  const callsAfterRepeat = __t14.webglGetContextCalls;

  const cases = [
    { name:'STD-green', mode:'STD', color:'GREEN', intensity:42, detail:56, presence:62, trace:48, definition:46 },
    { name:'WAVE-red', mode:'WAVE', color:'RED', intensity:68, detail:38, presence:74, trace:58, definition:32 },
    { name:'STATIC-blue', mode:'STATIC', color:'BLUE', intensity:55, detail:72, presence:80, trace:44, definition:76 },
  ];
  const matrix = document.createElement('canvas');
  matrix.width = 1280; matrix.height = cases.length * 240;
  const matrixCtx = matrix.getContext('2d');
  matrixCtx.fillStyle = '#111'; matrixCtx.fillRect(0, 0, matrix.width, matrix.height);
  matrixCtx.font = '16px monospace'; matrixCtx.textBaseline = 'top';
  const ab = {};
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index];
    configure(test);
    _resetOscamPersistence();
    const legacy = makeOutput();
    _renderOscamLegacy(source, source.width, source.height, legacy.ctx, false);
    const legacyPixels = pixels(legacy.canvas);
    _resetOscamPersistence();
    const current = makeOutput();
    const mode = _oscamGetModeKey();
    const cfg = _oscamGetConfig();
    const palette = _oscamGetModePalette();
    const currentRendered = _oscamWebGLEngine.render(source, source.width, source.height, false, mode, cfg, palette);
    if (currentRendered) {
      current.ctx.drawImage(_oscamWebGLEngine.canvas, 0, 0, current.canvas.width, current.canvas.height);
      _oscamDrawOverlayOnly(current.ctx);
    }
    const currentPixels = pixels(current.canvas);
    _resetOscamPersistence();
    const selected = makeOutput();
    renderOscam(source, source.width, source.height, selected.ctx, false);
    const selectedPixels = pixels(selected.canvas);
    ab[test.name] = {
      currentRendered,
      currentVsAndroid:{
        pixel:pixelDiff(currentPixels, selectedPixels),
        perceptual:perceptual(currentPixels, selectedPixels, 480, 360),
      },
      legacyVsAndroid:{
        pixel:pixelDiff(legacyPixels, selectedPixels),
        perceptual:perceptual(legacyPixels, selectedPixels, 480, 360),
      },
    };
    const y = index * 240;
    matrixCtx.fillStyle = '#fff'; matrixCtx.fillText(test.name + ' / SOURCE', 4, y + 4);
    matrixCtx.fillText('LEGACY', 324, y + 4); matrixCtx.fillText('CURRENT WEBGL', 644, y + 4);
    matrixCtx.fillText('ANDROID PROBE', 964, y + 4);
    matrixCtx.drawImage(source, 0, y + 24, 320, 216);
    matrixCtx.drawImage(legacy.canvas, 320, y + 24, 320, 216);
    matrixCtx.drawImage(current.canvas, 640, y + 24, 320, 216);
    matrixCtx.drawImage(selected.canvas, 960, y + 24, 320, 216);
  }
  return {
    android:EARLY_IS_ANDROID,
    userAgent:navigator.userAgent,
    probeFirst,
    probeRepeat,
    probeResult:_oscamWebGLEngine.getCapabilityProbeResult(),
    ready:_oscamWebGLEngine.isReady(),
    contexts:{ beforeProbe:contextsBeforeProbe, afterProbe:contextsAfterProbe, afterRepeat:__t14.webglContextCount },
    getContextCalls:{ beforeRepeat:callsBeforeRepeat, afterRepeat:callsAfterRepeat },
    ab,
    matrixDataUrl:matrix.toDataURL('image/png'),
    warnings:__t14.warnings.slice(),
  };
})()`;

const FALLBACK_PHASE = String.raw`
(() => {
${HELPERS}
  const source = makeSource();
  configure({ mode:'STATIC', color:'GREEN', intensity:55, detail:72, presence:80, trace:44, definition:76 });
  _resetOscamPersistence();
  const expected = makeOutput();
  _renderOscamLegacy(source, source.width, source.height, expected.ctx, false);
  _resetOscamPersistence();
  const actual = makeOutput();
  renderOscam(source, source.width, source.height, actual.ctx, false);
  const first = pixelDiff(pixels(expected.canvas), pixels(actual.canvas));
  const callsAfterFirst = __t14.webglGetContextCalls;
  _resetOscamPersistence();
  renderOscam(source, source.width, source.height, actual.ctx, false);
  return {
    first,
    ready:_oscamWebGLEngine.isReady(),
    probeResult:_oscamWebGLEngine.getCapabilityProbeResult(),
    contexts:__t14.webglContextCount,
    getContextCalls:{ first:callsAfterFirst, second:__t14.webglGetContextCalls },
    warnings:__t14.warnings.filter(message => message.includes('OSCAM WebGL')),
  };
})()`;

const CONTEXT_LOSS_PHASE = String.raw`
(async () => {
${HELPERS}
  const source = makeSource();
  configure({ mode:'STATIC', color:'GREEN', intensity:55, detail:72, presence:80, trace:44, definition:76 });
  _resetOscamPersistence();
  const firstGpu = makeOutput();
  renderOscam(source, source.width, source.height, firstGpu.ctx, false);
  const gl = _oscamWebGLEngine.canvas.getContext('webgl');
  const extension = gl && gl.getExtension('WEBGL_lose_context');
  if (!extension) return { skipped:'WEBGL_lose_context unavailable' };
  extension.loseContext();
  await new Promise(resolve => setTimeout(resolve, 0));
  _resetOscamPersistence();
  const expected = makeOutput();
  _renderOscamLegacy(source, source.width, source.height, expected.ctx, false);
  _resetOscamPersistence();
  const actual = makeOutput();
  renderOscam(source, source.width, source.height, actual.ctx, false);
  const firstFallback = pixelDiff(pixels(expected.canvas), pixels(actual.canvas));
  const warningCount = __t14.warnings.filter(message => message.includes('OSCAM WebGL')).length;
  renderOscam(source, source.width, source.height, actual.ctx, false);
  return {
    firstFallback,
    ready:_oscamWebGLEngine.isReady(),
    probeResult:_oscamWebGLEngine.getCapabilityProbeResult(),
    warningCount,
    warningCountAfterRepeat:__t14.warnings.filter(message => message.includes('OSCAM WebGL')).length,
    warnings:__t14.warnings.filter(message => message.includes('OSCAM WebGL')),
  };
})()`;

const DIRECT_UPLOAD_PHASE = String.raw`
(async () => {
${HELPERS}
  configure({ mode:'STATIC', color:'BLUE', intensity:55, detail:72, presence:80, trace:44, definition:76 });
  const base = makeSource(640, 360);
  const source = document.createElement('canvas');
  source.width = base.width;
  source.height = base.height;
  const sourceCtx = source.getContext('2d');
  const reference = document.createElement('canvas');
  reference.width = 384;
  reference.height = 288;
  const referenceCtx = reference.getContext('2d', { willReadFrequently:true });
  const output = makeOutput();
  const gl = _oscamWebGLEngine.canvas.getContext('webgl');
  const cfg = _oscamGetConfig();
  const palette = _oscamGetModePalette();
  const nativeNow = performance.now.bind(performance);
  const ownNowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let frameNow = 1000;
  Object.defineProperty(performance, 'now', { configurable:true, value:() => frameNow });
  const paintFrame = frame => {
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
    sourceCtx.drawImage(base, 0, 0);
    sourceCtx.fillStyle = '#e7ff4f';
    sourceCtx.fillRect(18 + (frame * 11) % 520, 32 + (frame * 7) % 220, 72, 54);
    sourceCtx.strokeStyle = '#ff3264';
    sourceCtx.lineWidth = 11;
    sourceCtx.beginPath();
    sourceCtx.moveTo(0, 40 + (frame * 13) % 260);
    sourceCtx.lineTo(640, 300 - (frame * 9) % 220);
    sourceCtx.stroke();
  };
  const prepareReference = () => {
    const [sx, sy, sw, sh] = cropCoords(source.width, source.height);
    referenceCtx.setTransform(1, 0, 0, 1, 0, 0);
    referenceCtx.clearRect(0, 0, reference.width, reference.height);
    referenceCtx.translate(reference.width, 0);
    referenceCtx.scale(-1, 1);
    referenceCtx.drawImage(source, sx, sy, sw, sh, 0, 0, reference.width, reference.height);
    referenceCtx.setTransform(1, 0, 0, 1, 0, 0);
  };
  const runSequence = useReference => {
    _oscamWebGLEngine.reset();
    const stationary = [];
    const started = nativeNow();
    for (let frame = 0; frame < 45; frame++) {
      frameNow = 1000 + frame * (1000 / 30);
      paintFrame(frame);
      if (useReference) prepareReference();
      const input = useReference ? reference : source;
      const rendered = _oscamWebGLEngine.render(
        input,
        input.width,
        input.height,
        useReference ? false : true,
        'STATIC',
        cfg,
        palette,
      );
      if (!rendered) throw new Error('OSCAM WebGL no renderizo secuencia A/B');
      gl.finish();
      if (frame >= 30) {
        output.ctx.clearRect(0, 0, output.canvas.width, output.canvas.height);
        output.ctx.drawImage(_oscamWebGLEngine.canvas, 0, 0, output.canvas.width, output.canvas.height);
        stationary.push(pixels(output.canvas));
      }
    }
    return { elapsedMs:nativeNow() - started, stationary };
  };
  let comparison;
  try {
    const referenceTimes = [];
    const directTimes = [];
    let referenceFrames;
    let directFrames;
    for (let sample = 0; sample < 3; sample++) {
      const cpu = runSequence(true);
      const direct = runSequence(false);
      referenceTimes.push(cpu.elapsedMs);
      directTimes.push(direct.elapsedMs);
      if (sample === 0) {
        referenceFrames = cpu.stationary;
        directFrames = direct.stationary;
      }
    }
    const correlations = referenceFrames.map((frame, index) =>
      perceptual(frame, directFrames[index], output.canvas.width, output.canvas.height).correlation);
    const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    comparison = {
      frames:45,
      stationaryFrames:correlations.length,
      correlation:{
        min:Math.min(...correlations),
        mean:correlations.reduce((sum, value) => sum + value, 0) / correlations.length,
      },
      performance:{
        referenceMs:median(referenceTimes),
        directMs:median(directTimes),
        referenceMsPerFrame:median(referenceTimes) / 45,
        directMsPerFrame:median(directTimes) / 45,
        ratio:median(directTimes) / median(referenceTimes),
        samples:{ reference:referenceTimes, direct:directTimes },
      },
    };
  } finally {
    if (ownNowDescriptor) Object.defineProperty(performance, 'now', ownNowDescriptor);
    else delete performance.now;
  }

  const feed = document.createElement('canvas');
  feed.width = 640;
  feed.height = 360;
  feed.getContext('2d').drawImage(base, 0, 0);
  const stream = feed.captureStream(30);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  await new Promise(resolve => setTimeout(resolve, 50));
  const ctx2dProto = CanvasRenderingContext2D.prototype;
  const glProto = WebGLRenderingContext.prototype;
  const nativeDrawImage = ctx2dProto.drawImage;
  const nativeTexImage2D = glProto.texImage2D;
  const hotPath = { frames:100, drawImageFromVideo:0, texImage2DFromVideo:0 };
  ctx2dProto.drawImage = function(...args) {
    if (args[0] === video) hotPath.drawImageFromVideo++;
    return nativeDrawImage.apply(this, args);
  };
  glProto.texImage2D = function(...args) {
    if (args[5] === video) hotPath.texImage2DFromVideo++;
    return nativeTexImage2D.apply(this, args);
  };
  try {
    _oscamWebGLEngine.reset();
    for (let frame = 0; frame < hotPath.frames; frame++) {
      if (!_oscamWebGLEngine.render(
        video,
        video.videoWidth || feed.width,
        video.videoHeight || feed.height,
        true,
        'STATIC',
        cfg,
        palette,
      )) throw new Error('OSCAM WebGL no renderizo video directo');
    }
    gl.finish();
  } finally {
    ctx2dProto.drawImage = nativeDrawImage;
    glProto.texImage2D = nativeTexImage2D;
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  return { comparison, hotPath };
})()`;

const LEGACY_ALLOCATION_PHASE = String.raw`
(() => {
${HELPERS}
  const NativeFloat32Array = window.Float32Array;
  const nativeSlice = NativeFloat32Array.prototype.slice;
  const ctx2dProto = CanvasRenderingContext2D.prototype;
  const nativeCreateImageData = ctx2dProto.createImageData;
  const allocations = { float32:0, float32Slice:0, imageData:0 };
  window.Float32Array = new Proxy(NativeFloat32Array, {
    construct(Target, args) {
      allocations.float32++;
      return Reflect.construct(Target, args);
    },
  });
  NativeFloat32Array.prototype.slice = function(...args) {
    allocations.float32Slice++;
    return nativeSlice.apply(this, args);
  };
  ctx2dProto.createImageData = function(...args) {
    allocations.imageData++;
    return nativeCreateImageData.apply(this, args);
  };
  const resetCounts = () => {
    allocations.float32 = 0;
    allocations.float32Slice = 0;
    allocations.imageData = 0;
  };
  const snapshotCounts = () => ({
    float32:allocations.float32 + allocations.float32Slice,
    explicitFloat32:allocations.float32,
    sliceFloat32:allocations.float32Slice,
    imageData:allocations.imageData,
  });
  const previousOut = [OUT_W, OUT_H];
  OUT_W = 256;
  OUT_H = 192;
  const cases = [
    { name:'static-default', source:makeSource(640, 480), mirror:false, config:{ mode:'STATIC', color:'GREEN', intensity:55, detail:72, presence:80, trace:44, definition:76 } },
    { name:'static-mirror', source:makeSource(640, 480), mirror:true, config:{ mode:'STATIC', color:'RED', intensity:68, detail:38, presence:74, trace:58, definition:32 } },
    { name:'static-crop', source:makeSource(640, 360), mirror:false, config:{ mode:'STATIC', color:'BLUE', intensity:42, detail:56, presence:62, trace:48, definition:92 } },
  ];
  const results = {};
  try {
    for (const test of cases) {
      configure(test.config);
      _resetOscamPersistence();
      const output = makeOutput(256, 192);
      resetCounts();
      _renderOscamLegacy(test.source, test.source.width, test.source.height, output.ctx, test.mirror);
      const warmup = snapshotCounts();
      resetCounts();
      for (let frame = 0; frame < 100; frame++) {
        _renderOscamLegacy(test.source, test.source.width, test.source.height, output.ctx, test.mirror);
      }
      results[test.name] = {
        frames:100,
        warmup,
        steady:snapshotCounts(),
        finalPixelHash:pixelHash(pixels(output.canvas)),
      };
    }
    return {
      frames:Object.values(results).reduce((sum, result) => sum + result.frames, 0),
      results,
    };
  } finally {
    OUT_W = previousOut[0];
    OUT_H = previousOut[1];
    window.Float32Array = NativeFloat32Array;
    NativeFloat32Array.prototype.slice = nativeSlice;
    ctx2dProto.createImageData = nativeCreateImageData;
    _resetOscamPersistence();
  }
})()`;

async function navigate(page, url) {
  await page.send('Page.navigate', { url });
  await waitFor(
    () => evaluate(page, 'document.readyState === "complete" && typeof _oscamWebGLEngine === "object"'),
    `runtime ${url}`,
  );
}

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  new Function(scripts[0]);
  const sectionStart = html.indexOf('const _oscamWebGLEngine');
  const sectionEnd = html.indexOf('// SLHT CAM', sectionStart);
  const section = html.slice(sectionStart, sectionEnd);
  const staticChecks = {
    engineFound:sectionStart >= 0,
    cachedProbe:/let capabilityProbeResult = null/.test(section) && /capabilityProbeResult !== null/.test(section),
    realProbeFrame:/gl\.readPixels/.test(section) && /litPixels === 0/.test(section),
    stickyFallback:/function disable\(message, err\)/.test(section) && /failed = true/.test(section),
    contextLossGuard:/gl && gl\.isContextLost\(\)/.test(section),
    contextLossEvent:/addEventListener\('webglcontextlost'/.test(section),
    noAndroidVeto:!section.includes('forceLegacy = /Android'),
    androidCapabilityGate:/!EARLY_IS_ANDROID \|\| _oscamWebGLEngine\.probe\(\)/.test(section),
    noCpuInputCanvas:!section.includes('inputCvs') && !section.includes('inputCtx'),
    directSourceUpload:/gl\.texImage2D\(gl\.TEXTURE_2D, 0, gl\.RGBA, gl\.RGBA, gl\.UNSIGNED_BYTE, source\)/.test(section),
    uvCropMirror:/u_uvScale/.test(section) && /u_uvOffset/.test(section) && /mirror \? -sw : sw/.test(section),
  };
  assert(Object.values(staticChecks).every(Boolean), `checks estaticos=${JSON.stringify(staticChecks)}`);

  const server = USE_PIPE ? null : await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t14-chrome-'));
  const devtoolsArg = USE_PIPE ? '--remote-debugging-pipe' : `--remote-debugging-port=${CDP_PORT}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files', `--user-data-dir=${profileDir}`, devtoolsArg, 'about:blank',
  ], { stdio:USE_PIPE ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  let browser = null;
  let page = null;
  const cleanup = () => {
    page?.close();
    browser?.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    server?.close();
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);
  try {
    if (USE_PIPE) {
      browser = await new PipeCdp(chrome).open();
    } else {
      const version = await waitFor(async () => {
        if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          return response.ok && response.json();
        } catch (_) {
          return false;
        }
      }, 'Chrome DevTools');
      browser = await new Cdp(version.webSocketDebuggerUrl).open();
    }
    page = await browser.createSession();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Network.setUserAgentOverride', { userAgent:ANDROID_UA, platform:'Android' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });

    const pageBaseUrl = USE_PIPE ? FILE_URL : BASE_URL;
    await navigate(page, `${pageBaseUrl}?t14=ab`);
    const runtime = await evaluate(page, AB_PHASE);
    const matrixPath = path.join(os.tmpdir(), 'flip-t14-oscam-ab.png');
    fs.writeFileSync(matrixPath, Buffer.from(runtime.matrixDataUrl.split(',')[1], 'base64'));
    delete runtime.matrixDataUrl;
    assert(runtime.android && runtime.probeFirst && runtime.probeRepeat.every(Boolean), `probe Android=${JSON.stringify(runtime)}`);
    assert(runtime.probeResult && runtime.ready, `OSCAM WebGL no listo=${JSON.stringify(runtime)}`);
    assert(runtime.contexts.afterProbe === 3 && runtime.contexts.afterRepeat === 3, `contextos=${JSON.stringify(runtime.contexts)}`);
    assert(runtime.getContextCalls.beforeRepeat === runtime.getContextCalls.afterRepeat, `probe no cacheado=${JSON.stringify(runtime.getContextCalls)}`);
    for (const [name, result] of Object.entries(runtime.ab)) {
      assert(result.currentRendered, `${name} no renderizo path WebGL actual=${JSON.stringify(result)}`);
      assert(result.currentVsAndroid.perceptual.correlation >= 0.995, `${name} paridad current/Android=${JSON.stringify(result)}`);
      assert(result.currentVsAndroid.pixel.meanChannelDelta <= 1, `${name} delta current/Android=${JSON.stringify(result)}`);
      assert(result.legacyVsAndroid.perceptual.correlation >= 0.25, `${name} correlacion legacy/Android=${JSON.stringify(result)}`);
      assert(result.legacyVsAndroid.perceptual.contrastA > 0.5 && result.legacyVsAndroid.perceptual.contrastB > 0.5, `${name} sin estructura=${JSON.stringify(result)}`);
    }
    const directUpload = await evaluate(page, DIRECT_UPLOAD_PHASE);
    assert(directUpload.comparison.frames === 45 && directUpload.comparison.stationaryFrames === 15, `frames A/B=${JSON.stringify(directUpload)}`);
    assert(directUpload.comparison.correlation.min > 0.99, `paridad inputCvs/directo=${JSON.stringify(directUpload.comparison)}`);
    assert(directUpload.comparison.performance.ratio <= 1, `perf inputCvs/directo=${JSON.stringify(directUpload.comparison.performance)}`);
    assert(directUpload.hotPath.drawImageFromVideo === 0, `drawImage(video) hot path=${JSON.stringify(directUpload.hotPath)}`);
    assert(directUpload.hotPath.texImage2DFromVideo === 100, `texImage2D(video) hot path=${JSON.stringify(directUpload.hotPath)}`);
    const legacyAllocations = await evaluate(page, LEGACY_ALLOCATION_PHASE);
    assert(legacyAllocations.frames === 300, `frames legacy=${JSON.stringify(legacyAllocations)}`);
    // Golden pixels from 4f29d86, before pooling; an equal hash covers the full RGBA frame.
    const expectedHashes = {
      'static-default':'9c819a07',
      'static-mirror':'5291ebff',
      'static-crop':'91ab205f',
    };
    for (const [name, result] of Object.entries(legacyAllocations.results)) {
      assert(result.steady.float32 === 0, `${name} Float32Array en regimen=${JSON.stringify(result)}`);
      assert(result.steady.imageData === 0, `${name} ImageData en regimen=${JSON.stringify(result)}`);
      assert(result.finalPixelHash === expectedHashes[name], `${name} pixel-diff legacy != 0=${JSON.stringify(result)}`);
    }

    await navigate(page, `${pageBaseUrl}?t14-no-webgl=1`);
    const fallback = await evaluate(page, FALLBACK_PHASE);
    assert(fallback.first.changedPixels === 0, `fallback no es legacy exacto=${JSON.stringify(fallback)}`);
    assert(!fallback.ready && fallback.probeResult === false && fallback.contexts === 0, `fallback estado=${JSON.stringify(fallback)}`);
    assert(fallback.getContextCalls.first === fallback.getContextCalls.second, `fallback reintento=${JSON.stringify(fallback)}`);
    assert(fallback.warnings.length === 1, `fallback warnings=${JSON.stringify(fallback.warnings)}`);

    await navigate(page, `${pageBaseUrl}?t14-bad-probe=1`);
    const badProbe = await evaluate(page, FALLBACK_PHASE);
    assert(badProbe.first.changedPixels === 0, `probe invalido no cae a legacy=${JSON.stringify(badProbe)}`);
    assert(!badProbe.ready && badProbe.probeResult === false && badProbe.contexts === 1, `probe invalido estado=${JSON.stringify(badProbe)}`);
    assert(badProbe.getContextCalls.first === badProbe.getContextCalls.second, `probe invalido reintento=${JSON.stringify(badProbe)}`);
    assert(badProbe.warnings.length === 1 && badProbe.warnings[0].includes('capability probe failed'), `probe invalido warnings=${JSON.stringify(badProbe)}`);

    await navigate(page, `${pageBaseUrl}?t14=context-loss`);
    const contextLoss = await evaluate(page, CONTEXT_LOSS_PHASE);
    assert(!contextLoss.skipped, `context-loss no verificable=${JSON.stringify(contextLoss)}`);
    assert(contextLoss.firstFallback.changedPixels === 0, `context-loss no cae a legacy=${JSON.stringify(contextLoss)}`);
    assert(!contextLoss.ready && contextLoss.probeResult === false, `context-loss no sticky=${JSON.stringify(contextLoss)}`);
    assert(contextLoss.warningCount === 1 && contextLoss.warningCountAfterRepeat === 1, `context-loss warnings=${JSON.stringify(contextLoss)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown');
    assert(runtimeExceptions.length === 0, `excepciones=${exceptionDescriptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ inlineScripts:scripts.length, syntax:true, transport:USE_PIPE ? 'cdp-pipe/file' : `http:${HTTP_PORT}`, ...staticChecks },
      runtime,
      directUpload,
      legacyAllocations,
      fallback,
      badProbe,
      contextLoss,
      artifacts:{ abMatrix:matrixPath, bytes:fs.statSync(matrixPath).size },
      runtimeExceptions:runtimeExceptions.length,
    }, null, 2)}\n`);
  } finally {
    cleanup();
    await timeout(200);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

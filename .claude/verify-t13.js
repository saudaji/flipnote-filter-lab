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
const HTTP_PORT = Number(process.env.T13_HTTP_PORT) || 8873;
const CDP_PORT = Number(process.env.T13_CDP_PORT) || 24653;
const EXTERNAL_SERVER = process.env.T13_EXTERNAL_SERVER === '1';
const USE_PIPE = process.env.T13_USE_PIPE === '1';
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t13=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTRA_FLAGS = (process.env.T13_CHROME_EXTRA_FLAGS || '').split(' ').filter(Boolean);
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
  const response = await page.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true, userGesture:true });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error(`Runtime.evaluate: ${detail}`);
  }
  return response.result?.value;
}

const INIT_SCRIPT = String.raw`
(() => {
  window.__t13Warnings = [];
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (location.search.includes('t13-no-webgl') && (type === 'webgl' || type === 'experimental-webgl')) return null;
    return nativeGetContext.call(this, type, ...args);
  };
  const nativeWarn = console.warn.bind(console);
  console.warn = (...args) => {
    __t13Warnings.push(args.map(String).join(' '));
    nativeWarn(...args);
  };
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('stub only', 'NotAllowedError'); };
})()`;

const PARITY_PHASE = String.raw`
(async () => {
  const pixels = canvas => {
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently:true });
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, copy.width, copy.height).data.slice();
  };
  const sourcePixels = source => {
    const copy = document.createElement('canvas'); copy.width = source.sw; copy.height = source.sh;
    const ctx = copy.getContext('2d', { willReadFrequently:true });
    ctx.drawImage(source.canvas, source.sx, source.sy, source.sw, source.sh, 0, 0, source.sw, source.sh);
    return ctx.getImageData(0, 0, copy.width, copy.height).data.slice();
  };
  const diff = (a, b) => {
    let changedPixels = 0, totalDelta = 0, maxDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta) changedPixels++;
      totalDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
    }
    return { changedPixels, totalDelta, maxDelta, totalPixels:a.length / 4 };
  };
  const nonAdjacentBands = (a, b, palette) => {
    const bands = new Map(palette.map((color, index) => [color.join(','), index]));
    let count = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      const left = bands.get(a[i] + ',' + a[i + 1] + ',' + a[i + 2]);
      const right = bands.get(b[i] + ',' + b[i + 1] + ',' + b[i + 2]);
      if (left === undefined || right === undefined || Math.abs(left - right) !== 1) count++;
    }
    return count;
  };
  const makeSource = (w, h, phase = 0) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tile = (((x + phase * 3) >> 3) ^ ((y + phase * 5) >> 3)) & 1;
      image.data[i] = (x * 11 + y * 3 + phase * 29 + tile * 47) & 255;
      image.data[i + 1] = (x * 5 + y * 13 + phase * 17 + tile * 83) & 255;
      image.data[i + 2] = (x * 17 + y * 7 + phase * 41 + tile * 31) & 255;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0); return canvas;
  };
  const makeOutput = (w, h) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    return { canvas, ctx:canvas.getContext('2d', { willReadFrequently:true }) };
  };
  const rawTarget = (family, w, h) => family === 'dsi' ? _getDsiRenderTarget(w, h).canvas :
    family === 'dolphin' ? _getDolphinRenderTarget(w, h).canvas :
    family === 'caskia' ? _getCaskiaRenderTarget(w, h).canvas : _getVfdRenderTarget(w, h).canvas;
  const configure = test => {
    camVariant = test.variant;
    if (test.family === 'dsi') legacyMode = test.variant === 'LGCY';
    if (test.family === 'dolphin') {
      dlpColorMode = test.color || 'AQUA';
      dlpContrastVal = test.contrast ?? 100;
      dlpResonanceVal = test.resonance ?? 0;
    }
    if (test.family === 'vfd') {
      vfdActivePal = test.paletteIndex ?? 0;
      vfdCustomPal = test.customPalette || null;
    }
  };
  const callCore = (test, source, target, forceCPU) => {
    const options = { sampleW:test.w, sampleH:test.h, outW:test.outW, outH:test.outH, forceCPU, scanCanvas:test.scan !== false };
    if (test.family === 'dsi') _renderDitheredCore(source, source.width, source.height, target.ctx, !!test.mirror, !!test.autoLevels, !!test.applyEdits, test.palette || null, options);
    else if (test.family === 'dolphin') _renderDolphinCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
    else if (test.family === 'caskia') _renderCaskiaCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
    else _renderVfdCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
  };
  const resetEInk = () => {
    _caskiaEInkMemory.fill(0);
    _caskiaEInkPrimed = false;
  };
  const gpuTests = [
    { name:'DSI Bayer default', family:'dsi', variant:'STD', w:256, h:192, outW:768, outH:576, scan:false },
    { name:'DSI Bayer custom mirror', family:'dsi', variant:'STD', mirror:true, palette:{ ink:[17,61,113], paper:[241,213,157] }, w:192, h:108, outW:576, outH:324, scan:true },
    { name:'DSI Bayer auto-levels', family:'dsi', variant:'STD', autoLevels:true, w:160, h:120, outW:480, outH:360, scan:false },
    { name:'DLPHN STD AQUA', family:'dolphin', variant:'STD', color:'AQUA', contrast:100, resonance:0, w:256, h:192, outW:1024, outH:768, scan:false },
    { name:'DLPHN LGCY WARM', family:'dolphin', variant:'LGCY', color:'WARM', contrast:137, resonance:56, mirror:true, w:144, h:144, outW:432, outH:432, scan:true },
    { name:'CASKIA LCD wide', family:'caskia', variant:'STD', w:192, h:108, outW:576, outH:324 },
    { name:'CASKIA LCD tall mirror', family:'caskia', variant:'STD', mirror:true, w:108, h:192, outW:324, outH:576 },
    { name:'VFD STD palette 0', family:'vfd', variant:'STD', paletteIndex:0, w:160, h:120, outW:480, outH:360 },
    { name:'VFD STD custom', family:'vfd', variant:'STD', customPalette:{ ink:[247,63,191], paper:[91,246,233] }, mirror:true, w:192, h:108, outW:576, outH:324 },
  ];
  const parity = {};
  for (const test of gpuTests) {
    configure(test);
    const source = makeSource(test.w + 37, test.h + 19, 1);
    const cpu = makeOutput(test.outW, test.outH);
    callCore(test, source, cpu, true);
    const cpuRaw = pixels(rawTarget(test.family, test.w, test.h));
    const gpu = makeOutput(test.outW, test.outH);
    callCore(test, source, gpu, false);
    const gpuResult = _camPaletteWebGLEngine.getResultSource();
    const gpuRaw = sourcePixels(gpuResult);
    const dolphinPalette = test.family !== 'dolphin' ? null :
      test.variant === 'LGCY'
        ? (test.color === 'WARM' ? [[10,6,0],[60,28,4],[160,82,18],[220,175,100]] : [[0,6,18],[10,30,70],[60,110,180],[178,210,255]])
        : (test.color === 'WARM' ? [[10,4,0],[80,22,0],[200,70,0],[255,148,12]] : [[0,13,13],[0,42,68],[0,119,153],[0,229,204]]);
    parity[test.name] = {
      family:test.family,
      raw:diff(cpuRaw, gpuRaw),
      final:diff(pixels(cpu.canvas), pixels(gpu.canvas)),
      nonAdjacentPixels:dolphinPalette ? nonAdjacentBands(cpuRaw, gpuRaw, dolphinPalette) : 0,
      sample:[test.w, test.h],
      engine:[gpuResult.sw, gpuResult.sh],
    };
  }

  const contrastSweep = [];
  const sweepTest = { family:'dolphin', variant:'STD', color:'AQUA', resonance:0, w:256, h:192, outW:256, outH:192, scan:false };
  const sweepSource = makeSource(293, 211, 3);
  for (let contrast = 51; contrast <= 149; contrast++) {
    configure({ ...sweepTest, contrast });
    const cpu = makeOutput(256, 192), gpu = makeOutput(256, 192);
    callCore(sweepTest, sweepSource, cpu, true);
    callCore(sweepTest, sweepSource, gpu, false);
    const cpuPixels = pixels(cpu.canvas), gpuPixels = pixels(gpu.canvas);
    const delta = diff(cpuPixels, gpuPixels);
    if (delta.changedPixels) contrastSweep.push({
      contrast,
      ...delta,
      nonAdjacentPixels:nonAdjacentBands(cpuPixels, gpuPixels, [[0,13,13],[0,42,68],[0,119,153],[0,229,204]]),
    });
  }

  const originalRender = _camPaletteWebGLEngine.render;
  const cpuOnlyModes = [];
  _camPaletteWebGLEngine.render = (...args) => {
    cpuOnlyModes.push(args[3]);
    return originalRender(...args);
  };
  try {
    resetEInk();
    const eink = { family:'caskia', variant:'E-INK', w:256, h:192, outW:256, outH:192, scan:false };
    configure(eink);
    callCore(eink, makeSource(293, 211, 4), makeOutput(256, 192), false);
    const thermal = { family:'vfd', variant:'THRML', w:256, h:192, outW:256, outH:192, scan:false };
    configure(thermal);
    callCore(thermal, makeSource(293, 211, 5), makeOutput(256, 192), false);
    const dsiSource = makeSource(293, 211, 6);
    const dsiLegacy = { family:'dsi', variant:'LGCY', w:256, h:192, outW:256, outH:192, scan:false };
    configure(dsiLegacy);
    callCore(dsiLegacy, dsiSource, makeOutput(256, 192), false);
    const dsiEdits = { family:'dsi', variant:'STD', applyEdits:true, w:256, h:192, outW:256, outH:192, scan:false };
    configure(dsiEdits);
    callCore(dsiEdits, dsiSource, makeOutput(256, 192), false);
  } finally {
    _camPaletteWebGLEngine.render = originalRender;
  }

  const recInterleave = { perPreviewFrame:[] };
  {
    const eink = { family:'caskia', variant:'E-INK', w:256, h:192, outW:768, outH:576, scan:false };
    configure(eink);
    const capDims = _getCaskiaCaptureSampleDims({ resolution:'medium' });
    const sources = [0,1,2,3,4,5].map(phase => makeSource(293, 211, phase * 3 + 1));
    const sequence = forceCPU => {
      resetEInk();
      const previews = [];
      for (let i = 0; i < 3; i++) {
        const preview = makeOutput(768, 576);
        callCore(eink, sources[i * 2], preview, forceCPU);
        previews.push(pixels(preview.canvas));
        const capture = makeOutput(1280, 960);
        callCore({ ...eink, w:capDims.sampleW, h:capDims.sampleH, outW:1280, outH:960 }, sources[i * 2 + 1], capture, forceCPU);
      }
      return previews;
    };
    const forcedCpu = sequence(true);
    const defaultCpu = sequence(false);
    recInterleave.capDims = [capDims.sampleW, capDims.sampleH];
    recInterleave.perPreviewFrame = forcedCpu.map((frame, i) => diff(frame, defaultCpu[i]));
    resetEInk();
    const fresh = makeOutput(768, 576);
    callCore(eink, sources[4], fresh, false);
    recInterleave.ghostSurvives = diff(defaultCpu[2], pixels(fresh.canvas)).changedPixels;
  }

  const sizeChurn = {};
  {
    const source = makeSource(400, 300, 7);
    const families = [
      { key:'dsi', test:{ family:'dsi', variant:'STD', w:256, h:192, outW:256, outH:192, scan:false }, capture:_getDsiCaptureSampleDims({ resolution:'medium' }) },
      { key:'dolphin', test:{ family:'dolphin', variant:'STD', color:'AQUA', contrast:100, resonance:0, w:256, h:192, outW:256, outH:192, scan:false }, capture:_getDolphinCaptureSampleDims({ resolution:'medium' }) },
      { key:'caskia-lcd', test:{ family:'caskia', variant:'STD', w:256, h:192, outW:256, outH:192, scan:false }, capture:_getCaskiaCaptureSampleDims({ resolution:'medium' }) },
      { key:'vfd-std', test:{ family:'vfd', variant:'STD', paletteIndex:0, w:256, h:192, outW:256, outH:192, scan:false }, capture:_getVfdCaptureSampleDims({ resolution:'medium' }) },
    ];
    for (const item of families) {
      configure(item.test);
      const output = makeOutput(256, 192);
      const renderAt = capture => callCore({
        ...item.test,
        w:capture ? item.capture.sampleW : item.test.w,
        h:capture ? item.capture.sampleH : item.test.h,
      }, source, output, false);
      const measure = alternating => {
        const samples = [];
        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < 12; i++) renderAt(alternating && !!(i & 1));
          const started = performance.now();
          for (let i = 0; i < 120; i++) renderAt(alternating && !!(i & 1));
          samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        return samples[1];
      };
      const fixedMs = measure(false);
      const alternatingMs = measure(true);
      sizeChurn[item.key] = {
        fixedMs:+fixedMs.toFixed(2),
        alternatingMs:+alternatingMs.toFixed(2),
        ratio:+(alternatingMs / Math.max(0.001, fixedMs)).toFixed(3),
      };
    }
  }

  const paletteGl = _camPaletteWebGLEngine.canvas.getContext('webgl');
  const glitchGl = _scrashWebGLEngine.canvas.getContext('webgl');
  const oscamGl = _oscamWebGLEngine.canvas.getContext('webgl');
  const debugInfo = paletteGl && paletteGl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo ? paletteGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : paletteGl?.getParameter(paletteGl.RENDERER);
  const readyBeforeLoss = _camPaletteWebGLEngine.isReady();
  const contextLoss = {};
  {
    const test = { family:'dolphin', variant:'STD', color:'AQUA', contrast:100, resonance:0, w:256, h:192, outW:512, outH:384, scan:false };
    configure(test);
    const source = makeSource(300, 220, 8);
    const cpu = makeOutput(512, 384), sameTick = makeOutput(512, 384);
    callCore(test, source, cpu, true);
    const lose = paletteGl.getExtension('WEBGL_lose_context');
    if (lose) {
      lose.loseContext();
      callCore(test, source, sameTick, false);
      contextLoss.sameTick = diff(pixels(cpu.canvas), pixels(sameTick.canvas));
      await new Promise(resolve => setTimeout(resolve, 120));
      contextLoss.ready = _camPaletteWebGLEngine.isReady();
      contextLoss.warnings = __t13Warnings.filter(message => message.includes('CAM palette'));
    } else {
      contextLoss.skipped = 'WEBGL_lose_context unavailable';
    }
  }

  return {
    claim:'byte-exacto CASKIA-LCD/VFD-STD/DSI-Bayer; DLPHN <=0.04% y solo banda adyacente',
    cpuCuts:['CASKIA E-INK', 'VFD THERMAL', 'DSI legacy Floyd-Steinberg', 'DSI applyEdits (Math.random)'],
    readyBeforeLoss,
    renderer,
    parity,
    dsiBayerChangedPixels:parity['DSI Bayer default'].final.changedPixels,
    contrastSweep,
    cpuOnlyModes,
    recInterleave,
    sizeChurn,
    contextLoss,
    isolation:{
      distinctCanvases:_camPaletteWebGLEngine.canvas !== _scrashWebGLEngine.canvas && _camPaletteWebGLEngine.canvas !== _oscamWebGLEngine.canvas,
      distinctContexts:paletteGl !== glitchGl && paletteGl !== oscamGl,
    },
    warnings:__t13Warnings.slice(),
  };
})()`;

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  new Function(scripts[0]);
  const sectionStart = html.indexOf('const _camPaletteWebGLEngine');
  const sectionEnd = html.indexOf('// CASKIA RENDER', sectionStart);
  const section = html.slice(sectionStart, sectionEnd);
  const staticChecks = {
    dedicatedEngine:sectionStart >= 0,
    nearestTextures:(section.match(/gl\.NEAREST/g) || []).length >= 2,
    sampleSizedCanvas:/canvas\.width < w \+ 2 \|\| canvas\.height < h \+ 2/.test(section) &&
      /function getResultSource\(\)/.test(section) && !/outputCtx/.test(section),
    targetsBySize:/const renderTargetCache = new Map\(\)/.test(section) && /renderTargetCache\.get\(key\)/.test(section),
    contextLossGuard:/gl && gl\.isContextLost\(\)/.test(section),
    dsiBayerGpu:/dsi-bayer/.test(html) && /bayer8Threshold/.test(section),
    cpuOnlyCuts:!/caskia-eink|vfd-thermal/.test(section),
    cpuFallbacks:/options\.forceCPU/.test(html) && /CAM palette WebGL init failed, using CPU fallback/.test(section),
    separateCanvases:/const canvas = document\.createElement\('canvas'\)/.test(section),
  };
  assert(Object.values(staticChecks).every(Boolean), `checks estaticos=${JSON.stringify(staticChecks)}`);

  const server = EXTERNAL_SERVER || USE_PIPE ? null : await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t13-chrome-'));
  const devtoolsArg = USE_PIPE ? '--remote-debugging-pipe' : `--remote-debugging-port=${CDP_PORT}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
    ...EXTRA_FLAGS, `--user-data-dir=${profileDir}`, devtoolsArg, 'about:blank',
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
        try { const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return response.ok && response.json(); }
        catch (_) { return false; }
      }, 'Chrome DevTools');
      browser = await new Cdp(version.webSocketDebuggerUrl).open();
    }
    page = await browser.createSession();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    const testUrl = USE_PIPE ? `${pathToFileURL(INDEX_PATH).href}?t13=1` : BASE_URL;
    await page.send('Page.navigate', { url:testUrl });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _camPaletteWebGLEngine === "object"'), 'runtime T13');
    const runtime = await evaluate(page, PARITY_PHASE);
    assert(runtime.readyBeforeLoss, `WebGL no listo antes del context-loss: ${JSON.stringify(runtime)}`);
    assert(runtime.isolation.distinctCanvases && runtime.isolation.distinctContexts, `aislamiento=${JSON.stringify(runtime.isolation)}`);
    const familyTolerance = { dsi:0, dolphin:0.0004, caskia:0, vfd:0 };
    for (const [name, result] of Object.entries(runtime.parity)) {
      assert(JSON.stringify(result.sample) === JSON.stringify(result.engine), `${name} dimensiones=${JSON.stringify(result)}`);
      const tolerance = familyTolerance[result.family];
      assert(result.raw.changedPixels / result.raw.totalPixels <= tolerance, `${name} raw CPU/GPU=${JSON.stringify(result.raw)}`);
      assert(result.final.changedPixels / result.final.totalPixels <= tolerance, `${name} final CPU/GPU=${JSON.stringify(result.final)}`);
      if (result.family === 'dolphin') assert(result.nonAdjacentPixels === 0, `${name} salto no adyacente=${result.nonAdjacentPixels}`);
    }
    assert(runtime.dsiBayerChangedPixels === 0, `DSI Bayer CPU/GPU=${runtime.dsiBayerChangedPixels} px`);
    assert(runtime.contrastSweep.every(result => result.changedPixels / result.totalPixels <= familyTolerance.dolphin && result.nonAdjacentPixels === 0), `DLPHN sweep=${JSON.stringify(runtime.contrastSweep)}`);
    assert(runtime.cpuOnlyModes.length === 0, `E-INK/THERMAL tocaron GPU: ${JSON.stringify(runtime.cpuOnlyModes)}`);
    assert(runtime.recInterleave.perPreviewFrame.every(result => result.changedPixels === 0), `REC E-INK=${JSON.stringify(runtime.recInterleave)}`);
    assert(runtime.recInterleave.ghostSurvives > 0, `REC E-INK sin ghost=${JSON.stringify(runtime.recInterleave)}`);
    for (const [family, timing] of Object.entries(runtime.sizeChurn)) {
      assert(timing.ratio <= 2, `${family} alternancia=${JSON.stringify(timing)}`);
    }
    assert(runtime.contextLoss.skipped || runtime.contextLoss.sameTick.changedPixels === 0, `context-loss=${JSON.stringify(runtime.contextLoss)}`);

    const fallbackUrl = USE_PIPE
      ? `${pathToFileURL(INDEX_PATH).href}?t13-no-webgl=1`
      : `http://127.0.0.1:${HTTP_PORT}/index.html?t13-no-webgl=1`;
    await page.send('Page.navigate', { url:fallbackUrl });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _camPaletteWebGLEngine === "object"'), 'runtime fallback T13');
    const fallback = await evaluate(page, `(() => {
      const source=document.createElement('canvas'); source.width=180; source.height=140;
      const sourceCtx=source.getContext('2d'); sourceCtx.fillStyle='#416f9b'; sourceCtx.fillRect(0,0,180,140);
      sourceCtx.fillStyle='#e36b42'; sourceCtx.fillRect(17,13,91,77);
      camVariant='STD'; dlpColorMode='AQUA'; dlpContrastVal=100; dlpResonanceVal=0;
      const make=()=>{const canvas=document.createElement('canvas'); canvas.width=480;canvas.height=360;return {canvas,ctx:canvas.getContext('2d',{willReadFrequently:true})}};
      const cpu=make(), fallback=make();
      _renderDolphinCore(source,180,140,cpu.ctx,false,{sampleW:160,sampleH:120,outW:480,outH:360,scanCanvas:false,forceCPU:true});
      _renderDolphinCore(source,180,140,fallback.ctx,false,{sampleW:160,sampleH:120,outW:480,outH:360,scanCanvas:false});
      const a=cpu.ctx.getImageData(0,0,480,360).data,b=fallback.ctx.getImageData(0,0,480,360).data;
      let changed=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;
      return { ready:_camPaletteWebGLEngine.isReady(), changed, warnings:__t13Warnings.slice() };
    })()`);
    assert(!fallback.ready && fallback.changed === 0 && fallback.warnings.some(message => message.includes('CAM palette WebGL init failed')), `fallback=${JSON.stringify(fallback)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event => event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown');
    assert(runtimeExceptions.length === 0, `excepciones=${exceptionDescriptions.join(' | ')}`);
    process.stdout.write(`${JSON.stringify({
      static:{ inlineScripts:scripts.length, syntax:true, httpPort:HTTP_PORT, ...staticChecks },
      ...runtime,
      fallback,
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

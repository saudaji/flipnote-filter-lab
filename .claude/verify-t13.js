#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS, 'index.html');
const HTTP_PORT = Number(process.env.T13_HTTP_PORT) || 8873;
const CDP_PORT = Number(process.env.T13_CDP_PORT) || 24653;
const EXTERNAL_SERVER = process.env.T13_EXTERNAL_SERVER === '1';
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t13=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
(() => {
  const pixels = canvas => {
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently:true });
    ctx.drawImage(canvas, 0, 0);
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
  const makeSource = (w, h, phase = 0) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tile = (((x + phase * 3) >> 3) ^ ((y + phase * 5) >> 3)) & 1;
      image.data[i] = (x * 11 + y * 3 + phase * 29 + tile * 47) & 255;
      image.data[i + 1] = (x * 5 + y * 13 + phase * 17 + tile * 83) & 255;
      image.data[i + 2] = (x * 17 + y * 7 + phase * 41 + tile * 31) & 255;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  };
  const makeOutput = (w, h) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    return { canvas, ctx:canvas.getContext('2d', { willReadFrequently:true }) };
  };
  const rawTarget = (family, w, h) => family === 'dolphin' ? _getDolphinRenderTarget(w, h).canvas :
    family === 'caskia' ? _getCaskiaRenderTarget(w, h).canvas : _getVfdRenderTarget(w, h).canvas;
  const configure = test => {
    camVariant = test.variant;
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
    if (test.family === 'dolphin') _renderDolphinCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
    else if (test.family === 'caskia') _renderCaskiaCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
    else _renderVfdCore(source, source.width, source.height, target.ctx, !!test.mirror, options);
  };
  const resetEInk = () => {
    _caskiaEInkMemory.fill(0);
    _caskiaEInkPrimed = false;
    _camPaletteWebGLEngine.resetEInk();
  };
  const tests = [
    { name:'DLPHN STD AQUA', family:'dolphin', variant:'STD', color:'AQUA', contrast:100, resonance:0, w:160, h:120, outW:480, outH:360, scan:false },
    { name:'DLPHN LGCY WARM edits', family:'dolphin', variant:'LGCY', color:'WARM', contrast:137, resonance:56, mirror:true, w:144, h:144, outW:432, outH:432, scan:true },
    { name:'CASKIA STD wide', family:'caskia', variant:'STD', w:192, h:108, outW:576, outH:324 },
    { name:'CASKIA STD tall mirror', family:'caskia', variant:'STD', mirror:true, w:108, h:192, outW:324, outH:576 },
    { name:'CASKIA E-INK first', family:'caskia', variant:'E-INK', w:256, h:192, outW:768, outH:576 },
    { name:'VFD STD palette 0', family:'vfd', variant:'STD', paletteIndex:0, w:160, h:120, outW:480, outH:360 },
    { name:'VFD STD custom palette', family:'vfd', variant:'STD', customPalette:{ ink:[247,63,191], paper:[91,246,233] }, mirror:true, w:192, h:108, outW:576, outH:324 },
    { name:'VFD THRML tall', family:'vfd', variant:'THRML', w:108, h:192, outW:324, outH:576 },
  ];
  const results = {};
  for (const test of tests) {
    configure(test);
    if (test.variant === 'E-INK') resetEInk();
    const source = makeSource(test.w + 37, test.h + 19, 1);
    const cpu = makeOutput(test.outW, test.outH);
    callCore(test, source, cpu, true);
    const cpuRaw = pixels(rawTarget(test.family, test.w, test.h));
    if (test.variant === 'E-INK') resetEInk();
    const gpu = makeOutput(test.outW, test.outH);
    callCore(test, source, gpu, false);
    const gpuRaw = pixels(_camPaletteWebGLEngine.canvas);
    results[test.name] = {
      raw:diff(cpuRaw, gpuRaw),
      final:diff(pixels(cpu.canvas), pixels(gpu.canvas)),
      sample:[test.w, test.h],
      engine:[_camPaletteWebGLEngine.canvas.width, _camPaletteWebGLEngine.canvas.height],
      output:[gpu.canvas.width, gpu.canvas.height],
    };
  }

  const temporal = { name:'CASKIA E-INK temporal', family:'caskia', variant:'E-INK', w:256, h:192, outW:768, outH:576 };
  configure(temporal);
  const firstSource = makeSource(293, 211, 2);
  const secondSource = makeSource(293, 211, 9);
  resetEInk();
  const cpuFirst = makeOutput(temporal.outW, temporal.outH);
  const cpuSecond = makeOutput(temporal.outW, temporal.outH);
  callCore(temporal, firstSource, cpuFirst, true);
  callCore(temporal, secondSource, cpuSecond, true);
  const cpuTemporalRaw = pixels(rawTarget('caskia', temporal.w, temporal.h));
  resetEInk();
  const gpuFirst = makeOutput(temporal.outW, temporal.outH);
  const gpuSecond = makeOutput(temporal.outW, temporal.outH);
  callCore(temporal, firstSource, gpuFirst, false);
  callCore(temporal, secondSource, gpuSecond, false);
  results[temporal.name] = {
    raw:diff(cpuTemporalRaw, pixels(_camPaletteWebGLEngine.canvas)),
    final:diff(pixels(cpuSecond.canvas), pixels(gpuSecond.canvas)),
    sample:[temporal.w, temporal.h],
    engine:[_camPaletteWebGLEngine.canvas.width, _camPaletteWebGLEngine.canvas.height],
    output:[gpuSecond.canvas.width, gpuSecond.canvas.height],
  };

  // A device without float render targets keeps WebGL for the static families but
  // must preserve E-INK's CPU Float32 history instead of resetting it each frame.
  resetEInk();
  const originalRender = _camPaletteWebGLEngine.render;
  _camPaletteWebGLEngine.render = () => false;
  const floatFallbackFirst = makeOutput(temporal.outW, temporal.outH);
  const floatFallbackSecond = makeOutput(temporal.outW, temporal.outH);
  callCore(temporal, firstSource, floatFallbackFirst, false);
  callCore(temporal, secondSource, floatFallbackSecond, false);
  _camPaletteWebGLEngine.render = originalRender;
  results['CASKIA E-INK float fallback'] = {
    raw:diff(cpuTemporalRaw, pixels(rawTarget('caskia', temporal.w, temporal.h))),
    final:diff(pixels(cpuSecond.canvas), pixels(floatFallbackSecond.canvas)),
    sample:[temporal.w, temporal.h],
    engine:[_camPaletteWebGLEngine.canvas.width, _camPaletteWebGLEngine.canvas.height],
    output:[floatFallbackSecond.canvas.width, floatFallbackSecond.canvas.height],
  };

  const perfTest = { family:'dolphin', variant:'STD', color:'AQUA', contrast:100, resonance:0, w:256, h:192, outW:256, outH:192, scan:false };
  configure(perfTest);
  const perfSource = makeSource(320, 240, 4);
  const measure = forceCPU => {
    const target = makeOutput(256, 192);
    for (let i = 0; i < 20; i++) callCore(perfTest, perfSource, target, forceCPU);
    const values = [];
    for (let i = 0; i < 180; i++) {
      const started = performance.now();
      callCore(perfTest, perfSource, target, forceCPU);
      values.push(performance.now() - started);
    }
    values.sort((a, b) => a - b);
    return { medianMs:values[values.length >> 1], p95Ms:values[Math.floor(values.length * 0.95)], meanMs:values.reduce((a,b)=>a+b,0)/values.length };
  };
  const performanceStats = { cpu:measure(true), gpu:measure(false) };
  const paletteGl = _camPaletteWebGLEngine.canvas.getContext('webgl');
  const glitchGl = _scrashWebGLEngine.canvas.getContext('webgl');
  const oscamGl = _oscamWebGLEngine.canvas.getContext('webgl');
  const debugInfo = paletteGl && paletteGl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo ? paletteGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : paletteGl?.getParameter(paletteGl.RENDERER);
  return {
    ready:_camPaletteWebGLEngine.isReady(),
    renderer,
    results,
    performance:performanceStats,
    isolation:{ distinctCanvases:_camPaletteWebGLEngine.canvas !== _scrashWebGLEngine.canvas && _camPaletteWebGLEngine.canvas !== _oscamWebGLEngine.canvas, distinctContexts:paletteGl !== glitchGl && paletteGl !== oscamGl },
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
    sampleSizedCanvas:/canvas\.width = w;\s*canvas\.height = h/.test(section),
    cpuFallbacks:/options\.forceCPU/.test(html) && /CAM palette WebGL init failed, using CPU fallback/.test(section),
    separateCanvases:/const canvas = document\.createElement\('canvas'\)/.test(section),
  };
  assert(Object.values(staticChecks).every(Boolean), `checks estaticos=${JSON.stringify(staticChecks)}`);

  const server = EXTERNAL_SERVER ? null : await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t13-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
  ], { stdio:'ignore' });
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
    const version = await waitFor(async () => {
      if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
      try { const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return response.ok && response.json(); }
      catch (_) { return false; }
    }, 'Chrome DevTools');
    browser = await new Cdp(version.webSocketDebuggerUrl).open();
    page = await browser.createSession();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _camPaletteWebGLEngine === "object"'), 'runtime T13');
    const runtime = await evaluate(page, PARITY_PHASE);
    assert(runtime.ready, `WebGL no listo: ${JSON.stringify(runtime)}`);
    assert(runtime.isolation.distinctCanvases && runtime.isolation.distinctContexts, `aislamiento=${JSON.stringify(runtime.isolation)}`);
    for (const [name, result] of Object.entries(runtime.results)) {
      assert(JSON.stringify(result.sample) === JSON.stringify(result.engine), `${name} dimensiones=${JSON.stringify(result)}`);
      assert(result.raw.changedPixels === 0, `${name} raw CPU/GPU=${JSON.stringify(result.raw)}`);
      assert(result.final.changedPixels === 0, `${name} final CPU/GPU=${JSON.stringify(result.final)}`);
    }

    await page.send('Page.navigate', { url:`http://127.0.0.1:${HTTP_PORT}/index.html?t13-no-webgl=1` });
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

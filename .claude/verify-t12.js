#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'docs/index.html');
const BASE_URL = `${pathToFileURL(INDEX_PATH).href}?t12=1`;
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
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
        else pending.resolve(msg.result || {});
      } else if (msg.method) {
        this.sessions.get(msg.sessionId)?.events.push(msg);
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
  const realSetTimeout = window.setTimeout.bind(window);
  window.__t12 = { raf:0, consoleWarnings:[], stageStatuses:[] };
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    __t12.raf++;
    cb(performance.now());
  }, 16);
  window.cancelAnimationFrame = id => clearTimeout(id);
  const nativeCanvasGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (location.search.includes('t12-no-webgl') && (type === 'webgl' || type === 'experimental-webgl')) return null;
    return nativeCanvasGetContext.call(this, type, ...args);
  };
  const realWarn = console.warn.bind(console);
  console.warn = (...args) => {
    __t12.consoleWarnings.push(args.map(String).join(' '));
    realWarn(...args);
  };
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('stub only', 'NotAllowedError'); };
})();
`;

const GLITCH_PHASE = String.raw`
(async () => {
  const W = 640, H = 480;
  const source = document.createElement('canvas');
  source.width = W; source.height = H;
  const srcCtx = source.getContext('2d', { willReadFrequently:true });
  const image = srcCtx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const block = ((x >> 5) ^ (y >> 5)) & 1;
      image.data[i] = (x * 3 + y + block * 67) & 255;
      image.data[i + 1] = (x + y * 5 + block * 31) & 255;
      image.data[i + 2] = (x * 7 + y * 2 + block * 97) & 255;
      image.data[i + 3] = 255;
    }
  }
  srcCtx.putImageData(image, 0, 0);
  const output = document.createElement('canvas');
  output.width = W; output.height = H;
  const outCtx = output.getContext('2d', { willReadFrequently:true });
  const zero = () => ({ chroma:0, drip:0, neon:0, wave:0, crush:0, hue:0, grain:0, chaos:0, audioReact:0, animate:false, speed:5 });
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
  const render = (params, audio = null, t = 2) => {
    _scrashWebGLEngine.reset();
    const usedGpu = _applyScrash(srcCtx, outCtx, W, H, t, audio, params);
    return { usedGpu, pixels:outCtx.getImageData(0, 0, W, H).data.slice(), dataUrl:output.toDataURL('image/png') };
  };
  const nativeRandom = Math.random;
  Math.random = () => 0.25;
  scrPyPal = 'none';
  const base = render(zero());
  const parity = diff(image.data, base.pixels);

  const cases = [
    ['chroma', 10, 50, null],
    ['drip', 25, 100, null],
    ['neon', 25, 100, null],
    ['wave', 6, 30, null],
    ['crush', 25, 100, null],
    ['hue', 45, 180, null],
    ['grain', 25, 100, null],
    ['chaos', 25, 100, null],
    ['audioReact', 75, 300, { bass:0.8, mid:0.7, treble:0.6, rms:0.5, transient:0.8 }],
  ];
  const effects = {};
  const matrix = document.createElement('canvas');
  const thumbW = 160, thumbH = 120, labelW = 96;
  matrix.width = labelW + thumbW * 3;
  matrix.height = cases.length * thumbH;
  const matrixCtx = matrix.getContext('2d');
  matrixCtx.fillStyle = '#111'; matrixCtx.fillRect(0, 0, matrix.width, matrix.height);
  matrixCtx.font = '12px monospace'; matrixCtx.textBaseline = 'middle';
  for (let row = 0; row < cases.length; row++) {
    const [key, lowValue, highValue, audio] = cases[row];
    const lowP = zero(), highP = zero();
    lowP[key] = lowValue; highP[key] = highValue;
    const low = render(lowP, audio), high = render(highP, audio);
    const lowDiff = diff(base.pixels, low.pixels), highDiff = diff(base.pixels, high.pixels);
    const levelDiff = diff(low.pixels, high.pixels);
    effects[key] = { lowValue, highValue, low:lowDiff, high:highDiff, lowVsHigh:levelDiff };
    const y = row * thumbH;
    matrixCtx.fillStyle = '#fff'; matrixCtx.fillText(key, 4, y + thumbH / 2);
    matrixCtx.drawImage(source, labelW, y, thumbW, thumbH);
    matrixCtx.drawImage((() => { const c=document.createElement('canvas'); c.width=W;c.height=H;c.getContext('2d').putImageData(new ImageData(low.pixels,W,H),0,0);return c; })(), labelW + thumbW, y, thumbW, thumbH);
    matrixCtx.drawImage((() => { const c=document.createElement('canvas'); c.width=W;c.height=H;c.getContext('2d').putImageData(new ImageData(high.pixels,W,H),0,0);return c; })(), labelW + thumbW * 2, y, thumbW, thumbH);
  }

  const aspects = {};
  for (const [name, dims] of Object.entries({ '4:3':[640,480], '1:1':[480,480], '16:9':[854,480], '9:16':[480,854] })) {
    const [w, h] = dims;
    const s = document.createElement('canvas'); s.width=w; s.height=h;
    const sc = s.getContext('2d', { willReadFrequently:true });
    sc.fillStyle='#123456'; sc.fillRect(0,0,w,h);
    sc.fillStyle='#ef7134'; sc.fillRect(0,0,Math.max(1,w>>2),Math.max(1,h>>3));
    const d = document.createElement('canvas'); d.width=w; d.height=h;
    const dc = d.getContext('2d', { willReadFrequently:true });
    const usedGpu = _applyScrash(sc, dc, w, h, 3, null, { ...zero(), chroma:17, wave:11, neon:35, hue:120 });
    const data = dc.getImageData(0,0,w,h).data;
    const input = sc.getImageData(0,0,w,h).data;
    aspects[name] = { input:[w,h], engine:[_scrashWebGLEngine.canvas.width,_scrashWebGLEngine.canvas.height], output:[d.width,d.height], usedGpu, diff:diff(input,data) };
  }

  const palettes = {};
  for (const name of ['py','spy','ide']) {
    scrPyPal = name;
    const result = render(zero());
    const allowed = new Set(SCR_PY_PALETTES[name].map(rgb => rgb.join(',')));
    let unexpected = 0;
    const seen = new Set();
    for (let i=0; i<result.pixels.length; i+=4) {
      const key = result.pixels[i] + ',' + result.pixels[i+1] + ',' + result.pixels[i+2];
      seen.add(key); if (!allowed.has(key)) unexpected++;
    }
    palettes[name] = { colorsSeen:seen.size, unexpectedPixels:unexpected };
  }
  scrPyPal = 'none';

  const allMax = { chroma:50, drip:100, neon:100, wave:30, crush:100, hue:180, grain:100, chaos:100, audioReact:300, animate:false, speed:20 };
  for (let i=0;i<30;i++) _applyScrash(srcCtx,outCtx,W,H,4+i/30,null,allMax);
  const timings = [];
  for (let i=0;i<300;i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const started = performance.now();
    _applyScrash(srcCtx,outCtx,W,H,5+i/30,null,allMax);
    timings.push(performance.now()-started);
  }
  const sorted = [...timings].sort((a,b)=>a-b);
  const performanceStats = {
    frames:timings.length,
    meanMs:timings.reduce((a,b)=>a+b,0)/timings.length,
    medianMs:sorted[sorted.length>>1],
    p95Ms:sorted[Math.floor(sorted.length*0.95)],
    maxMs:sorted[sorted.length-1],
  };

  const fallbackSource = document.createElement('canvas'); fallbackSource.width=64; fallbackSource.height=48;
  const fallbackCtx = fallbackSource.getContext('2d', { willReadFrequently:true });
  fallbackCtx.fillStyle='#345678'; fallbackCtx.fillRect(0,0,64,48);
  const beforeFallback = fallbackCtx.getImageData(0,0,64,48).data;
  const realRender = _scrashWebGLEngine.render;
  _scrashWebGLEngine.render = () => false;
  const fallbackUsedGpu = _applyScrash(fallbackCtx,fallbackCtx,64,48,1,null,{ ...zero(), neon:100 });
  const firstBuffer = _scrashOutBuffer;
  _applyScrash(fallbackCtx,fallbackCtx,64,48,2,null,{ ...zero(), neon:100 });
  const fallbackBufferReused = firstBuffer === _scrashOutBuffer;
  _scrashWebGLEngine.render = realRender;
  const fallbackDiff = diff(beforeFallback, fallbackCtx.getImageData(0,0,64,48).data);

  const gl = _scrashWebGLEngine.canvas.getContext('webgl') || _scrashWebGLEngine.canvas.getContext('experimental-webgl');
  const debugInfo = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'none');
  Math.random = nativeRandom;
  return {
    webgl:{ ready:_scrashWebGLEngine.isReady(), renderer },
    parity,
    effects,
    aspects,
    palettes,
    performance:performanceStats,
    fallback:{ usedGpu:fallbackUsedGpu, bufferReused:fallbackBufferReused, diff:fallbackDiff },
    matrixDataUrl:matrix.toDataURL('image/png'),
    matrixSize:[matrix.width,matrix.height],
  };
})()
`;

const STAGE_SETUP = String.raw`
(() => {
  window.__t12StageChannel?.close();
  window.__t12StageChannel = new BroadcastChannel('flip_stage');
  __t12.stageStatuses = [];
  __t12StageChannel.addEventListener('message', event => {
    if (event.data?.type === 'status') __t12.stageStatuses.push(event.data);
  });
  __t12StageChannel.postMessage({
    type:'state',
    payload:{
      source:{ cam:false, audioMode:'off', audioDeviceId:null },
      pipeline:[{ engine:'glitch', on:true, params:{ chroma:50,drip:100,neon:100,wave:30,crush:50,hue:180,grain:100,chaos:100,audioReact:300,animate:true,speed:20 } }],
      vhs:{ enabled:true,intensity:100,tracking:100,chromaBleed:100,scanlines:100,jitter:100,warble:100 },
    },
  });
  return { before:_stageGetWorkRes(), canvas:[stageOutCanvas.width,stageOutCanvas.height] };
})()
`;

async function main() {
  const stageSeconds = Number(process.env.T12_STAGE_SECONDS) || 60;
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t12-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, scripts[0]);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const sectionStart = html.indexOf('const _scrashWebGLEngine');
  const sectionEnd = html.indexOf('// Reads band energies', sectionStart);
  const section = html.slice(sectionStart, sectionEnd);
  const staticChecks = {
    webglEngine:sectionStart >= 0,
    resolutionUniform:/uniform vec2 u_resolution/.test(section),
    dynamicCanvas:/canvas\.width = w;\s*canvas\.height = h/.test(section),
    jsFallback:/let _scrashOutBuffer = new Uint8ClampedArray\(0\)/.test(section) && /_scrashGrainNoise/.test(section),
    renderStepSignature:/renderStep\(srcCanvas, targetCtx, params, audio, t\)/.test(html),
  };
  assert(Object.values(staticChecks).every(Boolean), `checks estaticos=${JSON.stringify(staticChecks)}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t12-chrome-'));
  const debugPort = Number(process.env.T12_CDP_PORT) || 24652;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const version = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`); return response.ok && response.json(); }
    catch (_) { return false; }
  }, 'Chrome DevTools');
  const browser = await new Cdp(version.webSocketDebuggerUrl).open();
  const page = await browser.createSession();
  const cleanup = () => {
    page.close(); browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _applyScrash === "function"'), 'runtime GLITCH');
    const runtime = await evaluate(page, GLITCH_PHASE);
    const matrixPath = path.join(os.tmpdir(), 'flip-t12-effects-matrix.png');
    fs.writeFileSync(matrixPath, Buffer.from(runtime.matrixDataUrl.split(',')[1], 'base64'));
    delete runtime.matrixDataUrl;

    assert(runtime.webgl.ready, `WebGL no listo: ${JSON.stringify(runtime.webgl)}`);
    assert(runtime.parity.changedPixels === 0, `pass-through difiere=${JSON.stringify(runtime.parity)}`);
    for (const [name, effect] of Object.entries(runtime.effects)) {
      assert(effect.low.changedPixels > 0 && effect.high.changedPixels > 0 && effect.lowVsHigh.changedPixels > 0,
        `${name} no responde en ambos niveles: ${JSON.stringify(effect)}`);
    }
    for (const [name, aspect] of Object.entries(runtime.aspects)) {
      assert(aspect.usedGpu && JSON.stringify(aspect.input) === JSON.stringify(aspect.engine) &&
        JSON.stringify(aspect.input) === JSON.stringify(aspect.output) && aspect.diff.changedPixels > 0,
      `${name}=${JSON.stringify(aspect)}`);
    }
    for (const [name, palette] of Object.entries(runtime.palettes)) {
      assert(palette.colorsSeen > 0 && palette.unexpectedPixels === 0, `${name}=${JSON.stringify(palette)}`);
    }
    // Cold headless profiles on this host put the unchanged c1687d8 baseline at
    // 1.308ms mean; a warm profile remains below 1ms. Guard both mean and tail
    // without mistaking cold-start variance for a product regression.
    assert(runtime.performance.meanMs < 1.5 && runtime.performance.p95Ms < 2.5,
      `GPU fuera de presupuesto: ${JSON.stringify(runtime.performance)}`);
    assert(runtime.fallback.usedGpu === false && runtime.fallback.bufferReused && runtime.fallback.diff.changedPixels > 0,
      `fallback=${JSON.stringify(runtime.fallback)}`);

    await page.send('Page.navigate', { url:`${pathToFileURL(INDEX_PATH).href}?t12-no-webgl=1` });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _applyScrash === "function"'), 'runtime fallback sin contexto');
    const contextFallback = await evaluate(page, `(() => {
      const source=document.createElement('canvas'); source.width=64; source.height=48;
      const ctx=source.getContext('2d',{willReadFrequently:true}); ctx.fillStyle='#345678'; ctx.fillRect(0,0,64,48);
      const usedGpu=_applyScrash(ctx,ctx,64,48,1,null,{chroma:0,drip:0,neon:100,wave:0,crush:0,hue:0,grain:0,chaos:0,audioReact:0,animate:false,speed:5});
      const px=ctx.getImageData(0,0,64,48).data;
      let changedPixels=0; for(let i=0;i<px.length;i+=4) if(px[i]!==52||px[i+1]!==86||px[i+2]!==120) changedPixels++;
      _ensurePipeBuffers(64,48);
      return {
        usedGpu,
        ready:_scrashWebGLEngine.isReady(),
        changedPixels,
        pipeCpuFallback:_pipeA.__flipCpuFallback,
        warnings:__t12.consoleWarnings.slice(),
      };
    })()`);
    assert(contextFallback.usedGpu === false && contextFallback.ready === false && contextFallback.changedPixels > 0 &&
      contextFallback.pipeCpuFallback === true &&
      contextFallback.warnings.some(message => message.includes('GLITCH WebGL init failed')),
      `fallo de contexto=${JSON.stringify(contextFallback)}`);

    await page.send('Page.navigate', { url:`${pathToFileURL(INDEX_PATH).href}?t12-stage=1#stageout` });
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _stageGetWorkRes === "function"'), 'runtime STAGE OUTPUT');
    const stageStart = await evaluate(page, STAGE_SETUP);
    await timeout(stageSeconds * 1000);
    const stageEnd = await evaluate(page, `({
      after:_stageGetWorkRes(),
      canvas:[stageOutCanvas.width,stageOutCanvas.height],
      statuses:__t12.stageStatuses.length,
      lastStatus:__t12.stageStatuses.at(-1) || null,
      webglReady:_scrashWebGLEngine.isReady(),
      raf:__t12.raf,
    })`);
    assert(stageStart.before === 640 && stageEnd.after === 640, `STAGE degrado=${JSON.stringify({ stageStart, stageEnd })}`);
    assert(stageEnd.webglReady && stageEnd.statuses >= Math.max(1, stageSeconds - 10) && stageEnd.lastStatus?.workRes === 640,
      `STAGE status=${JSON.stringify(stageEnd)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown');
    assert(runtimeExceptions.length === 0, `excepciones=${exceptionDescriptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ nodeCheckExit:syntax.status, inlineScripts:scripts.length, ...staticChecks },
      ...runtime,
      contextFallback,
      artifacts:{ effectsMatrix:matrixPath, bytes:fs.statSync(matrixPath).size },
      stage:{ seconds:stageSeconds, start:stageStart, end:stageEnd },
      runtimeExceptions:runtimeExceptions.length,
      exceptionDescriptions,
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

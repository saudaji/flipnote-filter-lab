#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.T04_BASE_URL || pathToFileURL(path.join(ROOT, 'docs/index.html')).href;
const SNAPSHOT_PATH = process.env.T04_SNAPSHOT || '';
const BASELINE_PATH = process.env.T04_BASELINE || '';
const BASELINE_ONLY = process.env.T04_BASELINE_ONLY === '1';
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
const debug = message => { if (process.env.T04_DEBUG) process.stderr.write(`[t04] ${message}\n`); };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 10000, intervalMs = 25) {
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
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
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
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new CdpSession(this, sessionId, targetId);
    this.sessions.set(sessionId, session);
    return session;
  }
  close() {
    try { this.ws.close(); } catch (_) {}
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
    this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
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
  let randomState = 0x1f2e3d4c;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  Date.now = () => 1700000000000;
  try { Object.defineProperty(performance, 'now', { configurable:true, value:() => 1000 }); } catch (_) {}
  window.requestAnimationFrame = cb => realSetTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);
  window.__t04 = { gumCalls: [] };
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      const bank = [[90, 1.3], [800, 2.1], [3000, 0.7], [9000, 1.9]];
      bank.forEach(([frequency, lfoFrequency], index) => {
        const osc = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.025 + index * 0.004;
        lfo.frequency.value = lfoFrequency;
        lfoGain.gain.value = 0.012;
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        osc.connect(gain);
        gain.connect(bus);
        osc.start();
        lfo.start();
      });
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'stub-mic', label:'STUB MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    const isVideo = !!constraints?.video;
    __t04.gumCalls.push(isVideo ? 'video' : 'audio');
    if (isVideo) {
      const source = document.createElement('canvas');
      source.width = 96;
      source.height = 72;
      const ctx = source.getContext('2d');
      let frame = 0;
      const paint = () => {
        frame++;
        ctx.fillStyle = frame % 2 ? '#ff3b00' : '#006bff';
        ctx.fillRect(0, 0, source.width, source.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect((frame * 7) % 72, 12, 24, 48);
        if (source.__running !== false) requestAnimationFrame(paint);
      };
      paint();
      const stream = source.captureStream(30);
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { source.__running = false; }, { once:true }));
      return stream;
    }
    const audioCtx = new AC();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(dest);
    osc.start();
    return dest.stream;
  };
})();
`;

const RUNTIME_MEASURE = String.raw`
(async () => {
  const W = 640, H = 480;
  const markerSize = 96, inset = 16;
  const corners = [
    { name:'TL', x:inset, y:inset, rx:0, ry:0 },
    { name:'TR', x:W - inset - markerSize, y:inset, rx:W - 160, ry:0 },
    { name:'BL', x:inset, y:H - inset - markerSize, rx:0, ry:H - 160 },
    { name:'BR', x:W - inset - markerSize, y:H - inset - markerSize, rx:W - 160, ry:H - 160 },
  ];

  function makeSource(omit) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#707070';
    ctx.fillRect(0, 0, W, H);
    for (const corner of corners) {
      if (corner.name === omit) continue;
      ctx.fillStyle = '#f8f8f8';
      ctx.fillRect(corner.x, corner.y, markerSize, markerSize);
      ctx.fillStyle = '#080808';
      ctx.fillRect(corner.x + 22, corner.y + 22, markerSize - 44, markerSize - 44);
      ctx.fillStyle = '#f8f8f8';
      ctx.fillRect(corner.x + 42, corner.y + 8, 12, markerSize - 16);
      ctx.fillRect(corner.x + 8, corner.y + 42, markerSize - 16, 12);
    }
    return canvas;
  }

  function resetRenderState() {
    _pipeA = null;
    _pipeB = null;
    _caskiaEInkPrimed = false;
    _caskiaSeikoPrimed = false;
    if (_caskiaEInkMemory?.fill) _caskiaEInkMemory.fill(0);
    if (_caskiaSeikoMemory?.fill) _caskiaSeikoMemory.fill(0);
    if (_caskiaSeikoLum?.fill) _caskiaSeikoLum.fill(0);
    _resetOscamPersistence();
    _oscamPersistSignature = '';
    _oscamOverlaySignature = '';
    _oscamWebGLEngine.reset();
  }

  function renderPipeline(source, family, variant, forceLegacy) {
    resetRenderState();
    camVariant = variant;
    oscamLegacyMode = 'WAVE';
    const output = document.createElement('canvas');
    output.width = W;
    output.height = H;
    const originalWebGLRender = _oscamWebGLEngine.render;
    if (forceLegacy) _oscamWebGLEngine.render = () => false;
    try {
      runPipeline([{ engine:'cam', params:{ family } }], source, output.getContext('2d'), null, 1000);
    } finally {
      _oscamWebGLEngine.render = originalWebGLRender;
    }
    return output;
  }

  function regionDiff(a, b, corner) {
    const da = a.data, db = b.data;
    let changedPixels = 0, sumAbs = 0, maxDelta = 0;
    for (let y = corner.ry; y < corner.ry + 160; y++) {
      for (let x = corner.rx; x < corner.rx + 160; x++) {
        const i = (y * W + x) * 4;
        let changed = false;
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(da[i + c] - db[i + c]);
          sumAbs += delta;
          if (delta) changed = true;
          if (delta > maxDelta) maxDelta = delta;
        }
        if (changed) changedPixels++;
      }
    }
    return { changedPixels, totalPixels:160 * 160, sumAbs, maxDelta };
  }

  const cases = [
    { name:'CASKIA_LCD', family:'CASKIA', variant:'STD', forceLegacy:false },
    { name:'CASKIA_EINK', family:'CASKIA', variant:'E-INK', forceLegacy:false },
    { name:'CASKIA_SEIKO', family:'CASKIA', variant:'SEIKO', forceLegacy:false },
    { name:'OSCAM_WEBGL', family:'OSCAM', variant:'STD', forceLegacy:false },
    { name:'OSCAM_LEGACY', family:'OSCAM', variant:'STD', forceLegacy:true },
  ].filter(testCase => testCase.name === __T04_CASE__);
  const markerCoverage = {};
  const camPngs = {};
  const allMarkers = makeSource(null);

  for (const testCase of cases) {
    const full = renderPipeline(allMarkers, testCase.family, testCase.variant, testCase.forceLegacy);
    const fullPixels = full.getContext('2d').getImageData(0, 0, W, H);
    markerCoverage[testCase.name] = {};
    for (const corner of corners) {
      const omitted = renderPipeline(makeSource(corner.name), testCase.family, testCase.variant, testCase.forceLegacy);
      const omittedPixels = omitted.getContext('2d').getImageData(0, 0, W, H);
      markerCoverage[testCase.name][corner.name] = regionDiff(fullPixels, omittedPixels, corner);
    }

    resetRenderState();
    camVariant = testCase.variant;
    const cam = document.createElement('canvas');
    cam.width = OUT_W;
    cam.height = OUT_H;
    const originalWebGLRender = _oscamWebGLEngine.render;
    if (testCase.forceLegacy) _oscamWebGLEngine.render = () => false;
    try {
      _renderCamEngineFrame(allMarkers, W, H, cam.getContext('2d'), false, {
        path:'preview', now:1000, family:testCase.family,
      });
    } finally {
      _oscamWebGLEngine.render = originalWebGLRender;
    }
    camPngs[testCase.name] = cam.toDataURL('image/png');
  }

  const videoStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
  const audioStream = await navigator.mediaDevices.getUserMedia({ video:false, audio:true });
  videoStream.getTracks().forEach(track => track.stop());
  audioStream.getTracks().forEach(track => track.stop());

  return {
    markerCoverage,
    camPngs,
    stubCalls: {
      video:__t04.gumCalls.filter(kind => kind === 'video').length,
      audio:__t04.gumCalls.filter(kind => kind === 'audio').length,
    },
  };
})()
`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  debug('static');
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t04-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, scripts[0]);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const dynamicIds = [...html.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
  const refs = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const allIds = new Set([...ids, ...dynamicIds]);
  const missingIds = [...new Set(refs.filter(id => !allIds.has(id)))];
  assert(duplicateIds.length === 0, `IDs duplicados: ${duplicateIds.join(', ')}`);
  assert(missingIds.length === 0, `getElementById rotos: ${missingIds.join(', ')}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t04-chrome-'));
  const debugPort = Number(process.env.T04_CDP_PORT) || 24570;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio:'ignore', detached:true });
  chrome.unref();
  debug(`chrome ${debugPort}`);
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const browserVersion = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && response.json();
    } catch (_) { return false; }
  }, 'Chrome DevTools');
  debug('devtools');
  const browser = await new Cdp(browserVersion.webSocketDebuggerUrl).open();
  debug('websocket');
  const page = await browser.createSession();
  const cleanup = () => {
    page.close();
    browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled:true });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga del LAB');
    debug('loaded');
    const caseNames = ['CASKIA_LCD', 'CASKIA_EINK', 'CASKIA_SEIKO', 'OSCAM_WEBGL', 'OSCAM_LEGACY'];
    const runtime = { markerCoverage:{}, camPngs:{}, stubCalls:{ video:0, audio:0 } };
    const caseMs = {};
    const runtimeStarted = Date.now();
    for (const caseName of caseNames) {
      const caseStarted = Date.now();
      const keepAlive = setInterval(() => {}, 1000);
      let partial;
      try {
        partial = await evaluate(page, RUNTIME_MEASURE.replace('__T04_CASE__', JSON.stringify(caseName)));
      } finally {
        clearInterval(keepAlive);
      }
      Object.assign(runtime.markerCoverage, partial.markerCoverage);
      Object.assign(runtime.camPngs, partial.camPngs);
      runtime.stubCalls = partial.stubCalls;
      caseMs[caseName] = Date.now() - caseStarted;
      debug(`measured ${caseName}`);
    }
    const runtimeMs = Date.now() - runtimeStarted;
    debug('measured');

    for (const [caseName, cornerMetrics] of Object.entries(runtime.markerCoverage)) {
      for (const [corner, metric] of Object.entries(cornerMetrics)) {
        if (!BASELINE_ONLY) {
          assert(metric.changedPixels >= 100 && metric.maxDelta >= 10,
            `${caseName} ${corner}: marcador insuficiente pixels=${metric.changedPixels}/${metric.totalPixels} maxDelta=${metric.maxDelta}`);
        }
      }
    }
    assert(runtime.stubCalls.video === caseNames.length && runtime.stubCalls.audio === caseNames.length,
      `stubs gUM video/audio=${runtime.stubCalls.video}/${runtime.stubCalls.audio}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert(runtimeExceptions.length === 0, `excepciones runtime=${runtimeExceptions.length}`);

    const camHashes = Object.fromEntries(Object.entries(runtime.camPngs).map(([name, png]) => [name, sha256(png)]));
    let camParity = null;
    if (BASELINE_PATH) {
      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      camParity = {};
      for (const [name, png] of Object.entries(runtime.camPngs)) {
        const same = png === baseline.camPngs[name];
        camParity[name] = { changedPixels:same ? 0 : null, totalPixels:OUT_PIXELS, same };
        assert(same, `${name}: CAM difiere del baseline ${baseline.camHashes[name]} -> ${camHashes[name]}`);
      }
    }

    if (SNAPSHOT_PATH) {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
        camPngs:runtime.camPngs,
        camHashes,
        markerCoverage:runtime.markerCoverage,
      }));
    }

    process.stdout.write(`${JSON.stringify({
      static: {
        nodeCheckExit:syntax.status,
        inlineScripts:scripts.length,
        htmlIds:ids.length,
        dynamicIds:dynamicIds.length,
        getElementByIdRefs:refs.length,
        duplicateIds:duplicateIds.length,
        missingIds:missingIds.length,
      },
      markerCoverage:runtime.markerCoverage,
      camHashes,
      camParity,
      stubs:runtime.stubCalls,
      timing:{ runtimeMs, caseMs },
      runtimeExceptions:runtimeExceptions.length,
    }, null, 2)}\n`);
  } finally {
    cleanup();
    await timeout(200);
  }
}

const OUT_PIXELS = 1024 * 768;
main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

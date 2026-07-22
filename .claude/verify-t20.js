#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const BASE_URL = `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t20=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  window.__t20 = { ticks:{}, toasts:[] };
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    const name = cb.name || 'anonymous';
    __t20.ticks[name] = (__t20.ticks[name] || 0) + 1;
    cb(performance.now());
  }, 25);
  window.cancelAnimationFrame = id => clearTimeout(id);
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('stub only', 'NotAllowedError'); };
})();
`;

const PHASE_ONE = String.raw`
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, label, limit = 12000) => {
    const started = performance.now();
    let last;
    while (performance.now() - started < limit) {
      last = check();
      if (last) return last;
      await sleep(25);
    }
    throw new Error('timeout ' + label + ': ' + String(last));
  };
  const zeroAudio = Object.freeze({ bass:0, mid:0, treble:0, rms:0, transient:0 });
  const expected = {
    '4:3':{ src:[640,480], out:[1280,960] },
    '1:1':{ src:[480,480], out:[960,960] },
    '16:9':{ src:[854,480], out:[1708,960] },
    '9:16':{ src:[480,854], out:[960,1708] },
  };
  const realToast = flipToast;
  flipToast = (message, ...args) => {
    __t20.toasts.push(String(message));
    return realToast(message, ...args);
  };
  const pixelDiff = (a, b) => {
    let changedPixels = 0, totalDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta) changedPixels++;
      totalDelta += delta;
    }
    return { changedPixels, totalDelta, totalPixels:a.length / 4 };
  };
  const greenBounds = canvas => {
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 1] > 100 && data[i + 1] > data[i] * 1.4 && data[i + 1] > data[i + 2] * 1.4) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); pixels++;
        }
      }
    }
    const boxW = maxX - minX + 1, boxH = maxY - minY + 1;
    return { minX, minY, maxX, maxY, width:boxW, height:boxH, pixels,
      eccentricityPct:+(Math.abs(boxW - boxH) / Math.max(boxW, boxH) * 100).toFixed(4) };
  };
  let sourceStream = null;
  const attachSource = async source => {
    sourceStream?.getTracks().forEach(track => track.stop());
    sourceStream = source.captureStream(30);
    stream = sourceStream;
    vid.srcObject = sourceStream;
    await vid.play();
    await wait(() => vid.videoWidth === source.width && vid.videoHeight === source.height,
      'video metadata ' + source.width + 'x' + source.height);
  };

  localStorage.clear();
  splash.classList.add('hidden');
  const circleSource = document.createElement('canvas');
  circleSource.width = 480; circleSource.height = 640;
  const circleCtx = circleSource.getContext('2d');
  circleCtx.fillStyle = '#000'; circleCtx.fillRect(0, 0, 480, 640);
  circleCtx.fillStyle = '#00ff00'; circleCtx.beginPath(); circleCtx.arc(240, 320, 90, 0, Math.PI * 2); circleCtx.fill();
  await attachSource(circleSource);

  const originalSteps = _fusionPipelineSteps.slice();
  _fusionPipelineSteps.splice(0, _fusionPipelineSteps.length);
  switchTab('fusion');
  await sleep(150);
  const aspects = {};
  for (const aspect of Object.keys(expected)) {
    document.querySelector('[data-fusion-aspect="' + aspect + '"]').click();
    await sleep(80);
    const src = _fusionGetSrcCanvas();
    runPipeline([], src, ctxFusion, zeroAudio, performance.now());
    const active = [...document.querySelectorAll('.fusion-aspect-pill.active')].map(btn => btn.dataset.fusionAspect);
    aspects[aspect] = {
      source:[src.width, src.height],
      pipeA:[_pipeA.width, _pipeA.height],
      pipeB:[_pipeB.width, _pipeB.height],
      canvas:[fusionCanvas.width, fusionCanvas.height],
      active,
      bounds:greenBounds(fusionCanvas),
    };
  }
  const touchHeights = [...document.querySelectorAll('.fusion-aspect-pill')]
    .map(btn => +btn.getBoundingClientRect().height.toFixed(2));
  const jpeg = await _canvasToJpeg(fusionCanvas);
  const jpegBitmap = await createImageBitmap(jpeg);
  const photo = { bytes:jpeg.size, width:jpegBitmap.width, height:jpegBitmap.height };
  jpegBitmap.close();

  const tickCount = () => __t20.ticks._fusionLoop || 0;
  const realReadSnapshot = _readFlipAudioSnapshot;
  let snapshotReads = 0, frozenSnapshots = 0;
  _readFlipAudioSnapshot = (...args) => {
    const snapshot = realReadSnapshot(...args);
    snapshotReads++;
    if (Object.isFrozen(snapshot)) frozenSnapshots++;
    return snapshot;
  };
  let mark = tickCount();
  await sleep(1000);
  const ticksBefore = tickCount() - mark;
  for (let i = 0; i < 10; i++) {
    const aspect = i % 2 ? '9:16' : '4:3';
    document.querySelector('[data-fusion-aspect="' + aspect + '"]').click();
    await sleep(60);
  }
  mark = tickCount();
  await sleep(1000);
  const ticksAfter = tickCount() - mark;
  const live = {
    switches:10,
    ticksBefore,
    ticksAfter,
    ratio:+(ticksAfter / Math.max(1, ticksBefore)).toFixed(4),
    trackState:sourceStream.getVideoTracks()[0]?.readyState,
    fusionRunning,
    loopAlive:_fusionLoopAlive,
    snapshotReads,
    frozenSnapshots,
  };
  _readFlipAudioSnapshot = realReadSnapshot;

  flipAudioSettings.audioMode = 'off';
  flipAudioSettings.saveMode = 'files';
  flipAudioSettings.resolution = 'low';
  document.querySelector('[data-fusion-aspect="9:16"]').click();
  await sleep(80);
  const recordingDims = _getFlipRecordDimensions(fusionCanvas, { resolution:'low' });
  const extremeCanvas = document.createElement('canvas');
  extremeCanvas.width = 1; extremeCanvas.height = 10000;
  const clampDims = _getFlipRecordDimensions(extremeCanvas, { resolution:'high' });
  const saved = [];
  const inspectBlob = async blob => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    const url = URL.createObjectURL(blob);
    video.src = url; document.body.appendChild(video);
    await Promise.race([
      new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once:true });
        video.addEventListener('error', () => reject(new Error('metadata code=' + (video.error?.code || 0))), { once:true });
      }),
      sleep(6000).then(() => { throw new Error('metadata timeout'); }),
    ]);
    const result = { bytes:blob.size, mime:blob.type, width:video.videoWidth, height:video.videoHeight,
      duration:+video.duration.toFixed(3) };
    video.remove(); URL.revokeObjectURL(url);
    return result;
  };
  saveBlob = async (blob, filename) => saved.push({ filename, ...(await inspectBlob(blob)) });
  const recButton = document.getElementById('btnFusionRec');
  recButton.click();
  await wait(() => recButton.classList.contains('recording'), 'FUSION recording');
  const recCanvasBefore = [fusionCanvas.width, fusionCanvas.height];
  document.querySelector('[data-fusion-aspect="4:3"]').click();
  await sleep(80);
  const recLock = {
    canvasBefore:recCanvasBefore,
    canvasAfter:[fusionCanvas.width, fusionCanvas.height],
    selected:fusionAspect,
    toast:__t20.toasts.at(-1) || '',
  };
  await sleep(2100);
  recButton.click();
  await wait(() => saved.length === 1, 'blob FUSION', 15000);
  const recording = saved[0];

  document.querySelector('[data-fusion-aspect="16:9"]').click();
  _writeSettings();
  const stored = JSON.parse(localStorage.getItem('flipSettings'));

  fusionRunning = false;
  await sleep(80);
  const pattern = document.createElement('canvas');
  pattern.width = 640; pattern.height = 480;
  const patternCtx = pattern.getContext('2d');
  patternCtx.fillStyle = '#172031'; patternCtx.fillRect(0, 0, 640, 480);
  for (let y = 0; y < 480; y += 24) {
    for (let x = 0; x < 640; x += 24) {
      patternCtx.fillStyle = 'rgb(' + ((x * 3 + y) % 256) + ',' + ((x + y * 2) % 256) + ',' + ((x * 2 + y * 3) % 256) + ')';
      patternCtx.fillRect(x, y, 18, 18);
    }
  }
  await attachSource(pattern);
  _fusionApplyAspect('4:3', { persist:false });
  const mainSource = document.createElement('canvas');
  mainSource.width = 640; mainSource.height = 480;
  mainSource.getContext('2d').drawImage(vid, 0, 0, 640, 480);
  const currentSource = _fusionGetSrcCanvas();
  const sourceParity = pixelDiff(
    mainSource.getContext('2d').getImageData(0, 0, 640, 480).data,
    currentSource.getContext('2d').getImageData(0, 0, 640, 480).data
  );
  const renderDeterministic = source => {
    const out = document.createElement('canvas'); out.width = 640; out.height = 480;
    let seed = 0x31415926;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    _camEngineCore.sessionSeed = 0x1234abcd;
    _resetCamEngineState('preview');
    const steps = [{ engine:'cam' }, { engine:'glitch', params:{ glitch:{} } }];
    runPipeline(steps, source, out.getContext('2d'), zeroAudio, 123456.789);
    return out.getContext('2d').getImageData(0, 0, 640, 480).data;
  };
  const realRandom = Math.random;
  const mainPixels = renderDeterministic(mainSource);
  const currentPixels = renderDeterministic(currentSource);
  Math.random = realRandom;
  const pipelineParity = pixelDiff(mainPixels, currentPixels);
  _fusionPipelineSteps.splice(0, _fusionPipelineSteps.length, ...originalSteps);
  sourceStream.getTracks().forEach(track => track.stop());

  return {
    aspects, touchHeights, photo, live, recordingDims, clampDims, recLock, recording,
    persistence:{ stored:stored.fusionAspect },
    parity:{ source:sourceParity, pipeline:pipelineParity },
  };
})()
`;

const PHASE_RESTORED = String.raw`
(() => ({
  fusionAspect,
  canvas:[fusionCanvas.width, fusionCanvas.height],
  source:[_fusionSrc.width, _fusionSrc.height],
  pipeA:[_pipeA.width, _pipeA.height],
  pipeB:[_pipeB.width, _pipeB.height],
  active:[...document.querySelectorAll('.fusion-aspect-pill.active')].map(btn => btn.dataset.fusionAspect),
  stored:JSON.parse(localStorage.getItem('flipSettings')).fusionAspect,
}))()
`;

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t20-check-'));
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

  const mainHtml = spawnSync('git', ['show', 'main:docs/index.html'], { cwd:ROOT, encoding:'utf8' });
  assert(mainHtml.status === 0, `no se pudo leer main: ${mainHtml.stderr}`);
  const mainHasStretchDraw = /fctx\.drawImage\(vid,\s*0,\s*0,\s*w,\s*h\)/.test(mainHtml.stdout);
  assert(mainHasStretchDraw, 'main ya no contiene el drawImage baseline esperado');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t20-chrome-'));
  const debugPort = Number(process.env.T20_CDP_PORT) || 24640;
  const externalChrome = process.env.T20_CDP_EXTERNAL === '1';
  const chrome = externalChrome ? null : spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  chrome?.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const browserVersion = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`); return response.ok && response.json(); }
    catch (_) { return false; }
  }, 'Chrome DevTools');
  const browser = await new Cdp(browserVersion.webSocketDebuggerUrl).open();
  const page = await browser.createSession();
  const cleanup = () => {
    page.close(); browser.close();
    if (chrome && !chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled:true });
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga LAB');
    await waitFor(() => evaluate(page, 'typeof _fusionApplyAspect === "function"'), 'runtime FUSION');

    const started = Date.now();
    const runtime = await evaluate(page, PHASE_ONE);

    await page.send('Page.reload', { ignoreCache:true });
    await timeout(350);
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _fusionApplyAspect === "function"'), 'reload persistencia');
    const restored = await evaluate(page, PHASE_RESTORED);
    await evaluate(page, `(() => { const s=JSON.parse(localStorage.getItem('flipSettings')); s.fusionAspect='INVALID'; localStorage.setItem('flipSettings',JSON.stringify(s)); return true; })()`);
    await page.send('Page.reload', { ignoreCache:true });
    await timeout(350);
    await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof _fusionApplyAspect === "function"'), 'reload invalido');
    const invalid = await evaluate(page, PHASE_RESTORED);
    const runtimeMs = Date.now() - started;

    const expected = {
      '4:3':{ src:[640,480], out:[1280,960] },
      '1:1':{ src:[480,480], out:[960,960] },
      '16:9':{ src:[854,480], out:[1708,960] },
      '9:16':{ src:[480,854], out:[960,1708] },
    };
    for (const [aspect, dims] of Object.entries(expected)) {
      const result = runtime.aspects[aspect];
      assert(JSON.stringify(result.source) === JSON.stringify(dims.src), `${aspect} source=${result.source}`);
      assert(JSON.stringify(result.pipeA) === JSON.stringify(dims.src) && JSON.stringify(result.pipeB) === JSON.stringify(dims.src),
        `${aspect} pipes=${result.pipeA}/${result.pipeB}`);
      assert(JSON.stringify(result.canvas) === JSON.stringify(dims.out), `${aspect} canvas=${result.canvas}`);
      assert(result.active.length === 1 && result.active[0] === aspect, `${aspect} active=${result.active}`);
      assert(result.bounds.pixels > 0 && result.bounds.eccentricityPct < 2,
        `${aspect} circulo=${JSON.stringify(result.bounds)}`);
    }
    assert(runtime.touchHeights.every(height => height >= 40), `touch heights=${runtime.touchHeights}`);
    assert(runtime.photo.bytes > 0 && runtime.photo.width === 960 && runtime.photo.height === 1708,
      `foto 9:16=${JSON.stringify(runtime.photo)}`);
    assert(runtime.live.switches === 10 && runtime.live.trackState === 'live' && runtime.live.fusionRunning && runtime.live.loopAlive,
      `live=${JSON.stringify(runtime.live)}`);
    assert(runtime.live.ratio >= 0.8 && runtime.live.ratio <= 1.2, `ticks multiplicados=${JSON.stringify(runtime.live)}`);
    assert(runtime.live.snapshotReads > 0 && runtime.live.frozenSnapshots === runtime.live.snapshotReads,
      `snapshots=${JSON.stringify(runtime.live)}`);
    assert(JSON.stringify(runtime.recordingDims) === JSON.stringify({ width:480, height:854, aspect:'240:427' }),
      `record dims=${JSON.stringify(runtime.recordingDims)}`);
    assert(Math.max(runtime.clampDims.width, runtime.clampDims.height) === 4096,
      `clamp=${JSON.stringify(runtime.clampDims)}`);
    assert(JSON.stringify(runtime.recLock.canvasBefore) === JSON.stringify(runtime.recLock.canvasAfter) &&
      runtime.recLock.selected === '9:16' && /REC/.test(runtime.recLock.toast), `REC lock=${JSON.stringify(runtime.recLock)}`);
    assert(runtime.recording.bytes > 0 && runtime.recording.width === 480 && runtime.recording.height === 854 &&
      Number.isFinite(runtime.recording.duration) && runtime.recording.duration > 1.5 && runtime.recording.duration < 5,
      `REC=${JSON.stringify(runtime.recording)}`);
    assert(runtime.persistence.stored === '16:9', `stored=${runtime.persistence.stored}`);
    assert(restored.fusionAspect === '16:9' && restored.stored === '16:9' && restored.active[0] === '16:9' &&
      JSON.stringify(restored.canvas) === JSON.stringify([1708,960]), `restore=${JSON.stringify(restored)}`);
    assert(invalid.fusionAspect === '4:3' && invalid.active[0] === '4:3' &&
      JSON.stringify(invalid.canvas) === JSON.stringify([1280,960]), `invalid=${JSON.stringify(invalid)}`);
    assert(runtime.parity.source.changedPixels === 0 && runtime.parity.pipeline.changedPixels === 0,
      `paridad=${JSON.stringify(runtime.parity)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown'
    );
    assert(runtimeExceptions.length === 0, `excepciones runtime=${exceptionDescriptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ nodeCheckExit:syntax.status, inlineScripts:scripts.length, htmlIds:ids.length,
        dynamicIds:dynamicIds.length, getElementByIdRefs:refs.length,
        duplicateIds:duplicateIds.length, missingIds:missingIds.length, mainHasStretchDraw },
      ...runtime,
      persistence:{ ...runtime.persistence, restored, invalid },
      timing:{ runtimeMs },
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

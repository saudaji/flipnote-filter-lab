#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_COMMIT = 'c1687d8210556a19f564cf29376174bb534822a8';
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

const SEGMENTER_MODULE = `
  export const FilesetResolver = { forVisionTasks: async () => ({}) };
  export const ImageSegmenter = {
    createFromOptions: async () => {
      const W = 256, H = 256;
      const mask = new Float32Array(W * H);
      let frame = 0;
      return {
        segmentForVideo() {
          frame++;
          window.__t25.segmentCalls++;
          const cx = 128 + (frame % 12), cy = 128, r = 58;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const dx = x - cx, dy = y - cy;
              mask[y * W + x] = dx * dx + dy * dy <= r * r ? 1 : 0;
            }
          }
          return {
            confidenceMasks:[{ width:W, height:H, getAsFloat32Array:() => mask }],
            close() {},
          };
        },
        close() {},
      };
    },
  };
`;

const INIT_SCRIPT = String.raw`
(() => {
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  let randomState = 0x25f11f0;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  window.__t25 = {
    segmentCalls:0,
    callbacks:{},
    cpu:{},
    contextOptions:[],
    nativeRaf,
    reset() { this.callbacks={}; this.cpu={}; },
    read(name) {
      return { callbacks:this.callbacks[name] || 0, cpuMs:this.cpu[name] || 0 };
    },
  };
  HTMLCanvasElement.prototype.getContext = function(type, options, ...rest) {
    if (type === '2d' && (this.id === 'scrashCanvas' || this.id === 'sflowCanvas')) {
      __t25.contextOptions.push({ id:this.id, willReadFrequently:options?.willReadFrequently });
    }
    return nativeGetContext.call(this, type, options, ...rest);
  };
  window.requestAnimationFrame = cb => nativeRaf(ts => {
    const name = cb.name || 'anonymous';
    const started = performance.now();
    let result;
    try { result = cb(ts); }
    finally {
      if (!result || typeof result.then !== 'function') {
        __t25.callbacks[name] = (__t25.callbacks[name] || 0) + 1;
        __t25.cpu[name] = (__t25.cpu[name] || 0) + performance.now() - started;
      }
    }
    if (result && typeof result.then === 'function') {
      result.finally(() => {
        __t25.callbacks[name] = (__t25.callbacks[name] || 0) + 1;
        __t25.cpu[name] = (__t25.cpu[name] || 0) + performance.now() - started;
      });
    }
  });
  window.cancelAnimationFrame = id => nativeCancelRaf(id);

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.video) {
      const AC = window.AudioContext || window.webkitAudioContext;
      return new AC().createMediaStreamDestination().stream;
    }
    const source = document.createElement('canvas');
    source.width = 320; source.height = 240;
    const ctx = source.getContext('2d');
    let frame = 0;
    const paint = () => {
      frame++;
      ctx.fillStyle = frame % 2 ? '#102030' : '#203010';
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(90 + frame % 30, 35, 110, 180);
      if (source.__running !== false) requestAnimationFrame(paint);
    };
    paint();
    const stream = source.captureStream(30);
    stream.getTracks().forEach(track => track.addEventListener('ended', () => { source.__running = false; }, { once:true }));
    return stream;
  };
})();
`;

const RUNTIME_MEASURE = String.raw`
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, label, limit = 10000) => {
    const started = performance.now();
    let last;
    while (performance.now() - started < limit) {
      last = check();
      if (last) return last;
      await sleep(20);
    }
    throw new Error('timeout ' + label + ': ' + String(last));
  };
  const makeAnalyser = () => ({
    frequencyBinCount:1024,
    fftSize:2048,
    freqCalls:0,
    getByteFrequencyData(data) {
      this.freqCalls++;
      for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 37) & 127;
    },
    getByteTimeDomainData(data) {
      for (let i = 0; i < data.length; i++) data[i] = 128 + Math.round(Math.sin(i * 0.07) * 24);
    },
  });
  const finishMetric = (name, renders, elapsedMs) => {
    const raw = __t25.read(name);
    return {
      renders,
      elapsedMs:Math.round(elapsedMs),
      callbacks:raw.callbacks,
      cpuMs:+raw.cpuMs.toFixed(3),
      cpuMsPerDisplayFrame:+(raw.cpuMs / Math.max(1, raw.callbacks)).toFixed(4),
    };
  };
  const pixelHash = canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
    return { width:canvas.width, height:canvas.height, hash };
  };

  splash.classList.add('hidden');
  cameraRunning = asciiRunning = sonoRunning = scrashRunning = fusionRunning = editRunning = false;
  wmpRunning = false;

  const sonoAn = makeAnalyser();
  sonoAnalyser = sonoAn;
  extAudioMode = extMicOnlyMode = false;
  sonoPreset = 0; sonoMixVal = 0; sonoChaosVal = 0; sonoT = 0; sonoLastRAF = 0;
  const realAnalyze = analyzeAudio;
  let sonoRenders = 0;
  analyzeAudio = (...args) => { sonoRenders++; return realAnalyze(...args); };
  __t25.reset();
  let started = performance.now();
  sonoRunning = true;
  requestAnimationFrame(sonoLoop);
  await sleep(2000);
  sonoRunning = false;
  await sleep(80);
  const sono = finishMetric('sonoLoop', sonoRenders, performance.now() - started);
  analyzeAudio = realAnalyze;

  const wmpAn = makeAnalyser();
  wmpAnalyser = wmpAn;
  wmpPreset = 0; wmpRandom = false; wmpPerfMode = 0; _wmpFpsHist = []; _wmpLastFrameT = 0;
  __t25.reset();
  started = performance.now();
  wmpRunning = true;
  requestAnimationFrame(wmpLoop);
  await sleep(2000);
  wmpRunning = false;
  await sleep(80);
  const wmp = finishMetric('wmpLoop', wmpAn.freqCalls, performance.now() - started);

  const realDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  let flowRenders = 0;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    if (this.canvas === document.getElementById('sflowCanvas') && source === document.getElementById('sflowVid')) flowRenders++;
    return realDrawImage.call(this, source, ...args);
  };
  __t25.segmentCalls = 0;
  document.getElementById('btnSflowCam').click();
  await wait(() => __t25.segmentCalls >= 3, 'FLOW warmup');
  flowRenders = 0;
  __t25.segmentCalls = 0;
  __t25.reset();
  started = performance.now();
  await sleep(2000);
  const flow = finishMetric('_sfLoop', flowRenders, performance.now() - started);
  flow.segmentCalls = __t25.segmentCalls;
  flow.segmentRatio = +(flow.segmentCalls / Math.max(1, flow.renders)).toFixed(4);
  document.getElementById('btnSflowCam').click();
  await sleep(100);
  CanvasRenderingContext2D.prototype.drawImage = realDrawImage;

  const realInteractive = _isTypoCamInteractive;
  const realMotion = _isTypoMotionEnabled;
  const realUpdateTouch = updateTouchReflow;
  const realCommit = _commitTypoInteractionFrame;
  const realGyro = _updateTypoGyroPhysics;
  let typoRenders = 0;
  _isTypoCamInteractive = () => true;
  _isTypoMotionEnabled = () => true;
  updateTouchReflow = () => {};
  _commitTypoInteractionFrame = () => { typoRenders++; };
  _updateTypoGyroPhysics = () => true;
  asciiStaticSrc = {};
  _runTypoInteractionFrame._lastNow = 0;
  __t25.reset();
  started = performance.now();
  requestAnimationFrame(_runTypoInteractionFrame);
  await sleep(2000);
  _isTypoCamInteractive = () => false;
  await sleep(80);
  const typo = finishMetric('_runTypoInteractionFrame', typoRenders, performance.now() - started);
  _isTypoCamInteractive = realInteractive;
  _isTypoMotionEnabled = realMotion;
  updateTouchReflow = realUpdateTouch;
  _commitTypoInteractionFrame = realCommit;
  _updateTypoGyroPhysics = realGyro;
  asciiStaticSrc = null;

  const videoSource = document.createElement('canvas');
  videoSource.width = 160; videoSource.height = 120;
  const videoCtx = videoSource.getContext('2d');
  const videoStream = videoSource.captureStream(30);
  const videoMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8' : 'video/webm';
  const videoRecorder = new MediaRecorder(videoStream, { mimeType:videoMime });
  const videoChunks = [];
  videoRecorder.ondataavailable = event => { if (event.data?.size) videoChunks.push(event.data); };
  const videoStopped = new Promise(resolve => videoRecorder.addEventListener('stop', resolve, { once:true }));
  let videoFrame = 0;
  const videoPaint = setInterval(() => {
    videoFrame++;
    videoCtx.fillStyle = videoFrame % 2 ? '#e04b24' : '#245be0';
    videoCtx.fillRect(0, 0, 160, 120);
    videoCtx.fillStyle = '#fff';
    videoCtx.fillRect((videoFrame * 5) % 130, 20, 30, 80);
  }, 33);
  const videoStartedAt = performance.now();
  videoRecorder.start(100);
  await sleep(700);
  videoRecorder.stop();
  await videoStopped;
  clearInterval(videoPaint);
  let videoBlob = new Blob(videoChunks, { type:videoRecorder.mimeType || videoMime });
  try { videoBlob = await _fixWebmDuration(videoBlob, performance.now() - videoStartedAt); } catch (_) {}
  const videoFile = new File([videoBlob], 't25-preview.webm', { type:videoBlob.type });
  const realRenderDithered = renderDithered;
  let vidRenders = 0;
  renderDithered = (...args) => { vidRenders++; return realRenderDithered(...args); };
  _loadVidPlayer(videoFile);
  await wait(() => _vidPlayerActive, 'UPLOAD preview');
  await uploadVid.play();
  vidRenders = 0;
  started = performance.now();
  await sleep(2000);
  const vidPreview = { renders:vidRenders, elapsedMs:Math.round(performance.now() - started) };
  _stopVidPlayer();
  renderDithered = realRenderDithered;
  videoStream.getTracks().forEach(track => track.stop());

  const proxySource = document.createElement('canvas');
  proxySource.width = 160; proxySource.height = 120;
  let proxyRenders = 0;
  __t25.reset();
  started = performance.now();
  const proxy = _createRecordingCanvasStream(proxySource, 30, {
    dims:{ width:160, height:120, aspect:'4:3' },
    renderFrame({ ctx, width, height }) {
      proxyRenders++;
      ctx.fillStyle = proxyRenders % 2 ? '#f00' : '#00f';
      ctx.fillRect(0, 0, width, height);
    },
  });
  await sleep(2000);
  proxy.stop();
  const proxyRec = { renders:proxyRenders, elapsedMs:Math.round(performance.now() - started) };

  const mask = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const dx=x-128, dy=y-128; mask[y*256+x] = dx*dx+dy*dy < 58*58 ? 1 : 0;
  }
  window._sfStepHelpers.buildVectors(mask, 256, 256, 12, 0.5);
  const NativeF32 = window.Float32Array;
  let alloc65536 = 0;
  window.Float32Array = new Proxy(NativeF32, {
    construct(Target, args) {
      if (args[0] === 65536) alloc65536++;
      return new Target(...args);
    },
  });
  const vectorBenchStarted = performance.now();
  for (let i = 0; i < 300; i++) window._sfStepHelpers.buildVectors(mask, 256, 256, 12, 0.5);
  const vectorBenchMs = performance.now() - vectorBenchStarted;
  window.Float32Array = NativeF32;

  let changed = 0;
  const shifted = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const dx=x-129, dy=y-128;
    shifted[y*256+x] = dx*dx+dy*dy < 58*58 ? 1 : 0;
    if (shifted[y*256+x] !== mask[y*256+x]) changed++;
  }
  const reusedMaskDiffPct = +(changed / mask.length * 100).toFixed(4);

  scrashCamMode = 'foto';
  scrashCvs.width = 96; scrashCvs.height = 72;
  ctxScrash.fillStyle = '#d14b22'; ctxScrash.fillRect(0, 0, 96, 72);
  let snap = null;
  const realSaveBlob = saveBlob;
  saveBlob = async blob => {
    const bitmap = await createImageBitmap(blob);
    snap = { bytes:blob.size, width:bitmap.width, height:bitmap.height };
    bitmap.close();
  };
  document.getElementById('btnScrashSnap').click();
  await wait(() => snap, 'GLITCH snap');
  saveBlob = realSaveBlob;

  const contextOptions = __t25.contextOptions.filter((entry, index, all) =>
    all.findIndex(item => item.id === entry.id) === index
  );
  const pipe = {
    cpuFallback:_pipeA.__flipCpuFallback,
    willReadFrequently:_pipeA.__flipCpuFallback === true,
  };

  const measuredRaf = requestAnimationFrame;
  requestAnimationFrame = () => 0;
  const paritySonoAn = makeAnalyser();
  sonoAnalyser = paritySonoAn;
  sonoPreset = 0; sonoMixVal = 0; sonoChaosVal = 0; sonoHueVal = 0;
  sonoT = 1.25; sonoLastRAF = 0; sonoRunning = true;
  ctxSono.clearRect(0, 0, sonoCvs.width, sonoCvs.height);
  sonoLoop(1000);
  sonoRunning = false;
  const sonoFrame = pixelHash(sonoCvs);

  const parityWmpAn = makeAnalyser();
  wmpAnalyser = parityWmpAn;
  wmpPreset = 0; wmpRandom = false; wmpPerfMode = 0; wmpAlchemyAngle = 0;
  _wmpLastFrameT = 0; _wmpFpsHist = [];
  wmpPeaks.fill(0); wmpPeakHold.fill(0);
  ctxWmp.fillStyle = '#000'; ctxWmp.fillRect(0, 0, wmpCvs.width, wmpCvs.height);
  wmpRunning = true;
  wmpLoop(1000);
  wmpRunning = false;
  const wmpFrame = pixelHash(wmpCvs);

  let flowShotScheduled = false;
  requestAnimationFrame = cb => {
    if (!flowShotScheduled) {
      flowShotScheduled = true;
      setTimeout(() => cb(1000), 0);
    }
    return 1;
  };
  const nativePerfNow = performance.now.bind(performance);
  let perfNowOverridden = false;
  try {
    Object.defineProperty(performance, 'now', { configurable:true, value:() => 5000 });
    perfNowOverridden = true;
  } catch (_) {}
  extAudioMode = true;
  extAnalyser = makeAnalyser();
  window._sflowStartExtAudio();
  await sleep(150);
  const flowFrame = pixelHash(document.getElementById('sflowCanvas'));
  window._sflowStop();
  extAudioMode = false;
  extAnalyser = null;
  if (perfNowOverridden) {
    Object.defineProperty(performance, 'now', { configurable:true, value:nativePerfNow });
  }
  requestAnimationFrame = measuredRaf;

  return {
    loops:{ sono, wmp, flow, typo, vidPreview, proxyRec },
    flow:{ alloc65536, vectorBenchMs:+vectorBenchMs.toFixed(3), reusedMaskDiffPct },
    snap,
    canvasContexts:{ contextOptions, pipe },
    screenshots:{ sono:sonoFrame, wmp:wmpFrame, flow:flowFrame },
  };
})()
`;

function prepareFixture(tempRoot, label, html) {
  const dir = path.join(tempRoot, label);
  fs.cpSync(path.join(ROOT, 'docs'), dir, { recursive:true });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(SEGMENTER_MODULE).toString('base64')}`;
  const stubbed = html.replaceAll(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm',
    moduleUrl
  );
  fs.writeFileSync(path.join(dir, 'index.html'), stubbed);
  return `${pathToFileURL(path.join(dir, 'index.html')).href}?t25=${label}`;
}

async function main() {
  const currentHtml = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const base = spawnSync('git', ['show', `${BASE_COMMIT}:docs/index.html`], {
    cwd:ROOT, encoding:'utf8', maxBuffer:8 * 1024 * 1024,
  });
  assert(base.status === 0, `no se pudo leer baseline ${BASE_COMMIT}: ${base.stderr}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t25-'));
  const urls = {
    before:prepareFixture(tempRoot, 'before', base.stdout),
    after:prepareFixture(tempRoot, 'after', currentHtml),
  };
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t25-chrome-'));
  const debugPort = Number(process.env.T25_CDP_PORT) || 24725;
  assert(debugPort !== 8742, 'T25 debe usar un puerto distinto de 8742');
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const browserVersion = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && response.json();
    } catch (_) { return false; }
  }, 'Chrome DevTools');
  const browser = await new Cdp(browserVersion.webSocketDebuggerUrl).open();
  const page = await browser.createSession();
  const cleanup = () => {
    page.close(); browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(tempRoot, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    const results = {};
    for (const label of ['before', 'after']) {
      await page.send('Page.navigate', { url:urls[label] });
      await waitFor(() => evaluate(page, 'document.readyState === "complete" && typeof sonoLoop === "function"'), `${label} carga`);
      results[label] = await evaluate(page, RUNTIME_MEASURE);
    }

    for (const name of ['sono', 'wmp', 'flow', 'typo', 'vidPreview']) {
      assert(results.after.loops[name].renders >= 38 && results.after.loops[name].renders <= 66,
        `${name} renders/2s=${results.after.loops[name].renders}`);
      assert(results.before.loops[name].renders >= 100,
        `${name} baseline renders/2s=${results.before.loops[name].renders}`);
    }
    assert(results.after.loops.proxyRec.renders >= 38 && results.after.loops.proxyRec.renders <= 66,
      `proxy renders/2s=${results.after.loops.proxyRec.renders}`);
    assert(results.after.loops.flow.segmentRatio >= 0.45 && results.after.loops.flow.segmentRatio <= 0.55,
      `FLOW segment ratio=${results.after.loops.flow.segmentRatio}`);
    assert(results.after.flow.alloc65536 === 0, `FLOW alloc65536=${results.after.flow.alloc65536}`);
    assert(results.after.flow.reusedMaskDiffPct < 5, `FLOW mask diff=${results.after.flow.reusedMaskDiffPct}%`);
    assert(results.after.snap.bytes > 0 && results.after.snap.width === 96 && results.after.snap.height === 72,
      `GLITCH snap=${JSON.stringify(results.after.snap)}`);
    assert(results.after.canvasContexts.contextOptions.every(entry => entry.willReadFrequently === false),
      `visible contexts=${JSON.stringify(results.after.canvasContexts.contextOptions)}`);
    assert(results.after.canvasContexts.pipe.cpuFallback === false,
      `pipe fallback=${JSON.stringify(results.after.canvasContexts.pipe)}`);
    for (const name of ['sono', 'wmp', 'flow']) {
      assert(JSON.stringify(results.before.screenshots[name]) === JSON.stringify(results.after.screenshots[name]),
        `${name} screenshot A/B=${JSON.stringify({ before:results.before.screenshots[name], after:results.after.screenshots[name] })}`);
    }
    for (const name of ['sono']) {
      const before = results.before.loops[name].cpuMsPerDisplayFrame;
      const after = results.after.loops[name].cpuMsPerDisplayFrame;
      const reductionPct = (before - after) / before * 100;
      results.after.loops[name].reductionPct = +reductionPct.toFixed(2);
      assert(reductionPct >= 40,
        `${name} reduccion=${reductionPct.toFixed(2)}% before=${JSON.stringify(results.before.loops[name])} after=${JSON.stringify(results.after.loops[name])}`);
    }
    const flowBefore = results.before.loops.flow;
    const flowAfter = results.after.loops.flow;
    const baselineRenderCost = flowBefore.cpuMs / Math.max(1, flowBefore.renders);
    const flowCapOnlyMsPerDisplayFrame = baselineRenderCost *
      (flowAfter.renders / Math.max(1, flowAfter.callbacks));
    const flowCapOnlyReduction = (flowBefore.cpuMsPerDisplayFrame - flowCapOnlyMsPerDisplayFrame) /
      flowBefore.cpuMsPerDisplayFrame * 100;
    flowAfter.asyncWallReductionPct = +(
      (flowBefore.cpuMsPerDisplayFrame - flowAfter.cpuMsPerDisplayFrame) /
      flowBefore.cpuMsPerDisplayFrame * 100
    ).toFixed(2);
    flowAfter.capOnlyCpuMsPerDisplayFrame = +flowCapOnlyMsPerDisplayFrame.toFixed(4);
    flowAfter.reductionPct = +flowCapOnlyReduction.toFixed(2);
    assert(flowCapOnlyReduction >= 40,
      `flow cap-only reduccion=${flowCapOnlyReduction.toFixed(2)}% before=${JSON.stringify(flowBefore)} after=${JSON.stringify(flowAfter)}`);

    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);
    process.stdout.write(`${JSON.stringify({
      baseline:BASE_COMMIT,
      port:debugPort,
      ...results,
      runtimeExceptions:exceptions.length,
    }, null, 2)}\n`);
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

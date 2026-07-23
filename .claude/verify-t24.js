#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'index.html');
const HTTP_PORT = Number(process.env.T24_HTTP_PORT) || 8877;
const CDP_PORT = Number(process.env.T24_CDP_PORT) || 24588;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t24=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 12000, intervalMs = 25) {
  const started = Date.now();
  let last;
  while (Date.now() - started < limitMs) {
    last = await check();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout esperando ${label}; ultimo=${JSON.stringify(last)}`);
}

function serveDocs() {
  const mime = {
    '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
    '.png':'image/png', '.ttf':'font/ttf', '.otf':'font/otf',
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
  async close() {
    this.cdp.sessions.delete(this.sessionId);
    await this.cdp.send('Target.closeTarget', { targetId:this.targetId }).catch(() => {});
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
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  window.__t24 = {
    gumCalls:[], videoStreams:[], audioStreams:[], sourceContexts:[], logs:[],
    forcedHidden:false,
  };

  try {
    Object.defineProperty(document, 'hidden', {
      configurable:true,
      get:() => __t24.forcedHidden,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable:true,
      get:() => __t24.forcedHidden ? 'hidden' : 'visible',
    });
  } catch (_) {}

  const nativeLog = console.log.bind(console);
  console.log = (...args) => {
    __t24.logs.push(args.map(String).join(' '));
    nativeLog(...args);
  };

  const NativeAC = window.AudioContext || window.webkitAudioContext;
  if (NativeAC) {
    const TrackedAC = new Proxy(NativeAC, {
      construct(Target, args) {
        return Reflect.construct(Target, args, Target);
      },
    });
    window.AudioContext = TrackedAC;
    window.webkitAudioContext = TrackedAC;
  }

  __t24.makeVideoStream = constraints => {
    const source = document.createElement('canvas');
    source.width = 640;
    source.height = 480;
    const ctx = source.getContext('2d');
    let frame = 0;
    const paint = () => {
      frame++;
      ctx.fillStyle = frame % 2 ? '#ff5a1f' : '#1540ff';
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((frame * 11) % 520, 80, 120, 320);
      if (source.__running !== false) requestAnimationFrame(paint);
    };
    paint();
    const fps = constraints?.frameRate?.ideal || 30;
    const mediaStream = source.captureStream(fps);
    mediaStream.__source = source;
    mediaStream.getTracks().forEach(track => track.addEventListener('ended', () => {
      source.__running = false;
    }, { once:true }));
    __t24.videoStreams.push(mediaStream);
    return mediaStream;
  };

  __t24.makeAudioStream = async () => {
    const ctx = new NativeAC();
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.12;
    oscillator.connect(gain).connect(dest);
    oscillator.start();
    __t24.sourceContexts.push(ctx);
    __t24.audioStreams.push(dest.stream);
    return dest.stream;
  };

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [
    { kind:'audioinput', deviceId:'stub-mic', label:'STUB MIC' },
  ];
  mediaDevices.getUserMedia = async constraints => {
    const kind = constraints?.video ? 'video' : 'audio';
    __t24.gumCalls.push({
      kind,
      constraints:JSON.parse(JSON.stringify(constraints || {})),
      at:performance.now(),
    });
    return kind === 'video'
      ? __t24.makeVideoStream(constraints.video)
      : __t24.makeAudioStream();
  };
  Object.defineProperty(navigator, 'permissions', {
    configurable:true,
    value:{ query:async () => ({ state:'granted' }) },
  });
})()
`;

const RUNTIME = String.raw`
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label, limit = 4000) => {
    const started = performance.now();
    let last;
    while (performance.now() - started < limit) {
      last = check();
      if (last) return last;
      await wait(20);
    }
    throw new Error('timeout ' + label + ': ' + JSON.stringify(last));
  };
  const liveVideoTracks = mediaStream => (mediaStream?.getVideoTracks() || [])
    .filter(track => track.readyState === 'live');
  const liveAudioTracks = mediaStream => (mediaStream?.getAudioTracks() || [])
    .filter(track => track.readyState === 'live');
  const makeAuditWav = () => {
    const sampleRate = 8000;
    const samples = sampleRate;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
      view.setInt16(44 + i * 2, Math.sin(i * Math.PI * 2 * 220 / sampleRate) * 1800, true);
    }
    return new File([buffer], 'energy-audit.wav', { type:'audio/wav' });
  };
  const longRun = !!window.__T24_LONG;

  splash.classList.add('hidden');
  activeTab = 'cam';
  await startCamera(facingMode);
  const firstGlobalStream = stream;
  await until(() => liveVideoTracks(firstGlobalStream).length === 1, 'cam inicial');

  const permissionQuery = navigator.permissions.query;
  navigator.permissions.query = async () => ({ state:'denied' });
  switchTab('sono');
  await wait(0);
  navigator.permissions.query = permissionQuery;
  sonoAudioEl.loop = true;
  await sonoLoadFile(makeAuditWav());
  if (longRun) await wait(300000);
  const sonoFileAfterCam = {
    globalStreamNull:stream === null,
    liveGlobalVideo:liveVideoTracks(firstGlobalStream).length,
    filePlaying:sonoFileLoaded && !sonoAudioEl.paused,
    observedMs:longRun ? 300000 : 0,
  };

  const cameraReturnMs = {};
  const cameraReturnLoop = {};
  for (const tab of ['cam', 'ascii', 'scrash', 'fusion', 'edit']) {
    if (activeTab !== 'up') switchTab('up');
    if (tab === 'edit') editSource = { type:'cam' };
    const started = performance.now();
    switchTab(tab);
    const loopReady = () => ({
      cam:_camLoopAlive,
      ascii:_asciiLoopAlive,
      scrash:_scrashLoopAlive,
      fusion:_fusionLoopAlive,
      edit:_editLoopAlive,
    })[tab];
    await until(() => stream && liveVideoTracks(stream).length === 1 && loopReady(), 'retorno ' + tab);
    cameraReturnMs[tab] = +(performance.now() - started).toFixed(1);
    cameraReturnLoop[tab] = loopReady();
  }
  switchTab('up');

  const originalMobile = FLIP_IS_MOBILE;
  FLIP_IS_MOBILE = () => true;
  await startCamera(facingMode);
  const mobileCall = [...__t24.gumCalls].reverse().find(call => call.kind === 'video');
  const mobileConstraints = mobileCall.constraints.video;
  FLIP_IS_MOBILE = originalMobile;
  _stopGlobalCamera();

  switchTab('wmp');
  await until(() => wmpMicStream && liveAudioTracks(wmpMicStream).length === 1, 'WMP mic');
  const firstWmpTrack = wmpMicStream.getAudioTracks()[0];
  const firstWmpCtx = wmpAudioCtx;
  switchTab('cam');
  await until(() => firstWmpTrack.readyState === 'ended' && firstWmpCtx.state === 'closed', 'WMP teardown');
  const wmpExit = {
    liveMicTracks:firstWmpTrack.readyState === 'live' ? 1 : 0,
    contextState:firstWmpCtx.state,
  };
  switchTab('wmp');
  await until(() => wmpMicStream && liveAudioTracks(wmpMicStream).length === 1, 'WMP reentrada');
  const wmpReentry = {
    liveMicTracks:liveAudioTracks(wmpMicStream).length,
    contextState:wmpAudioCtx.state,
  };
  await wmpStopAudio();
  switchTab('up');

  await flipAudioEngine.destroy();
  flipAudioSettings.audioMode = 'lofi';
  flipAudioSettings.effects.lofi.enabled = true;
  await flipAudioEngine.primeFromGesture(flipAudioSettings);
  const firstEngineTrack = flipAudioEngine.micStream.getAudioTracks()[0];
  flipAudioEngine.stopAfterRecording();
  await until(() => firstEngineTrack.readyState === 'ended', 'engine post REC');
  if (longRun) await wait(30000);
  const engineAfterStop = {
    liveMicTracks:firstEngineTrack.readyState === 'live' ? 1 : 0,
    streamNull:flipAudioEngine.micStream === null,
    contextState:flipAudioEngine.ctx.state,
  };
  await flipAudioEngine.primeFromGesture(flipAudioSettings);
  const secondEngineTrack = flipAudioEngine.micStream.getAudioTracks()[0];
  const engineReentry = {
    newTrack:secondEngineTrack !== firstEngineTrack,
    liveMicTracks:secondEngineTrack.readyState === 'live' ? 1 : 0,
  };
  flipAudioEngine.stopAfterRecording();

  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const trackedIntervals = new Map();
  window.setInterval = (fn, ms, ...args) => {
    const id = nativeSetInterval(fn, ms, ...args);
    trackedIntervals.set(id, ms);
    return id;
  };
  window.clearInterval = id => {
    trackedIntervals.delete(id);
    return nativeClearInterval(id);
  };
  const meterCount = () => [...trackedIntervals.values()].filter(ms => ms === 150).length;

  const audioPanel = document.getElementById('audioIOPanel');
  audioPanel.classList.add('open');
  await startExtAudio();
  await wait(220);
  const meterOpen = meterCount();
  document.getElementById('btnAudioIO').click();
  await wait(50);
  const meterClosed = meterCount();
  const meterCloseState = {
    panelOpen:audioPanel.classList.contains('open'),
    micButtonVisible:_isMicLevelButtonVisible(),
    timerLive:!!_extLevelTimer,
  };
  const logMark = __t24.logs.length;
  await wait(longRun ? 60000 : 650);
  const logsWhileClosed = __t24.logs.length - logMark;
  await stopExtAudio();

  await startCamera(facingMode);
  await startMicOnly();
  scrAudioReactVal = 0;
  switchTab('scrash');
  await until(() => stream && liveVideoTracks(stream).length === 1 && vid.videoWidth > 0, 'GLITCH cam');
  const originalRead = FlipAudioReact.read.bind(FlipAudioReact);
  let snapshotReads = 0;
  FlipAudioReact.read = () => {
    snapshotReads++;
    return originalRead();
  };
  await wait(2000);
  const readsAtZero = snapshotReads;
  scrAudioReactVal = 100;
  snapshotReads = 0;
  await wait(500);
  const readsAtHundred = snapshotReads;
  scrashRunning = false;
  await wait(80);
  snapshotReads = 0;
  await new Promise(resolve => {
    let completed = 0;
    const sample = ts => {
      _readFlipAudioSnapshot(true, ts);
      if (++completed === 2) resolve();
    };
    requestAnimationFrame(sample);
    requestAnimationFrame(sample);
  });
  const readsTwoLoopsOneFrame = snapshotReads;
  FlipAudioReact.read = originalRead;
  await stopMicOnly();
  switchTab('up');

  await startCamera(facingMode);
  await startMicOnly();
  const visibilityTrack = stream.getVideoTracks()[0];
  const visibilityCtx = extAudioCtx;
  const sonoFileCtx = new (window.AudioContext || window.webkitAudioContext)();
  const wmpFileCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sonoFileCtx.state === 'suspended') await sonoFileCtx.resume();
  if (wmpFileCtx.state === 'suspended') await wmpFileCtx.resume();
  sonoAudioCtx = sonoFileCtx;
  wmpAudioCtx = wmpFileCtx;
  sonoFileLoaded = true;
  sonoAudioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';
  wmpAudioEl.src = sonoAudioEl.src;
  Object.defineProperty(sonoAudioEl, 'paused', { configurable:true, value:false });
  Object.defineProperty(wmpAudioEl, 'paused', { configurable:true, value:false });
  __t24.forcedHidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await until(() => !visibilityTrack.enabled && visibilityCtx.state === 'suspended', 'ocultar');
  if (longRun) await wait(60000);
  const hiddenState = {
    cameraEnabled:visibilityTrack.enabled,
    audioContext:visibilityCtx.state,
    sonoFileContext:sonoFileCtx.state,
    wmpFileContext:wmpFileCtx.state,
    meterTimers:meterCount(),
  };
  __t24.forcedHidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await until(() => visibilityTrack.enabled && visibilityCtx.state === 'running', 'volver visible');
  const visibleState = {
    cameraEnabled:visibilityTrack.enabled,
    audioContext:visibilityCtx.state,
  };

  audioPanel.classList.add('open');
  _syncAudioLevelMeter();
  const recCanvas = document.createElement('canvas');
  recCanvas.width = 64;
  recCanvas.height = 48;
  const recStream = recCanvas.captureStream(10);
  const visibilityRecorder = _trackFlipRecorder(new MediaRecorder(recStream));
  visibilityRecorder.start();
  await until(() => visibilityRecorder.state === 'recording', 'REC visibility');
  const timerBeforeRecHide = meterCount();
  __t24.forcedHidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(250);
  const recordingHiddenState = {
    recorderState:visibilityRecorder.state,
    cameraEnabled:visibilityTrack.enabled,
    audioContext:visibilityCtx.state,
    meterTimersBefore:timerBeforeRecHide,
    meterTimersAfter:meterCount(),
  };
  const recorderStopped = new Promise(resolve => visibilityRecorder.addEventListener('stop', resolve, { once:true }));
  visibilityRecorder.stop();
  await recorderStopped;
  recStream.getTracks().forEach(track => track.stop());
  __t24.forcedHidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  audioPanel.classList.remove('open');
  _syncAudioLevelMeter();

  await stopMicOnly();
  _stopGlobalCamera();
  await sonoFileCtx.close().catch(() => {});
  await wmpFileCtx.close().catch(() => {});
  sonoAudioCtx = null;
  wmpAudioCtx = null;
  await flipAudioEngine.destroy();
  for (const ctx of __t24.sourceContexts) {
    if (ctx.state !== 'closed') await ctx.close().catch(() => {});
  }

  return {
    longRun,
    camera:{ sonoFileAfterCam, returnMs:cameraReturnMs, loopAlive:cameraReturnLoop, mobileConstraints },
    wmp:{ exit:wmpExit, reentry:wmpReentry },
    engine:{ afterStop:engineAfterStop, reentry:engineReentry },
    meters:{ open:meterOpen, closed:meterClosed, logsWhileClosed, closeState:meterCloseState },
    snapshot:{ readsAtZero, readsAtHundred, readsTwoLoopsOneFrame },
    visibility:{ hidden:hiddenState, visible:visibleState, recordingHidden:recordingHiddenState },
  };
})()
`;

async function main() {
  assert(HTTP_PORT !== 8742, 'T24 no debe usar el puerto 8742');
  const html = fs.readFileSync(INDEX, 'utf8');
  const marker = '<script>';
  const scriptStart = html.indexOf(marker);
  const scriptEnd = html.lastIndexOf('</script>');
  assert(scriptStart >= 0 && scriptEnd > scriptStart, 'script inline no encontrado');
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t24-check-'));
  const extracted = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extracted, html.slice(scriptStart + marker.length, scriptEnd));
  const syntax = spawnSync(process.execPath, ['--check', extracted], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const server = await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t24-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  let resolveChromeExit;
  const chromeExitPromise = new Promise(resolve => { resolveChromeExit = resolve; });
  chrome.once('exit', (code, signal) => {
    chromeExit = { code, signal };
    resolveChromeExit(chromeExit);
  });
  let browser;
  let page;
  try {
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
    page = await browser.createSession();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width:1280,
      height:900,
      deviceScaleFactor:1,
      mobile:false,
    });
    await page.send('Network.setCacheDisabled', { cacheDisabled:true });
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga T24');
    await waitFor(() => evaluate(page, 'typeof switchTab === "function" && typeof startMicOnly === "function"'), 'runtime T24');
    await evaluate(page, `window.__T24_LONG = ${process.env.T24_LONG === '1'}`);
    const result = await evaluate(page, RUNTIME);
    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');

    assert(result.camera.sonoFileAfterCam.globalStreamNull &&
      result.camera.sonoFileAfterCam.liveGlobalVideo === 0 &&
      result.camera.sonoFileAfterCam.filePlaying,
      `cam viva en SONO archivo=${JSON.stringify(result.camera.sonoFileAfterCam)}`);
    assert(Object.values(result.camera.returnMs).every(ms => ms < 1500),
      `retorno de camara lento=${JSON.stringify(result.camera.returnMs)}`);
    assert(Object.values(result.camera.loopAlive).every(Boolean),
      `loops de camara sin volver=${JSON.stringify(result.camera.loopAlive)}`);
    const mobile = result.camera.mobileConstraints;
    assert(mobile.width?.ideal === 640 && mobile.height?.ideal === 480 &&
      mobile.frameRate?.ideal === 24 && mobile.frameRate?.max === 30,
    `constraints movil=${JSON.stringify(mobile)}`);
    assert(result.wmp.exit.liveMicTracks === 0 && result.wmp.exit.contextState === 'closed',
      `WMP no murio=${JSON.stringify(result.wmp.exit)}`);
    assert(result.wmp.reentry.liveMicTracks === 1 && result.wmp.reentry.contextState === 'running',
      `WMP no volvio=${JSON.stringify(result.wmp.reentry)}`);
    assert(result.engine.afterStop.liveMicTracks === 0 && result.engine.afterStop.streamNull &&
      result.engine.afterStop.contextState === 'suspended',
    `engine post REC=${JSON.stringify(result.engine.afterStop)}`);
    assert(result.engine.reentry.newTrack && result.engine.reentry.liveMicTracks === 1,
      `engine no readquirio=${JSON.stringify(result.engine.reentry)}`);
    assert(result.meters.open === 1 && result.meters.closed === 0 && result.meters.logsWhileClosed === 0,
      `meters=${JSON.stringify(result.meters)}`);
    assert(result.snapshot.readsAtZero === 0 && result.snapshot.readsAtHundred > 0 &&
      result.snapshot.readsTwoLoopsOneFrame === 1,
    `snapshot=${JSON.stringify(result.snapshot)}`);
    assert(!result.visibility.hidden.cameraEnabled && result.visibility.hidden.audioContext === 'suspended' &&
      result.visibility.hidden.sonoFileContext === 'running' &&
      result.visibility.hidden.wmpFileContext === 'running' &&
      result.visibility.hidden.meterTimers === 0,
    `hidden=${JSON.stringify(result.visibility.hidden)}`);
    assert(result.visibility.visible.cameraEnabled && result.visibility.visible.audioContext === 'running',
      `visible=${JSON.stringify(result.visibility.visible)}`);
    const recHidden = result.visibility.recordingHidden;
    assert(recHidden.recorderState === 'recording' && recHidden.cameraEnabled &&
      recHidden.audioContext === 'running',
    `hidden con REC=${JSON.stringify(recHidden)}`);
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);

    console.log(JSON.stringify({
      static:{ syntax:true, port:HTTP_PORT },
      ...result,
      runtimeExceptions:exceptions.length,
    }, null, 2));
  } finally {
    await page?.close();
    browser?.close();
    if (!chromeExit) {
      chrome.kill('SIGTERM');
      await Promise.race([chromeExitPromise, sleep(3000)]);
    }
    if (!chromeExit) {
      chrome.kill('SIGKILL');
      await Promise.race([chromeExitPromise, sleep(3000)]);
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profileDir, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
    fs.rmSync(checkDir, { recursive:true, force:true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

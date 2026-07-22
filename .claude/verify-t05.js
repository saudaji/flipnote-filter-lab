#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.T05_BASE_URL || `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?beta=1`;
const BASELINE_ONLY = process.env.T05_BASELINE_ONLY === '1';
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

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
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
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  window.__t05 = {
    rafTicks:{},
    gumCalls:[],
    videoMode:'immediate',
    pendingVideo:[],
    tracks:[],
    saved:[],
  };
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    const name = cb.name || 'anonymous';
    __t05.rafTicks[name] = (__t05.rafTicks[name] || 0) + 1;
    cb(performance.now());
  }, 50);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]].forEach(([frequency,lfoFrequency], index) => {
        const osc = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.025 + index * 0.004;
        lfo.frequency.value = lfoFrequency;
        lfoGain.gain.value = 0.012;
        lfo.connect(lfoGain); lfoGain.connect(gain.gain);
        osc.connect(gain); gain.connect(bus);
        osc.start(); lfo.start();
      });
      return bus;
    };
  }

  __t05.makeVideoStream = () => {
    const source = document.createElement('canvas');
    source.width = 96; source.height = 72;
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
    const mediaStream = source.captureStream(30);
    mediaStream.getTracks().forEach(track => {
      __t05.tracks.push(track);
      track.addEventListener('ended', () => { source.__running = false; }, { once:true });
    });
    return mediaStream;
  };
  __t05.liveTracks = () => __t05.tracks.filter(track => track.readyState === 'live').length;
  __t05.stopAllTracks = () => __t05.tracks.forEach(track => track.stop());
  __t05.resolvePendingVideo = () => {
    const pending = __t05.pendingVideo.splice(0);
    pending.forEach(entry => entry.resolve(__t05.makeVideoStream()));
    return pending.length;
  };

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'stub-mic', label:'STUB MIC' }];
  mediaDevices.getUserMedia = constraints => {
    const isVideo = !!constraints?.video;
    __t05.gumCalls.push(isVideo ? 'video' : 'audio');
    if (isVideo && __t05.videoMode === 'deferred') {
      return new Promise((resolve, reject) => __t05.pendingVideo.push({ resolve, reject }));
    }
    if (isVideo) return Promise.resolve(__t05.makeVideoStream());
    const audioCtx = new AC();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440; osc.connect(dest); osc.start();
    dest.stream.getTracks().forEach(track => __t05.tracks.push(track));
    return Promise.resolve(dest.stream);
  };
})();
`;

const RUNTIME_MEASURE = String.raw`
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const countTicks = name => __t05.rafTicks[name] || 0;
  const dispatchSfMetadata = () => {
    const video = document.getElementById('sflowVid');
    for (const delay of [0, 20, 80]) setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), delay);
  };
  const stopTracked = () => {
    __t05.stopAllTracks();
    __t05.tracks = [];
  };

  const splashDisplay = getComputedStyle(splash).display;
  document.getElementById('flipOsBoot')?.click();
  await sleep(50);
  splash.classList.add('hidden');

  // GLITCH: one chain before and after five clicks on the already-active tab.
  stream = __t05.makeVideoStream();
  switchTab('scrash');
  await sleep(150);
  let mark = countTicks('_scrashLoop');
  await sleep(2000);
  const glitchTicksBefore = countTicks('_scrashLoop') - mark;
  const wrapperCalls = { relayout:0, renderFlipNav:0, updateExportBar:0 };
  const originalRelayout = relayout;
  const originalRenderFlipNav = renderFlipNav;
  const originalUpdateExportBar = _updateExportBar;
  relayout = (...args) => { wrapperCalls.relayout++; return originalRelayout(...args); };
  renderFlipNav = (...args) => { wrapperCalls.renderFlipNav++; return originalRenderFlipNav(...args); };
  _updateExportBar = (...args) => { wrapperCalls.updateExportBar++; return originalUpdateExportBar(...args); };
  for (let i = 0; i < 5; i++) document.getElementById('tabScrash').click();
  relayout = originalRelayout;
  renderFlipNav = originalRenderFlipNav;
  _updateExportBar = originalUpdateExportBar;
  mark = countTicks('_scrashLoop');
  await sleep(2000);
  const glitchTicksAfter = countTicks('_scrashLoop') - mark;
  const glitchRatio = glitchTicksAfter / Math.max(1, glitchTicksBefore);
  switchTab('up');
  stream?.getTracks().forEach(track => track.stop()); stream = null; vid.srcObject = null;
  stopTracked();

  // EXT AUDIO on CAM must keep the existing camera rAF chain singular.
  stream = __t05.makeVideoStream();
  switchTab('cam');
  await sleep(150);
  mark = countTicks('cameraLoop');
  await sleep(1000);
  const extCamTicksBefore = countTicks('cameraLoop') - mark;
  await startExtAudio();
  mark = countTicks('cameraLoop');
  await sleep(1000);
  const extCamTicksAfter = countTicks('cameraLoop') - mark;
  const extCamRatio = extCamTicksAfter / Math.max(1, extCamTicksBefore);
  switchTab('up');
  await stopExtAudio();
  stream?.getTracks().forEach(track => track.stop()); stream = null; vid.srcObject = null;
  stopTracked();

  // Splash grant after leaving CAM may keep the camera ready, but never restart CAM's loop.
  stream = __t05.makeVideoStream();
  switchTab('cam');
  await sleep(100);
  stream.getTracks().forEach(track => track.stop()); stream = null; vid.srcObject = null;
  cameraRunning = false;
  await sleep(100);
  __t05.videoMode = 'deferred';
  _waitForVideoReady = async () => {};
  vid.play = async () => {};
  const bootPendingBefore = __t05.pendingVideo.length;
  const bootPromise = _bootFromSplash();
  await sleep(50);
  const bootPendingRequests = __t05.pendingVideo.length - bootPendingBefore;
  switchTab('up');
  __t05.resolvePendingVideo();
  await bootPromise;
  mark = countTicks('cameraLoop');
  await sleep(500);
  const bootTicksAfterGrant = countTicks('cameraLoop') - mark;
  const bootReadyTracks = stream?.getTracks().filter(track => track.readyState === 'live').length || 0;
  const bootCameraRunning = cameraRunning;
  stream?.getTracks().forEach(track => track.stop()); stream = null; vid.srcObject = null;
  stopTracked();

  // FLOW: leave while gUM is pending, then grant. No acquired track may survive.
  __t05.videoMode = 'deferred';
  const exitGumStart = __t05.gumCalls.length;
  switchTab('sflow');
  document.getElementById('btnSflowCam').click();
  await sleep(50);
  const flowExitPending = __t05.pendingVideo.length;
  switchTab('up');
  const flowExitResolved = __t05.resolvePendingVideo();
  dispatchSfMetadata();
  await sleep(350);
  const flowExitLiveTracks = __t05.liveTracks();
  const flowExitGumCalls = __t05.gumCalls.slice(exitGumStart).filter(kind => kind === 'video').length;
  window._sflowStop(); stopTracked();

  // FLOW: double click while starting must issue a single gUM request.
  __t05.videoMode = 'deferred';
  const doubleGumStart = __t05.gumCalls.length;
  switchTab('sflow');
  document.getElementById('btnSflowCam').click();
  document.getElementById('btnSflowCam').click();
  await sleep(50);
  const flowDoublePending = __t05.pendingVideo.length;
  const flowDoubleGumCalls = __t05.gumCalls.slice(doubleGumStart).filter(kind => kind === 'video').length;
  switchTab('up');
  __t05.resolvePendingVideo(); dispatchSfMetadata();
  await sleep(200);
  window._sflowStop(); stopTracked();

  // FLOW: segmenter failure must release the stream acquired by this start.
  __t05.videoMode = 'immediate';
  document.getElementById('sflowVid').play = async () => {};
  switchTab('sflow');
  document.getElementById('btnSflowCam').click();
  const sfVideo = document.getElementById('sflowVid');
  const metadataTimer = setInterval(() => sfVideo.dispatchEvent(new Event('loadedmetadata')), 25);
  let segmenterFailed = false;
  for (let i = 0; i < 160; i++) {
    if (document.getElementById('sflowStatusBadge')?.textContent.includes('AI unavailable')) {
      segmenterFailed = true;
      break;
    }
    await sleep(25);
  }
  clearInterval(metadataTimer);
  const flowSegmenterFailState = {
    reachedFailure:segmenterFailed,
    badge:document.getElementById('sflowStatusBadge')?.textContent || '',
  };
  const flowSegmenterFailLiveTracks = __t05.liveTracks();
  switchTab('up'); stopTracked();

  async function recordAndLeave(kind) {
    __t05.saved = [];
    saveBlob = async (blob, filename) => {
      __t05.saved.push({ blob, filename, savedAt:performance.now() });
    };
    stream = __t05.makeVideoStream();
    if (kind === 'cam') {
      switchTab('cam');
      camMode = 'video';
      document.getElementById('btnCapture').click();
      await waitRecorder(() => recorder);
    } else {
      switchTab('ascii');
      asciiCamMode = 'video';
      document.getElementById('btnAsciiCapture').click();
      await waitRecorder(() => asciiRecorder);
    }
    const rec = kind === 'cam' ? recorder : asciiRecorder;
    const startedAt = performance.now();
    let stoppedAt = null;
    rec.addEventListener('stop', () => { stoppedAt = performance.now(); }, { once:true });
    await sleep(1200);
    const changedAt = performance.now();
    switchTab('up');
    await sleep(350);
    const stateAfterChange = rec.state;
    let forcedStop = false;
    if (rec.state !== 'inactive') { forcedStop = true; _stopRecorderSafely(rec); }
    for (let i = 0; i < 80 && !__t05.saved.length; i++) await sleep(25);
    const saved = __t05.saved[0];
    const result = {
      stateAfterChange,
      forcedStop,
      stopEventLatencyMs:stoppedAt == null ? null : Math.round(stoppedAt - changedAt),
      recordedDurationMs:stoppedAt == null ? null : Math.round(stoppedAt - startedAt),
      stopLatencyMs:saved ? Math.round(saved.savedAt - changedAt) : null,
      savedDurationMs:saved ? Math.round(saved.savedAt - startedAt) : null,
      blobBytes:saved ? saved.blob.size : 0,
    };
    stream?.getTracks().forEach(track => track.stop()); stream = null; vid.srcObject = null;
    stopTracked();
    return result;
  }
  async function waitRecorder(getRecorder) {
    for (let i = 0; i < 120; i++) {
      const current = getRecorder();
      if (current?.state === 'recording') return current;
      await sleep(25);
    }
    throw new Error('recorder no inicio');
  }
  const camRecording = await recordAndLeave('cam');
  const asciiRecording = await recordAndLeave('ascii');

  // FLIP OS close must route through tab teardown, stopping the open module loop.
  _flipOsShowDesktop();
  _flipOsOpenModule('scrash');
  await sleep(150);
  mark = countTicks('_scrashLoop');
  await sleep(500);
  const osTicksOpen = countTicks('_scrashLoop') - mark;
  _flipOsCloseModule();
  await sleep(200);
  mark = countTicks('_scrashLoop');
  await sleep(500);
  const osTicksClosed = countTicks('_scrashLoop') - mark;

  return {
    splashDisplay,
    glitch:{ ticksBefore:glitchTicksBefore, ticksAfter:glitchTicksAfter, ratio:+glitchRatio.toFixed(3), wrapperCalls },
    extAudioCam:{ ticksBefore:extCamTicksBefore, ticksAfter:extCamTicksAfter, ratio:+extCamRatio.toFixed(3) },
    splashGrant:{ pendingRequests:bootPendingRequests, readyTracks:bootReadyTracks, cameraRunning:bootCameraRunning, ticksAfterGrant:bootTicksAfterGrant },
    flowExit:{ pending:flowExitPending, resolved:flowExitResolved, gumCalls:flowExitGumCalls, liveTracks:flowExitLiveTracks },
    flowDouble:{ pending:flowDoublePending, gumCalls:flowDoubleGumCalls },
    flowSegmenterFail:{ ...flowSegmenterFailState, liveTracks:flowSegmenterFailLiveTracks },
    recording:{ cam:camRecording, ascii:asciiRecording },
    flipOs:{ ticksOpen:osTicksOpen, ticksClosed:osTicksClosed, activeTab },
  };
})()
`;

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t05-check-'));
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t05-chrome-'));
  const debugPort = Number(process.env.T05_CDP_PORT) || 24575;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:'ignore', detached:true });
  chrome.unref();
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
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled:true });
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga del LAB');
    await waitFor(() => evaluate(page, 'typeof switchTab === "function" && typeof _flipOsCloseModule === "function"'), 'runtime FLIP');
    const started = Date.now();
    const runtime = await evaluate(page, RUNTIME_MEASURE);
    const runtimeMs = Date.now() - started;
    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown'
    );

    if (!BASELINE_ONLY) {
      assert(runtime.glitch.ratio >= 0.75 && runtime.glitch.ratio <= 1.25,
        `GLITCH multiplico ticks: ${runtime.glitch.ticksBefore}->${runtime.glitch.ticksAfter} ratio=${runtime.glitch.ratio}`);
      assert(Object.values(runtime.glitch.wrapperCalls).every(count => count === 5),
        `wrapper no corrio por click activo: ${JSON.stringify(runtime.glitch.wrapperCalls)}`);
      assert(runtime.extAudioCam.ratio >= 0.75 && runtime.extAudioCam.ratio <= 1.25,
        `EXT AUDIO multiplico CAM: ${JSON.stringify(runtime.extAudioCam)}`);
      assert(runtime.splashGrant.pendingRequests === 1 && runtime.splashGrant.readyTracks === 1 &&
        !runtime.splashGrant.cameraRunning && runtime.splashGrant.ticksAfterGrant === 0,
        `splash reanimo CAM fuera del tab: ${JSON.stringify(runtime.splashGrant)}`);
      assert(runtime.flowExit.pending === 1 && runtime.flowExit.liveTracks === 0,
        `FLOW salir durante prompt: pending=${runtime.flowExit.pending} tracks=${runtime.flowExit.liveTracks}`);
      assert(runtime.flowDouble.gumCalls === 1 && runtime.flowDouble.pending === 1,
        `FLOW doble click: gUM=${runtime.flowDouble.gumCalls} pending=${runtime.flowDouble.pending}`);
      assert(runtime.flowSegmenterFail.reachedFailure && runtime.flowSegmenterFail.liveTracks === 0,
        `FLOW fallo segmenter: ${JSON.stringify(runtime.flowSegmenterFail)}`);
      for (const [name, result] of Object.entries(runtime.recording)) {
        assert(result.stateAfterChange === 'inactive' && !result.forcedStop,
          `${name} REC siguio activo al cambiar tab: ${JSON.stringify(result)}`);
        assert(result.stopLatencyMs >= 0 && result.stopLatencyMs < 1000,
          `${name} REC latencia de cierre=${result.stopLatencyMs}ms`);
        assert(result.stopEventLatencyMs >= 0 && result.stopEventLatencyMs < 500,
          `${name} REC evento stop=${result.stopEventLatencyMs}ms`);
        assert(result.recordedDurationMs >= 1000 && result.recordedDurationMs < 2600,
          `${name} REC duracion de contenido=${result.recordedDurationMs}ms`);
        assert(result.savedDurationMs >= 1000 && result.savedDurationMs < 3000,
          `${name} REC duracion guardada=${result.savedDurationMs}ms`);
        assert(result.blobBytes > 0, `${name} REC blob vacio`);
      }
      assert(runtime.flipOs.ticksOpen >= 5 && runtime.flipOs.ticksClosed <= 1 && runtime.flipOs.activeTab === 'up',
        `FLIP OS teardown invalido: ${JSON.stringify(runtime.flipOs)}`);
      assert(runtime.splashDisplay === 'none', `splash visible en FLIP OS: ${runtime.splashDisplay}`);
      assert(runtimeExceptions.length === 0, `excepciones runtime=${runtimeExceptions.length}`);
    }

    process.stdout.write(`${JSON.stringify({
      static:{
        nodeCheckExit:syntax.status,
        inlineScripts:scripts.length,
        htmlIds:ids.length,
        dynamicIds:dynamicIds.length,
        getElementByIdRefs:refs.length,
        duplicateIds:duplicateIds.length,
        missingIds:missingIds.length,
      },
      ...runtime,
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

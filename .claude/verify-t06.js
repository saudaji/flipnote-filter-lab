#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.T06_BASE_URL || 'http://127.0.0.1:8742/?t06=1';
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
  window.__t06 = {
    gumCalls:[], audioStreams:[], videoStreams:[], contexts:[], sourceBanks:[], toasts:[],
    audioDelay:0, audioFailures:0, audioInFlight:0, maxAudioInFlight:0,
    killVideoOnAudio:false,
  };
  window.requestAnimationFrame = cb => realSetTimeout(() => cb(performance.now()), 50);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const NativeAC = window.AudioContext || window.webkitAudioContext;
  if (NativeAC) {
    const nativeCreateMediaStreamSource = NativeAC.prototype.createMediaStreamSource;
    NativeAC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      const nodes = [];
      [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]].forEach(([frequency,lfoFrequency], index) => {
        const osc = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.035 + index * 0.006;
        lfo.frequency.value = lfoFrequency;
        lfoGain.gain.value = 0.012;
        lfo.connect(lfoGain); lfoGain.connect(gain.gain);
        osc.connect(gain); gain.connect(bus);
        osc.start(); lfo.start();
        nodes.push(osc, gain, lfo, lfoGain);
      });
      __t06.sourceBanks.push({ ctx:this, nodes, nativeCreateMediaStreamSource });
      return bus;
    };
    const TrackedAC = new Proxy(NativeAC, {
      construct(Target, args) {
        const ctx = Reflect.construct(Target, args, Target);
        __t06.contexts.push({ ctx, requestedSampleRate:args[0]?.sampleRate || null });
        return ctx;
      },
    });
    window.AudioContext = TrackedAC;
    window.webkitAudioContext = TrackedAC;
  }

  __t06.makeVideoStream = () => {
    const source = document.createElement('canvas');
    source.width = 160; source.height = 120;
    const ctx = source.getContext('2d');
    let frame = 0;
    const paint = () => {
      frame++;
      ctx.fillStyle = frame % 2 ? '#ff3b00' : '#006bff';
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((frame * 9) % 120, 20, 32, 80);
      if (source.__running !== false) requestAnimationFrame(paint);
    };
    paint();
    const mediaStream = source.captureStream(30);
    mediaStream.__source = source;
    mediaStream.getTracks().forEach(track => track.addEventListener('ended', () => {
      source.__running = false;
    }, { once:true }));
    __t06.videoStreams.push(mediaStream);
    return mediaStream;
  };
  __t06.liveAudioTracks = () => __t06.audioStreams.flatMap(s => s.getAudioTracks())
    .filter(t => t.readyState === 'live').length;
  __t06.liveVideoTracks = () => __t06.videoStreams.flatMap(s => s.getVideoTracks())
    .filter(t => t.readyState === 'live').length;

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'stub-mic', label:'STUB MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    const isVideo = !!constraints?.video;
    __t06.gumCalls.push({ kind:isVideo ? 'video' : 'audio', at:performance.now() });
    if (isVideo) return __t06.makeVideoStream();

    __t06.audioInFlight++;
    __t06.maxAudioInFlight = Math.max(__t06.maxAudioInFlight, __t06.audioInFlight);
    try {
      await new Promise(resolve => realSetTimeout(resolve, __t06.audioDelay));
      if (__t06.audioFailures > 0) {
        __t06.audioFailures--;
        throw new DOMException('Mic ocupado por arnes', 'NotReadableError');
      }
      if (__t06.killVideoOnAudio) {
        __t06.videoStreams.forEach(s => s.getVideoTracks().filter(t => t.readyState === 'live').forEach(t => t.stop()));
      }
      const ctx = new window.AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.15;
      osc.connect(gain); gain.connect(dest); osc.start();
      __t06.audioStreams.push(dest.stream);
      return dest.stream;
    } finally {
      __t06.audioInFlight--;
    }
  };
})();
`;

const RUNTIME_MEASURE = String.raw`
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const countGum = kind => __t06.gumCalls.filter(call => call.kind === kind).length;
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const realToast = flipToast;
  flipToast = (message, ...args) => {
    __t06.toasts.push({ message:String(message), at:performance.now() });
    return realToast(message, ...args);
  };
  activeTab = 'up';
  splash.classList.add('hidden');

  async function recordBlob(label) {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    let frame = 0, running = true;
    const paint = () => {
      frame++;
      ctx.fillStyle = frame % 2 ? '#24134f' : '#ef6a32';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((frame * 5) % 130, 25, 30, 70);
      if (running) requestAnimationFrame(paint);
    };
    paint();
    const job = await _createFlipRecordingJob(canvas, 20, 1000000, { resolution:'low' });
    const chunks = [];
    job.recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    const stopped = new Promise(resolve => job.recorder.addEventListener('stop', resolve, { once:true }));
    const tracksAtStart = {
      video:job.recorder.stream.getVideoTracks().length,
      audio:job.recorder.stream.getAudioTracks().length,
    };
    job.recorder.start(100);
    await sleep(1100);
    job.recorder.stop();
    await stopped;
    running = false;
    job.cleanup();
    const blob = new Blob(chunks, { type:job.mime || chunks[0]?.type || 'video/webm' });
    return { label, bytes:blob.size, mime:blob.type, tracksAtStart, dataUrl:await blobToDataUrl(blob) };
  }

  await stopMicOnly();
  await flipAudioEngine.destroy();
  __t06.audioDelay = 20;
  await startMicOnly();
  const externalCtx = extAudioCtx;
  flipAudioSettings.resolution = 'low';
  flipAudioSettings.audioMode = 'lofi';
  flipAudioSettings.effects.lofi.enabled = true;
  const firstRecording = await recordBlob('antes-apagar-mic-externo');
  const engineCtx = flipAudioEngine.ctx;
  const engineContext = {
    distinctFromExternal:engineCtx !== externalCtx,
    requestedSampleRate:__t06.contexts.find(entry => entry.ctx === engineCtx)?.requestedSampleRate || null,
    actualSampleRate:engineCtx?.sampleRate || null,
  };
  await stopMicOnly();
  const externalAfterStop = {
    ctxNull:extAudioCtx === null,
    streamNull:extMicStream === null,
    liveInputTracks:__t06.liveAudioTracks(),
    engineContextState:flipAudioEngine.ctx?.state || null,
  };
  const secondRecording = await recordBlob('despues-apagar-mic-externo');
  const p0 = { firstRecording, secondRecording, engineContext, externalAfterStop };
  await flipAudioEngine.destroy();

  __t06.audioDelay = 80;
  __t06.maxAudioInFlight = 0;
  const doubleTapTrackCounts = [];
  const doubleTapGumBefore = countGum('audio');
  for (let round = 0; round < 10; round++) {
    await Promise.all([startMicOnly(), startMicOnly()]);
    doubleTapTrackCounts.push(__t06.liveAudioTracks());
  }
  const doubleTap = {
    rounds:doubleTapTrackCounts.length,
    livePerRound:doubleTapTrackCounts,
    gumCalls:countGum('audio') - doubleTapGumBefore,
    maxConcurrentGum:__t06.maxAudioInFlight,
    liveBeforeOff:__t06.liveAudioTracks(),
  };
  await stopMicOnly();
  doubleTap.liveAfterOff = __t06.liveAudioTracks();

  __t06.maxAudioInFlight = 0;
  const extRaceGumBefore = countGum('audio');
  await Promise.all([startExtAudio(), stopExtAudio(), startExtAudio()]);
  const extRace = {
    gumCalls:countGum('audio') - extRaceGumBefore,
    maxConcurrentGum:__t06.maxAudioInFlight,
    extMode:extAudioMode,
    micMode:extMicOnlyMode,
    liveBeforeOff:__t06.liveAudioTracks(),
  };
  await stopExtAudio();
  extRace.liveAfterOff = __t06.liveAudioTracks();

  __t06.audioDelay = 120;
  await startMicOnly();
  const muteTrack = extMicStream.getAudioTracks()[0];
  const muteStopAt = performance.now();
  muteTrack.dispatchEvent(new Event('mute'));
  await stopMicOnly();
  const remainingWait = Math.max(0, 2000 - (performance.now() - muteStopAt));
  await sleep(remainingWait);
  const muteImmediateOff = {
    elapsedMs:Math.round(performance.now() - muteStopAt),
    liveTracks:__t06.liveAudioTracks(),
    streamNull:extMicStream === null,
    ctxNull:extAudioCtx === null,
    mode:extMicOnlyMode,
  };

  __t06.audioDelay = 10;
  await startMicOnly();
  __t06.audioFailures = 10;
  const watchdogGumBefore = countGum('audio');
  const watchdogToastBefore = __t06.toasts.length;
  const watchdogStartedAt = performance.now();
  extMicStream.getAudioTracks()[0].dispatchEvent(new Event('mute'));
  await _extChainOp;
  const watchdogBackoff = {
    rebuildAttempts:_micRebuildHistory.length,
    gumCalls:countGum('audio') - watchdogGumBefore,
    elapsedMs:Math.round(performance.now() - watchdogStartedAt),
    liveTracks:__t06.liveAudioTracks(),
    mode:extMicOnlyMode,
    exhaustedToasts:__t06.toasts.slice(watchdogToastBefore)
      .filter(entry => entry.message.includes('3 reintentos')).length,
  };
  __t06.audioFailures = 0;

  __t06.killVideoOnAudio = false;
  await startCamera(facingMode);
  await startMicOnly();
  __t06.killVideoOnAudio = true;
  const watchdogCamGumBefore = countGum('video');
  extMicStream.getAudioTracks()[0].dispatchEvent(new Event('mute'));
  await _extChainOp;
  const watchdogCamera = {
    videoGum:countGum('video') - watchdogCamGumBefore,
    liveCurrentVideo:stream?.getVideoTracks().filter(t => t.readyState === 'live').length || 0,
    liveAudio:extMicStream?.getAudioTracks().filter(t => t.readyState === 'live').length || 0,
  };
  await stopMicOnly();
  stream?.getTracks().forEach(t => t.stop()); stream = null; vid.srcObject = null;

  __t06.killVideoOnAudio = false;
  await startCamera(facingMode);
  __t06.killVideoOnAudio = true;
  flipAudioSettings.audioMode = 'on';
  flipAudioSettings.effects.lofi.enabled = false;
  await flipAudioEngine.destroy();
  const recordingCamGumBefore = countGum('video');
  const recordingReady = await flipAudioEngine.prepareForRecording(flipAudioSettings);
  const recordingCamera = {
    ready:recordingReady,
    videoGum:countGum('video') - recordingCamGumBefore,
    liveCurrentVideo:stream?.getVideoTracks().filter(t => t.readyState === 'live').length || 0,
  };
  await flipAudioEngine.destroy();
  stream?.getTracks().forEach(t => t.stop()); stream = null; vid.srcObject = null;
  __t06.killVideoOnAudio = false;

  flipAudioSettings.audioMode = 'lofi';
  flipAudioSettings.effects.lofi.enabled = true;
  await flipAudioEngine.primeFromGesture(flipAudioSettings);
  const closedCtx = flipAudioEngine.ctx;
  await closedCtx.close();
  await sleep(100);
  const closedContextReset = {
    ctxNull:flipAudioEngine.ctx === null,
    initialized:flipAudioEngine.isInitialized,
    effects:Object.keys(flipAudioEngine.effects).length,
    recordingDestNull:flipAudioEngine.recordingDest === null,
    micStreamNull:flipAudioEngine.micStream === null,
  };

  flipAudioSettings.audioMode = 'on';
  await flipAudioEngine.primeFromGesture(flipAudioSettings);
  const audioOffLiveBefore = flipAudioEngine.micStream?.getAudioTracks()
    .filter(t => t.readyState === 'live').length || 0;
  _ensureFlipSettingsUI();
  document.querySelector('[data-audio-mode="off"]').click();
  for (let i = 0; i < 100 && flipAudioEngine.micStream !== null; i++) await sleep(20);
  const audioOff = {
    liveBefore:audioOffLiveBefore,
    micStreamNull:flipAudioEngine.micStream === null,
    ctxNull:flipAudioEngine.ctx === null,
    initialized:flipAudioEngine.isInitialized,
  };

  return { p0, doubleTap, extRace, muteImmediateOff, watchdogBackoff, watchdogCamera,
    recordingCamera, closedContextReset, audioOff };
})()
`;

function inspectMedia(dataUrl, label, workDir) {
  const comma = dataUrl.lastIndexOf(',');
  const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const mediaPath = path.join(workDir, `${label}.webm`);
  fs.writeFileSync(mediaPath, buffer);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mediaPath], { encoding:'utf8' });
  assert(probe.status === 0, `ffprobe ${label} fallo: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const audioTracks = (info.streams || []).filter(stream => stream.codec_type === 'audio').length;
  const videoTracks = (info.streams || []).filter(stream => stream.codec_type === 'video').length;
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', mediaPath, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], {
    encoding:null,
    maxBuffer:20 * 1024 * 1024,
  });
  assert(decode.status === 0, `ffmpeg audio ${label} fallo: ${decode.stderr?.toString()}`);
  let sumSquares = 0;
  let peak = 0;
  const samples = Math.floor(decode.stdout.length / 2);
  for (let offset = 0; offset + 1 < decode.stdout.length; offset += 2) {
    const sample = decode.stdout.readInt16LE(offset);
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return {
    bytes:buffer.length,
    audioTracks,
    videoTracks,
    decodedSamples:samples,
    rms:samples ? +Math.sqrt(sumSquares / samples).toFixed(2) : 0,
    peak,
    durationSec:+Number(info.format?.duration || 0).toFixed(3),
  };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t06-check-'));
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

  const server = spawn(process.execPath, [path.join(ROOT, '.claude/serve.js')], { cwd:ROOT, stdio:'ignore' });
  let serverExit = null;
  server.once('exit', (code, signal) => { serverExit = { code, signal }; });
  let testUrl = BASE_URL;
  let serverMode = 'http:8742';
  let serverReady = false;
  for (let attempt = 0; attempt < 40 && !serverReady && !serverExit; attempt++) {
    try {
      const response = await fetch(BASE_URL);
      serverReady = response.ok;
    } catch (_) {}
    if (!serverReady) await timeout(25);
  }
  if (!serverReady) {
    testUrl = `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t06=1`;
    serverMode = `file-fallback (serve exit ${serverExit?.code ?? 'unknown'})`;
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t06-chrome-'));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t06-media-'));
  const debugPort = Number(process.env.T06_CDP_PORT) || 24622;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
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
    if (!server.killed && !serverExit) server.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(mediaDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled:true });
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:testUrl });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga del LAB');
    await waitFor(() => evaluate(page, 'typeof startMicOnly === "function" && typeof flipAudioEngine === "object"'), 'runtime T6');
    const started = Date.now();
    const runtime = await evaluate(page, RUNTIME_MEASURE);
    const runtimeMs = Date.now() - started;
    const firstDataUrl = runtime.p0.firstRecording.dataUrl;
    const secondDataUrl = runtime.p0.secondRecording.dataUrl;
    delete runtime.p0.firstRecording.dataUrl;
    delete runtime.p0.secondRecording.dataUrl;
    runtime.p0.firstBlob = inspectMedia(firstDataUrl, 'first', mediaDir);
    runtime.p0.secondBlob = inspectMedia(secondDataUrl, 'second', mediaDir);

    assert(runtime.p0.engineContext.distinctFromExternal, 'engine reutilizo el contexto externo');
    assert(runtime.p0.engineContext.requestedSampleRate === 22050, `sampleRate solicitado=${runtime.p0.engineContext.requestedSampleRate}`);
    assert(runtime.p0.firstBlob.audioTracks === 1 && runtime.p0.secondBlob.audioTracks === 1,
      `pistas audio blobs=${runtime.p0.firstBlob.audioTracks}/${runtime.p0.secondBlob.audioTracks}`);
    assert(runtime.p0.firstBlob.rms > 20 && runtime.p0.secondBlob.rms > 20,
      `RMS blobs=${runtime.p0.firstBlob.rms}/${runtime.p0.secondBlob.rms}`);
    assert(runtime.p0.secondBlob.rms / runtime.p0.firstBlob.rms > 0.1,
      `segundo blob casi mudo ratio=${runtime.p0.secondBlob.rms / runtime.p0.firstBlob.rms}`);
    assert(runtime.doubleTap.rounds === 10 && runtime.doubleTap.livePerRound.every(count => count === 1),
      `doble tap tracks=${runtime.doubleTap.livePerRound.join(',')}`);
    assert(runtime.doubleTap.maxConcurrentGum === 1, `gUM concurrentes=${runtime.doubleTap.maxConcurrentGum}`);
    assert(runtime.doubleTap.liveBeforeOff === 1 && runtime.doubleTap.liveAfterOff === 0,
      `doble tap off=${JSON.stringify(runtime.doubleTap)}`);
    assert(runtime.extRace.gumCalls === 1 && runtime.extRace.maxConcurrentGum === 1 &&
      runtime.extRace.extMode && !runtime.extRace.micMode && runtime.extRace.liveBeforeOff === 1 &&
      runtime.extRace.liveAfterOff === 0, `EXT race=${JSON.stringify(runtime.extRace)}`);
    assert(runtime.muteImmediateOff.elapsedMs >= 1900 && runtime.muteImmediateOff.liveTracks === 0 &&
      runtime.muteImmediateOff.streamNull && runtime.muteImmediateOff.ctxNull && !runtime.muteImmediateOff.mode,
      `mute+off=${JSON.stringify(runtime.muteImmediateOff)}`);
    assert(runtime.watchdogBackoff.rebuildAttempts === 3 && runtime.watchdogBackoff.exhaustedToasts === 1 &&
      runtime.watchdogBackoff.liveTracks === 0 && !runtime.watchdogBackoff.mode,
      `watchdog backoff=${JSON.stringify(runtime.watchdogBackoff)}`);
    assert(runtime.watchdogCamera.videoGum === 1 && runtime.watchdogCamera.liveCurrentVideo === 1 && runtime.watchdogCamera.liveAudio === 1,
      `watchdog camera=${JSON.stringify(runtime.watchdogCamera)}`);
    assert(runtime.recordingCamera.ready && runtime.recordingCamera.videoGum === 1 && runtime.recordingCamera.liveCurrentVideo === 1,
      `recording camera=${JSON.stringify(runtime.recordingCamera)}`);
    assert(runtime.closedContextReset.ctxNull && !runtime.closedContextReset.initialized && runtime.closedContextReset.effects === 0 &&
      runtime.closedContextReset.recordingDestNull && runtime.closedContextReset.micStreamNull,
      `statechange reset=${JSON.stringify(runtime.closedContextReset)}`);
    assert(runtime.audioOff.liveBefore === 1 && runtime.audioOff.micStreamNull && runtime.audioOff.ctxNull && !runtime.audioOff.initialized,
      `AUDIO OFF=${JSON.stringify(runtime.audioOff)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown'
    );
    assert(runtimeExceptions.length === 0, `excepciones runtime=${exceptionDescriptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ nodeCheckExit:syntax.status, inlineScripts:scripts.length, htmlIds:ids.length,
        dynamicIds:dynamicIds.length, getElementByIdRefs:refs.length,
        duplicateIds:duplicateIds.length, missingIds:missingIds.length },
      ...runtime,
      timing:{ runtimeMs, serverMode },
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

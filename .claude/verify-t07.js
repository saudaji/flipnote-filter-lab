#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.T07_BASE_URL || `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t07=1`;
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
  window.__t07 = { gumCalls:[], videoStreams:[], audioStreams:[], sourceBanks:[], saved:[], toasts:[] };
  window.requestAnimationFrame = cb => realSetTimeout(() => cb(performance.now()), 25);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const NativeAC = window.AudioContext || window.webkitAudioContext;
  if (NativeAC) {
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
      __t07.sourceBanks.push({ ctx:this, nodes });
      return bus;
    };
  }

  __t07.makeVideoStream = () => {
    const source = document.createElement('canvas');
    source.width = 320; source.height = 240;
    const ctx = source.getContext('2d');
    let frame = 0;
    const paint = () => {
      frame++;
      ctx.fillStyle = frame % 2 ? '#ff4b16' : '#164bff';
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((frame * 11) % 260, 35, 60, 170);
      ctx.fillStyle = '#00ff9c';
      ctx.fillRect(40, (frame * 7) % 180, 220, 36);
      if (source.__running !== false) requestAnimationFrame(paint);
    };
    paint();
    const mediaStream = source.captureStream(30);
    mediaStream.__source = source;
    mediaStream.getTracks().forEach(track => track.addEventListener('ended', () => { source.__running = false; }, { once:true }));
    __t07.videoStreams.push(mediaStream);
    return mediaStream;
  };

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'stub-mic', label:'STUB MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    const isVideo = !!constraints?.video;
    __t07.gumCalls.push({ kind:isVideo ? 'video' : 'audio', at:performance.now() });
    if (isVideo) return __t07.makeVideoStream();
    const ctx = new NativeAC();
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440; gain.gain.value = 0.12;
    osc.connect(gain); gain.connect(dest); osc.start();
    __t07.audioStreams.push(dest.stream);
    return dest.stream;
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
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const inspectBlob = async blob => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    const url = URL.createObjectURL(blob);
    video.src = url;
    document.body.appendChild(video);
    let metadataMs = 0, seekMs = 0, playMs = 0;
    const metadataAt = performance.now();
    await Promise.race([
      new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once:true });
        video.addEventListener('error', () => reject(new Error('video metadata error ' + (video.error?.code || 0))), { once:true });
      }),
      sleep(4000).then(() => { throw new Error('video metadata timeout'); }),
    ]);
    metadataMs = performance.now() - metadataAt;
    const duration = video.duration;
    const playAt = performance.now();
    await video.play();
    await wait(() => video.currentTime > 0.02 || video.ended, 'video playback', 2000);
    playMs = performance.now() - playAt;
    video.pause();
    const target = Math.max(0.01, Math.min(duration * 0.65, duration - 0.01));
    const seekAt = performance.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seek timeout')), 2500);
      video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once:true });
      video.currentTime = target;
    });
    seekMs = performance.now() - seekAt;
    const seekError = Math.abs(video.currentTime - target);
    video.remove(); URL.revokeObjectURL(url);
    return {
      bytes:blob.size,
      mime:blob.type,
      duration:+duration.toFixed(3),
      metadataMs:Math.round(metadataMs),
      playMs:Math.round(playMs),
      seekMs:Math.round(seekMs),
      seekError:+seekError.toFixed(4),
    };
  };
  const pixelDiff = async canvas => {
    const ctx = canvas.getContext('2d');
    const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    await sleep(250);
    const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0, totalDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
      if (delta) changed++;
      totalDelta += delta;
    }
    return { changedPixels:changed, totalPixels:a.length / 4, totalDelta };
  };

  const realToast = flipToast;
  flipToast = (message, ...args) => {
    __t07.toasts.push({ message:String(message), at:performance.now() });
    return realToast(message, ...args);
  };
  saveBlob = async (blob, filename) => {
    const inspection = await inspectBlob(blob);
    __t07.saved.push({ blob, filename, inspection, at:performance.now() });
  };

  splash.classList.add('hidden');
  flipAudioSettings.audioMode = 'off';
  flipAudioSettings.saveMode = 'files';
  flipAudioSettings.resolution = 'low';
  await startCamera(facingMode);
  await wait(() => vid.videoWidth > 0, 'video stub metadata');

  const runSeries = async ({ module, switchTo, setVideoMode, button, getRecorder, isUiRecording }) => {
    switchTab(switchTo);
    await sleep(300);
    setVideoMode();
    const canvas = vid.srcObject?.__source || (module === 'cam' ? display : scrashCvs);
    const pixels = await pixelDiff(canvas);
    const savedBefore = __t07.saved.length;
    const toastBefore = __t07.toasts.length;
    const restartMs = [];
    let zombieClobbers = 0;
    button.click();
    await wait(() => getRecorder()?.state === 'recording', module + ' start');
    for (let take = 0; take < 10; take++) {
      await sleep(620);
      const oldRecorder = getRecorder();
      button.click();
      if (take < 9) {
        const restartAt = performance.now();
        button.click();
        const nextRecorder = await wait(() => {
          const current = getRecorder();
          return current && current !== oldRecorder && current.state === 'recording' ? current : null;
        }, module + ' restart ' + (take + 1));
        restartMs.push(Math.round(performance.now() - restartAt));
        await sleep(220);
        if (getRecorder() !== nextRecorder || nextRecorder.state !== 'recording' || !isUiRecording()) zombieClobbers++;
      }
    }
    await wait(() => __t07.saved.length - savedBefore === 10, module + ' 10 saves', 20000);
    await wait(() => !getRecorder(), module + ' recorder null');
    const saves = __t07.saved.slice(savedBefore).map(entry => entry.inspection);
    const errors = __t07.toasts.slice(toastBefore).filter(entry => /⚠|error|no se pudo/i.test(entry.message));
    return {
      takes:saves.length,
      valid:saves.filter(item => item.bytes > 0 && Number.isFinite(item.duration) && item.duration > 0 && item.seekError < 0.08).length,
      bytesMin:Math.min(...saves.map(item => item.bytes)),
      bytesMax:Math.max(...saves.map(item => item.bytes)),
      durationMin:Math.min(...saves.map(item => item.duration)),
      durationMax:Math.max(...saves.map(item => item.duration)),
      seekErrorMax:Math.max(...saves.map(item => item.seekError)),
      seekMsMax:Math.max(...saves.map(item => item.seekMs)),
      restartMsMax:Math.max(...restartMs),
      restartMs,
      zombieClobbers,
      errorToasts:errors.length,
      pixels,
      mimeCounts:saves.reduce((acc, item) => { acc[item.mime] = (acc[item.mime] || 0) + 1; return acc; }, {}),
    };
  };

  const cam = await runSeries({
    module:'cam', switchTo:'cam',
    setVideoMode:() => { if (camMode !== 'video') btnRec.click(); },
    button:btnCap,
    getRecorder:() => recorder,
    isUiRecording:() => btnCap.classList.contains('recording'),
  });
  const camFirst = __t07.saved.find(entry => /flip_cam_|flip_slht_/.test(entry.filename));

  const glitch = await runSeries({
    module:'glitch', switchTo:'scrash',
    setVideoMode:() => { if (scrashCamMode !== 'video') document.getElementById('btnScrashMode').click(); },
    button:document.getElementById('btnScrashSnap'),
    getRecorder:() => scrashRecorder,
    isUiRecording:() => document.getElementById('btnScrashSnap').classList.contains('recording'),
  });
  const glitchFirst = __t07.saved.find(entry => /flip_glitch_/.test(entry.filename));

  const webmCanvas = document.createElement('canvas');
  webmCanvas.width = 160; webmCanvas.height = 120;
  const webmCtx = webmCanvas.getContext('2d');
  let webmFrame = 0, webmRunning = true;
  const webmPaint = () => {
    webmFrame++;
    webmCtx.fillStyle = webmFrame % 2 ? '#ff00a0' : '#00a0ff';
    webmCtx.fillRect(0, 0, 160, 120);
    webmCtx.fillStyle = '#fff'; webmCtx.fillRect((webmFrame * 5) % 130, 20, 30, 80);
    if (webmRunning) requestAnimationFrame(webmPaint);
  };
  webmPaint();
  const webmStream = webmCanvas.captureStream(20);
  const webmRecorder = new MediaRecorder(webmStream, { mimeType:'video/webm;codecs=vp8', videoBitsPerSecond:1_000_000 });
  const webmChunks = [];
  webmRecorder.ondataavailable = event => { if (event.data?.size) webmChunks.push(event.data); };
  const webmStopped = new Promise(resolve => webmRecorder.addEventListener('stop', resolve, { once:true }));
  const webmStartedAt = performance.now();
  webmRecorder.start(100);
  await sleep(900);
  webmRecorder.stop();
  await webmStopped;
  webmRunning = false; webmStream.getTracks().forEach(track => track.stop());
  const rawWebm = new Blob(webmChunks, { type:'video/webm' });
  const fixedWebm = await _fixWebmDuration(rawWebm, performance.now() - webmStartedAt);
  const fixedWebmInspection = await inspectBlob(fixedWebm);

  const fake = {
    state:'recording', requestDataCalls:0, stopCalls:0,
    requestData() { this.requestDataCalls++; },
    stop() { this.stopCalls++; this.state = 'inactive'; setTimeout(() => this.onstop?.(), 0); },
  };
  let fakeFinalizes = 0;
  const releaseFake = _bindRecorderFinalize(fake, { addChunk:() => {}, onFinalize:async () => { fakeFinalizes++; releaseFake(); } });
  fake.onerror(new Event('error'));
  await wait(() => fakeFinalizes === 1, 'onerror finalize');

  const firstCamDataUrl = await blobToDataUrl(camFirst.blob);
  const firstGlitchDataUrl = await blobToDataUrl(glitchFirst.blob);
  const rawWebmDataUrl = await blobToDataUrl(rawWebm);
  const fixedWebmDataUrl = await blobToDataUrl(fixedWebm);
  const desktopMimeCandidates = _getFlipRecorderMimeCandidates(false);
  return {
    cam, glitch,
    desktop:{
      avc1Supported:MediaRecorder.isTypeSupported('video/mp4;codecs=avc1'),
      firstCandidate:desktopMimeCandidates[0],
      selectedMime:_pickFlipRecorderMime(webmCanvas.captureStream(1)),
      camFirst:camFirst.inspection,
      glitchFirst:glitchFirst.inspection,
    },
    webmFallback:{ rawBytes:rawWebm.size, fixedBytes:fixedWebm.size, addedBytes:fixedWebm.size - rawWebm.size, ...fixedWebmInspection },
    recorderError:{ stopCalls:fake.stopCalls, requestDataCalls:fake.requestDataCalls, finalizes:fakeFinalizes, finalState:fake.state },
    totals:{ saves:__t07.saved.length, errorToasts:__t07.toasts.filter(entry => /⚠|error|no se pudo/i.test(entry.message)).length,
      videoGumCalls:__t07.gumCalls.filter(call => call.kind === 'video').length },
    media:{ firstCamDataUrl, firstGlitchDataUrl, rawWebmDataUrl, fixedWebmDataUrl },
  };
})()
`;

function inspectMedia(dataUrl, label, workDir) {
  const comma = dataUrl.lastIndexOf(',');
  const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const ext = /^data:video\/mp4/i.test(dataUrl) ? 'mp4' : 'webm';
  const mediaPath = path.join(workDir, `${label}.${ext}`);
  fs.writeFileSync(mediaPath, buffer);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mediaPath], { encoding:'utf8' });
  assert(probe.status === 0, `ffprobe ${label} fallo: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const videoStream = (info.streams || []).find(stream => stream.codec_type === 'video');
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', mediaPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], {
    encoding:null,
    maxBuffer:128 * 1024 * 1024,
  });
  assert(decode.status === 0, `ffmpeg decode ${label} fallo: ${decode.stderr}`);
  const frameSize = Number(videoStream?.width || 0) * Number(videoStream?.height || 0) * 3;
  const decodedFrames = frameSize ? Math.floor(decode.stdout.length / frameSize) : 0;
  let changedPixels = 0, totalDelta = 0;
  for (let frame = 1; frame < decodedFrames; frame++) {
    let frameChanged = 0, frameDelta = 0;
    const frameAt = frame * frameSize;
    for (let i = 0; i < frameSize; i += 3) {
      const delta = Math.abs(decode.stdout[i] - decode.stdout[frameAt + i]) +
        Math.abs(decode.stdout[i + 1] - decode.stdout[frameAt + i + 1]) +
        Math.abs(decode.stdout[i + 2] - decode.stdout[frameAt + i + 2]);
      if (delta) frameChanged++;
      frameDelta += delta;
    }
    if (frameDelta > totalDelta) { changedPixels = frameChanged; totalDelta = frameDelta; }
  }
  return {
    bytes:buffer.length,
    durationSec:+Number(info.format?.duration || 0).toFixed(3),
    videoTracks:(info.streams || []).filter(stream => stream.codec_type === 'video').length,
    decodedFrames,
    changedPixels,
    totalDelta,
    formatName:info.format?.format_name || '',
  };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t07-check-'));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t07-media-'));
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
  const generationSymbols = ['camRecGeneration', 'asciiRecGeneration', 'sonoRecGeneration', 'wmpRecGeneration',
    'scrashRecGeneration', '_sfRecGeneration', '_fuRecGeneration', '_edRecGeneration'];
  const missingGenerationSymbols = generationSymbols.filter(symbol => !scripts[0].includes(`++${symbol}`));
  assert(duplicateIds.length === 0, `IDs duplicados: ${duplicateIds.join(', ')}`);
  assert(missingIds.length === 0, `getElementById rotos: ${missingIds.join(', ')}`);
  assert(missingGenerationSymbols.length === 0, `tokens REC ausentes: ${missingGenerationSymbols.join(', ')}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t07-chrome-'));
  const debugPort = Number(process.env.T07_CDP_PORT) || 24627;
  const externalChrome = process.env.T07_CDP_EXTERNAL === '1';
  const chrome = externalChrome ? null : spawn(CHROME, [
      '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
      '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
      `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
    ], { stdio:'inherit' });
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
    await page.send('Page.navigate', { url:BASE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga del LAB');
    await waitFor(() => evaluate(page, 'typeof _makeRecordedBlob === "function" && typeof scrashRecorder !== "undefined"'), 'runtime T07');
    const started = Date.now();
    const runtime = await evaluate(page, RUNTIME_MEASURE);
    const runtimeMs = Date.now() - started;

    const media = runtime.media;
    delete runtime.media;
    runtime.ffprobe = {
      cam:inspectMedia(media.firstCamDataUrl, 'cam', mediaDir),
      glitch:inspectMedia(media.firstGlitchDataUrl, 'glitch', mediaDir),
      rawWebm:inspectMedia(media.rawWebmDataUrl, 'raw-webm', mediaDir),
      webmFallback:inspectMedia(media.fixedWebmDataUrl, 'webm-fallback', mediaDir),
    };

    for (const [name, result] of [['CAM', runtime.cam], ['GLITCH', runtime.glitch]]) {
      assert(result.takes === 10 && result.valid === 10, `${name} videos=${result.valid}/${result.takes}`);
      assert(result.errorToasts === 0, `${name} toasts error=${result.errorToasts}`);
      assert(result.zombieClobbers === 0, `${name} zombie clobbers=${result.zombieClobbers}`);
      assert(result.restartMsMax < 500, `${name} restart max=${result.restartMsMax}ms`);
      assert(result.pixels.changedPixels > 0 && result.pixels.totalDelta > 0, `${name} source pixel diff=${JSON.stringify(result.pixels)}`);
    }
    assert(runtime.desktop.firstCandidate === 'video/mp4;codecs=avc1', `primer MIME=${runtime.desktop.firstCandidate}`);
    assert(Number.isFinite(runtime.desktop.camFirst.duration) && runtime.desktop.camFirst.duration > 0 && runtime.desktop.camFirst.seekError < 0.08,
      `CAM duration/seek=${JSON.stringify(runtime.desktop.camFirst)}`);
    assert(runtime.webmFallback.addedBytes === 11 && runtime.webmFallback.duration > 0 && runtime.webmFallback.seekError < 0.08,
      `WebM fallback=${JSON.stringify(runtime.webmFallback)}`);
    assert(runtime.ffprobe.rawWebm.durationSec === 0 && runtime.ffprobe.webmFallback.durationSec > 0,
      `WebM duration raw/fixed=${runtime.ffprobe.rawWebm.durationSec}/${runtime.ffprobe.webmFallback.durationSec}`);
    assert(runtime.recorderError.stopCalls === 1 && runtime.recorderError.finalizes === 1 && runtime.recorderError.finalState === 'inactive',
      `onerror=${JSON.stringify(runtime.recorderError)}`);
    Object.entries(runtime.ffprobe).forEach(([name, result]) => {
      assert((name === 'rawWebm' || result.durationSec > 0) && result.videoTracks === 1 && result.decodedFrames >= 2,
        `ffprobe ${name}=${JSON.stringify(result)}`);
      if (name === 'cam' || name === 'glitch') assert(result.changedPixels > 0 && result.totalDelta > 0,
        `pixel diff ${name}=${JSON.stringify(result)}`);
    });

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown'
    );
    assert(runtimeExceptions.length === 0, `excepciones runtime=${exceptionDescriptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ nodeCheckExit:syntax.status, inlineScripts:scripts.length, htmlIds:ids.length,
        dynamicIds:dynamicIds.length, getElementByIdRefs:refs.length,
        duplicateIds:duplicateIds.length, missingIds:missingIds.length,
        generationModules:generationSymbols.length, missingGenerationSymbols:missingGenerationSymbols.length },
      ...runtime,
      timing:{ runtimeMs, source:'file:// (puerto alterno bloqueado por sandbox)', externalChrome },
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

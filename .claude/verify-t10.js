#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t10=1`;
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
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  window.__t10 = {
    urls:{ created:0, revoked:0, live:new Map() },
    bitmaps:{ created:0, closed:0 },
    gumCalls:{ video:0, audio:0 },
    rafCallbacks:0,
    bankOscillators:0,
  };
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    __t10.rafCallbacks++;
    cb(performance.now());
  }, 25);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = object => {
    const url = nativeCreateObjectURL(object);
    __t10.urls.created++;
    __t10.urls.live.set(url, { type:object?.type || '', size:object?.size || 0 });
    return url;
  };
  URL.revokeObjectURL = url => {
    if (__t10.urls.live.delete(url)) __t10.urls.revoked++;
    nativeRevokeObjectURL(url);
  };

  const nativeCreateImageBitmap = window.createImageBitmap?.bind(window);
  if (nativeCreateImageBitmap) {
    const trackedCreateImageBitmap = async (...args) => {
      const bitmap = await nativeCreateImageBitmap(...args);
      __t10.bitmaps.created++;
      const nativeClose = bitmap.close.bind(bitmap);
      let closed = false;
      bitmap.close = () => {
        if (!closed) { closed = true; __t10.bitmaps.closed++; }
        return nativeClose();
      };
      return bitmap;
    };
    window.createImageBitmap = trackedCreateImageBitmap;
    __t10.trackedCreateImageBitmap = trackedCreateImageBitmap;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      for (const [frequency, lfoFrequency] of [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]) {
        const osc = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.025;
        lfo.frequency.value = lfoFrequency;
        lfoGain.gain.value = 0.012;
        lfo.connect(lfoGain); lfoGain.connect(gain.gain);
        osc.connect(gain); gain.connect(bus);
        osc.start(); lfo.start();
        __t10.bankOscillators++;
      }
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'t10-mic', label:'T10 MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    if (constraints?.video) {
      __t10.gumCalls.video++;
      const source = document.createElement('canvas');
      source.width = 160; source.height = 120;
      const ctx = source.getContext('2d');
      let frame = 0;
      const paint = () => {
        frame++;
        ctx.fillStyle = frame % 2 ? '#f40' : '#04f'; ctx.fillRect(0, 0, 160, 120);
        ctx.fillStyle = '#fff'; ctx.fillRect((frame * 7) % 120, 20, 40, 80);
        requestAnimationFrame(paint);
      };
      paint();
      return source.captureStream(30);
    }
    __t10.gumCalls.audio++;
    const audioCtx = new AC();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx.createMediaStreamDestination().stream;
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
      await sleep(25);
    }
    throw new Error('timeout ' + label + ': ' + String(last));
  };
  const canvasBlob = (canvas, type) => new Promise((resolve, reject) =>
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob nulo')), type));
  const dispatchFile = file => {
    const input = document.getElementById('editFileInput');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  };
  const makeImageFile = async name => {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e42'; ctx.fillRect(0, 0, 128, 96);
    ctx.fillStyle = '#1ce'; ctx.fillRect(19, 13, 71, 58);
    const blob = await canvasBlob(canvas, 'image/png');
    return new File([blob], name, { type:'image/png' });
  };
  const makeVideoBytes = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(40);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond:6000000 });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once:true }));
    recorder.start(200);
    let frame = 0;
    const painter = setInterval(() => {
      frame++;
      for (let y = 0; y < 480; y += 24) {
        for (let x = 0; x < 640; x += 24) {
          const hue = (x * 3 + y * 5 + frame * 29) % 360;
          ctx.fillStyle = 'hsl(' + hue + ' 90% ' + (35 + ((x + y + frame) % 35)) + '%)';
          ctx.fillRect(x, y, 24, 24);
        }
      }
    }, 20);
    await sleep(3000);
    clearInterval(painter);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    return new Uint8Array(await new Blob(chunks, { type:'video/webm' }).arrayBuffer());
  };
  const loadVideo = async (bytes, index) => {
    const createdBefore = __t10.urls.created;
    dispatchFile(new File([bytes.slice()], 't10-' + index + '.webm', { type:'video/webm' }));
    await wait(() => __t10.urls.created === createdBefore + 1 && editSource.type === 'video' && editVideoEl.readyState >= 2,
      'video EDIT ' + index, 15000);
    await sleep(150);
    if (window.gc) { window.gc(); await sleep(100); }
    return {
      index,
      heap:performance.memory?.usedJSHeapSize || 0,
      liveUrls:__t10.urls.live.size - urlBaseline.live,
      paused:editVideoEl.paused,
      readyState:editVideoEl.readyState,
    };
  };
  const pixelDiff = async canvas => {
    const ctx = canvas.getContext('2d');
    const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    await sleep(250);
    const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let changedPixels = 0, totalDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);
      if (delta) changedPixels++;
      totalDelta += delta;
    }
    return { changedPixels, totalPixels:a.length / 4, totalDelta };
  };

  const urlBaseline = {
    created:__t10.urls.created,
    revoked:__t10.urls.revoked,
    live:__t10.urls.live.size,
    liveTypes:[...__t10.urls.live.values()].map(value => value.type),
  };
  const audioProbeStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioProbeCtx = new AudioContextCtor();
  if (audioProbeCtx.state === 'suspended') await audioProbeCtx.resume();
  audioProbeCtx.createMediaStreamSource(audioProbeStream);
  await audioProbeCtx.close();
  audioProbeStream.getTracks().forEach(track => track.stop());
  switchTab('edit');
  await wait(() => activeTab === 'edit' && editRunning, 'entrada EDIT');

  const bitmapCreatedBefore = __t10.bitmaps.created;
  const bitmapClosedBefore = __t10.bitmaps.closed;
  dispatchFile(await makeImageFile('bitmap.png'));
  await wait(() => editSource.type === 'photo' && __t10.bitmaps.created === bitmapCreatedBefore + 1, 'ImageBitmap EDIT');
  document.getElementById('editSrcAudio').click();
  await wait(() => editSource.type === 'audio' && __t10.bitmaps.closed === bitmapClosedBefore + 1, 'close ImageBitmap');
  const bitmapRelease = {
    created:__t10.bitmaps.created - bitmapCreatedBefore,
    closed:__t10.bitmaps.closed - bitmapClosedBefore,
    retained:_editPhotoImg !== null ? 1 : 0,
  };

  const fallbackCreatedBefore = __t10.urls.created;
  const fallbackRevokedBefore = __t10.urls.revoked;
  window.createImageBitmap = undefined;
  dispatchFile(await makeImageFile('fallback.png'));
  await wait(() => editSource.type === 'photo' && __t10.urls.created === fallbackCreatedBefore + 1, 'fallback imagen EDIT');
  const fallbackLoaded = { liveUrls:__t10.urls.live.size - urlBaseline.live };
  window.createImageBitmap = __t10.trackedCreateImageBitmap;

  const videoBytes = await makeVideoBytes();
  const videoLoads = [];
  for (let index = 1; index <= 5; index++) videoLoads.push(await loadVideo(videoBytes, index));
  const heapDeltaBytes = videoLoads[4].heap - videoLoads[0].heap;
  const retainedHeapDeltaBytes = Math.max(0, heapDeltaBytes);
  const videoPixels = await pixelDiff(editCanvas);
  const afterFive = {
    fileBytes:videoBytes.byteLength,
    heapFirst:videoLoads[0].heap,
    heapFifth:videoLoads[4].heap,
    heapDeltaBytes,
    retainedHeapDeltaBytes,
    liveUrls:__t10.urls.live.size - urlBaseline.live,
    createdVideoUrls:__t10.urls.created - fallbackCreatedBefore - 1,
    revokedSinceFallback:__t10.urls.revoked - fallbackRevokedBefore,
    loads:videoLoads,
    pixelDiff:videoPixels,
  };

  document.getElementById('editSrcAudio').click();
  await wait(() => editSource.type === 'audio', 'cambio a fuente audio');
  await sleep(250);
  const sourceSwitch = {
    sourceType:editSource.type,
    paused:editVideoEl.paused,
    srcAttribute:editVideoEl.getAttribute('src'),
    currentSrc:editVideoEl.currentSrc,
    currentSrcLive:__t10.urls.live.has(editVideoEl.currentSrc),
    liveUrls:__t10.urls.live.size - urlBaseline.live,
    liveUrlTypes:[...__t10.urls.live.values()].map(value => value.type),
    internalUrl:_editMediaUrl,
  };

  await loadVideo(videoBytes, 6);
  switchTab('cam');
  await wait(() => activeTab === 'cam', 'salida EDIT');
  await sleep(250);
  const tabExit = {
    paused:editVideoEl.paused,
    srcAttribute:editVideoEl.getAttribute('src'),
    currentSrc:editVideoEl.currentSrc,
    currentSrcLive:__t10.urls.live.has(editVideoEl.currentSrc),
    liveUrls:__t10.urls.live.size - urlBaseline.live,
    internalUrl:_editMediaUrl,
    photoRetained:_editPhotoImg !== null ? 1 : 0,
    sourceType:editSource.type,
  };

  return {
    bitmapRelease,
    urlBaseline,
    fallback:{ ...fallbackLoaded, revokedByFirstVideo:__t10.urls.revoked > fallbackRevokedBefore },
    fiveVideos:afterFive,
    sourceSwitch,
    tabExit,
    totals:{
      urlCreated:__t10.urls.created,
      urlRevoked:__t10.urls.revoked,
      urlLive:__t10.urls.live.size,
      editUrlCreated:__t10.urls.created - urlBaseline.created,
      editUrlRevoked:__t10.urls.revoked - urlBaseline.revoked,
      editUrlLive:__t10.urls.live.size - urlBaseline.live,
      bitmapCreated:__t10.bitmaps.created,
      bitmapClosed:__t10.bitmaps.closed,
      rafCallbacks:__t10.rafCallbacks,
      gumCalls:__t10.gumCalls,
      bankOscillators:__t10.bankOscillators,
    },
  };
})()
`;

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t10-check-'));
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
  assert(duplicateIds.length === 0, `IDs duplicados=${duplicateIds.join(',')}`);
  assert(missingIds.length === 0, `IDs rotos=${missingIds.join(',')}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t10-chrome-'));
  const debugPort = Number(process.env.T10_CDP_PORT) || 24910;
  const externalChrome = process.env.T10_CDP_EXTERNAL === '1';
  const chrome = externalChrome ? null : spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--disable-crash-reporter', '--disable-breakpad',
    '--no-sandbox', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
    '--enable-precise-memory-info', '--js-flags=--expose-gc',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:['ignore', 'pipe', 'pipe'] });
  chrome?.stdout.resume();
  chrome?.stderr.resume();
  let chromeExit = null;
  chrome?.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const version = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && response.json();
    } catch (_) { return false; }
  }, 'Chrome DevTools');
  const browser = await new Cdp(version.webSocketDebuggerUrl).open();
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
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:PAGE_URL });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'carga LAB');
    await waitFor(() => evaluate(page, 'typeof _editReleaseMedia === "function" && typeof switchTab === "function"'), 'runtime EDIT');
    const started = Date.now();
    const runtime = await evaluate(page, RUNTIME_MEASURE);
    const runtimeMs = Date.now() - started;

    assert(runtime.bitmapRelease.created === 1 && runtime.bitmapRelease.closed === 1 && runtime.bitmapRelease.retained === 0,
      `ImageBitmap=${JSON.stringify(runtime.bitmapRelease)}`);
    assert(runtime.fallback.liveUrls === 1 && runtime.fallback.revokedByFirstVideo,
      `fallback imagen=${JSON.stringify(runtime.fallback)}`);
    assert(runtime.fiveVideos.loads.length === 5 && runtime.fiveVideos.loads.every(load => load.liveUrls === 1),
      `URLs tras videos=${JSON.stringify(runtime.fiveVideos.loads)}`);
    assert(runtime.fiveVideos.retainedHeapDeltaBytes < runtime.fiveVideos.fileBytes,
      `heap delta=${runtime.fiveVideos.retainedHeapDeltaBytes} bytes; video=${runtime.fiveVideos.fileBytes} bytes`);
    assert(runtime.fiveVideos.liveUrls === 1 && runtime.fiveVideos.pixelDiff.changedPixels > 0,
      `cinco videos=${JSON.stringify(runtime.fiveVideos)}`);
    for (const [label, state] of [['cambio fuente', runtime.sourceSwitch], ['salida EDIT', runtime.tabExit]]) {
      assert(state.paused && state.srcAttribute === null && !state.currentSrcLive && state.liveUrls === 0,
        `${label}=${JSON.stringify(state)}`);
    }
    assert(runtime.tabExit.internalUrl === null && runtime.tabExit.photoRetained === 0 && runtime.tabExit.sourceType === 'cam',
      `estado salida=${JSON.stringify(runtime.tabExit)}`);
    assert(runtime.totals.editUrlCreated === runtime.totals.editUrlRevoked && runtime.totals.editUrlLive === 0,
      `saldo URLs=${JSON.stringify(runtime.totals)}`);
    assert(runtime.totals.gumCalls.video >= 1 && runtime.totals.gumCalls.audio === 1 && runtime.totals.bankOscillators === 4,
      `stubs media=${JSON.stringify(runtime.totals)}`);

    const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    const exceptionDescriptions = runtimeExceptions.map(event =>
      event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'unknown');
    assert(runtimeExceptions.length === 0, `excepciones runtime=${exceptionDescriptions.join(' | ')}`);

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
      timing:{ runtimeMs, source:'file://', cdpPort:debugPort, externalChrome },
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

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_URL = pathToFileURL(path.join(ROOT, 'docs/index.html')).href;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 5000, intervalMs = 25) {
  const started = Date.now();
  let last;
  while (Date.now() - started < limitMs) {
    last = await check();
    if (last) return last;
    await timeout(intervalMs);
  }
  throw new Error(`Timeout esperando ${label}; último=${JSON.stringify(last)}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
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
        this.events.push(msg);
        const session = this.sessions.get(msg.sessionId);
        if (session) session.events.push(msg);
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
  window.requestAnimationFrame = cb => realSetTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);
  window.__t02 = {
    camDelay: 140,
    audioDelay: 0,
    denyCamera: false,
    gumCalls: [],
    camStreams: [],
    audioStreams: [],
    audioContexts: [],
    recorderStreams: [],
    recorderChunkBytes: 0,
    recorderChunks: [],
    firstVideoDrawAt: 0,
    firstStateAt: 0,
    messages: [],
    downloads: 0,
    savedBlob: null,
    fullscreenCalls: 0,
    runtimeMarks: {},
  };

  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}

  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(...args) {
    const source = args[0];
    if (!window.__t02.firstVideoDrawAt && source instanceof HTMLVideoElement && source.videoWidth) {
      window.__t02.firstVideoDrawAt = performance.now();
    }
    return drawImage.apply(this, args);
  };

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      bus.gain.value = 0.7;
      const bank = [[90, 1.3], [800, 2.1], [3000, 0.7], [9000, 1.9]];
      const nodes = [];
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
        nodes.push(osc, gain, lfo, lfoGain);
      });
      window.__t02.audioContexts.push({ ctx: this, nodes });
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'stub-mic', label: 'STUB MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    const isVideo = !!constraints?.video;
    window.__t02.gumCalls.push({ kind: isVideo ? 'video' : 'audio', at: performance.now() });
    if (isVideo) {
      if (window.__t02.denyCamera) throw new DOMException('Permiso de cámara denegado por arnés', 'NotAllowedError');
      await new Promise(resolve => realSetTimeout(resolve, window.__t02.camDelay));
      if (window.__t02.denyCamera) throw new DOMException('Permiso de cámara denegado por arnés', 'NotAllowedError');
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
        if (source.__running !== false) window.requestAnimationFrame(paint);
      };
      paint();
      const stream = source.captureStream(30);
      stream.__source = source;
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { source.__running = false; }, { once: true }));
      window.__t02.camStreams.push(stream);
      return stream;
    }

    const ctx = new AC();
    await new Promise(resolve => realSetTimeout(resolve, window.__t02.audioDelay));
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    window.__t02.audioContexts.push({ ctx, nodes: [osc, gain, dest] });
    window.__t02.audioStreams.push(dest.stream);
    return dest.stream;
  };

  if (window.MediaRecorder) {
    const NativeMediaRecorder = window.MediaRecorder;
    window.MediaRecorder = new Proxy(NativeMediaRecorder, {
      construct(Target, args) {
        const recorder = Reflect.construct(Target, args, Target);
        window.__t02.recorderStreams.push(args[0]);
        recorder.addEventListener('dataavailable', event => {
          if (event.data?.size) {
            window.__t02.recorderChunkBytes += event.data.size;
            const meta = { index: window.__t02.recorderChunks.length, size: event.data.size, type: event.data.type, header: '' };
            window.__t02.recorderChunks.push(meta);
            event.data.slice(0, 16).arrayBuffer().then(buffer => {
              meta.header = Array.from(new Uint8Array(buffer)).map(value => value.toString(16).padStart(2, '0')).join('');
            });
          }
        });
        return recorder;
      },
    });
  }

  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = object => {
    if (object instanceof Blob && /^video\//i.test(object.type || '')) window.__t02.savedBlob = object;
    return createObjectURL(object);
  };
  HTMLAnchorElement.prototype.click = function() { window.__t02.downloads++; };

  HTMLCanvasElement.prototype.requestFullscreen = function() {
    window.__t02.fullscreenCalls++;
    try { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: this }); } catch (_) {}
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
})();
`;

async function newPage(browser, url, name, exceptionSink) {
  const cdp = await browser.createSession();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => evaluate(cdp, 'document.readyState === "complete"'), `${name} complete`, 10000);
  cdp.events.push = new Proxy(cdp.events.push, {
    apply(targetPush, thisArg, args) {
      const event = args[0];
      if (event?.method === 'Runtime.exceptionThrown') exceptionSink.push({ page: name, detail: event.params?.exceptionDetails?.text || 'exception' });
      return Reflect.apply(targetPush, thisArg, args);
    },
  });
  return cdp;
}

function state(cam, audioMode = 'off') {
  return {
    source: { cam, audioMode, audioDeviceId: null },
    pipeline: [{ engine: 'glitch', on: true }],
    vhs: { enabled: false, intensity: 50, tracking: 30, chromaBleed: 40, scanlines: 50, jitter: 20, warble: 15 },
  };
}

async function post(cdp, message) {
  await evaluate(cdp, `window.__t02.channel.postMessage(${JSON.stringify(message)})`);
}

async function summary(cdp) {
  return evaluate(cdp, `(() => ({
    videoGum: __t02.gumCalls.filter(x => x.kind === 'video').length,
    audioGum: __t02.gumCalls.filter(x => x.kind === 'audio').length,
    liveCamTracks: __t02.camStreams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState === 'live').length,
    liveAudioTracks: __t02.audioStreams.flatMap(s => s.getAudioTracks()).filter(t => t.readyState === 'live').length,
    camTrackStates: __t02.camStreams.flatMap(s => s.getVideoTracks()).map(t => t.readyState),
    firstVideoDrawAt: __t02.firstVideoDrawAt,
    firstStateAt: __t02.firstStateAt,
    fullscreenCalls: __t02.fullscreenCalls,
    recorderChunkBytes: __t02.recorderChunkBytes,
    downloads: __t02.downloads,
  }))()`);
}

async function sampleCanvas(cdp) {
  return evaluate(cdp, `(() => {
    const source = document.getElementById('stageOutCanvas');
    const probe = document.createElement('canvas');
    probe.width = 32; probe.height = 24;
    const ctx = probe.getContext('2d');
    ctx.drawImage(source, 0, 0, 32, 24);
    return Array.from(ctx.getImageData(0, 0, 32, 24).data);
  })()`);
}

function pixelDiff(a, b) {
  let changedPixels = 0;
  let sumAbs = 0;
  for (let i = 0; i < a.length; i += 4) {
    let changed = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(a[i + channel] - b[i + channel]);
      sumAbs += delta;
      if (delta) changed = true;
    }
    if (changed) changedPixels++;
  }
  return { changedPixels, totalPixels: a.length / 4, sumAbs };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const dynamicIds = [...html.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
  const refs = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const allIds = new Set([...ids, ...dynamicIds]);
  const missingIds = [...new Set(refs.filter(id => !allIds.has(id)))];
  assert(duplicateIds.length === 0, `IDs duplicados: ${duplicateIds.join(', ')}`);
  assert(missingIds.length === 0, `getElementById rotos: ${missingIds.join(', ')}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t02-chrome-'));
  const mediaPath = path.join(profileDir, 'stage-output.webm');
  const debugPort = Number(process.env.T02_CDP_PORT) || 24568;
  const chromeArgs = [
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
  ];
  const chrome = spawn('/bin/zsh', ['-lc', 'exec "$@"', 'zsh', CHROME, ...chromeArgs], { stdio: 'ignore', detached: true });
  chrome.unref();
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const browserVersion = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome terminó antes de DevTools: ${JSON.stringify(chromeExit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && response.json();
    } catch (_) { return false; }
  }, 'Chrome DevTools', 10000);
  const browserUrl = browserVersion.webSocketDebuggerUrl;
  const browser = await new Cdp(browserUrl).open();
  const pages = [];
  const exceptions = [];

  const cleanup = () => {
    pages.forEach(page => page.close());
    browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
  };
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    await browser.send('Browser.getVersion');

    const output = await newPage(browser, `${BASE_URL}#stageout`, 'OUTPUT', exceptions);
    pages.push(output);
    await evaluate(output, `
      __t02.channel = new BroadcastChannel('flip_stage');
      __t02.channel.addEventListener('message', event => __t02.messages.push({ ...event.data, receivedAt: performance.now() }));
      true;
    `);

    const layout = await evaluate(output, `(() => {
      const canvas = document.getElementById('stageOutCanvas');
      const prompt = document.getElementById('stageOutFullscreenPrompt');
      return {
        canvasHeight: Math.round(canvas.getBoundingClientRect().height),
        viewportHeight: innerHeight,
        promptDisplay: getComputedStyle(prompt).display,
      };
    })()`);
    assert(layout.canvasHeight === layout.viewportHeight, `100dvh no coincide: ${layout.canvasHeight}/${layout.viewportHeight}`);
    assert(layout.promptDisplay !== 'none', 'overlay fullscreen inicial oculto');

    const beforeCamera = await sampleCanvas(output);
    await evaluate(output, `__t02.firstStateAt = performance.now(); true`);
    await post(output, { type: 'state', payload: state(true) });
    await waitFor(async () => (await summary(output)).firstVideoDrawAt > 0, 'primer frame de cámara', 3000);
    const first = await summary(output);
    const firstImageMs = Math.round(first.firstVideoDrawAt - first.firstStateAt);
    assert(firstImageMs >= 0 && firstImageMs < 3000, `primera imagen tardó ${firstImageMs}ms`);
    assert(first.videoGum === 1, `primer estado hizo ${first.videoGum} llamadas video gUM`);
    const afterCamera = await sampleCanvas(output);
    const firstPixelDiff = pixelDiff(beforeCamera, afterCamera);
    assert(firstPixelDiff.changedPixels > 0, 'pixel-diff de primera cámara fue 0');

    await post(output, { type: 'state', payload: state(false) });
    await waitFor(async () => (await summary(output)).liveCamTracks === 0, 'cámara apagada antes de carrera');
    const gumBeforeRace = (await summary(output)).videoGum;
    await evaluate(output, `__t02.camDelay = 350; true`);
    for (let cycle = 0; cycle < 5; cycle++) {
      await post(output, { type: 'state', payload: state(true) });
      await timeout(5);
      await post(output, { type: 'state', payload: state(false) });
      await timeout(5);
      await post(output, { type: 'state', payload: state(true) });
      await timeout(5);
    }
    await waitFor(async () => {
      const value = await summary(output);
      return value.liveCamTracks === 1 && value.videoGum === gumBeforeRace + 1 && value;
    }, 'última intención CAM ON', 3000);
    const race = await summary(output);
    assert(race.liveCamTracks === 1, `tracks vivos tras carrera=${race.liveCamTracks}`);
    assert(race.videoGum - gumBeforeRace === 1, `gUM extra en carrera=${race.videoGum - gumBeforeRace}`);

    await evaluate(output, `document.getElementById('stageOutFullscreenPrompt').hidden = true; true`);
    const fullscreenBefore = (await summary(output)).fullscreenCalls;
    await post(output, { type: 'cmd', cmd: 'fullscreen' });
    await waitFor(async () => evaluate(output, `!document.getElementById('stageOutFullscreenPrompt').hidden`), 'overlay por comando fullscreen');
    const fullscreenAfterRemote = (await summary(output)).fullscreenCalls;
    assert(fullscreenAfterRemote === fullscreenBefore, 'comando remoto intentó fullscreen directamente');
    await evaluate(output, `document.getElementById('stageOutFullscreenPrompt').click(); true`);
    await waitFor(async () => evaluate(output, `document.getElementById('stageOutFullscreenPrompt').hidden`), 'overlay oculto tras click');
    const fullscreenAfterClick = (await summary(output)).fullscreenCalls;
    assert(fullscreenAfterClick === fullscreenBefore + 1, `click fullscreen hizo ${fullscreenAfterClick - fullscreenBefore} requests`);

    const control = await newPage(browser, BASE_URL, 'CONTROL', exceptions);
    pages.push(control);
    await evaluate(control, `document.getElementById('btnSplashStage').click(); true`);
    const controlLedActive = await waitFor(async () => evaluate(control, `document.getElementById('stageSrcCam').classList.contains('active')`), 'LED CAM activo en CONTROL');
    const controlVisibility = await evaluate(control, `(() => {
      const area = document.getElementById('stageArea');
      const status = document.getElementById('stageOutStatus');
      return { areaDisplay: getComputedStyle(area).display, statusRects: status.getClientRects().length };
    })()`);
    assert(controlVisibility.areaDisplay === 'block' && controlVisibility.statusRects > 0,
      `CONTROL STAGE no visible=${JSON.stringify(controlVisibility)}`);
    await evaluate(control, `
      __t02.statusMutations = [];
      new MutationObserver(() => {
        const el = document.getElementById('stageOutStatus');
        __t02.statusMutations.push({ text: el.textContent, at: performance.now(), color: getComputedStyle(el).color });
      }).observe(document.getElementById('stageOutStatus'), { childList: true, subtree: true, attributes: true });
      true;
    `);

    await post(output, { type: 'state', payload: state(false) });
    await waitFor(async () => (await summary(output)).liveCamTracks === 0, 'cámara apagada antes de denegación');
    await evaluate(output, `__t02.denyCamera = true; __t02.camDelay = 40; true`);
    const denyStarted = Date.now();
    await post(output, { type: 'state', payload: state(true) });
    const deniedStatus = await waitFor(async () => {
      const value = await evaluate(control, `(() => {
        const el = document.getElementById('stageOutStatus');
        return { text: el.textContent, color: getComputedStyle(el).color, rects: el.getClientRects().length, areaDisplay: getComputedStyle(document.getElementById('stageArea')).display };
      })()`);
      return value.text.includes('CAM_FAILED') && value.rects > 0 && value.areaDisplay === 'block' && value;
    }, 'error CAM visible en CONTROL', 1000, 10);
    const denyVisibleMs = Date.now() - denyStarted;
    assert(deniedStatus.color === 'rgb(255, 68, 68)', `color error=${deniedStatus.color}`);

    await evaluate(output, `__t02.denyCamera = false; true`);
    const audioGumBefore = (await summary(output)).audioGum;
    await evaluate(output, `__t02.audioDelay = 220; true`);
    await post(output, { type: 'state', payload: state(false, 'mic') });
    await timeout(5);
    await post(output, { type: 'state', payload: state(false, 'off') });
    await timeout(5);
    await post(output, { type: 'state', payload: state(false, 'mic') });
    await waitFor(async () => evaluate(output, `typeof extAudioCtx !== 'undefined' && !!extAudioCtx && extAudioCtx.state !== 'closed' && !!extInGainNode`), 'bus de audio OUTPUT', 5000);
    const audioRace = await summary(output);
    assert(audioRace.audioGum - audioGumBefore === 1, `gUM extra en carrera audio=${audioRace.audioGum - audioGumBefore}`);
    assert(audioRace.liveAudioTracks === 1, `audio tracks vivos tras carrera=${audioRace.liveAudioTracks}`);

    await evaluate(control, `document.getElementById('btnStageRec').click(); true`);
    await waitFor(async () => evaluate(output, `__t02.recorderStreams.length === 1`), 'MediaRecorder de STAGE', 3000);
    const recorderStartTracks = await evaluate(output, `(() => {
      const stream = __t02.recorderStreams[0];
      return { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length, states: stream.getTracks().map(t => t.readyState) };
    })()`);
    assert(recorderStartTracks.video === 1, `REC video tracks=${recorderStartTracks.video}`);
    assert(recorderStartTracks.audio === 1, `REC audio tracks=${recorderStartTracks.audio}`);

    const counter = await waitFor(async () => {
      const status = await evaluate(control, `document.getElementById('stageOutStatus').textContent`);
      const elapsed = await evaluate(output, `Math.max(0, ...__t02.messages.filter(m => m.type === 'status').map(m => Number(m.recElapsed) || 0))`);
      return elapsed >= 2 && /REC 00:0[2-9]/.test(status) && { status, elapsed };
    }, 'contador REC >= 00:02', 5000, 50);

    await evaluate(control, `document.getElementById('btnStageRec').click(); true`);
    await waitFor(async () => evaluate(output, `!!__t02.savedBlob`), 'blob de grabación', 5000);
    const recorderEnd = await waitFor(async () => {
      const value = await evaluate(output, `(() => {
        const stream = __t02.recorderStreams[0];
        const states = stream.getTracks().map(t => t.readyState);
        return { states, allEnded: states.every(state => state === 'ended'), bytes: __t02.recorderChunkBytes, chunks: __t02.recorderChunks, blobBytes: __t02.savedBlob?.size || 0, mime: __t02.savedBlob?.type || '' };
      })()`);
      return value.allEnded && value.blobBytes > 0 && value;
    }, 'finalize y tracks detenidos', 5000);

    const dataUrl = await evaluate(output, `new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(__t02.savedBlob);
    })`);
    const mediaBuffer = Buffer.from(dataUrl.slice(dataUrl.lastIndexOf(',') + 1), 'base64');
    fs.writeFileSync(mediaPath, mediaBuffer);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', mediaPath], { encoding: 'utf8' });
    assert(probe.status === 0, `ffprobe falló (bytes=${mediaBuffer.length}, mime=${recorderEnd.mime}, header=${mediaBuffer.subarray(0, 24).toString('hex')}, chunks=${JSON.stringify(recorderEnd.chunks)}, dataUrl=${dataUrl.slice(0, 80)}): ${probe.stderr}`);
    const streams = JSON.parse(probe.stdout).streams || [];
    const blobVideoTracks = streams.filter(stream => stream.codec_type === 'video').length;
    const blobAudioTracks = streams.filter(stream => stream.codec_type === 'audio').length;
    assert(blobVideoTracks === 1, `blob video tracks=${blobVideoTracks}`);
    assert(blobAudioTracks === 1, `blob audio tracks=${blobAudioTracks}`);

    await post(output, { type: 'state', payload: state(false, 'off') });
    const audioOff = await waitFor(async () => {
      const value = await evaluate(output, `(() => ({
        ctxNull: extAudioCtx === null,
        analyserNull: extAnalyser === null,
        streamNull: extMicStream === null,
        reactDetached: FlipAudioReact._analyser === null,
        liveTracks: __t02.audioStreams.flatMap(s => s.getAudioTracks()).filter(t => t.readyState === 'live').length,
      }))()`);
      return value.ctxNull && value.analyserNull && value.streamNull && value.reactDetached && value.liveTracks === 0 && value;
    }, 'audio OUTPUT apagado', 3000);
    assert(audioOff.ctxNull && audioOff.analyserNull && audioOff.streamNull && audioOff.reactDetached && audioOff.liveTracks === 0,
      `audio off incompleto=${JSON.stringify(audioOff)}`);

    await evaluate(control, `
      window.open = () => null;
      __t02.popupStartedAt = performance.now();
      document.getElementById('btnStageOpenOut').click();
      true;
    `);
    const popup = await evaluate(control, `(() => {
      const el = document.getElementById('stageOutStatus');
      return { text: el.textContent, color: getComputedStyle(el).color, elapsed: performance.now() - __t02.popupStartedAt };
    })()`);
    assert(popup.text === '⚠ popup bloqueado — permite ventanas emergentes', `status popup=${popup.text}`);
    assert(popup.color === 'rgb(255, 68, 68)', `color popup=${popup.color}`);

    await timeout(100);
    const runtimeExceptions = pages.flatMap(page => page.events)
      .filter(event => event.method === 'Runtime.exceptionThrown')
      .map(event => event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'exception');
    assert(runtimeExceptions.length === 0, `excepciones runtime: ${runtimeExceptions.join(' | ')}`);

    const statusFields = await evaluate(output, `(() => {
      const statuses = __t02.messages.filter(m => m.type === 'status');
      return {
        count: statuses.length,
        withWorkRes: statuses.filter(m => Number(m.workRes) > 0).length,
        withRecElapsed: statuses.filter(m => Object.prototype.hasOwnProperty.call(m, 'recElapsed')).length,
        workRes: statuses.at(-1)?.workRes || 0,
      };
    })()`);

    const result = {
      static: { htmlIds: ids.length, dynamicIds: dynamicIds.length, getElementByIdRefs: refs.length, duplicateIds: 0, missingIds: 0 },
      firstOpen: { imageMs: firstImageMs, videoGumCalls: first.videoGum, pixelDiff: firstPixelDiff },
      cameraRace: { intentMessages: 15, extraVideoGumCalls: race.videoGum - gumBeforeRace, liveTracks: race.liveCamTracks, controlLedActive, allTrackStates: race.camTrackStates },
      audioRace: { intentMessages: 3, extraAudioGumCalls: audioRace.audioGum - audioGumBefore, liveTracks: audioRace.liveAudioTracks, offFinal: audioOff },
      cameraDenied: { visibleMs: denyVisibleMs, status: deniedStatus.text, color: deniedStatus.color, statusRects: deniedStatus.rects, areaDisplay: deniedStatus.areaDisplay },
      fullscreen: { initialDisplay: layout.promptDisplay, remoteRequests: fullscreenAfterRemote - fullscreenBefore, clickRequests: fullscreenAfterClick - fullscreenAfterRemote, hiddenAfterClick: true, canvasDvh: `${layout.canvasHeight}/${layout.viewportHeight}` },
      recording: {
        counter: counter.status,
        recElapsedMax: counter.elapsed,
        inputVideoTracks: recorderStartTracks.video,
        inputAudioTracks: recorderStartTracks.audio,
        blobVideoTracks,
        blobAudioTracks,
        blobBytes: recorderEnd.blobBytes,
        chunkBytes: recorderEnd.bytes,
        finalTrackStates: recorderEnd.states,
      },
      protocolStatus: statusFields,
      popupBlocked: popup,
      runtimeExceptions: runtimeExceptions.length,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    cleanup();
    await timeout(200);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

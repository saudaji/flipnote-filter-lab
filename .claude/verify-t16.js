#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS, 'index.html');
const HTTP_PORT = Number(process.env.T16_HTTP_PORT) || 8876;
const CDP_PORT = Number(process.env.T16_CDP_PORT) || 24656;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t16=1`;
const FILE_URL = `${pathToFileURL(INDEX_PATH).href}?t16=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USE_PIPE = process.env.T16_USE_PIPE === '1';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 15000, intervalMs = 25) {
  const started = Date.now();
  let last;
  while (Date.now() - started < limitMs) {
    last = await check();
    if (last) return last;
    await timeout(intervalMs);
  }
  throw new Error(`Timeout esperando ${label}; ultimo=${JSON.stringify(last)}`);
}

function serveDocs() {
  const mime = {
    '.html':'text/html',
    '.js':'text/javascript',
    '.json':'application/json',
    '.png':'image/png',
    '.ttf':'font/ttf',
    '.otf':'font/otf',
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

class PipeCdp {
  constructor(chrome) {
    this.input = chrome.stdio[3];
    this.output = chrome.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.buffer = '';
  }
  async open() {
    this.output.setEncoding('utf8');
    this.output.on('data', chunk => {
      this.buffer += chunk;
      let separator;
      while ((separator = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
          else pending.resolve(message.result || {});
        } else if (message.method) {
          this.sessions.get(message.sessionId)?.events.push(message);
        }
      }
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
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
    try { this.input.destroy(); } catch (_) {}
    try { this.output.destroy(); } catch (_) {}
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
  window.__t16 = { targetCalls:[], warnings:[], errors:[], stubContexts:[] };
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.requestAnimationFrame = cb => nativeSetTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const nativeWarn = console.warn.bind(console);
  const nativeError = console.error.bind(console);
  console.warn = (...args) => {
    __t16.warnings.push(args.map(String).join(' '));
    nativeWarn(...args);
  };
  console.error = (...args) => {
    __t16.errors.push(args.map(String).join(' '));
    nativeError(...args);
  };

  if (window.AudioParam) {
    const nativeTarget = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function(value, startTime, timeConstant) {
      __t16.targetCalls.push({ value, startTime, timeConstant });
      return nativeTarget.call(this, value, startTime, timeConstant);
    };
  }

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (AudioCtor) {
    AudioCtor.prototype.createMediaStreamSource = function() {
      const mix = this.createGain();
      mix._t16Sources = [];
      if (__t16.recordingTone) {
        mix.gain.value = 0.45;
        const oscillator = this.createOscillator();
        oscillator.frequency.value = 937.5;
        oscillator.connect(mix);
        oscillator.start();
        mix._t16Sources.push(oscillator);
        return mix;
      }
      mix.gain.value = 0.18;
      for (const [frequency, lfoRate] of [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]) {
        const oscillator = this.createOscillator();
        const gain = this.createGain();
        const lfo = this.createOscillator();
        const lfoGain = this.createGain();
        oscillator.frequency.value = frequency;
        lfo.frequency.value = lfoRate;
        gain.gain.value = 0.15;
        lfoGain.gain.value = 0.12;
        lfo.connect(lfoGain).connect(gain.gain);
        oscillator.connect(gain).connect(mix);
        oscillator.start();
        lfo.start();
        mix._t16Sources.push(oscillator, lfo);
      }
      return mix;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async constraints => {
    const stream = new MediaStream();
    if (constraints && constraints.video) {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#213547';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvas.captureStream(30).getVideoTracks().forEach(track => stream.addTrack(track));
    }
    if (constraints && constraints.audio && AudioCtor) {
      const audio = new AudioCtor();
      __t16.stubContexts.push(audio);
      const destination = audio.createMediaStreamDestination();
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    }
    return stream;
  };
})()`;

const RUNTIME_PHASE = String.raw`
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const closeContext = async ctx => {
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  };

  cameraRunning = false;
  asciiRunning = false;
  sonoRunning = false;
  wmpRunning = false;
  scrashRunning = false;
  fusionRunning = false;

  async function measureOnsetAndIsolation() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor({ sampleRate:48000 });
    await ctx.resume();
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = 90;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.80;
    const transientAnalyser = ctx.createAnalyser();
    transientAnalyser.fftSize = 1024;
    transientAnalyser.smoothingTimeConstant = 0;
    const sinkA = ctx.createGain();
    const sinkB = ctx.createGain();
    sinkA.gain.value = 0;
    sinkB.gain.value = 0;
    oscillator.connect(gate);
    gate.connect(analyser);
    gate.connect(transientAnalyser);
    analyser.connect(sinkA).connect(ctx.destination);
    transientAnalyser.connect(sinkB).connect(ctx.destination);
    oscillator.start();
    FlipAudioReact.attach(analyser, transientAnalyser);

    for (let i = 0; i < 24; i++) {
      FlipAudioReact.read();
      await wait(5);
    }

    const leadMs = 60;
    const scheduledAt = ctx.currentTime + leadMs / 1000;
    const expectedPerf = performance.now() + leadMs;
    gate.gain.setValueAtTime(0.72, scheduledAt);
    let detectedAt = null;
    let peakTransient = 0;
    const deadline = performance.now() + 180;
    while (performance.now() < deadline) {
      const snapshot = FlipAudioReact.read();
      peakTransient = Math.max(peakTransient, snapshot.transient);
      if (detectedAt == null && snapshot.transient >= 0.45) detectedAt = performance.now();
      await wait(2);
    }

    let treblePeak = 0;
    let bassPeak = 0;
    const isolationDeadline = performance.now() + 420;
    while (performance.now() < isolationDeadline) {
      const snapshot = FlipAudioReact.read();
      treblePeak = Math.max(treblePeak, snapshot.treble);
      bassPeak = Math.max(bassPeak, snapshot.bass);
      await wait(1000 / 60);
    }
    const latencyMs = detectedAt == null ? Infinity : detectedAt - expectedPerf;
    FlipAudioReact.attach(null);
    try { oscillator.stop(); } catch (_) {}
    await closeContext(ctx);
    return {
      latencyMs,
      peakTransient,
      treblePeak,
      bassPeak,
      fft:{ main:analyser.fftSize, transient:transientAnalyser.fftSize },
      smoothing:{ main:analyser.smoothingTimeConstant, transient:transientAnalyser.smoothingTimeConstant },
    };
  }

  async function measureBankOnset() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor({ sampleRate:48000 });
    await ctx.resume();
    const mix = ctx.createGain();
    mix.gain.value = 0.18;
    const sources = [];
    for (const [frequency, lfoRate] of [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.15;
      lfo.frequency.value = lfoRate;
      lfoGain.gain.value = 0.12;
      lfo.connect(lfoGain).connect(gain.gain);
      oscillator.connect(gain).connect(mix);
      oscillator.start();
      lfo.start();
      sources.push(oscillator, lfo);
    }
    const gatedOscillator = ctx.createOscillator();
    gatedOscillator.frequency.value = 1400;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    gatedOscillator.connect(gate).connect(mix);
    gatedOscillator.start();
    sources.push(gatedOscillator);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.80;
    const transientAnalyser = ctx.createAnalyser();
    transientAnalyser.fftSize = 1024;
    transientAnalyser.smoothingTimeConstant = 0;
    const sinkA = ctx.createGain();
    const sinkB = ctx.createGain();
    sinkA.gain.value = 0;
    sinkB.gain.value = 0;
    mix.connect(analyser);
    mix.connect(transientAnalyser);
    analyser.connect(sinkA).connect(ctx.destination);
    transientAnalyser.connect(sinkB).connect(ctx.destination);
    FlipAudioReact.attach(analyser, transientAnalyser);

    for (let i = 0; i < 50; i++) {
      FlipAudioReact.read();
      await wait(5);
    }
    const leadMs = 60;
    const expectedPerf = performance.now() + leadMs;
    gate.gain.setValueAtTime(0.15, ctx.currentTime + leadMs / 1000);
    let detectedAt = null;
    let peakTransient = 0, preGatePeak = 0;
    const deadline = performance.now() + 180;
    while (performance.now() < deadline) {
      const snapshot = FlipAudioReact.read();
      const readAt = performance.now();
      if (readAt < expectedPerf) {
        preGatePeak = Math.max(preGatePeak, snapshot.transient);
      } else {
        peakTransient = Math.max(peakTransient, snapshot.transient);
        if (detectedAt == null && snapshot.transient >= 0.45) detectedAt = readAt;
      }
      await wait(2);
    }
    const latencyMs = detectedAt == null ? Infinity : detectedAt - expectedPerf;
    FlipAudioReact.attach(null);
    for (const source of sources) {
      try { source.stop(); } catch (_) {}
    }
    await closeContext(ctx);
    return { latencyMs, peakTransient, preGatePeak };
  }

  async function measureScaleParity() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor({ sampleRate:48000 });
    await ctx.resume();
    const mix = ctx.createGain();
    mix.gain.value = 0.18;
    const sources = [];
    for (const [frequency, lfoRate] of [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.15;
      lfo.frequency.value = lfoRate;
      lfoGain.gain.value = 0.12;
      lfo.connect(lfoGain).connect(gain.gain);
      oscillator.connect(gain).connect(mix);
      oscillator.start();
      lfo.start();
      sources.push(oscillator, lfo);
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.80;
    const transientAnalyser = ctx.createAnalyser();
    transientAnalyser.fftSize = 1024;
    transientAnalyser.smoothingTimeConstant = 0;
    const sinkA = ctx.createGain();
    const sinkB = ctx.createGain();
    sinkA.gain.value = 0;
    sinkB.gain.value = 0;
    mix.connect(analyser);
    mix.connect(transientAnalyser);
    analyser.connect(sinkA).connect(ctx.destination);
    transientAnalyser.connect(sinkB).connect(ctx.destination);
    FlipAudioReact.attach(analyser, transientAnalyser);

    const bytes = new Uint8Array(analyser.frequencyBinCount);
    const legacySmoothed = { bass:0, mid:0, treble:0, rms:0 };
    const totals = {
      frames:0,
      modern:{ bass:0, mid:0, treble:0, rms:0 },
      legacy:{ bass:0, mid:0, treble:0, rms:0 },
    };
    for (let frame = 0; frame < 200; frame++) {
      const modern = FlipAudioReact.read();
      analyser.getByteFrequencyData(bytes);
      const n = bytes.length;
      const bassEnd = Math.max(1, Math.floor(n * 0.08));
      const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.35));
      let bassSum = 0, midSum = 0, trebSum = 0, sqSum = 0;
      for (let i = 0; i < n; i++) {
        const level = bytes[i] / 255;
        if (i < bassEnd) bassSum += bytes[i];
        else if (i < midEnd) midSum += bytes[i];
        else trebSum += bytes[i];
        sqSum += level * level;
      }
      const legacyRaw = {
        bass:bassSum / (bassEnd * 255),
        mid:midSum / ((midEnd - bassEnd) * 255),
        treble:trebSum / ((n - midEnd) * 255),
        rms:Math.sqrt(sqSum / n),
      };
      for (const key of ['bass','mid','treble','rms']) {
        const current = legacySmoothed[key];
        const target = legacyRaw[key];
        legacySmoothed[key] = current + (target - current) * (target > current ? 0.6 : 0.12);
        if (frame >= 80) {
          totals.modern[key] += modern[key];
          totals.legacy[key] += legacySmoothed[key];
        }
      }
      if (frame >= 80) totals.frames++;
      await wait(16);
    }
    FlipAudioReact.attach(null);
    for (const source of sources) {
      try { source.stop(); } catch (_) {}
    }
    await closeContext(ctx);
    const modern = {}, legacy = {}, relative = {};
    for (const key of ['bass','mid','treble','rms']) {
      modern[key] = totals.modern[key] / totals.frames;
      legacy[key] = totals.legacy[key] / totals.frames;
      relative[key] = Math.abs(modern[key] - legacy[key]) / Math.max(0.001, legacy[key]);
    }
    return { tolerance:0.30, modern, legacy, relative };
  }

  function makeCadenceAnalysers() {
    let frequencyReads = 0;
    const analyser = {
      frequencyBinCount:1024,
      fftSize:2048,
      context:{ sampleRate:48000 },
      getFloatFrequencyData(data) {
        frequencyReads++;
        data.fill(-120);
        for (let i = 0; i <= 10; i++) data[i] = -6;
        for (let i = 11; i <= 85; i++) data[i] = -10;
        for (let i = 86; i <= 341; i++) data[i] = -14;
      },
      getFloatTimeDomainData(data) { data.fill(0.24); },
    };
    const transientAnalyser = {
      fftSize:1024,
      frequencyBinCount:512,
      getFloatTimeDomainData(data) { data.fill(0); },
      getFloatFrequencyData(data) { data.fill(-120); },
    };
    return { analyser, transientAnalyser, reads:() => frequencyReads };
  }

  async function runCadence(fps) {
    const fake = makeCadenceAnalysers();
    FlipAudioReact.attach(fake.analyser, fake.transientAnalyser);
    const interval = 1000 / fps;
    const started = performance.now();
    let next = started;
    let snapshot = null;
    while (next - started <= 600.1) {
      const remaining = next - performance.now();
      if (remaining > 0) await wait(remaining);
      snapshot = FlipAudioReact.read();
      next += interval;
    }
    return { snapshot, elapsedMs:performance.now() - started, reads:fake.reads() };
  }

  async function runAudioCadence(fps) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor({ sampleRate:48000 });
    await ctx.resume();
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = 90;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.80;
    const transientAnalyser = ctx.createAnalyser();
    transientAnalyser.fftSize = 1024;
    transientAnalyser.smoothingTimeConstant = 0;
    const sinkA = ctx.createGain();
    const sinkB = ctx.createGain();
    sinkA.gain.value = 0;
    sinkB.gain.value = 0;
    oscillator.connect(gate);
    gate.connect(analyser);
    gate.connect(transientAnalyser);
    analyser.connect(sinkA).connect(ctx.destination);
    transientAnalyser.connect(sinkB).connect(ctx.destination);
    oscillator.start();
    FlipAudioReact.attach(analyser, transientAnalyser);
    const interval = 1000 / fps;

    async function samplePhase(durationMs) {
      const started = performance.now();
      let next = started;
      const samples = [];
      while (next - started <= durationMs + 0.1) {
        const remaining = next - performance.now();
        if (remaining > 0) await wait(remaining);
        samples.push({ at:performance.now() - started, value:FlipAudioReact.read().bass });
        next += interval;
      }
      return samples;
    }
    await samplePhase(200);
    gate.gain.setValueAtTime(0.72, ctx.currentTime + 0.04);
    await wait(50);
    const attack = await samplePhase(360);
    gate.gain.setValueAtTime(0, ctx.currentTime + 0.04);
    await wait(50);
    const release = await samplePhase(360);
    const area = samples => samples.reduce((sum, sample, index) => {
      if (!index) return sum;
      const dtSeconds = (sample.at - samples[index - 1].at) / 1000;
      return sum + (sample.value + samples[index - 1].value) * 0.5 * dtSeconds;
    }, 0);
    const atTime = (samples, targetMs) => {
      const nextIndex = samples.findIndex(sample => sample.at >= targetMs);
      if (nextIndex <= 0) return samples[Math.max(0, nextIndex)]?.value || 0;
      const before = samples[nextIndex - 1];
      const after = samples[nextIndex];
      const k = (targetMs - before.at) / Math.max(0.001, after.at - before.at);
      return before.value + (after.value - before.value) * k;
    };
    const metrics = {
      peak:Math.max(...attack.map(sample => sample.value)),
      attackArea:area(attack),
      releaseArea:area(release),
      attack100:atTime(attack, 100),
      attack200:atTime(attack, 200),
      attack300:atTime(attack, 300),
      release100:atTime(release, 100),
      release200:atTime(release, 200),
    };
    metrics.attackAreaNormalized = metrics.attackArea / Math.max(0.001, metrics.peak);
    FlipAudioReact.attach(null);
    try { oscillator.stop(); } catch (_) {}
    await closeContext(ctx);
    return metrics;
  }

  const cadence30 = await runCadence(30);
  const cadence60 = await runCadence(60);
  const cadenceRelative = {};
  for (const key of ['bass','mid','treble','rms']) {
    const a = cadence30.snapshot[key];
    const b = cadence60.snapshot[key];
    cadenceRelative[key] = Math.abs(a - b) / Math.max(0.001, a, b);
  }
  const audioCadence30 = await runAudioCadence(30);
  const audioCadence60 = await runAudioCadence(60);
  const audioCadenceRelative = {};
  for (const key of ['attackAreaNormalized']) {
    const a = audioCadence30[key];
    const b = audioCadence60[key];
    audioCadenceRelative[key] = Math.abs(a - b) / Math.max(0.001, a, b);
  }
  const scaleParity = await measureScaleParity();

  const snapshotFake = makeCadenceAnalysers();
  FlipAudioReact.attach(snapshotFake.analyser, snapshotFake.transientAnalyser);
  const immutableSnapshot = _readFlipAudioSnapshot(true);
  const snapshotContract = {
    frozen:Object.isFrozen(immutableSnapshot),
    reads:snapshotFake.reads(),
    keys:Object.keys(immutableSnapshot).sort(),
  };
  FlipAudioReact.attach(null);

  const extBuilt = await _buildExtAudioChain();
  await wait(120);
  const extSnapshot = _readFlipAudioSnapshot(true);
  const extChain = {
    built:extBuilt,
    mainFft:extAnalyser?.fftSize,
    transientFft:extTransientAnalyser?.fftSize,
    transientSmoothing:extTransientAnalyser?.smoothingTimeConstant,
    attached:FlipAudioReact._analyser === extAnalyser &&
      FlipAudioReact._transientAnalyser === extTransientAnalyser,
    energy:extSnapshot ? extSnapshot.bass + extSnapshot.mid + extSnapshot.treble + extSnapshot.rms : 0,
  };
  await _clearExtAudioChain();

  await flipAudioEngine.destroy();
  await flipAudioEngine._ensureContext(false);
  flipAudioEngine._buildGraph();
  const spring = flipAudioEngine.effects.springReverb;
  const automationBefore = __t16.targetCalls.length;
  const settings = _flipCloneSettings(FLIP_AUDIO_DEFAULT_SETTINGS);
  settings.audioMode = 'on';
  settings.effects.lofi.enabled = true;
  settings.effects.springReverb.enabled = true;
  settings.effects.plateReverb.enabled = true;
  settings.effects.echo.enabled = true;
  flipAudioEngine.applySettings(settings);
  const automationCalls = __t16.targetCalls.slice(automationBefore);
  flipAudioEngine._scheduleImpulse('springReverb', 3.1, 2.4);
  await wait(1000);
  const crossfade = {
    slots:spring.convolvers.length,
    gains:spring.irGains.map(node => node.gain.value),
    active:spring.irActive,
    activePointer:spring.convolver === spring.convolvers[spring.irActive],
    size:spring.size,
    decay:spring.decay,
  };
  const automation = {
    calls:automationCalls.length,
    minTau:Math.min(...automationCalls.map(call => call.timeConstant)),
    maxTau:Math.max(...automationCalls.map(call => call.timeConstant)),
  };
  await flipAudioEngine.destroy();

  function spectrogramMetrics(audioBuffer, carrierHz = 937.5) {
    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const size = 256;
    const hop = 64;
    const start = Math.floor(sampleRate * 0.14);
    const end = Math.min(data.length - size, Math.floor(sampleRate * (audioBuffer.duration - 0.12)));
    const magnitudes = [];
    const highRatios = [];
    for (let at = start; at <= end; at += hop) {
      let carrierRe = 0;
      let carrierIm = 0;
      let totalEnergy = 0;
      let highEnergy = 0;
      for (let bin = 0; bin <= size / 2; bin++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < size; i++) {
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
          const sample = data[at + i] * window;
          const angle = 2 * Math.PI * bin * i / size;
          re += sample * Math.cos(angle);
          im -= sample * Math.sin(angle);
        }
        const energy = re * re + im * im;
        totalEnergy += energy;
        if (bin * sampleRate / size >= 5000) highEnergy += energy;
      }
      for (let i = 0; i < size; i++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
        const angle = 2 * Math.PI * carrierHz * i / sampleRate;
        carrierRe += data[at + i] * window * Math.cos(angle);
        carrierIm -= data[at + i] * window * Math.sin(angle);
      }
      magnitudes.push(Math.hypot(carrierRe, carrierIm));
      highRatios.push(highEnergy / Math.max(1e-12, totalEnergy));
    }
    const jumps = [];
    for (let i = 1; i < magnitudes.length; i++) jumps.push(Math.abs(magnitudes[i] - magnitudes[i - 1]));
    jumps.sort((a, b) => a - b);
    highRatios.sort((a, b) => a - b);
    return {
      frames:magnitudes.length,
      maxBandJump:jumps[jumps.length - 1],
      p95BandJump:jumps[Math.floor(jumps.length * 0.95)],
      p95HighRatio:highRatios[Math.floor(highRatios.length * 0.95)],
    };
  }

  async function recordSlider(smooth) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const previousSettings = flipAudioSettings;
    const nativeSmooth = _setAudioParamTarget;
    let blob = null;
    let paintTimer = null;
    let stream = null;
    try {
      const settings = _flipCloneSettings(FLIP_AUDIO_DEFAULT_SETTINGS);
      settings.audioMode = 'on';
      settings.effects.lofi.enabled = true;
      settings.effects.lofi.mix = 0;
      settings.effects.lofi.crush = 16;
      settings.effects.lofi.grit = 0;
      settings.effects.springReverb.enabled = false;
      settings.effects.plateReverb.enabled = false;
      settings.effects.echo.enabled = false;
      flipAudioSettings = settings;
      __t16.recordingTone = true;
      if (!smooth) {
        _setAudioParamTarget = (param, value) => { param.value = value; };
      }
      await flipAudioEngine.destroy();
      const ready = await flipAudioEngine.primeFromGesture(settings);
      if (!ready) throw new Error('FlipAudioEngine no armo REC');
      await wait(180);

      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 72;
      const canvasCtx = canvas.getContext('2d');
      let frame = 0;
      paintTimer = setInterval(() => {
        canvasCtx.fillStyle = frame++ % 2 ? '#101010' : '#181818';
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
      }, 33);
      const canvasStream = canvas.captureStream(30);
      stream = createCombinedStream(canvasStream, flipAudioEngine);
      const mime = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
      ].find(candidate => MediaRecorder.isTypeSupported(candidate)) || '';
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType:mime } : {}),
        videoBitsPerSecond:500000,
        audioBitsPerSecond:128000,
      });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once:true }));
      recorder.start(50);
      await wait(180);
      for (let i = 0; i <= 18; i++) {
        settings.effects.lofi.mix = 100 * i / 18;
        flipAudioEngine.applySettings(settings);
        await wait(24);
      }
      await wait(260);
      recorder.stop();
      await stopped;
      blob = new Blob(chunks, { type:recorder.mimeType || mime });
    } finally {
      if (paintTimer) clearInterval(paintTimer);
      stream?.getTracks().forEach(track => track.stop());
      await flipAudioEngine.destroy();
      _setAudioParamTarget = nativeSmooth;
      __t16.recordingTone = false;
      flipAudioSettings = previousSettings;
    }

    const decodeCtx = new Ctor();
    const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
    const metrics = spectrogramMetrics(decoded);
    await closeContext(decodeCtx);
    return {
      bytes:blob.size,
      mime:blob.type,
      duration:decoded.duration,
      sampleRate:decoded.sampleRate,
      ...metrics,
    };
  }

  const recordingStepped = await recordSlider(false);
  const recordingSmooth = await recordSlider(true);
  const recording = {
    stepped:recordingStepped,
    smooth:recordingSmooth,
    maxJumpRatio:recordingSmooth.maxBandJump / recordingStepped.maxBandJump,
    p95JumpRatio:recordingSmooth.p95BandJump / recordingStepped.p95BandJump,
    highRatio:recordingSmooth.p95HighRatio / recordingStepped.p95HighRatio,
  };

  const onset = await measureOnsetAndIsolation();
  const bankOnset = await measureBankOnset();
  __t16.stubContexts.forEach(ctx => closeContext(ctx));
  return {
    onset,
    bankOnset,
    cadence:{
      deterministic:{ fps30:cadence30, fps60:cadence60, relative:cadenceRelative },
      audio:{ fps30:audioCadence30, fps60:audioCadence60, relative:audioCadenceRelative },
    },
    scaleParity,
    snapshot:snapshotContract,
    extChain,
    automation,
    crossfade,
    recording,
    runtime:{ warnings:__t16.warnings, errors:__t16.errors },
  };
})()
`;

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const marker = '<script>';
  const scriptStart = html.indexOf(marker);
  const scriptEnd = html.lastIndexOf('</script>');
  assert(scriptStart >= 0 && scriptEnd > scriptStart, 'script inline no encontrado');
  assert(html.indexOf(marker, scriptStart + marker.length) < 0, 'mas de un script inline');
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t16-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, html.slice(scriptStart + marker.length, scriptEnd));
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const idCounts = new Map();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const duplicateIds = [...idCounts].filter(([, count]) => count > 1);
  const staticRefs = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const missingStaticRefs = [...new Set(staticRefs.filter(id => !idCounts.has(id) && id !== 'flipSettingsStyle'))];
  assert(duplicateIds.length === 0, `ids duplicados=${JSON.stringify(duplicateIds)}`);
  assert(missingStaticRefs.length === 0, `refs sin id=${JSON.stringify(missingStaticRefs)}`);
  assert(
    /const CACHE = 'flipnote-filter-lab-v89-ascii-atlas'/.test(fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8')),
    'docs/sw.js no conserva el CACHE baseline de T16'
  );

  const server = USE_PIPE ? null : await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t16-chrome-'));
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
    USE_PIPE ? '--remote-debugging-pipe' : `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ], { stdio:USE_PIPE ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });

  let cdp;
  let page;
  try {
    if (USE_PIPE) {
      cdp = await new PipeCdp(chrome).open();
    } else {
      const version = await waitFor(async () => {
        if (chromeExit) throw new Error(`Chrome termino antes de CDP: ${JSON.stringify(chromeExit)}`);
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          return response.ok ? response.json() : false;
        } catch (_) {
          return false;
        }
      }, 'Chrome CDP');
      cdp = await new Cdp(version.webSocketDebuggerUrl).open();
    }
    page = await cdp.createSession();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width:1440,
      height:900,
      deviceScaleFactor:1,
      mobile:false,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:USE_PIPE ? FILE_URL : BASE_URL });
    await waitFor(
      () => evaluate(page, `typeof FlipAudioReact === 'object' && typeof FlipAudioEngine === 'function'`),
      'runtime FLIP'
    );

    const result = await evaluate(page, RUNTIME_PHASE);
    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    if (process.env.T16_VERBOSE === '1') console.error(JSON.stringify(result, null, 2));
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);
    assert(Number.isFinite(result.onset.latencyMs) && result.onset.latencyMs < 30, `onset=${result.onset.latencyMs.toFixed(2)}ms`);
    assert(result.onset.peakTransient >= 0.45, `transient peak=${result.onset.peakTransient.toFixed(4)}`);
    assert(Number.isFinite(result.bankOnset.latencyMs) && result.bankOnset.latencyMs < 30, `onset banco=${result.bankOnset.latencyMs.toFixed(2)}ms`);
    assert(result.bankOnset.peakTransient >= 0.45, `transient banco peak=${result.bankOnset.peakTransient.toFixed(4)}`);
    assert(result.bankOnset.preGatePeak < 0.45, `falso onset banco=${result.bankOnset.preGatePeak.toFixed(4)}`);
    assert(result.onset.treblePeak <= 0.09, `90Hz movio treble=${result.onset.treblePeak.toFixed(5)}`);
    assert(result.onset.bassPeak > result.onset.treblePeak + 0.05, `90Hz no quedo aislado bass=${result.onset.bassPeak.toFixed(5)}`);
    for (const [key, relative] of Object.entries(result.cadence.deterministic.relative)) {
      assert(relative <= 0.10, `${key} difiere ${(relative * 100).toFixed(2)}% entre 30/60fps`);
    }
    for (const [key, relative] of Object.entries(result.cadence.audio.relative)) {
      assert(relative <= 0.10, `${key} Web Audio difiere ${(relative * 100).toFixed(2)}% entre 30/60fps`);
    }
    for (const [key, relative] of Object.entries(result.scaleParity.relative)) {
      assert(relative <= result.scaleParity.tolerance,
        `${key} nuevo/viejo difiere ${(relative * 100).toFixed(2)}%`);
    }
    assert(result.snapshot.frozen, 'snapshot no inmutable');
    assert(result.snapshot.reads === 1, `snapshot hizo ${result.snapshot.reads} lecturas`);
    assert(result.extChain.built && result.extChain.attached, 'cadena EXT no adjunto ambos analysers');
    assert(result.extChain.mainFft === 2048 && result.extChain.transientFft === 1024, `FFT EXT=${result.extChain.mainFft}/${result.extChain.transientFft}`);
    assert(result.extChain.transientSmoothing === 0, `smoothing detector=${result.extChain.transientSmoothing}`);
    assert(result.extChain.energy > 0, 'cadena EXT sin energia');
    assert(result.automation.calls >= 20, `solo ${result.automation.calls} AudioParams automatizados`);
    assert(result.automation.minTau >= 0.02 && result.automation.maxTau <= 0.04, `tau fuera de 20-40ms: ${result.automation.minTau}-${result.automation.maxTau}`);
    assert(result.crossfade.slots === 2 && result.crossfade.activePointer, 'reverb no usa doble convolver activo');
    assert(result.crossfade.active === 1, `IR no cambio de slot: ${result.crossfade.active}`);
    assert(result.crossfade.gains[0] < 0.01 && result.crossfade.gains[1] > 0.99, `crossfade incompleto=${result.crossfade.gains}`);
    assert(result.recording.stepped.bytes > 1000 && result.recording.smooth.bytes > 1000, 'videos A/B vacios');
    assert(result.recording.stepped.duration > 0.6 && result.recording.smooth.duration > 0.6, 'audio de video demasiado corto');
    assert(result.recording.maxJumpRatio < 0.80, `zipper max ratio=${result.recording.maxJumpRatio.toFixed(3)}`);
    assert(result.recording.p95JumpRatio < 0.85, `zipper p95 ratio=${result.recording.p95JumpRatio.toFixed(3)}`);

    console.log(JSON.stringify({
      static:{ syntax:true, duplicateIds:0, missingStaticRefs:0 },
      onset:result.onset,
      bankOnset:result.bankOnset,
      cadence:result.cadence,
      scaleParity:result.scaleParity,
      snapshot:result.snapshot,
      extChain:result.extChain,
      automation:result.automation,
      crossfade:result.crossfade,
      recording:result.recording,
      runtime:{ exceptions:exceptions.length, warnings:result.runtime.warnings.length, errors:result.runtime.errors.length },
    }, null, 2));
  } finally {
    page?.close();
    cdp?.close();
    chrome.kill('SIGTERM');
    if (!chromeExit) {
      await Promise.race([
        new Promise(resolve => chrome.once('exit', resolve)),
        timeout(2000),
      ]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(profileDir, { recursive:true, force:true });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await timeout(100);
      }
    }
    fs.rmSync(checkDir, { recursive:true, force:true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

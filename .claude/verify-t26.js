#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_PATH = path.join(DOCS, 'index.html');
const BASE_COMMIT = '472231c';
const HTTP_PORT = Number(process.env.T26_HTTP_PORT) || 8875;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
    const session = {
      sessionId,
      targetId,
      events:[],
      send:(method, params = {}) => this.send(method, params, sessionId),
      close:() => this.send('Target.closeTarget', { targetId }).catch(() => {}),
    };
    this.sessions.set(sessionId, session);
    return session;
  }
  close() {
    try { this.input.destroy(); } catch (_) {}
    try { this.output.destroy(); } catch (_) {}
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

function prepareFixtures(tempRoot, baselineHtml, currentHtml) {
  for (const [label, html] of [['before', baselineHtml], ['after', currentHtml]]) {
    const dir = path.join(tempRoot, label);
    fs.cpSync(DOCS, dir, { recursive:true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }
}

function serveFixtures(tempRoot) {
  const runner = '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;background:#111;color:#fff;font:14px monospace;overflow:hidden}' +
    '#labels{height:28px;display:grid;grid-template-columns:390px 390px;text-align:center;align-items:center}' +
    '#frames{display:flex;gap:0}iframe{width:390px;height:844px;border:0;background:#000}' +
    '</style><div id="labels"><b>MAIN 472231c</b><b>T26</b></div><div id="frames">' +
    '<iframe id="before" src="/before/index.html?t26=before"></iframe>' +
    '<iframe id="after" src="/after/index.html?t26=after"></iframe></div>';
  const mime = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png', '.ttf':'font/ttf', '.otf':'font/otf' };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    if (pathname === '/' || pathname === '/runner.html') {
      res.writeHead(200, { 'Content-Type':'text/html' });
      res.end(runner);
      return;
    }
    const file = path.resolve(tempRoot, `.${pathname}`);
    if (!file.startsWith(`${tempRoot}${path.sep}`)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

const INIT_SCRIPT = String.raw`
(() => {
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('stub only', 'NotAllowedError'); };
})()`;

const FRAME_SUITE = String.raw`
window.__t26Run = async function() {
  const makeSource = (w = 1280, h = 720) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#07131f');
    gradient.addColorStop(0.45, '#e1a346');
    gradient.addColorStop(1, '#175f78');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f7f3dd'; ctx.fillRect(w * 0.12, h * 0.16, w * 0.27, h * 0.31);
    ctx.fillStyle = '#10151c'; ctx.beginPath(); ctx.arc(w * 0.68, h * 0.43, h * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f4572e'; ctx.lineWidth = Math.max(4, h * 0.035);
    ctx.beginPath(); ctx.moveTo(w * 0.08, h * 0.82); ctx.bezierCurveTo(w * 0.32, h * 0.54, w * 0.62, h * 0.94, w * 0.92, h * 0.66); ctx.stroke();
    for (let x = 0; x < w; x += Math.max(8, w / 20)) {
      ctx.fillStyle = Math.round(x / Math.max(8, w / 20)) % 2 ? '#292f48' : '#d9d36b';
      ctx.fillRect(x, h * 0.9, Math.max(8, w / 20), h * 0.1);
    }
    return canvas;
  };
  const makeCanvas = (w, h, smoothing) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently:true });
    if (typeof smoothing === 'boolean') ctx.imageSmoothingEnabled = smoothing;
    return { canvas, ctx };
  };
  const clone = canvas => {
    const copy = makeCanvas(canvas.width, canvas.height, false);
    copy.ctx.drawImage(canvas, 0, 0);
    return copy.canvas;
  };
  const source = makeSource();
  const artifacts = { glow:{}, oscam:{}, blit:{ CAM:{}, EDIT:{} } };
  const blur = {};
  const ctxProto = CanvasRenderingContext2D.prototype;
  const nativeDrawImage = ctxProto.drawImage;
  let trackedFamily = '';
  ctxProto.drawImage = function(...args) {
    if (trackedFamily && String(this.filter).startsWith('blur(')) {
      const src = args[0];
      const dw = args.length >= 9 ? Math.abs(args[7]) : args.length >= 5 ? Math.abs(args[3]) : Math.abs(src.width || 0);
      const dh = args.length >= 9 ? Math.abs(args[8]) : args.length >= 5 ? Math.abs(args[4]) : Math.abs(src.height || 0);
      const row = blur[trackedFamily] || (blur[trackedFamily] = { draws:0, pixels:0 });
      row.draws++; row.pixels += dw * dh;
    }
    return nativeDrawImage.apply(this, args);
  };
  try {
    trackedFamily = 'DLPHN';
    camVariant = 'STD'; dlpColorMode = 'AQUA'; dlpContrastVal = 100; dlpResonanceVal = 72;
    let output = makeCanvas(1024, 768, false);
    _renderDolphinCore(source, source.width, source.height, output.ctx, false, {
      sampleW:256, sampleH:192, outW:1024, outH:768, scanCanvas:false, forceCPU:true,
    });
    artifacts.glow.DLPHN = output.canvas;

    trackedFamily = 'VFD';
    camVariant = 'STD'; vfdActivePal = 0; vfdCustomPal = null;
    output = makeCanvas(1024, 768, false);
    _renderVfdCore(source, source.width, source.height, output.ctx, false, {
      sampleW:256, sampleH:192, outW:1024, outH:768, forceCPU:true,
    });
    artifacts.glow.VFD = output.canvas;

    trackedFamily = 'AUTO03';
    camVariant = 'NIGHT'; auto03ToneMode = 'STD'; auto03SharpMode = 'STD'; auto03NoiseMode = 'STD';
    output = makeCanvas(1024, 768, false);
    _renderAuto03Core(source, source.width, source.height, output.ctx, false, 1234, {
      sampleW:256, sampleH:192, outW:1024, outH:768,
    });
    artifacts.glow.AUTO03 = output.canvas;
  } finally {
    trackedFamily = '';
    ctxProto.drawImage = nativeDrawImage;
  }

  const modes = [
    ['DSI', 'dsi-bayer', { palette:[[8,18,10],[203,219,166]], autoLevels:false }],
    ['DLPHN', 'dolphin', { palette:[[0,13,13],[0,42,68],[0,119,153],[0,229,204]], contrast:1 }],
    ['CASKIA', 'caskia-std', { palette:[[164,172,130],[110,120,84],[48,60,32],[22,28,10]] }],
    ['VFD', 'vfd-std', { palette:[[2,8,4],[8,40,20],[16,96,50],[24,164,92],[88,224,144],[206,255,224]] }],
  ];
  const sample = makeSource(256, 192);
  for (const item of modes) {
    _camPaletteWebGLEngine.render(sample, 256, 192, item[1], item[2]);
    const result = typeof _camPaletteWebGLEngine.getResultSource === 'function'
      ? _camPaletteWebGLEngine.getResultSource()
      : _camPaletteWebGLEngine.getResultCanvas();
    for (const consumer of ['CAM', 'EDIT']) {
      const targetCanvas = consumer === 'CAM' ? display : editCanvas;
      const targetCtx = consumer === 'CAM' ? ctxD : ctxEdit;
      targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      if (result && result.canvas) {
        targetCtx.drawImage(result.canvas, result.sx, result.sy, result.sw, result.sh, 0, 0, targetCanvas.width, targetCanvas.height);
      } else {
        targetCtx.drawImage(result, 0, 0, targetCanvas.width, targetCanvas.height);
      }
      artifacts.blit[consumer][item[0]] = clone(targetCanvas);
    }
  }

  const glProto = WebGLRenderingContext.prototype;
  const nativeTexImage2D = glProto.texImage2D;
  const nativeTexSubImage2D = glProto.texSubImage2D;
  const upload = { frames:60, texImageBytes:0, texSubBytes:0, texImageSourceCalls:0, texSubSourceCalls:0 };
  glProto.texImage2D = function(...args) {
    const input = args[5];
    if (input && typeof input.width === 'number' && typeof input.height === 'number') {
      upload.texImageSourceCalls++;
      upload.texImageBytes += input.width * input.height * 4;
    }
    return nativeTexImage2D.apply(this, args);
  };
  glProto.texSubImage2D = function(...args) {
    const input = args[6];
    if (input && typeof input.width === 'number' && typeof input.height === 'number') {
      upload.texSubSourceCalls++;
      upload.texSubBytes += input.width * input.height * 4;
    }
    return nativeTexSubImage2D.apply(this, args);
  };
  const oscamCases = [
    ['STD', 'STD', 'GREEN', 42, 56, 62, 48, 46],
    ['WAVE', 'WAVE', 'RED', 68, 38, 74, 58, 32],
    ['STATIC', 'STATIC', 'BLUE', 55, 72, 80, 44, 76],
  ];
  const nativeNow = performance.now.bind(performance);
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let frameNow = 1000;
  Object.defineProperty(performance, 'now', { configurable:true, value:() => frameNow });
  try {
    for (const test of oscamCases) {
      camVariant = test[1] === 'STD' ? 'STD' : 'LGCY';
      oscamLegacyMode = test[1] === 'STD' ? 'WAVE' : test[1];
      oscamColorMode = test[2];
      oscamIntensityVal = test[3]; oscamDetailVal = test[4]; oscamPresenceVal = test[5];
      oscamTraceVal = test[6]; oscamDefinitionVal = test[7];
      _resetOscamPersistence();
      const output = makeCanvas(480, 360, true);
      for (let frame = 0; frame < 20; frame++) {
        frameNow = 1000 + frame * (1000 / 30);
        renderOscam(source, source.width, source.height, output.ctx, false);
      }
      artifacts.oscam[test[0]] = output.canvas;
    }
  } finally {
    if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
    else delete performance.now;
    glProto.texImage2D = nativeTexImage2D;
    glProto.texSubImage2D = nativeTexSubImage2D;
  }
  upload.bytes = upload.texImageBytes + upload.texSubBytes;
  upload.mbPerSecond30 = upload.bytes / (oscamCases.length * 20) * 30 / 1e6;

  const styleSelectors = ['#btnMicMobile', '#btnAudioIO', '.flip-settings-trigger', '#camControlInner', '#flipExportBar'];
  const readStyles = () => Object.fromEntries(styleSelectors.map(selector => {
    const style = getComputedStyle(document.querySelector(selector));
    return [selector, {
      backgroundColor:style.backgroundColor,
      backdropFilter:style.backdropFilter || style.webkitBackdropFilter || 'none',
    }];
  }));
  document.body.classList.add('cam-ui-active');
  document.getElementById('camControlDock').classList.add('visible');
  document.getElementById('flipExportBar').classList.add('visible');
  splash.style.display = 'none';
  display.style.display = 'block';
  ctxD.clearRect(0, 0, display.width, display.height);
  ctxD.drawImage(artifacts.glow.VFD, 0, 0, display.width, display.height);
  const mobileStyles = readStyles();

  const captures = {};
  const captureCases = [
    ['DLPHN', 'STD'], ['VFD', 'STD'], ['AUTO03', 'NIGHT'], ['OSCAM', 'STD'],
  ];
  if (location.pathname.includes('/after/')) for (const test of captureCases) {
    camFamily = test[0]; camVariant = test[1];
    if (test[0] === 'OSCAM') oscamLegacyMode = 'WAVE';
    const target = makeCanvas(320, 240, true);
    _renderCamEngineFrame(source, source.width, source.height, target.ctx, false, {
      family:test[0], variant:test[1], path:'capture', resolution:'low', outW:320, outH:240, now:2222,
    });
    const data = target.ctx.getImageData(0, 0, 320, 240).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 12) nonBlack++;
    const snap = await new Promise(resolve => target.canvas.toBlob(resolve, 'image/jpeg', 0.9));
    let recBytes = 0;
    let recType = '';
    if (typeof MediaRecorder !== 'undefined' && typeof target.canvas.captureStream === 'function') {
      const stream = target.canvas.captureStream(8);
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const started = new Promise(resolve => { recorder.onstart = resolve; });
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start(50);
      await Promise.race([started, new Promise(resolve => setTimeout(resolve, 1000))]);
      const track = stream.getVideoTracks()[0];
      for (let frame = 0; frame < 4; frame++) {
        target.ctx.fillStyle = frame & 1 ? '#010101' : '#020202';
        target.ctx.fillRect(frame, 0, 1, 1);
        if (track && typeof track.requestFrame === 'function') track.requestFrame();
        await new Promise(resolve => setTimeout(resolve, 70));
      }
      if (recorder.state === 'recording') {
        try { recorder.requestData(); } catch (_) {}
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (recorder.state === 'recording') recorder.stop();
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000))]);
      stream.getTracks().forEach(trackItem => trackItem.stop());
      const blob = new Blob(chunks, { type:recorder.mimeType || chunks[0]?.type || 'video/webm' });
      recBytes = blob.size; recType = blob.type;
    }
    captures[test[0]] = {
      snapBytes:snap ? snap.size : 0,
      snapType:snap ? snap.type : '',
      nonBlackPixels:nonBlack,
      totalPixels:320 * 240,
      recBytes,
      recType,
    };
  }

  return { artifacts, blur, upload, mobileStyles, captures };
};`;

function comparisonExpression() {
  return `(async () => {
    const beforeFrame = document.getElementById('before');
    const afterFrame = document.getElementById('after');
    const frames = [beforeFrame, afterFrame];
    const wait = async check => {
      const started = performance.now();
      while (performance.now() - started < 15000) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('timeout frames T26');
    };
    await wait(() => frames.every(frame => frame.contentDocument &&
      frame.contentDocument.readyState === 'complete' &&
      frame.contentWindow.eval('typeof _camPaletteWebGLEngine === "object"')));
    const suiteSource = ${JSON.stringify(FRAME_SUITE)};
    for (const frame of frames) frame.contentWindow.eval(suiteSource);
    const before = await beforeFrame.contentWindow.__t26Run();
    const after = await afterFrame.contentWindow.__t26Run();
    afterFrame.style.flex = '0 0 1024px';
    afterFrame.style.width = '1024px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterDesktop = afterFrame.contentWindow.eval(\`(() => {
      const selectors = ['#btnMicMobile', '#btnAudioIO', '.flip-settings-trigger', '#camControlInner', '#flipExportBar'];
      return Object.fromEntries(selectors.map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return [selector, {
          backgroundColor:style.backgroundColor,
          backdropFilter:style.backdropFilter || style.webkitBackdropFilter || 'none',
        }];
      }));
    })()\`);
    afterFrame.style.flex = '0 0 390px';
    afterFrame.style.width = '390px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pixels = canvas => canvas.getContext('2d', { willReadFrequently:true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const compare = (leftCanvas, rightCanvas) => {
      const a = pixels(leftCanvas), b = pixels(rightCanvas);
      let changedPixels = 0, totalDelta = 0, maxDelta = 0;
      const histA = new Array(16).fill(0), histB = new Array(16).fill(0);
      let lumA = 0, lumB = 0, covariance = 0, varianceA = 0, varianceB = 0;
      const lumsA = new Float32Array(a.length / 4), lumsB = new Float32Array(a.length / 4);
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (delta) changedPixels++;
        totalDelta += delta; maxDelta = Math.max(maxDelta, delta);
        const la = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
        const lb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
        lumsA[p] = la; lumsB[p] = lb; lumA += la; lumB += lb;
        histA[Math.min(15, la >> 4)]++; histB[Math.min(15, lb >> 4)]++;
      }
      const count = a.length / 4;
      lumA /= count; lumB /= count;
      for (let i = 0; i < lumsA.length; i++) {
        const da = lumsA[i] - lumA, db = lumsB[i] - lumB;
        covariance += da * db; varianceA += da * da; varianceB += db * db;
      }
      const bucketDeltasPct = histA.map((value, index) => Math.abs(value - histB[index]) / count * 100);
      return {
        changedPixels, totalPixels:count,
        meanChannelDelta:totalDelta / count / 3, maxDelta,
        correlation:covariance / Math.sqrt(Math.max(1e-9, varianceA * varianceB)),
        meanLuminance:{ before:lumA, after:lumB, deltaPct:Math.abs(lumB - lumA) / Math.max(1, lumA) * 100 },
        histogram:{ maxBucketDeltaPct:Math.max(...bucketDeltasPct), bucketDeltasPct },
      };
    };
    const glow = {}, oscam = {}, blit = { CAM:{}, EDIT:{} };
    for (const family of ['DLPHN', 'VFD', 'AUTO03']) glow[family] = compare(before.artifacts.glow[family], after.artifacts.glow[family]);
    for (const mode of ['STD', 'WAVE', 'STATIC']) oscam[mode] = compare(before.artifacts.oscam[mode], after.artifacts.oscam[mode]);
    for (const consumer of ['CAM', 'EDIT']) for (const family of ['DSI', 'DLPHN', 'CASKIA', 'VFD']) {
      blit[consumer][family] = compare(before.artifacts.blit[consumer][family], after.artifacts.blit[consumer][family]);
    }
    const makeMatrix = (groups, width, cellW, cellH) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = groups.length * (cellH + 24);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff'; ctx.font = '14px monospace'; ctx.textBaseline = 'top';
      groups.forEach((group, row) => {
        const y = row * (cellH + 24);
        ctx.fillText(group[0] + ' / MAIN', 4, y + 4);
        ctx.fillText(group[0] + ' / T26', cellW + 4, y + 4);
        ctx.drawImage(group[1], 0, y + 24, cellW, cellH);
        ctx.drawImage(group[2], cellW, y + 24, cellW, cellH);
      });
      return canvas.toDataURL('image/png');
    };
    const glowMatrix = makeMatrix(['DLPHN','VFD','AUTO03'].map(name =>
      [name, before.artifacts.glow[name], after.artifacts.glow[name]]), 1024, 512, 384);
    const oscamMatrix = makeMatrix(['STD','WAVE','STATIC'].map(name =>
      [name, before.artifacts.oscam[name], after.artifacts.oscam[name]]), 960, 480, 360);
    const blitMatrix = makeMatrix(['DSI','DLPHN','CASKIA','VFD'].map(name =>
      [name, before.artifacts.blit.EDIT[name], after.artifacts.blit.EDIT[name]]), 1024, 512, 384);
    return {
      glow, oscam, blit,
      traffic:{ blur:{ before:before.blur, after:after.blur }, upload:{ before:before.upload, after:after.upload } },
      styles:{ beforeMobile:before.mobileStyles, afterMobile:after.mobileStyles, afterDesktop },
      captures:after.captures,
      matrices:{ glowMatrix, oscamMatrix, blitMatrix },
    };
  })()`;
}

async function main() {
  assert(HTTP_PORT !== 8742, 'T26 debe usar un puerto distinto de 8742');
  const currentHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  const baseline = spawnSync('git', ['show', `${BASE_COMMIT}:docs/index.html`], {
    cwd:ROOT, encoding:'utf8', maxBuffer:16 * 1024 * 1024,
  });
  assert(baseline.status === 0, `baseline ${BASE_COMMIT}: ${baseline.stderr}`);
  const baselineSw = spawnSync('git', ['show', `${BASE_COMMIT}:docs/sw.js`], {
    cwd:ROOT, encoding:'utf8', maxBuffer:1024 * 1024,
  });
  assert(baselineSw.status === 0, `baseline SW ${BASE_COMMIT}: ${baselineSw.stderr}`);
  const scripts = [...currentHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  new Function(scripts[0]);
  const baseBuild = baseline.stdout.match(/const FLIP_BUILD = '([^']+)'/)?.[1];
  const currentBuild = currentHtml.match(/const FLIP_BUILD = '([^']+)'/)?.[1];
  const currentSw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const baseCache = baselineSw.stdout.match(/const CACHE = '([^']+)'/)?.[1];
  const currentCache = currentSw.match(/const CACHE = '([^']+)'/)?.[1];
  assert(baseBuild === currentBuild && baseCache === currentCache,
    `versiones cambiaron=${JSON.stringify({ baseBuild, currentBuild, baseCache, currentCache })}`);
  const oscamSection = currentHtml.slice(
    currentHtml.indexOf('const _oscamWebGLEngine'),
    currentHtml.indexOf('// SLHT CAM', currentHtml.indexOf('const _oscamWebGLEngine')),
  );
  assert(/const FINAL_W = 512/.test(oscamSection) && /const FINAL_H = 384/.test(oscamSection) &&
    /texSubImage2D\(gl\.TEXTURE_2D, 0, 0, 0, gl\.RGBA, gl\.UNSIGNED_BYTE, inputCanvas\)/.test(oscamSection),
  'OSCAM no conserva targets 512x384 + texSub');
  assert(!/getResultCanvas/.test(currentHtml) && /function getResultSource\(\)/.test(currentHtml),
    'motor de paleta conserva el canvas 2D intermedio');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t26-fixtures-'));
  prepareFixtures(tempRoot, baseline.stdout, currentHtml);
  const server = await serveFixtures(tempRoot);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t26-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, '--remote-debugging-pipe', 'about:blank',
  ], { stdio:['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const browser = await new PipeCdp(chrome).open();
  const page = await browser.createSession();
  const cleanup = () => {
    page.close();
    browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    server.close();
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(tempRoot, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width:780, height:872, deviceScaleFactor:1, mobile:true, screenWidth:780, screenHeight:872,
    });
    await page.send('Page.navigate', { url:`http://127.0.0.1:${HTTP_PORT}/runner.html` });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'runner T26');
    const results = await evaluate(page, comparisonExpression());

    for (const [family, result] of Object.entries(results.glow)) {
      assert(result.histogram.maxBucketDeltaPct <= 10, `${family} histograma=${JSON.stringify(result)}`);
      assert(result.meanLuminance.deltaPct <= 10, `${family} luminancia=${JSON.stringify(result)}`);
    }
    for (const [mode, result] of Object.entries(results.oscam)) {
      assert(result.correlation >= 0.99, `OSCAM ${mode} correlacion=${JSON.stringify(result)}`);
    }
    for (const [consumer, families] of Object.entries(results.blit)) {
      for (const [family, result] of Object.entries(families)) {
        assert(result.changedPixels === 0, `blit ${consumer}/${family}=${JSON.stringify(result)}`);
      }
    }
    for (const family of ['DLPHN', 'VFD', 'AUTO03']) {
      const before = results.traffic.blur.before[family].pixels;
      const after = results.traffic.blur.after[family].pixels;
      const reductionPct = (1 - after / before) * 100;
      results.traffic.blur.after[family].reductionPct = reductionPct;
      results.traffic.blur.before[family].mpxPerSecond60 = before * 60 / 1e6;
      results.traffic.blur.after[family].mpxPerSecond60 = after * 60 / 1e6;
      assert(reductionPct >= 60, `${family} reduccion glow=${reductionPct}`);
    }
    const uploadBefore = results.traffic.upload.before.mbPerSecond30;
    const uploadAfter = results.traffic.upload.after.mbPerSecond30;
    results.traffic.upload.reductionPct = (1 - uploadAfter / uploadBefore) * 100;
    assert(results.traffic.upload.reductionPct >= 50, `OSCAM upload=${JSON.stringify(results.traffic.upload)}`);
    for (const [selector, style] of Object.entries(results.styles.afterMobile)) {
      assert(style.backdropFilter === 'none', `backdrop movil ${selector}=${JSON.stringify(style)}`);
      const alpha = Number(style.backgroundColor.match(/[\d.]+\)$/)?.[0]?.replace(')', '') || 1);
      assert(!style.backgroundColor.startsWith('rgba') || alpha === 1, `fondo no solido ${selector}=${style.backgroundColor}`);
    }
    for (const [selector, style] of Object.entries(results.styles.afterDesktop)) {
      assert(style.backdropFilter.includes('blur'), `blur desktop ${selector}=${JSON.stringify(style)}`);
    }
    for (const [family, capture] of Object.entries(results.captures)) {
      assert(capture.snapBytes > 0 && capture.snapType === 'image/jpeg', `SNAP ${family}=${JSON.stringify(capture)}`);
      assert(capture.nonBlackPixels / capture.totalPixels > 0.1, `frame negro ${family}=${JSON.stringify(capture)}`);
      assert(capture.recBytes > 0 && capture.recType.startsWith('video/'), `REC ${family}=${JSON.stringify(capture)}`);
    }

    const artifactDir = path.join(os.tmpdir(), 'flip-t26-artifacts');
    fs.mkdirSync(artifactDir, { recursive:true });
    const artifacts = {};
    for (const [name, dataUrl] of Object.entries(results.matrices)) {
      const file = path.join(artifactDir, name.replace('Matrix', '-ab') + '.png');
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      artifacts[name] = { path:file, bytes:fs.statSync(file).size };
    }
    delete results.matrices;
    const mobileShot = await page.send('Page.captureScreenshot', { format:'png', fromSurface:true });
    const mobilePath = path.join(artifactDir, 'mobile-ab.png');
    fs.writeFileSync(mobilePath, Buffer.from(mobileShot.data, 'base64'));
    artifacts.mobile = { path:mobilePath, bytes:fs.statSync(mobilePath).size };

    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);
    process.stdout.write(`${JSON.stringify({
      baseline:BASE_COMMIT,
      port:HTTP_PORT,
      static:{ inlineScripts:scripts.length, syntax:true, build:currentBuild, cache:currentCache },
      ...results,
      artifacts,
      runtimeExceptions:exceptions.length,
    }, null, 2)}\n`);
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
    await timeout(200);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

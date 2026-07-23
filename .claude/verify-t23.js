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
const HTTP_PORT = Number(process.env.T23_HTTP_PORT) || 8894;
const CDP_PORT = Number(process.env.T23_CDP_PORT) || 24694;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html?t23=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACT_DIR = path.join(__dirname, 't23-artifacts');
const REPORT_PATH = path.join(__dirname, 'T23-REPORT.md');
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 20000, intervalMs = 25) {
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
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  window.__t23 = { errors:[], warnings:[] };
  const nativeError = console.error.bind(console);
  const nativeWarn = console.warn.bind(console);
  console.error = (...args) => { __t23.errors.push(args.map(String).join(' ')); nativeError(...args); };
  console.warn = (...args) => { __t23.warnings.push(args.map(String).join(' ')); nativeWarn(...args); };
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async () => { throw new DOMException('T23 sin camara', 'NotAllowedError'); };
})();
`;

async function preparePage(browser, mobile = false) {
  const page = await browser.createSession();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled:true });
  await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
  await page.send('Emulation.setDeviceMetricsOverride', mobile ? {
    width:390,
    height:844,
    screenWidth:390,
    screenHeight:844,
    deviceScaleFactor:2,
    mobile:true,
    screenOrientation:{ type:'portraitPrimary', angle:0 },
  } : {
    width:1440,
    height:900,
    screenWidth:1440,
    screenHeight:900,
    deviceScaleFactor:1,
    mobile:false,
  });
  if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
  await page.send('Page.navigate', { url:BASE_URL + (mobile ? '&mobile=1' : '&desktop=1') });
  await waitFor(
    () => evaluate(page, `document.readyState === 'complete' && typeof _getAsciiDensityMetrics === 'function' && !!_asciiWorker`),
    mobile ? 'runtime movil T23' : 'runtime desktop T23'
  );
  return page;
}

const SETUP_SOURCE = String.raw`
(() => {
  splash.classList.add('hidden');
  cameraRunning = false;
  asciiRunning = false;
  const source = document.createElement('canvas');
  source.width = 960;
  source.height = 720;
  const ctx = source.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, source.width, source.height);
  grad.addColorStop(0, '#050505');
  grad.addColorStop(0.35, '#ff5b23');
  grad.addColorStop(0.68, '#f4efcf');
  grad.addColorStop(1, '#1325a8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, source.width, source.height);
  ctx.fillStyle = '#050505';
  ctx.beginPath();
  ctx.arc(260, 330, 205, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4efcf';
  ctx.beginPath();
  ctx.arc(260, 330, 115, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.fillRect(520, 100, 285, 470);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 18;
  for (let y = 125; y < 565; y += 58) {
    ctx.beginPath();
    ctx.moveTo(540, y);
    ctx.lineTo(785, y + 34);
    ctx.stroke();
  }
  ctx.fillStyle = '#ff5b23';
  ctx.font = 'bold 90px monospace';
  ctx.fillText('FLIP', 72, 665);
  window.__t23Source = source;
  asciiStaticSrc = source;
  asciiStaticW = source.width;
  asciiStaticH = source.height;
  asciiSubMode = 'classic';
  acBrightVal = 100;
  acContrastVal = 100;
  acSatVal = 100;
  acHueVal = 0;
  acGrayVal = 0;
  acSepiaVal = 0;
  acInvertVal = 0;
  acThreshOn = false;
  acSharpOn = false;
  acEdgeOn = false;
  acGradientVal = 'normal';
  acSpaceVal = 1;
  acFrameVal = 0;
  acQualityVal = 'none';
  pySubMode = 'off';
  asciiFont = 'monospace';
  activeTab = 'ascii';
  asciiArea.classList.add('visible');
  display.classList.remove('visible');
  relayout();
  return true;
})()
`;

const RENDER_AT_DENSITY = raw => String.raw`
(async () => {
  const wait = async (check, label, limit = 30000) => {
    const start = performance.now();
    while (performance.now() - start < limit) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('timeout ' + label);
  };
  asciiDensity = _clampAsciiDensity(${raw});
  asciiClassicCols = _asciiDensityToCols(asciiDensity);
  asciiCols = asciiClassicCols;
  _resetAsciiDensityBudget();
  _syncAsciiColsUI();
  const acceptedBefore = _asciiWorkerStats.acceptedFrames;
  renderASCII(__t23Source, __t23Source.width, __t23Source.height, false, false);
  await wait(() => !_asciiWorkerBusy && _asciiWorkerStats.acceptedFrames > acceptedBefore, 'worker density ${raw}');
  const metrics = _getAsciiDensityMetrics();
  return {
    metrics,
    renderMs:_asciiWorkerStats.lastRenderMs,
    dataUrl:asciiCvs.toDataURL('image/png'),
  };
})()
`;

const DESKTOP_CHECKS = String.raw`
(async () => {
  const monotonic = { cols:true, rows:true, width:true, height:true, sampleW:true, sampleH:true };
  let previous = null;
  for (let density = 0; density <= 1000; density++) {
    const cols = _asciiDensityToCols(density);
    const metrics = _getAsciiDensityMetrics(cols);
    const current = { cols, rows:metrics.rows, width:metrics.width, height:metrics.height, sampleW:metrics.sampleW, sampleH:metrics.sampleH };
    if (previous) {
      for (const key of Object.keys(monotonic)) {
        if (current[key] < previous[key]) monotonic[key] = false;
      }
    }
    previous = current;
  }

  // The page enters this phase with the real 720-col worker frame still painted.
  // Exercise the actual FOTO button before parity tests resize/clear the canvas.
  let savedPhoto = null;
  const originalSaveBlob = saveBlob;
  saveBlob = async (blob, name) => { savedPhoto = { blob, name }; };
  asciiCamMode = 'foto';
  document.getElementById('btnAsciiCapture').click();
  const photoStart = performance.now();
  while (!savedPhoto && performance.now() - photoStart < 10000) await new Promise(resolve => setTimeout(resolve, 20));
  saveBlob = originalSaveBlob;
  if (!savedPhoto) throw new Error('FOTO ASCII no produjo blob');
  const photoBitmap = await createImageBitmap(savedPhoto.blob);
  const photoProbe = document.createElement('canvas');
  photoProbe.width = 64;
  photoProbe.height = 48;
  const photoProbeCtx = photoProbe.getContext('2d', { willReadFrequently:true });
  photoProbeCtx.drawImage(photoBitmap, 0, 0, photoProbe.width, photoProbe.height);
  const photoPixels = photoProbeCtx.getImageData(0, 0, photoProbe.width, photoProbe.height).data;
  let photoMin = 255, photoMax = 0;
  for (let i = 0; i < photoPixels.length; i += 4) {
    const lum = photoPixels[i] * 0.299 + photoPixels[i + 1] * 0.587 + photoPixels[i + 2] * 0.114;
    photoMin = Math.min(photoMin, lum);
    photoMax = Math.max(photoMax, lum);
  }
  const photo = {
    width:photoBitmap.width,
    height:photoBitmap.height,
    bytes:savedPhoto.blob.size,
    type:savedPhoto.blob.type,
    name:savedPhoto.name,
    luminanceRange:+(photoMax - photoMin).toFixed(2),
  };
  photoBitmap.close();

  const recOptions = _getAsciiRecordingOptions();
  const recJob = await _createFlipRecordingJob(asciiCvs, 15, 6_000_000, recOptions);
  const recChunks = [];
  const recStartedAt = performance.now();
  const recStopped = new Promise((resolve, reject) => {
    recJob.recorder.addEventListener('dataavailable', event => {
      if (event.data && event.data.size) recChunks.push(event.data);
    });
    recJob.recorder.addEventListener('stop', resolve, { once:true });
    recJob.recorder.addEventListener('error', () => reject(recJob.recorder.error || new Error('REC ASCII error')), { once:true });
  });
  recJob.recorder.start(100);
  await new Promise(resolve => setTimeout(resolve, 650));
  recJob.recorder.stop();
  await recStopped;
  recJob.cleanup();
  if (!recChunks.length) throw new Error('REC ASCII no produjo chunks');
  const recResult = await _makeRecordedBlob(recChunks, recJob.mime, recStartedAt);
  const recVideo = document.createElement('video');
  recVideo.muted = true;
  recVideo.playsInline = true;
  const recUrl = URL.createObjectURL(recResult.blob);
  recVideo.src = recUrl;
  await Promise.race([
    new Promise((resolve, reject) => {
      recVideo.addEventListener('loadedmetadata', resolve, { once:true });
      recVideo.addEventListener('error', () => reject(new Error('metadata REC ASCII invalida')), { once:true });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout metadata REC ASCII')), 10000)),
  ]);
  const rec = {
    width:recVideo.videoWidth,
    height:recVideo.videoHeight,
    requestedWidth:recOptions.dims.width,
    requestedHeight:recOptions.dims.height,
    bytes:recResult.blob.size,
    type:recResult.mime,
    duration:+recVideo.duration.toFixed(3),
    aspect:recOptions.dims.aspect,
  };
  URL.revokeObjectURL(recUrl);

  const parity = cols => {
    asciiDensity = _asciiColsToDensity(cols);
    asciiClassicCols = cols;
    asciiCols = cols;
    _resetAsciiDensityBudget();
    _syncAsciiDensityCanvas();
    const sample = document.createElement('canvas');
    sample.width = 512;
    sample.height = 384;
    const sampleCtx = sample.getContext('2d', { willReadFrequently:true });
    sampleCtx.drawImage(__t23Source, 0, 0, 512, 384);
    const pixels = sampleCtx.getImageData(0, 0, 512, 384).data;
    _renderASCIISync(pixels, 512, 384, cols, false);
    const actual = ctxAscii.getImageData(0, 0, OUT_W, OUT_H).data;

    const reference = document.createElement('canvas');
    reference.width = OUT_W;
    reference.height = OUT_H;
    const ref = reference.getContext('2d');
    const colors = _getAsciiClassicColors(false);
    const gray = new Float32Array(512 * 384);
    let minG = 255, maxG = 0;
    for (let i = 0; i < gray.length; i++) {
      const p = i << 2;
      const value = asciiPixelLum(pixels[p], pixels[p + 1], pixels[p + 2]);
      gray[i] = value;
      if (value < minG) minG = value;
      if (value > maxG) maxG = value;
    }
    const range = maxG - minG || 1;
    const gradient = ASCII_GRADIENTS.normal;
    const rows = Math.max(1, Math.round(cols * OUT_H / OUT_W));
    const cW = OUT_W / cols, cH = OUT_H / rows;
    const sCW = 512 / cols, sCH = 384 / rows;
    ref.fillStyle = 'rgb(' + colors.paper + ')';
    ref.fillRect(0, 0, OUT_W, OUT_H);
    ref.font = 'bold ' + Math.max(4, Math.floor(cH * 0.92)) + 'px monospace';
    ref.textBaseline = 'top';
    ref.imageSmoothingEnabled = false;
    ref.fillStyle = 'rgb(' + colors.ink + ')';
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let sum = 0, count = 0;
        const x0 = Math.floor(col * sCW), x1 = Math.min(Math.ceil((col + 1) * sCW), 512);
        const y0 = Math.floor(row * sCH), y1 = Math.min(Math.ceil((row + 1) * sCH), 384);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          sum += gray[y * 512 + x];
          count++;
        }
        const raw = count ? sum / count : 128;
        const t = (raw - minG) / range;
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * (0.5 - 0.5 * Math.cos(Math.PI * t)));
        const density = colors.invertMap ? eased : 1 - eased;
        const index = Math.min(Math.floor(density * gradient.length), gradient.length - 1);
        if (index >= acSpaceVal) ref.fillText(gradient[index], col * cW, row * cH);
      }
    }
    const expected = ref.getImageData(0, 0, OUT_W, OUT_H).data;
    let changedPixels = 0, maxDelta = 0;
    for (let i = 0; i < actual.length; i += 4) {
      const delta = Math.abs(actual[i] - expected[i]) +
        Math.abs(actual[i + 1] - expected[i + 1]) +
        Math.abs(actual[i + 2] - expected[i + 2]) +
        Math.abs(actual[i + 3] - expected[i + 3]);
      if (delta) changedPixels++;
      if (delta > maxDelta) maxDelta = delta;
    }
    return { cols, changedPixels, maxDelta, pixels:actual.length / 4 };
  };

  const parity100 = parity(100);
  const parity160 = parity(160);

  asciiDensity = 1000;
  asciiClassicCols = 720;
  asciiCols = 720;
  _resetAsciiDensityBudget();
  _syncAsciiColsUI();
  const originalToast = flipToast;
  const toasts = [];
  flipToast = message => toasts.push(message);
  for (let i = 0; i < 10; i++) _asciiTrackFrameBudget(30);
  const firstDegrade = { cap:_asciiPerfMaxCols, effective:_getAsciiEffectiveCols(), warn:asciiPerfWarn.style.display };
  for (let i = 0; i < 10; i++) _asciiTrackFrameBudget(31);
  const secondDegrade = { cap:_asciiPerfMaxCols, effective:_getAsciiEffectiveCols(), warn:asciiPerfWarn.style.display };
  flipToast = originalToast;

  _resetAsciiDensityBudget();
  asciiDensity = 1000;
  asciiClassicCols = 720;
  asciiCols = 720;
  _syncAsciiColsUI();
  const maxMetrics = _getAsciiDensityMetrics();

  localStorage.setItem('flipSettings', JSON.stringify({ asciiDensity:5000, asciiSubMode:'classic' }));
  loadSettings();
  const persistedHigh = { density:asciiDensity, cols:asciiClassicCols };
  localStorage.setItem('flipSettings', JSON.stringify({ asciiDensity:-20, asciiSubMode:'classic' }));
  loadSettings();
  const persistedLow = { density:asciiDensity, cols:asciiClassicCols };
  asciiDensity = 1000;
  asciiClassicCols = 720;
  asciiCols = 720;
  _writeSettings();
  const savedSettings = JSON.parse(localStorage.getItem('flipSettings'));

  const layer = {
    defaultParams:_editDefaultAsciiParams(),
    clamped:_editClampAsciiParams({ cols:9999, ink:'INVALID', paper:'INVALID', gradient:'INVALID' }),
    html:_editAsciiPanelHtml(0, { params:{ cols:720, ink:'auto', paper:'auto', gradient:'normal' } }),
  };

  return {
    monotonic,
    boundaries:[0,333,666,1000].map(value => ({ density:value, cols:_asciiDensityToCols(value) })),
    maxMetrics,
    parity:[parity100, parity160],
    guardrail:{ firstDegrade, secondDegrade, toasts },
    persistence:{ high:persistedHigh, low:persistedLow, savedDensity:savedSettings.asciiDensity },
    capture:{ photo, rec },
    layer:{
      defaultParams:layer.defaultParams,
      clamped:layer.clamped,
      densityLabel:layer.html.includes('DENSITY'),
      perceptualRange:layer.html.includes('min="0" max="1000"'),
      sealLabel:layer.html.includes('SELLO'),
    },
    runtime:{ errors:__t23.errors, warnings:__t23.warnings },
  };
})()
`;

const MOBILE_CHECKS = String.raw`
(() => {
  asciiSubMode = 'classic';
  asciiDensity = 1000;
  asciiClassicCols = _asciiDensityToCols(asciiDensity);
  asciiCols = asciiClassicCols;
  _resetAsciiDensityBudget();
  const initial = {
    mobile:_isMobile,
    requested:asciiClassicCols,
    cap:_asciiPerfMaxCols,
    effective:_getAsciiEffectiveCols(),
    metrics:_getAsciiDensityMetrics(),
  };
  for (let i = 0; i < 70; i++) _asciiTrackFrameBudget(8);
  const proven = {
    cap:_asciiPerfMaxCols,
    effective:_getAsciiEffectiveCols(),
    average:_asciiLastBudgetAverage,
  };
  return { initial, proven, runtime:{ errors:__t23.errors, warnings:__t23.warnings } };
})()
`;

function writeDataUrl(dataUrl, targetPath) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  assert(match, `data URL PNG invalida para ${targetPath}`);
  fs.writeFileSync(targetPath, Buffer.from(match[1], 'base64'));
}

function buildReport(result) {
  const m = result.desktop.maxMetrics;
  const perf = result.desktop.workerMax;
  const photo = result.desktop.capture.photo;
  const rec = result.desktop.capture.rec;
  return `# T23 · ASCII sello — reporte medido

Verificado en Chromium headless, viewport desktop 1440×900 y móvil simulado 390×844.

## Densidad y salida

- Barrido 0→1000: cols, rows, resolución y sample fueron monótonos.
- Zonas: 0→20 cols; 333→80; 666→240; 1000→720.
- SELLO desktop: ${m.cols}×${m.rows} = **${m.cells.toLocaleString('en-US')} celdas**.
- Canvas: ${m.width}×${m.height}; sample: ${m.sampleW}×${m.sampleH}; glifo: ${m.fontPx}px.
- Worker SELLO máximo: **${perf.renderMs.toFixed(2)} ms** en esta máquina.

## Guardrails

- Promedio móvil: 10 frames; umbral: 24 ms.
- Carga simulada 30 ms: ${result.desktop.guardrail.firstDegrade.cap} cols en el primer escalón y ${result.desktop.guardrail.secondDegrade.cap} en el segundo.
- Toast \`modo rápido\`: ${result.desktop.guardrail.toasts.length} vez.
- Móvil simulado: techo inicial ${result.mobile.initial.cap} cols; tras 70 frames a 8 ms probó ${result.mobile.proven.cap} cols.

## Paridad y export

- Pixel-diff vs algoritmo legacy: ${result.desktop.parity.map(item => `${item.cols} cols = ${item.changedPixels}`).join('; ')}.
- FOTO SELLO: ${photo.width}×${photo.height}, ${photo.bytes.toLocaleString('en-US')} bytes, ${photo.type}.
- REC SELLO decodificado: ${rec.width}×${rec.height}, ${rec.bytes.toLocaleString('en-US')} bytes, ${rec.duration.toFixed(3)} s, ${rec.type}; lado largo ≤4096 y aspecto ${rec.aspect}.
- Atlas T15: presupuesto LRU de 32 MB conservado; glifo SELLO usa bucket mínimo de ${m.fontPx}px.

## A/B visual

| GRUESO · 20 cols | SELLO · 720 cols |
|---|---|
| ![ASCII grueso](t23-artifacts/grueso.png) | ![ASCII sello](t23-artifacts/sello.png) |

El A/B prueba el salto de escala y textura. El criterio estético final corresponde a Andy en staging.
`;
}

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const cacheBefore = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8').match(/^const CACHE = .+$/m)?.[0] || '';
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t23-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, scripts[0]);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const idCounts = new Map();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const duplicates = [...idCounts].filter(([, count]) => count > 1);
  assert(duplicates.length === 0, `IDs duplicados=${JSON.stringify(duplicates)}`);
  assert(/const ATLAS_CACHE_BUDGET = 32 \* 1024 \* 1024/.test(html), 'budget atlas T15 cambio');
  assert(/const ASCII_OUTPUT_LONG_HARD_MAX = 4096/.test(html), 'clamp 4096 ausente');
  assert(cacheBefore === "const CACHE = 'flipnote-filter-lab-v92-stage-capas';", `CACHE cambio: ${cacheBefore}`);

  const server = await serveDocs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t23-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });

  let browser;
  let desktopPage;
  let mobilePage;
  try {
    const version = await waitFor(async () => {
      if (chromeExit) throw new Error(`Chrome termino antes de CDP: ${JSON.stringify(chromeExit)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return response.ok ? response.json() : false;
      } catch (_) {
        return false;
      }
    }, 'Chrome CDP');
    browser = await new Cdp(version.webSocketDebuggerUrl).open();
    desktopPage = await preparePage(browser, false);
    await evaluate(desktopPage, SETUP_SOURCE);

    const coarse = await evaluate(desktopPage, RENDER_AT_DENSITY(0));
    const seal = await evaluate(desktopPage, RENDER_AT_DENSITY(1000));
    fs.mkdirSync(ARTIFACT_DIR, { recursive:true });
    writeDataUrl(coarse.dataUrl, path.join(ARTIFACT_DIR, 'grueso.png'));
    writeDataUrl(seal.dataUrl, path.join(ARTIFACT_DIR, 'sello.png'));

    const desktop = await evaluate(desktopPage, DESKTOP_CHECKS);
    desktop.workerMax = { renderMs:seal.renderMs, metrics:seal.metrics };

    mobilePage = await preparePage(browser, true);
    const mobile = await evaluate(mobilePage, MOBILE_CHECKS);

    Object.entries(desktop.monotonic).forEach(([key, value]) => assert(value, `barrido no monotono: ${key}`));
    assert(JSON.stringify(desktop.boundaries.map(item => item.cols)) === JSON.stringify([20, 80, 240, 720]),
      `zonas=${JSON.stringify(desktop.boundaries)}`);
    assert(desktop.maxMetrics.cols === 720, `max cols=${desktop.maxMetrics.cols}`);
    assert(desktop.maxMetrics.cells >= 500000, `celdas max=${desktop.maxMetrics.cells}`);
    assert(desktop.maxMetrics.fontPx >= 3, `glifo max=${desktop.maxMetrics.fontPx}px`);
    assert(desktop.maxMetrics.width > 1024 && desktop.maxMetrics.height > 768,
      `canvas SELLO=${desktop.maxMetrics.width}x${desktop.maxMetrics.height}`);
    assert(seal.renderMs > 0, `worker renderMs=${seal.renderMs}`);
    assert(desktop.guardrail.firstDegrade.cap === 600, `primer degrade=${desktop.guardrail.firstDegrade.cap}`);
    assert(desktop.guardrail.secondDegrade.cap === 480, `segundo degrade=${desktop.guardrail.secondDegrade.cap}`);
    assert(desktop.guardrail.toasts.length === 1 && desktop.guardrail.toasts[0] === 'modo rápido',
      `toasts=${JSON.stringify(desktop.guardrail.toasts)}`);
    assert(desktop.parity.every(item => item.changedPixels === 0), `pixel diff=${JSON.stringify(desktop.parity)}`);
    assert(desktop.persistence.high.density === 1000 && desktop.persistence.high.cols === 720,
      `clamp alto=${JSON.stringify(desktop.persistence.high)}`);
    assert(desktop.persistence.low.density === 0 && desktop.persistence.low.cols === 20,
      `clamp bajo=${JSON.stringify(desktop.persistence.low)}`);
    assert(desktop.persistence.savedDensity === 1000, `persistencia=${desktop.persistence.savedDensity}`);
    assert(desktop.capture.photo.width === desktop.maxMetrics.width &&
      desktop.capture.photo.height === desktop.maxMetrics.height &&
      desktop.capture.photo.bytes > 1000 && desktop.capture.photo.luminanceRange > 10,
      `FOTO=${JSON.stringify(desktop.capture.photo)}`);
    assert(Math.max(desktop.capture.rec.width, desktop.capture.rec.height) <= 4096,
      `REC=${JSON.stringify(desktop.capture.rec)}`);
    assert(desktop.capture.rec.width === desktop.capture.rec.requestedWidth &&
      desktop.capture.rec.height === desktop.capture.rec.requestedHeight &&
      desktop.capture.rec.bytes > 1000 && desktop.capture.rec.duration > 0,
      `REC invalido=${JSON.stringify(desktop.capture.rec)}`);
    assert(desktop.layer.clamped.cols === 720 && desktop.layer.densityLabel &&
      desktop.layer.perceptualRange && desktop.layer.sealLabel,
      `panel layer=${JSON.stringify(desktop.layer)}`);
    assert(mobile.initial.mobile && mobile.initial.cap === 480 && mobile.initial.effective === 480,
      `movil inicial=${JSON.stringify(mobile.initial)}`);
    assert(mobile.proven.cap === 600 && mobile.proven.effective === 600,
      `movil probado=${JSON.stringify(mobile.proven)}`);

    const exceptions = [
      ...desktopPage.events.filter(event => event.method === 'Runtime.exceptionThrown'),
      ...mobilePage.events.filter(event => event.method === 'Runtime.exceptionThrown'),
    ];
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);

    const result = {
      static:{
        syntax:true,
        inlineScripts:scripts.length,
        ids:ids.length,
        duplicateIds:duplicates.length,
        cache:cacheBefore,
        atlasBudgetBytes:32 * 1024 * 1024,
      },
      desktop,
      mobile,
      artifacts:{
        coarse:path.relative(ROOT, path.join(ARTIFACT_DIR, 'grueso.png')),
        seal:path.relative(ROOT, path.join(ARTIFACT_DIR, 'sello.png')),
        report:path.relative(ROOT, REPORT_PATH),
      },
      runtimeExceptions:exceptions.length,
    };
    fs.writeFileSync(REPORT_PATH, buildReport(result));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    try { desktopPage?.close(); } catch (_) {}
    try { mobilePage?.close(); } catch (_) {}
    try { browser?.close(); } catch (_) {}
    chrome.kill('SIGTERM');
    server.close();
    await timeout(200);
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

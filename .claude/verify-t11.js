#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t11=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

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
  window.__t11 = {
    gumCalls:{ video:0, audio:0 },
    videoStops:0,
    rafCallbacks:0,
    bankOscillators:0,
  };
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    __t11.rafCallbacks++;
    cb(performance.now());
  }, 25);
  window.cancelAnimationFrame = id => clearTimeout(id);

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
        __t11.bankOscillators++;
      }
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind:'audioinput', deviceId:'t11-mic', label:'T11 MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    if (constraints?.video) {
      __t11.gumCalls.video++;
      const source = document.createElement('canvas');
      source.width = 160; source.height = 120;
      const ctx = source.getContext('2d');
      let frame = 0;
      const paint = () => {
        frame++;
        ctx.fillStyle = frame % 2 ? '#f40' : '#04f';
        ctx.fillRect(0, 0, 160, 120);
        ctx.fillStyle = '#fff';
        ctx.fillRect((frame * 11) % 120, 18, 40, 84);
        if (source.__running !== false) requestAnimationFrame(paint);
      };
      paint();
      const stream = source.captureStream(30);
      const track = stream.getVideoTracks()[0];
      const nativeStop = track.stop.bind(track);
      track.stop = () => { __t11.videoStops++; source.__running = false; nativeStop(); };
      track.getCapabilities = () => ({ zoom:{ min:1, max:4, step:0.1 } });
      track.getSettings = () => ({ zoom:1 });
      track.applyConstraints = async () => {};
      return stream;
    }
    __t11.gumCalls.audio++;
    const audioCtx = new AC();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 440; osc.connect(dest); osc.start();
    return dest.stream;
  };
  Object.defineProperty(navigator, 'permissions', {
    configurable:true,
    value:{ query:async () => ({ state:'denied', addEventListener() {}, removeEventListener() {} }) },
  });
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
  const isVisible = el => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 && r.width > 0 && r.height > 0;
  };
  const rectData = el => {
    const r = el.getBoundingClientRect();
    return { left:+r.left.toFixed(1), top:+r.top.toFixed(1), right:+r.right.toFixed(1), bottom:+r.bottom.toFixed(1), width:+r.width.toFixed(1), height:+r.height.toFixed(1) };
  };
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const scanOverlaps = label => {
    const floatingSelectors = [
      '#flipSettingsTrigger','#btnMicMobile','#btnAudioIO','#btnExtCapture','#btnFlip',
      '#camAspect','#camFpsCtrl','#camZoomCtrl','#camFamilyTray','#camControlDock','.palettes','#audioIOPanel'
    ];
    const panelSelectors = ['#asciiPanel','#scrashControls','#fusionHUD','#sflowHUD','#editHUD','#wmpHUD'];
    const navSelectors = ['.tab-bar','#flipBottomNav','#barSflow','#barEdit','#barStage'];
    const collect = (selectors, kind) => selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .filter(isVisible).map(el => ({ el, kind, name:el.id ? '#' + el.id : '.' + el.className, rect:rectData(el) }));
    const floating = collect(floatingSelectors, 'floating');
    const panels = collect(panelSelectors, 'panel');
    const nav = collect(navSelectors, 'nav');
    const conflicts = [];
    const compare = (left, right) => {
      for (const a of left) for (const b of right) {
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const overlapWidth = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
        const overlapHeight = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
        const area = overlapArea(a.rect, b.rect);
        if (overlapWidth > 1.5 && overlapHeight > 1.5) conflicts.push({ label, a:a.name, b:b.name, area:+area.toFixed(1) });
      }
    };
    compare(floating, floating);
    compare(floating, panels);
    compare(floating, nav);
    compare(panels, nav);
    return { label, visible:floating.length + panels.length + nav.length, conflicts };
  };
  const targetStats = selector => {
    const items = [...document.querySelectorAll(selector)].map(rectData).filter(item => item.width > 0 && item.height > 0);
    return {
      count:items.length,
      minWidth:items.length ? Math.min(...items.map(item => item.width)) : 0,
      minHeight:items.length ? Math.min(...items.map(item => item.height)) : 0,
    };
  };
  const canvasSample = canvas => {
    const probe = document.createElement('canvas'); probe.width = 32; probe.height = 24;
    const ctx = probe.getContext('2d'); ctx.drawImage(canvas, 0, 0, 32, 24);
    return Array.from(ctx.getImageData(0, 0, 32, 24).data);
  };
  const pixelDiff = (a, b) => {
    let changedPixels = 0, sumAbs = 0;
    for (let i = 0; i < a.length; i += 4) {
      let changed = false;
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(a[i+c] - b[i+c]);
        sumAbs += delta; if (delta) changed = true;
      }
      if (changed) changedPixels++;
    }
    return { changedPixels, totalPixels:a.length / 4, sumAbs };
  };

  const started = performance.now();
  document.getElementById('btnSplashOriginal').click();
  await wait(() => stream && stream.getVideoTracks()[0]?.readyState === 'live' && vid.videoWidth > 0, 'camara');
  await sleep(200);
  const overlaps = [scanOverlaps('cam-default')];
  const sampleA = canvasSample(display); await sleep(300); const sampleB = canvasSample(display);
  const frameDiff = pixelDiff(sampleA, sampleB);
  const helper = {
    result:FLIP_IS_MOBILE(),
    coarse:matchMedia('(pointer:coarse)').matches,
    width:innerWidth,
    height:innerHeight,
  };
  const railRightOffsets = ['flipSettingsTrigger','btnMicMobile','btnAudioIO']
    .map(id => document.getElementById(id)).filter(isVisible)
    .map(el => +(innerWidth - el.getBoundingClientRect().right).toFixed(1));
  const micVisible = isVisible(document.getElementById('btnMicMobile'));
  const activationBefore = { videoStops:__t11.videoStops, videoCalls:__t11.gumCalls.video };
  document.getElementById('btnAudioIO').click();
  await sleep(50);
  overlaps.push(scanOverlaps('audio-open'));
  document.getElementById('btnExtAudioToggle').click();
  await wait(() => extMicOnlyMode || extAudioMode, 'audio activo');
  const activation = {
    mobileUI:_isMobileAudioUI(),
    extMicOnlyMode,
    extAudioMode,
    cameraTrackState:stream?.getVideoTracks()[0]?.readyState || 'none',
    videoStopsDelta:__t11.videoStops - activationBefore.videoStops,
    videoCallsDelta:__t11.gumCalls.video - activationBefore.videoCalls,
    audioCalls:__t11.gumCalls.audio,
    micVisibleAfterActivation:isVisible(document.getElementById('btnMicMobile')),
  };
  document.getElementById('audioIOPanel').classList.remove('open');

  _toggleCamFamilyTray(true); await sleep(50);
  const camFamilyTargets = targetStats('.cam-fam-btn');
  overlaps.push(scanOverlaps('cam-family'));
  _toggleCamFamilyTray(false); _toggleCamEdit(true); await sleep(100);
  _activatePaletteFreeMode(); _renderCustomSlots(); await sleep(50);
  const paletteTargets = targetStats('.pcs-slot');
  const dock = {
    parent:document.getElementById('camFpsCtrl').parentElement?.id || '',
    fps:rectData(document.getElementById('camFpsCtrl')),
    zoom:rectData(document.getElementById('camZoomCtrl')),
    fpsInViewport:document.getElementById('camFpsCtrl').getBoundingClientRect().bottom <= innerHeight,
    zoomInViewport:document.getElementById('camZoomCtrl').getBoundingClientRect().bottom <= innerHeight,
    paletteDisplay:getComputedStyle(document.getElementById('palettes')).display,
    freeBoxDisplay:getComputedStyle(document.getElementById('palFreeBox')).display,
    paletteRect:rectData(document.getElementById('palettes')),
    bodyClasses:document.body.className,
    camEditOpen,
    camFamily,
    hasEditor:_hasCamEditor(),
  };
  overlaps.push(scanOverlaps('cam-edit'));
  _toggleCamEdit(false);

  switchTab('ascii'); await sleep(100);
  document.getElementById('btnAsciiModeTypo').click();
  document.getElementById('btnAsciiEdit').click(); await sleep(100);
  const typoTargets = targetStats('.typo-pill');
  overlaps.push(scanOverlaps('ascii-edit'));

  switchTab('scrash'); await sleep(100);
  const glitchPyTargets = targetStats('.sc-py-btn');
  const glitchAspectTargets = targetStats('.scr-asp-btn');
  overlaps.push(scanOverlaps('glitch'));

  switchTab('sono'); await sleep(100);
  const sonoTargets = targetStats('.sono-preset-btn');
  overlaps.push(scanOverlaps('sono'));

  switchTab('wmp'); await sleep(150);
  const wmpTargets = targetStats('.wmp-preset-btn');
  const wmpArea = rectData(document.getElementById('wmpArea'));
  const wmpHud = rectData(document.getElementById('wmpHUD'));
  const wmpLayout = {
    hudHeight:wmpHud.height,
    cssVar:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wmp-hud-h')) || 0,
    gap:+(wmpHud.top - wmpArea.bottom).toFixed(1),
  };
  document.body.classList.add('wmp-file'); window._wmpSyncHudLayout(); await sleep(50);
  const wmpFileArea = rectData(document.getElementById('wmpArea'));
  const wmpFileHud = rectData(document.getElementById('wmpHUD'));
  wmpLayout.fileGap = +(wmpFileHud.top - wmpFileArea.bottom).toFixed(1);
  document.body.classList.remove('wmp-file'); window._wmpSyncHudLayout();
  overlaps.push(scanOverlaps('wmp'));

  switchTab('fusion'); await sleep(150);
  const fusionArea = rectData(document.getElementById('fusionArea'));
  const fusionHud = rectData(document.getElementById('fusionHUD'));
  const fusionLayout = {
    hudHeight:fusionHud.height,
    cssVar:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fusion-hud-h')) || 0,
    gap:+(fusionHud.top - fusionArea.bottom).toFixed(1),
  };
  overlaps.push(scanOverlaps('fusion'));

  switchTab('sflow'); await sleep(100); overlaps.push(scanOverlaps('flow'));
  switchTab('edit'); await sleep(100); overlaps.push(scanOverlaps('edit'));
  switchTab('stage'); await sleep(100); overlaps.push(scanOverlaps('stage'));

  return {
    elapsedMs:+(performance.now() - started).toFixed(1),
    helper,
    railRightOffsets,
    micVisible,
    activation,
    frameDiff,
    dock,
    huds:{ fusion:fusionLayout, wmp:wmpLayout },
    targets:{
      typo:typoTargets,
      camFamily:camFamilyTargets,
      glitchPy:glitchPyTargets,
      glitchAspect:glitchAspectTargets,
      sono:sonoTargets,
      wmp:wmpTargets,
      paletteSlots:paletteTargets,
    },
    overlapStates:overlaps.length,
    visibleOverlapCandidates:overlaps.reduce((sum, state) => sum + state.visible, 0),
    overlaps:overlaps.flatMap(state => state.conflicts),
    gumCalls:__t11.gumCalls,
    rafCallbacks:__t11.rafCallbacks,
    bankOscillators:__t11.bankOscillators,
  };
})()
`;

async function newPage(browser, viewport) {
  const page = await browser.createSession();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width:viewport.width,
    height:viewport.height,
    screenWidth:viewport.width,
    screenHeight:viewport.height,
    deviceScaleFactor:1,
    mobile:true,
    screenOrientation:{
      type:viewport.width > viewport.height ? 'landscapePrimary' : 'portraitPrimary',
      angle:viewport.width > viewport.height ? 90 : 0,
    },
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
  await page.send('Network.setUserAgentOverride', {
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    platform:'iPhone',
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
  await page.send('Page.navigate', { url:PAGE_URL });
  await waitFor(() => evaluate(page, 'document.readyState === "complete"'), `carga ${viewport.width}x${viewport.height}`);
  return page;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t11-check-'));
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
  const viewportFitCount = (html.match(/viewport-fit=cover/g) || []).length;
  const legacyMaxBreakpoints = (html.match(/max-width:\s*767px/g) || []).length;
  const legacyMinBreakpoints = (html.match(/min-width:\s*768px/g) || []).length;
  const fusionHudSetters = (html.match(/setProperty\('--fusion-hud-h'/g) || []).length;
  const wmpHudSetters = (html.match(/setProperty\('--wmp-hud-h'/g) || []).length;
  const safeAreaLeftRightRefs = (html.match(/safe-area-inset-(?:left|right)/g) || []).length;
  const safeBottomBars = ['barSflow','barEdit','barStage'].filter(id => {
    const start = html.indexOf(`#${id} {`);
    const end = html.indexOf('}', start);
    return start >= 0 && /safe-area-inset-bottom/.test(html.slice(start, end));
  }).length;
  assert(viewportFitCount === 1, `viewport-fit count=${viewportFitCount}`);
  assert(legacyMaxBreakpoints === 0 && legacyMinBreakpoints === 0,
    `breakpoints legacy max/min=${legacyMaxBreakpoints}/${legacyMinBreakpoints}`);
  assert(fusionHudSetters === 1 && wmpHudSetters === 1,
    `setters HUD fusion/wmp=${fusionHudSetters}/${wmpHudSetters}`);
  assert(safeAreaLeftRightRefs >= 2 && safeBottomBars === 3,
    `safe areas left-right/barras=${safeAreaLeftRightRefs}/${safeBottomBars}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t11-chrome-'));
  const debugPort = Number(process.env.T11_CDP_PORT) || await getFreePort();
  const chrome = spawn(CHROME, [
    '--headless=new','--no-first-run','--disable-default-apps','--disable-background-networking',
    '--disable-component-update','--disable-popup-blocking','--autoplay-policy=no-user-gesture-required',
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
  const pages = [];
  const cleanup = () => {
    pages.forEach(page => page.close());
    browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    const cases = [
      { name:'portrait', width:375, height:812 },
      { name:'landscape', width:852, height:393 },
      { name:'ipad768', width:768, height:1024 },
    ];
    const results = {};
    for (const testCase of cases) {
      const page = await newPage(browser, testCase);
      pages.push(page);
      const result = await evaluate(page, RUNTIME_MEASURE);
      const targetValues = Object.values(result.targets);
      assert(result.helper.result, `${testCase.name}: FLIP_IS_MOBILE=false`);
      assert(result.railRightOffsets.length === 3 && Math.max(...result.railRightOffsets) - Math.min(...result.railRightOffsets) <= 0.5,
        `${testCase.name}: riel right=${JSON.stringify(result.railRightOffsets)}`);
      assert(result.micVisible, `${testCase.name}: mic no visible`);
      assert(result.activation.mobileUI && result.activation.extMicOnlyMode && !result.activation.extAudioMode,
        `${testCase.name}: semantica ACTIVAR=${JSON.stringify(result.activation)}`);
      assert(result.activation.cameraTrackState === 'live' && result.activation.videoStopsDelta === 0,
        `${testCase.name}: camara alterada=${JSON.stringify(result.activation)}`);
      assert(result.activation.micVisibleAfterActivation, `${testCase.name}: mic oculto tras ACTIVAR`);
      assert(result.frameDiff.changedPixels > 0, `${testCase.name}: pixel diff=0`);
      assert(result.dock.parent === 'camMobileUtilityDock', `${testCase.name}: dock parent=${result.dock.parent}`);
      assert(result.dock.fpsInViewport && result.dock.zoomInViewport, `${testCase.name}: controles CAM fuera=${JSON.stringify(result.dock)}`);
      assert(targetValues.every(value => value.count > 0 && value.minWidth >= 40 && value.minHeight >= 40),
        `${testCase.name}: targets=${JSON.stringify(result.targets)} dock=${JSON.stringify(result.dock)}`);
      assert(Math.abs(result.huds.fusion.hudHeight - result.huds.fusion.cssVar) <= 1 && result.huds.fusion.gap >= -0.5,
        `${testCase.name}: FUSION HUD=${JSON.stringify(result.huds.fusion)}`);
      assert(Math.abs(result.huds.wmp.hudHeight - result.huds.wmp.cssVar) <= 1 && result.huds.wmp.gap >= -0.5 && result.huds.wmp.fileGap >= -0.5,
        `${testCase.name}: WMP HUD=${JSON.stringify(result.huds.wmp)}`);
      assert(result.overlaps.length === 0, `${testCase.name}: overlaps=${JSON.stringify(result.overlaps)} dock=${JSON.stringify(result.dock)}`);
      const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
      assert(runtimeExceptions.length === 0, `${testCase.name}: excepciones runtime=${runtimeExceptions.length}`);
      results[testCase.name] = { ...result, runtimeExceptions:runtimeExceptions.length };
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
        viewportFitCount,
        legacyMaxBreakpoints,
        legacyMinBreakpoints,
        fusionHudSetters,
        wmpHudSetters,
        safeAreaLeftRightRefs,
        safeBottomBars,
      },
      ...results,
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

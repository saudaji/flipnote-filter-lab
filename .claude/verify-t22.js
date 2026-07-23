#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_URL = `${pathToFileURL(path.join(ROOT, 'docs/index.html')).href}?t22=1`;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, label, limitMs = 10000, intervalMs = 10) {
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
  window.requestAnimationFrame = callback => realSetTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);
  window.__t22 = { messages:[], stateAppliedAt:0, glitchStartedAt:0, glitchAppliedAt:0, glitchDurationMs:0, gumCalls:0 };
  const observer = new BroadcastChannel('flip_stage');
  observer.addEventListener('message', event => {
    const message = event.data;
    __t22.messages.push({ ...message, receivedAt:Date.now() });
  });
  __t22.observer = observer;

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.enumerateDevices = async () => [];
  mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.video) throw new DOMException('audio desactivado en T22', 'NotAllowedError');
    __t22.gumCalls++;
    const source = document.createElement('canvas');
    source.width = 160;
    source.height = 120;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#14213d';
    ctx.fillRect(0, 0, source.width, source.height);
    for (let y = 0; y < source.height; y += 12) {
      for (let x = 0; x < source.width; x += 16) {
        ctx.fillStyle = 'rgb(' + ((x * 7 + y * 3) % 256) + ',' +
          ((x * 2 + y * 9) % 256) + ',' + ((x * 11 + y) % 256) + ')';
        ctx.fillRect(x, y, 12, 9);
      }
    }
    ctx.fillStyle = '#ffef00';
    ctx.fillRect(19, 17, 37, 71);
    ctx.fillStyle = '#00e5ff';
    ctx.fillRect(91, 31, 51, 23);
    return source.captureStream(30);
  };
})();
`;

async function preparePage(browser, url, viewport) {
  const page = await browser.createSession();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled:true });
  await page.send('Network.setBlockedURLs', { urls:['*cdn.jsdelivr.net/npm/@mediapipe/tasks-vision*'] });
  if (viewport) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width:viewport.width,
      height:viewport.height,
      screenWidth:viewport.width,
      screenHeight:viewport.height,
      deviceScaleFactor:1,
      mobile:true,
      screenOrientation:{ type:'portraitPrimary', angle:0 },
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
  await page.send('Page.navigate', { url });
  await waitFor(() => evaluate(page, 'typeof window.__preReload === "undefined" && document.readyState === "complete"'), `carga ${url}`);
  return page;
}

async function sampleCanvas(page) {
  return evaluate(page, `(() => {
    const source = document.getElementById('stageOutCanvas');
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 48;
    const ctx = probe.getContext('2d');
    ctx.drawImage(source, 0, 0, probe.width, probe.height);
    return Array.from(ctx.getImageData(0, 0, probe.width, probe.height).data);
  })()`);
}

function pixelDiff(before, after) {
  let changedPixels = 0;
  let sumAbs = 0;
  for (let i = 0; i < before.length; i += 4) {
    const delta = Math.abs(before[i] - after[i]) +
      Math.abs(before[i + 1] - after[i + 1]) +
      Math.abs(before[i + 2] - after[i + 2]);
    if (delta) changedPixels++;
    sumAbs += delta;
  }
  return { changedPixels, totalPixels:before.length / 4, sumAbs };
}

async function waitForPixelChange(page, before, label, limitMs = 1000) {
  const started = Date.now();
  let after = before;
  let diff = pixelDiff(before, after);
  while (Date.now() - started < limitMs) {
    after = await sampleCanvas(page);
    diff = pixelDiff(before, after);
    if (diff.changedPixels > 0) return { elapsedMs:Date.now() - started, diff };
    await timeout(5);
  }
  throw new Error(`${label}: pixel-diff=0 después de ${Date.now() - started}ms`);
}

async function measurePanel(page, index, toggleAction, panelClass) {
  await evaluate(page, `document.querySelector('#stageLayersList button[data-i="${index}"][data-act="${toggleAction}"]').click(); true`);
  await waitFor(() => evaluate(page,
    `!!document.querySelector('#stageLayersList > .${panelClass}')`), `${panelClass} abierto`);
  return evaluate(page, `(() => {
    const area = document.getElementById('stageArea');
    const bar = document.getElementById('barStage');
    const list = document.getElementById('stageLayersList');
    const panel = list.querySelector(':scope > .${panelClass}');
    const targets = [...panel.querySelectorAll('button,input')];
    area.scrollTop = 0;
    const layoutRects = targets.map(el => el.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < layoutRects.length; i++) {
      for (let j = i + 1; j < layoutRects.length; j++) {
        const a = layoutRects[i], b = layoutRects[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps++;
      }
    }
    let reachable = 0;
    let hit = 0;
    let minHeight = Infinity;
    let minWidth = Infinity;
    for (const el of targets) {
      const initial = el.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      const contentTop = area.scrollTop + initial.top - areaRect.top;
      area.scrollTop = Math.max(0, Math.min(area.scrollHeight - area.clientHeight,
        contentTop - (area.clientHeight - initial.height) / 2));
      const rect = el.getBoundingClientRect();
      minHeight = Math.min(minHeight, rect.height);
      minWidth = Math.min(minWidth, rect.width);
      const visible = rect.top >= areaRect.top - 0.5 && rect.bottom <= areaRect.bottom + 0.5;
      if (visible) reachable++;
      const atPoint = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      if (visible && atPoint && (atPoint === el || el.contains(atPoint))) hit++;
    }
    const areaRect = area.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    return {
      targets:targets.length,
      reachable,
      hit,
      minHeight:+minHeight.toFixed(2),
      minWidth:+minWidth.toFixed(2),
      overlaps,
      expandedTopLevel:[...list.children].filter(el =>
        el.matches('.edit-glitch-panel,.edit-ascii-panel,.edit-flow-panel,.edit-fam-panel')).length,
      stageBottom:+areaRect.bottom.toFixed(2),
      barTop:+barRect.top.toFixed(2),
      scrollHeight:area.scrollHeight,
      clientHeight:area.clientHeight,
    };
  })()`);
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t22-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, scripts[0]);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check falló: ${syntax.stderr}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t22-chrome-'));
  const debugPort = Number(process.env.T22_CDP_PORT) || 24642;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--enable-gpu',
    '--use-gl=angle',
    '--use-angle=metal',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio:'ignore' });
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const browserVersion = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome terminó antes de DevTools: ${JSON.stringify(chromeExit)}`);
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
    const output = await preparePage(browser, `${BASE_URL}#stageout`);
    pages.push(output);
    await waitFor(() => evaluate(output, '!!document.getElementById("stageOutCanvas")'), 'canvas OUTPUT');
    await evaluate(output, `(() => {
      const realApply = _applyScrash;
      const realClamp = _stageClampState;
      _stageClampState = function(payload) {
        if (payload?.pipeline?.[0]?.params?.chroma === 42 && !__t22.stateAppliedAt) {
          __t22.stateAppliedAt = Date.now();
        }
        return realClamp(payload);
      };
      _applyScrash = function(...args) {
        const measured = args[6]?.chroma === 42 && !__t22.glitchAppliedAt;
        if (measured) __t22.glitchStartedAt = Date.now();
        const result = realApply.apply(this, args);
        if (measured) {
          __t22.glitchAppliedAt = Date.now();
          __t22.glitchDurationMs = __t22.glitchAppliedAt - __t22.glitchStartedAt;
        }
        return result;
      };
      const fallback = document.createElement('canvas');
      fallback.width = 640;
      fallback.height = 480;
      const fallbackCtx = fallback.getContext('2d');
      fallbackCtx.fillStyle = '#14213d';
      fallbackCtx.fillRect(0, 0, fallback.width, fallback.height);
      for (let y = 0; y < fallback.height; y += 24) {
        for (let x = 0; x < fallback.width; x += 32) {
          fallbackCtx.fillStyle = 'rgb(' + ((x * 7 + y * 3) % 256) + ',' +
            ((x * 2 + y * 9) % 256) + ',' + ((x * 11 + y) % 256) + ')';
          fallbackCtx.fillRect(x, y, 24, 18);
        }
      }
      fallbackCtx.fillStyle = '#ffef00';
      fallbackCtx.fillRect(76, 68, 148, 284);
      fallbackCtx.fillStyle = '#00e5ff';
      fallbackCtx.fillRect(364, 124, 204, 92);
      _getExtAudioSourceFrame = () => fallback;
      __t22.fallback = fallback;
      return true;
    })()`);

    const control = await preparePage(browser, BASE_URL, { width:412, height:915 });
    pages.push(control);
    await evaluate(control, `document.getElementById('btnSplashStage').click(); true`);
    await waitFor(() => evaluate(control,
      `document.getElementById('stageArea').classList.contains('visible') &&
       document.querySelectorAll('#stageLayersList .edit-layer-row').length === 1`), 'STAGE CONTROL');
    await waitFor(() => evaluate(output,
      `__t22.messages.some(message => message.type === 'state' && message.payload?.pipeline?.[0]?.params?.chroma === 12)`),
      'default completo en OUTPUT');
    await evaluate(control, `document.getElementById('stageSrcCam').click(); true`);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(message => message.type === 'state' && message.payload?.source?.cam === false)`),
      'fuente estática T22');
    await waitFor(async () => {
      const pixels = await sampleCanvas(output);
      return pixels.some((value, index) => index % 4 !== 3 && value > 0);
    }, 'primer frame OUTPUT');

    const defaultState = await evaluate(control, `(() => {
      document.querySelector('#stageLayersList [data-act="glitchtoggle"]').click();
      const slider = document.querySelector('#stageLayersList [data-glitch-param="chroma"]');
      const message = __t22.messages.filter(item => item.type === 'state').at(-1);
      return {
        slider:+slider.value,
        editDefault:_editDefaultGlitchParams().chroma,
        params:window._stageState.pipeline[0].params,
        messageParams:message?.payload?.pipeline?.[0]?.params || null,
      };
    })()`);
    assert(defaultState.slider === 12 && defaultState.editDefault === 12,
      `default GLITCH=${JSON.stringify(defaultState)}`);
    assert(defaultState.messageParams && Object.keys(defaultState.messageParams).length === 11,
      `mensaje default incompleto=${JSON.stringify(defaultState.messageParams)}`);

    await evaluate(output, `__t22.messages.length = 0; __t22.stateAppliedAt = 0; __t22.glitchStartedAt = 0; __t22.glitchAppliedAt = 0; true`);
    const glitchBefore = await sampleCanvas(output);
    const changedAt = await evaluate(control, `(() => {
      __t22.messages.length = 0;
      const slider = document.querySelector('#stageLayersList [data-glitch-param="chroma"]');
      slider.value = 42;
      const at = Date.now();
      slider.dispatchEvent(new Event('input', { bubbles:true }));
      return at;
    })()`);
    const glitchReceived = await waitFor(() => evaluate(output, `(() => {
      const message = __t22.messages.find(item =>
        item.type === 'state' && item.payload?.pipeline?.[0]?.params?.chroma === 42);
      return message && { receivedAt:message.receivedAt, params:message.payload.pipeline[0].params };
    })()`), 'broadcast CHROMA 42');
    const glitchAppliedAt = await waitFor(() => evaluate(output, '__t22.glitchAppliedAt'), 'render CHROMA 42');
    const glitchPixels = await waitForPixelChange(output, glitchBefore, 'CHROMA OUTPUT');
    const glitchBackend = await evaluate(output, `({
      startedAt:__t22.glitchStartedAt,
      stateAppliedAt:__t22.stateAppliedAt,
      durationMs:__t22.glitchDurationMs,
      webglReady:_scrashWebGLEngine.isReady(),
      workRes:_stageGetWorkRes(),
    })`);
    const glitch = {
      broadcastMs:glitchReceived.receivedAt - changedAt,
      applyStateMs:glitchBackend.stateAppliedAt - changedAt,
      renderStartMs:glitchBackend.startedAt - changedAt,
      renderMs:glitchAppliedAt - changedAt,
      pixelObservedMs:glitchAppliedAt - changedAt + glitchPixels.elapsedMs,
      pixelDiff:glitchPixels.diff,
      paramsKeys:Object.keys(glitchReceived.params).sort(),
      backend:glitchBackend,
    };
    assert(glitch.broadcastMs >= 0 && glitch.broadcastMs < 100, `broadcast CHROMA=${JSON.stringify(glitch)}`);
    assert(glitch.renderStartMs >= 0 && glitch.renderStartMs < 100, `inicio render CHROMA=${JSON.stringify(glitch)}`);
    assert(glitch.pixelDiff.changedPixels > 0, `pixel CHROMA=${JSON.stringify(glitch)}`);
    assert(glitch.paramsKeys.length === 11, `params CHROMA incompletos=${glitch.paramsKeys}`);

    const burst = await evaluate(control, `new Promise(resolve => {
      __t22.messages.length = 0;
      const slider = document.querySelector('#stageLayersList [data-glitch-param="chroma"]');
      const startedAt = Date.now();
      for (let i = 0; i < 100; i++) {
        slider.value = i % 51;
        slider.dispatchEvent(new Event('input', { bubbles:true }));
      }
      slider.value = 50;
      slider.dispatchEvent(new Event('input', { bubbles:true }));
      setTimeout(() => {
        const states = __t22.messages.filter(item => item.type === 'state');
        resolve({
          elapsedMs:Date.now() - startedAt,
          messages:states.length,
          last:states.at(-1)?.payload?.pipeline?.[0]?.params || null,
        });
      }, 180);
    })`);
    assert(burst.messages > 0 && burst.messages <= 6 && burst.last?.chroma === 50,
      `throttle burst=${JSON.stringify(burst)}`);
    assert(Object.keys(burst.last || {}).length === 11, `burst params incompletos=${JSON.stringify(burst.last)}`);

    await evaluate(control, `document.getElementById('btnStageAddCam').click(); true`);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[1]?.engine === 'cam')`), 'CAM añadido');
    await timeout(80);
    const camBefore = await sampleCanvas(output);
    await evaluate(control, `
      document.querySelector('#stageLayersList [data-i="1"][data-act="famtoggle"]').click();
      document.querySelector('#stageLayersList [data-i="1"][data-act="setfam"][data-fam="AUTO03"]').click();
      true;
    `);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[1]?.family === 'AUTO03')`),
      'familia CAM AUTO03');
    const camPixels = await waitForPixelChange(output, camBefore, 'familia CAM');

    await evaluate(control, `document.getElementById('btnStageAddAscii').click(); true`);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[2]?.engine === 'ascii')`), 'ASCII añadido');
    await timeout(80);
    const asciiBefore = await sampleCanvas(output);
    await evaluate(control, `
      document.querySelector('#stageLayersList [data-i="2"][data-act="asciitoggle"]').click();
      const slider = document.querySelector('#stageLayersList [data-ascii-param="cols"]');
      slider.value = _asciiColsToDensity(32);
      slider.dispatchEvent(new Event('input', { bubbles:true }));
      true;
    `);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[2]?.params?.cols === 32)`),
      'ASCII cols 32');
    const asciiPixels = await waitForPixelChange(output, asciiBefore, 'ASCII cols');

    await evaluate(output, `(() => {
      const helpers = window._sfStepHelpers;
      window._sfStepHelpers = {
        ...helpers,
        audioMask(width, height) {
          const mask = new Float32Array(width * height);
          const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * 0.24;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              mask[y * width + x] = Math.hypot(x - cx, y - cy) <= radius ? 1 : 0;
            }
          }
          return mask;
        },
      };
      extAnalyser = {};
      return true;
    })()`);
    await evaluate(control, `document.getElementById('btnStageAddFlow').click(); true`);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[3]?.engine === 'flowblob')`),
      'FLOW añadido');
    await timeout(80);
    const flowBefore = await sampleCanvas(output);
    await evaluate(control, `
      document.querySelector('#stageLayersList [data-i="3"][data-act="flowtoggle"]').click();
      document.querySelector('#stageLayersList [data-i="3"][data-act="setaura"][data-val="l"]').click();
      true;
    `);
    await waitFor(() => evaluate(output,
      `__t22.messages.some(item => item.type === 'state' && item.payload?.pipeline?.[3]?.params?.aura === 'l')`),
      'FLOW aura L');
    const flowPixels = await waitForPixelChange(output, flowBefore, 'FLOW aura');

    await timeout(400);
    const persisted = await evaluate(control, `JSON.parse(localStorage.getItem('flipSettings')).stageState`);
    assert(persisted.pipeline[0].params.chroma === 50 &&
      persisted.pipeline[1].family === 'AUTO03' &&
      persisted.pipeline[2].params.cols === 32 &&
      persisted.pipeline[3].params.aura === 'l', `persistencia=${JSON.stringify(persisted.pipeline)}`);

    await evaluate(control, `(() => {
      const settings = JSON.parse(localStorage.getItem('flipSettings'));
      settings.stageState = {
        source:{ cam:true, audioMode:'off', audioDeviceId:null },
        pipeline:[
          { engine:'glitch', on:true, params:{ chroma:999, drip:-9, neon:999, wave:999, crush:-5,
            hue:999, grain:999, chaos:-1, audioReact:999, animate:1, speed:0 } },
          { engine:'cam', on:true, family:'INVALIDA' },
          { engine:'ascii', on:true, params:{ cols:999, ink:'INVALIDA', paper:'INVALIDA', gradient:'INVALIDA' } },
          { engine:'flowblob', on:true, params:{ aura:'xl', ink:'INVALIDA' } },
        ],
        vhs:{ enabled:true, intensity:999, tracking:-1, chromaBleed:999, scanlines:-2, jitter:999, warble:-3 },
      };
      localStorage.setItem('flipSettings', JSON.stringify(settings));
      return true;
    })()`);
    await evaluate(control, `window.__preReload = true; true`);
    await control.send('Page.reload', { ignoreCache:true });
    await waitFor(() => evaluate(control,
      `typeof window.__preReload === 'undefined' && document.readyState === 'complete' && typeof _stageClampState === 'function'`), 'reload clamp');
    await evaluate(control, `document.getElementById('btnSplashStage').click(); true`);
    await waitFor(() => evaluate(control,
      `document.querySelectorAll('#stageLayersList .edit-layer-row').length === 4`), 'capas restauradas');
    await waitFor(() => evaluate(control,
      `JSON.parse(localStorage.getItem('flipSettings') || '{}').stageState?.pipeline?.[2]?.params?.cols === 720`),
      'snapshot clamp persistido');
    const clamped = await evaluate(control, `(() => ({
      runtime:window._stageState,
      stored:JSON.parse(localStorage.getItem('flipSettings')).stageState,
    }))()`);
    const expectedGlitch = {
      chroma:50, drip:0, neon:100, wave:40, crush:0, hue:360,
      grain:100, chaos:0, audioReact:300, animate:true, speed:1,
    };
    assert(JSON.stringify(clamped.runtime.pipeline[0].params) === JSON.stringify(expectedGlitch),
      `clamp GLITCH=${JSON.stringify(clamped.runtime.pipeline[0].params)}`);
    assert(clamped.runtime.pipeline[1].family === undefined, `clamp CAM=${JSON.stringify(clamped.runtime.pipeline[1])}`);
    assert(JSON.stringify(clamped.runtime.pipeline[2].params) === JSON.stringify({ cols:720, ink:'auto', paper:'auto', gradient:'normal' }),
      `clamp ASCII=${JSON.stringify(clamped.runtime.pipeline[2].params)}`);
    assert(JSON.stringify(clamped.runtime.pipeline[3].params) === JSON.stringify({ aura:'m', ink:'white' }),
      `clamp FLOW=${JSON.stringify(clamped.runtime.pipeline[3].params)}`);
    assert(JSON.stringify(clamped.stored) === JSON.stringify(clamped.runtime),
      `snapshot clamped no persistió=${JSON.stringify(clamped)}`);

    const panelCases = [
      ['glitch', 0, 'glitchtoggle', 'edit-glitch-panel'],
      ['cam', 1, 'famtoggle', 'edit-fam-panel'],
      ['ascii', 2, 'asciitoggle', 'edit-ascii-panel'],
      ['flow', 3, 'flowtoggle', 'edit-flow-panel'],
    ];
    const mobile = {};
    for (const [name, index, action, panelClass] of panelCases) {
      mobile[name] = await measurePanel(control, index, action, panelClass);
      const panel = mobile[name];
      assert(panel.targets > 0 && panel.reachable === panel.targets && panel.hit === panel.targets,
        `${name} alcanzable=${JSON.stringify(panel)}`);
      assert(panel.minHeight >= 40 && panel.minWidth >= 40, `${name} targets=${JSON.stringify(panel)}`);
      assert(panel.overlaps === 0 && panel.expandedTopLevel === 1, `${name} overlaps/expand=${JSON.stringify(panel)}`);
      assert(panel.stageBottom === panel.barTop, `${name} panel/bar=${JSON.stringify(panel)}`);
    }

    const runtimeExceptions = pages.flatMap(page => page.events)
      .filter(event => event.method === 'Runtime.exceptionThrown')
      .map(event => event.params?.exceptionDetails?.exception?.description ||
        event.params?.exceptionDetails?.text || 'unknown');
    assert(runtimeExceptions.length === 0, `excepciones runtime=${runtimeExceptions.join(' | ')}`);

    process.stdout.write(`${JSON.stringify({
      static:{ nodeCheckExit:syntax.status, inlineScripts:scripts.length },
      viewport:[412, 915],
      defaultGlitch:defaultState,
      glitch,
      burst,
      cam:{ family:'AUTO03', pixelDiff:camPixels.diff },
      ascii:{ cols:32, pixelDiff:asciiPixels.diff },
      flow:{ aura:'l', pixelDiff:flowPixels.diff },
      persistence:{
        beforeReload:persisted.pipeline,
        clamped:clamped.runtime.pipeline,
        storedEqualsRuntime:JSON.stringify(clamped.stored) === JSON.stringify(clamped.runtime),
      },
      mobile,
      outputVideoGumCalls:await evaluate(output, '__t22.gumCalls'),
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

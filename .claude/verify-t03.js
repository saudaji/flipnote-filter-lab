#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.T03_BASE_URL || 'http://127.0.0.1:8742/';
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        return;
      }
      if (msg.method) this.sessions.get(msg.sessionId)?.events.push(msg);
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
  window.__t03 = { gumCalls: [], openCalls: 0, messages: [] };
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}

  window.open = (...args) => {
    window.__t03.openCalls++;
    window.__t03.lastOpenArgs = args;
    return { closed: false, focus() {}, close() { this.closed = true; } };
  };

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      const bank = [[90, 1.3], [800, 2.1], [3000, 0.7], [9000, 1.9]];
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
      });
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'stub-mic', label: 'STUB MIC' }];
  mediaDevices.getUserMedia = async constraints => {
    const isVideo = !!constraints?.video;
    window.__t03.gumCalls.push(isVideo ? 'video' : 'audio');
    if (isVideo) {
      const source = document.createElement('canvas');
      source.width = 96;
      source.height = 72;
      const ctx = source.getContext('2d');
      let frame = 0;
      const paint = () => {
        frame++;
        ctx.fillStyle = frame % 2 ? '#ff3b00' : '#006bff';
        ctx.fillRect(0, 0, 96, 72);
        ctx.fillStyle = '#fff';
        ctx.fillRect((frame * 7) % 72, 12, 24, 48);
        window.requestAnimationFrame(paint);
      };
      paint();
      return source.captureStream(30);
    }
    const ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    return dest.stream;
  };
})();
`;

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

async function newPage(browser, viewport, ios) {
  const cdp = await browser.createSession();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    deviceScaleFactor: 1,
    mobile: ios,
    screenOrientation: {
      type: viewport.width > viewport.height ? 'landscapePrimary' : 'portraitPrimary',
      angle: viewport.width > viewport.height ? 90 : 0,
    },
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: ios, maxTouchPoints: ios ? 5 : 1 });
  if (ios) await cdp.send('Network.setUserAgentOverride', { userAgent: IOS_UA, platform: 'iPhone' });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
  await cdp.send('Page.navigate', { url: BASE_URL });
  await waitFor(() => evaluate(cdp, 'document.readyState === "complete"'), `carga ${viewport.width}x${viewport.height}`, 10000);
  await evaluate(cdp, `
    __t03.channel = new BroadcastChannel('flip_stage');
    __t03.channel.addEventListener('message', event => __t03.messages.push(event.data));
    document.getElementById('btnSplashStage').click();
    true;
  `);
  await waitFor(() => evaluate(cdp, `document.getElementById('stageArea').classList.contains('visible') && document.querySelectorAll('#stageLayersList .edit-layer-row').length === 1`), 'STAGE visible');
  await evaluate(cdp, `
    document.getElementById('btnStageAddCam').click();
    document.getElementById('btnStageAddAscii').click();
    document.getElementById('btnStageVhsToggle').click();
    true;
  `);
  await waitFor(() => evaluate(cdp, `document.querySelectorAll('#stageLayersList .edit-layer-row').length === 3 && getComputedStyle(document.getElementById('stageVhsPanel')).display !== 'none'`), 'tres capas y VHS');
  return cdp;
}

async function samplePreview(cdp) {
  return evaluate(cdp, `(() => {
    const source = document.getElementById('stagePreviewCanvas');
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 24;
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

async function measureLayout(cdp) {
  return evaluate(cdp, `(() => {
    const area = document.getElementById('stageArea');
    const bar = document.getElementById('barStage');
    const tab = document.querySelector('.tab-bar');
    const first = area.querySelector('.stage-ctl-row');
    area.scrollTop = 0;
    const areaRect = area.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const visibleControls = [...area.querySelectorAll('button,input,select')].filter(el => getComputedStyle(el).display !== 'none');
    let reachableControls = 0;
    let reachableHitTargets = 0;
    const missedHitTargets = [];
    for (const el of visibleControls) {
      const before = el.getBoundingClientRect();
      const contentTop = area.scrollTop + before.top - areaRect.top;
      area.scrollTop = Math.max(0, Math.min(area.scrollHeight - area.clientHeight, contentTop - (area.clientHeight - before.height) / 2));
      const rect = el.getBoundingClientRect();
      const fullyVisible = rect.top >= areaRect.top - 0.5 && rect.bottom <= areaRect.bottom + 0.5;
      if (fullyVisible) reachableControls++;
      const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      if (fullyVisible && hit && (hit === el || el.contains(hit))) reachableHitTargets++;
      else missedHitTargets.push({ id: el.id || el.dataset.act || el.tagName, hit: hit?.id || hit?.className || hit?.tagName || null });
    }
    area.scrollTop = area.scrollHeight;
    const lastRect = document.getElementById('stageOutStatus').getBoundingClientRect();
    const barButtons = [...bar.querySelectorAll('button')];
    const barMetrics = barButtons.map(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      return {
        id: el.id,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        inViewport: rect.left >= -0.5 && rect.right <= innerWidth + 0.5 && rect.top >= -0.5 && rect.bottom <= innerHeight + 0.5,
        hit: !!hit && (hit === el || el.contains(hit)),
      };
    });
    return {
      viewport: [innerWidth, innerHeight],
      stage: {
        position: getComputedStyle(area).position,
        overflowY: getComputedStyle(area).overflowY,
        top: Math.round(areaRect.top),
        bottom: Math.round(areaRect.bottom),
        clientHeight: area.clientHeight,
        scrollHeight: area.scrollHeight,
        scrollRange: area.scrollHeight - area.clientHeight,
        firstTop: Math.round(firstRect.top),
        lastBottomAtMaxScroll: Math.round(lastRect.bottom),
        visibleControls: visibleControls.length,
        reachableControls,
        reachableHitTargets,
        missedHitTargets,
      },
      tab: { bottom: Math.round(tabRect.bottom) },
      bar: {
        position: getComputedStyle(bar).position,
        top: Math.round(barRect.top),
        bottom: Math.round(barRect.bottom),
        height: Math.round(barRect.height),
        visibleButtons: barMetrics.filter(item => item.inViewport).length,
        clickableButtons: barMetrics.filter(item => item.hit).length,
        buttons: barMetrics,
      },
    };
  })()`);
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t03-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, scripts[0]);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding: 'utf8' });
  assert(syntax.status === 0, `node --check falló: ${syntax.stderr}`);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const dynamicIds = [...html.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
  const refs = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const allIds = new Set([...ids, ...dynamicIds]);
  const missingIds = [...new Set(refs.filter(id => !allIds.has(id)))];
  assert(duplicateIds.length === 0, `IDs duplicados: ${duplicateIds.join(', ')}`);
  assert(missingIds.length === 0, `getElementById rotos: ${missingIds.join(', ')}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t03-chrome-'));
  const debugPort = Number(process.env.T03_CDP_PORT) || 24569;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio: 'ignore', detached: true });
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
  const browser = await new Cdp(browserVersion.webSocketDebuggerUrl).open();
  const pages = [];
  const cleanup = () => {
    pages.forEach(page => page.close());
    browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive: true, force: true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    const cases = [
      { name: 'portrait', viewport: { width: 375, height: 812 }, ios: true },
      { name: 'landscape', viewport: { width: 852, height: 393 }, ios: true },
      { name: 'desktop', viewport: { width: 1280, height: 720 }, ios: false },
    ];
    const results = {};
    for (const testCase of cases) {
      const page = await newPage(browser, testCase.viewport, testCase.ios);
      pages.push(page);
      const before = await samplePreview(page);
      await timeout(150);
      const after = await samplePreview(page);
      const layout = await measureLayout(page);
      const previewDiff = pixelDiff(before, after);

      assert(layout.stage.position === 'fixed', `${testCase.name}: stage position=${layout.stage.position}`);
      assert(layout.stage.overflowY === 'auto', `${testCase.name}: overflowY=${layout.stage.overflowY}`);
      assert(layout.stage.firstTop >= 40 && layout.stage.firstTop >= layout.tab.bottom, `${testCase.name}: firstTop/tab=${layout.stage.firstTop}/${layout.tab.bottom}`);
      assert(layout.stage.scrollRange > 0, `${testCase.name}: scrollRange=${layout.stage.scrollRange}`);
      assert(layout.stage.lastBottomAtMaxScroll <= layout.stage.bottom, `${testCase.name}: lastBottom/stageBottom=${layout.stage.lastBottomAtMaxScroll}/${layout.stage.bottom}`);
      assert(layout.stage.reachableControls === layout.stage.visibleControls, `${testCase.name}: controles alcanzables=${layout.stage.reachableControls}/${layout.stage.visibleControls}`);
      assert(layout.stage.reachableHitTargets === layout.stage.visibleControls, `${testCase.name}: hit targets alcanzables=${layout.stage.reachableHitTargets}/${layout.stage.visibleControls} ${JSON.stringify(layout.stage.missedHitTargets)}`);
      assert(layout.bar.position === 'fixed' && layout.bar.height === 96, `${testCase.name}: barra=${layout.bar.position}/${layout.bar.height}`);
      assert(layout.bar.visibleButtons === 6, `${testCase.name}: botones visibles=${layout.bar.visibleButtons}/6 ${JSON.stringify(layout.bar.buttons)}`);
      assert(layout.bar.clickableButtons === 6, `${testCase.name}: botones clickeables=${layout.bar.clickableButtons}/6`);
      assert(previewDiff.changedPixels > 0, `${testCase.name}: pixel diff=0`);

      const beforeOpen = await evaluate(page, '__t03.openCalls');
      await evaluate(page, `document.getElementById('btnStageOpenOut').click(); true`);
      await timeout(20);
      const outputGate = await evaluate(page, `(() => {
        const btn = document.getElementById('btnStageOpenOut');
        const toast = [...document.querySelectorAll('.flip-toast')].at(-1);
        return {
          ariaDisabled: btn.getAttribute('aria-disabled'),
          opacity: Number(getComputedStyle(btn).opacity),
          openCalls: __t03.openCalls,
          toast: toast?.textContent || '',
          toastRects: toast?.getClientRects().length || 0,
        };
      })()`);
      if (testCase.ios) {
        assert(outputGate.ariaDisabled === 'true', `${testCase.name}: aria-disabled=${outputGate.ariaDisabled}`);
        assert(outputGate.opacity < 1, `${testCase.name}: opacity=${outputGate.opacity}`);
        assert(outputGate.openCalls === beforeOpen, `${testCase.name}: window.open calls=${outputGate.openCalls - beforeOpen}`);
        assert(outputGate.toast === 'la salida por ventana necesita desktop — usa el preview o graba directo', `${testCase.name}: toast=${outputGate.toast}`);
        assert(outputGate.toastRects > 0, `${testCase.name}: toastRects=${outputGate.toastRects}`);
        await evaluate(page, `
          document.getElementById('btnStagePhoto').click();
          document.getElementById('btnStageRec').click();
          true;
        `);
        await waitFor(() => evaluate(page, `__t03.messages.filter(message => message.type === 'cmd' && (message.cmd === 'photo' || message.cmd === 'recStart')).length >= 2`), `${testCase.name}: comandos FOTO/REC`);
        outputGate.otherCommands = await evaluate(page, `__t03.messages.filter(message => message.type === 'cmd' && (message.cmd === 'photo' || message.cmd === 'recStart')).length`);
      } else {
        assert(outputGate.ariaDisabled === null, `desktop: aria-disabled=${outputGate.ariaDisabled}`);
        assert(outputGate.openCalls === beforeOpen + 1, `desktop: window.open calls=${outputGate.openCalls - beforeOpen}`);
      }

      const runtimeExceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
      assert(runtimeExceptions.length === 0, `${testCase.name}: excepciones runtime=${runtimeExceptions.length}`);
      results[testCase.name] = { layout, previewDiff, outputGate, runtimeExceptions: runtimeExceptions.length };
    }

    process.stdout.write(`${JSON.stringify({
      static: {
        nodeCheckExit: syntax.status,
        inlineScripts: scripts.length,
        htmlIds: ids.length,
        dynamicIds: dynamicIds.length,
        getElementByIdRefs: refs.length,
        duplicateIds: duplicateIds.length,
        missingIds: missingIds.length,
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

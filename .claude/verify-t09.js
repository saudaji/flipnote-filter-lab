#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CURRENT_PATH = path.join(ROOT, 'docs/index.html');
const BASE_COMMIT = process.env.T09_BASE_COMMIT || '2ec3f83';
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

function extractInlineScript(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(source => source.trim());
  assert(scripts.length === 1, `scripts inline=${scripts.length}`);
  return scripts[0];
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `no se encontro ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let state = 'code';
  for (let i = brace; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (state === 'code') {
      if (char === '"' || char === "'") state = char;
      else if (char === '`') state = '`';
      else if (char === '/' && next === '*') { state = 'block'; i++; }
      else if (char === '/' && next === '/') { state = 'line'; i++; }
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
    } else if (state === 'line') {
      if (char === '\n') state = 'code';
    } else if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; i++; }
    } else if (state === '`') {
      if (char === '\\') i++;
      else if (char === '`') state = 'code';
    } else {
      if (char === '\\') i++;
      else if (char === state) state = 'code';
    }
  }
  throw new Error(`funcion sin cerrar: ${name}`);
}

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert(start >= 0 && end > start, `seccion ausente: ${startNeedle}`);
  return source.slice(start, end);
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
  const nativeRandom = Math.random.bind(Math);
  let randomState = 0x1f2e3d4c;
  window.__t09 = {
    gumCalls:{ video:0, audio:0 },
    rafCallbacks:0,
    bankOscillators:0,
    setRandom(seed) { randomState = seed >>> 0; Math.random = seededRandom; },
    useNativeRandom() { Math.random = nativeRandom; },
  };
  const seededRandom = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  Math.random = seededRandom;
  window.requestAnimationFrame = cb => realSetTimeout(() => {
    __t09.rafCallbacks++;
    cb(performance.now());
  }, 16);
  window.cancelAnimationFrame = id => clearTimeout(id);

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    AC.prototype.createMediaStreamSource = function() {
      const bus = this.createGain();
      const bank = [[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]];
      for (const [frequency, lfoFrequency] of bank) {
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
        __t09.bankOscillators++;
      }
      return bus;
    };
  }

  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:mediaDevices });
  mediaDevices.getUserMedia = async constraints => {
    if (constraints?.video) {
      __t09.gumCalls.video++;
      const source = document.createElement('canvas');
      source.width = 96; source.height = 72;
      const ctx = source.getContext('2d');
      ctx.fillStyle = '#f40'; ctx.fillRect(0, 0, 96, 72);
      return source.captureStream(30);
    }
    __t09.gumCalls.audio++;
    const audioCtx = new AC();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx.createMediaStreamDestination().stream;
  };
})();
`;

function makeApplyFactory(functionSource, optimized, tracked) {
  return `(() => {
    const NativeU8C = window.Uint8ClampedArray;
    let allocations = 0;
    const Uint8ClampedArray = ${tracked
      ? "new Proxy(NativeU8C, { construct(Target, args) { allocations++; return new Target(...args); } })"
      : 'NativeU8C'};
    const SCR_BURST_TAU = 0.18;
    const _scrTabLayerParams = {};
    let scrChromaVal=0, scrDripVal=0, scrNeonVal=0, scrWaveVal=0, scrCrushVal=0;
    let scrHueVal=0, scrGrainVal=0, scrChaosVal=0, scrAudioReactVal=0;
    let scrAnimateOn=false, scrSpeedVal=50, scrPyPal='none';
    const _scrQuantize = (r,g,b) => [r,g,b];
    ${optimized ? `let _scrashOutBuffer = new Uint8ClampedArray(0);
    let _scrashRandWidth=0,_scrashGrainNoise=new Int16Array(0),_scrashChaosMask=new Uint8Array(0);
    let _scrashChaosR=new Uint8Array(0),_scrashChaosG=new Uint8Array(0),_scrashChaosB=new Uint8Array(0);
    const _scrashClamp8=Uint8Array.from({length:512},(_,i)=>Math.max(0,Math.min(255,i-128)));` : ''}
    ${functionSource}
    return { run:_applyScrash, allocations:() => allocations, resetAllocations:() => { allocations=0; } };
  })()`;
}

function makeSonoFactory(currentSource) {
  return `(() => {
    const NativeF32 = window.Float32Array;
    let allocations = 0;
    const Float32Array = new Proxy(NativeF32, { construct(Target, args) { allocations++; return new Target(...args); } });
    let DSI_W=256, DSI_H=192;
    const _sonoFieldPool = [
      new Float32Array(DSI_W * DSI_H),
      new Float32Array(DSI_W * DSI_H),
      new Float32Array(DSI_W * DSI_H),
    ];
    ${extractFunction(currentSource, '_ensureSonoFieldPool')}
    ${extractFunction(currentSource, 'generateSonoField')}
    ${extractFunction(currentSource, 'warpFieldByWave')}
    return { generate:generateSonoField, warp:warpFieldByWave, resize:(w,h) => { DSI_W=w; DSI_H=h; }, allocations:() => allocations, resetAllocations:() => { allocations=0; } };
  })()`;
}

function makeAudioFactory(currentSource) {
  return `(() => {
    const NativeU8 = window.Uint8Array;
    let allocations = 0;
    const Uint8Array = new Proxy(NativeU8, { construct(Target, args) { allocations++; return new Target(...args); } });
    const _audioDataBuffers = new WeakMap();
    ${extractFunction(currentSource, '_getAudioDataBuffers')}
    return { get:_getAudioDataBuffers, allocations:() => allocations, resetAllocations:() => { allocations=0; } };
  })()`;
}

async function main() {
  const currentHtml = fs.readFileSync(CURRENT_PATH, 'utf8');
  const baseHtml = execFileSync('git', ['show', `${BASE_COMMIT}:docs/index.html`], { cwd:ROOT, encoding:'utf8' });
  const currentSource = extractInlineScript(currentHtml);
  const baseSource = extractInlineScript(baseHtml);

  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t09-check-'));
  const extractedPath = path.join(checkDir, 'index-inline.js');
  fs.writeFileSync(extractedPath, currentSource);
  const syntax = spawnSync(process.execPath, ['--check', extractedPath], { encoding:'utf8' });
  assert(syntax.status === 0, `node --check fallo: ${syntax.stderr}`);

  const ids = [...currentHtml.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const dynamicIds = [...currentHtml.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
  const refs = [...currentHtml.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const allIds = new Set([...ids, ...dynamicIds]);
  const missingIds = [...new Set(refs.filter(id => !allIds.has(id)))];
  assert(duplicateIds.length === 0, `IDs duplicados=${duplicateIds.join(',')}`);
  assert(missingIds.length === 0, `IDs rotos=${missingIds.join(',')}`);

  const baseOscam = section(baseSource, 'const _oscamWebGLEngine', 'function renderOscam');
  const currentOscam = section(currentSource, 'const _oscamWebGLEngine', 'function renderOscam');
  const staticMetrics = {
    oscamUniformLookupsBase:(baseOscam.match(/getUniformLocation/g) || []).length,
    oscamUniformLookupsCurrent:(currentOscam.match(/getUniformLocation/g) || []).length,
    preserveDrawingBufferCurrent:(currentOscam.match(/preserveDrawingBuffer/g) || []).length,
    seikoDeadReadsBase:(extractFunction(baseSource, 'renderCaskia').match(/ctxS\.getImageData/g) || []).length,
    seikoDeadReadsCurrent:(extractFunction(currentSource, 'renderCaskia').match(/ctxS\.getImageData/g) || []).length,
  };
  assert(staticMetrics.oscamUniformLookupsCurrent === 1, `lookups OSCAM actuales=${staticMetrics.oscamUniformLookupsCurrent}`);
  assert(staticMetrics.preserveDrawingBufferCurrent === 0, 'preserveDrawingBuffer sigue activo');
  assert(staticMetrics.seikoDeadReadsCurrent === 0, 'getImageData muerto de SEIKO sigue presente');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-t09-chrome-'));
  const debugPort = Number(process.env.T09_CDP_PORT) || 24888;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-default-apps', '--disable-background-networking',
    '--disable-component-update', '--disable-popup-blocking', '--disable-crash-reporter', '--disable-breakpad',
    '--disable-gpu', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio:['ignore', 'pipe', 'pipe'], detached:true });
  chrome.stdout.resume();
  chrome.stderr.resume();
  chrome.unref();
  let chromeExit = null;
  chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
  const version = await waitFor(async () => {
    if (chromeExit) throw new Error(`Chrome termino antes de DevTools en puerto ${debugPort}: ${JSON.stringify(chromeExit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && response.json();
    } catch (_) { return false; }
  }, 'Chrome DevTools');
  const browser = await new Cdp(version.webSocketDebuggerUrl).open();
  const page = await browser.createSession();
  const cleanup = () => {
    page.close(); browser.close();
    if (!chrome.killed) chrome.kill('SIGTERM');
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch (_) {}
    try { fs.rmSync(checkDir, { recursive:true, force:true }); } catch (_) {}
  };
  process.once('exit', cleanup);

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:INIT_SCRIPT });
    await page.send('Page.navigate', { url:'data:text/html,<canvas id="root"></canvas>' });
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 'documento headless');

    const baseFactory = makeApplyFactory(extractFunction(baseSource, '_applyScrash'), false, false);
    const currentFactory = makeApplyFactory(extractFunction(currentSource, '_applyScrash'), true, false);
    const trackedFactory = makeApplyFactory(extractFunction(currentSource, '_applyScrash'), true, true);
    const sonoFactory = makeSonoFactory(currentSource);
    const audioFactory = makeAudioFactory(currentSource);
    await evaluate(page, `window.__baseRig=${baseFactory}; window.__currentRig=${currentFactory}; window.__trackedRig=${trackedFactory}; window.__sonoRig=${sonoFactory}; window.__audioRig=${audioFactory}; true`);

    const runtime = await evaluate(page, String.raw`
(async () => {
  const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const videoStream = await navigator.mediaDevices.getUserMedia({ video:true });
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  const AC = window.AudioContext || window.webkitAudioContext;
  const probeCtx = new AC();
  probeCtx.createMediaStreamSource(audioStream);

  const W=640, H=480;
  const src=document.createElement('canvas'); src.width=W; src.height=H;
  const srcCtx=src.getContext('2d', { willReadFrequently:true });
  const input=srcCtx.createImageData(W,H);
  for(let i=0;i<input.data.length;i++) input.data[i]=(i*73+19)&255;
  srcCtx.putImageData(input,0,0);
  const baseOut=document.createElement('canvas'); baseOut.width=W; baseOut.height=H;
  const currentOut=document.createElement('canvas'); currentOut.width=W; currentOut.height=H;
  const baseCtx=baseOut.getContext('2d', { willReadFrequently:true });
  const currentCtx=currentOut.getContext('2d', { willReadFrequently:true });
  const params=() => ({ chroma:50,drip:50,neon:50,wave:50,crush:50,hue:50,grain:50,chaos:50,audioReact:50,animate:false,speed:50 });
  const audio={ bass:0.5,mid:0.5,treble:0.5,rms:0.5,transient:0 };
  const baseP=params(), currentP=params();

  let diffBytes=0, diffPixels=0, maxDelta=0;
  for(let frame=0;frame<5;frame++) {
    const seed=0x2a6d365a+frame;
    __t09.setRandom(seed); __baseRig.run(srcCtx,baseCtx,W,H,1+frame/30,audio,baseP);
    __t09.setRandom(seed); __currentRig.run(srcCtx,currentCtx,W,H,1+frame/30,audio,currentP);
    const a=baseCtx.getImageData(0,0,W,H).data, b=currentCtx.getImageData(0,0,W,H).data;
    for(let i=0;i<a.length;i+=4) {
      let pixelDiff=false;
      for(let c=0;c<4;c++) {
        const delta=Math.abs(a[i+c]-b[i+c]);
        if(delta) { diffBytes++; pixelDiff=true; if(delta>maxDelta)maxDelta=delta; }
      }
      if(pixelDiff)diffPixels++;
    }
  }

  __t09.useNativeRandom();
  for(let i=0;i<3;i++) {
    __baseRig.run(srcCtx,baseCtx,W,H,2+i/30,audio,baseP);
    __currentRig.run(srcCtx,currentCtx,W,H,2+i/30,audio,currentP);
  }
  const baseMs=[], currentMs=[];
  const timed=(rig,ctx,t,p) => { const start=performance.now(); rig.run(srcCtx,ctx,W,H,t,audio,p); return performance.now()-start; };
  for(let i=0;i<90;i++) {
    const t=3+i/30;
    if(i&1) {
      currentMs.push(timed(__currentRig,currentCtx,t,currentP));
      baseMs.push(timed(__baseRig,baseCtx,t,baseP));
    } else {
      baseMs.push(timed(__baseRig,baseCtx,t,baseP));
      currentMs.push(timed(__currentRig,currentCtx,t,currentP));
    }
  }
  const stats=values => {
    const sorted=[...values].sort((a,b)=>a-b);
    return { meanMs:values.reduce((a,b)=>a+b,0)/values.length, medianMs:sorted[sorted.length>>1], minMs:sorted[0], maxMs:sorted.at(-1) };
  };
  const baseStats=stats(baseMs), currentStats=stats(currentMs);

  const small=document.createElement('canvas'); small.width=64; small.height=48;
  const smallCtx=small.getContext('2d', { willReadFrequently:true });
  smallCtx.fillStyle='#78695a'; smallCtx.fillRect(0,0,64,48);
  const smallOut=document.createElement('canvas'); smallOut.width=64; smallOut.height=48;
  const smallOutCtx=smallOut.getContext('2d');
  const trackedP=params();
  __trackedRig.run(smallCtx,smallOutCtx,64,48,0,audio,trackedP);
  __trackedRig.resetAllocations();
  for(let i=0;i<300;i++) __trackedRig.run(smallCtx,smallOutCtx,64,48,i/30,audio,trackedP);

  const timeData=new Uint8Array(2048); timeData.fill(128);
  __sonoRig.generate(0.5,0.4,0.2,0);
  __sonoRig.resetAllocations();
  __sonoRig.resize(128,96);
  const resizedSonoField=__sonoRig.generate(0.5,0.4,0.2,0);
  const sonoResizeAllocations=__sonoRig.allocations();
  __sonoRig.resetAllocations();
  for(let i=0;i<300;i++) {
    const field=__sonoRig.generate(0.5,0.4,0.2,i/30);
    __sonoRig.warp(field,timeData,0.5);
  }

  const fakeAnalyser={ frequencyBinCount:1024, fftSize:2048 };
  __audioRig.get(fakeAnalyser);
  __audioRig.resetAllocations();
  for(let i=0;i<600;i++) __audioRig.get(fakeAnalyser);

  const asciiCache=(() => {
    let _asciiStepCv=null,_asciiStepCtx=null,creates=0;
    const realDocument=window.document;
    const document={ createElement(tag) { creates++; return realDocument.createElement(tag); } };
    const ASCII_GRADIENTS={ normal:' .:-=+*#%@' }, TYPO_INKS={}, TYPO_PAPERS={};
    const _hexToRgbStr=()=>'', _getAsciiClassicColors=()=>({ink:'255,255,255',paper:'0,0,0'}), _asciiInvertMap=()=>false;
    ${extractFunction(currentSource, '_renderAsciiStep')}
    const source=realDocument.createElement('canvas'); source.width=32; source.height=24;
    const target=realDocument.createElement('canvas'); target.width=80; target.height=60;
    const ctx=target.getContext('2d');
    _renderAsciiStep(source,ctx,{cols:20},0); _renderAsciiStep(source,ctx,{cols:20},1);
    return { creates, sameCanvas:!!_asciiStepCv };
  })();

  const vhsCache=(() => {
    let _vhsNoiseTiles=[],_vhsNoiseTileIndex=0,_vhsNoiseSize='';
    ${extractFunction(currentSource, '_vhsNoiseCanvas')}
    const canvases=[]; for(let i=0;i<5;i++)canvases.push(_vhsNoiseCanvas(8,8));
    return { tileCount:_vhsNoiseTiles.length, unique:new Set(canvases).size, wraps:canvases[0]===canvases[4] };
  })();

  const pipeContexts=(() => {
    let _pipeA=null,_pipeB=null; const options=[];
    const document={ createElement() { return { width:0,height:0,getContext(type,opts) { options.push(opts || null); return {}; } }; } };
    ${extractFunction(currentSource, '_ensurePipeBuffers')}
    _ensurePipeBuffers(640,480);
    return { canvases:+!!_pipeA + +!!_pipeB, willReadFrequently:options.filter(o=>o?.willReadFrequently===true).length };
  })();

  const scrashCap=(() => {
    let _scrashLastFrameMs=0,scrashRunning=true,_scrashLoopAlive=false,_scrRafId=null,renders=0,raf=0;
    const requestAnimationFrame=()=>{raf++;return raf},_rigSeconds=ts=>ts/1000;
    const scrashCvs={width:1,height:1},vid={videoWidth:1,videoHeight:1};
    const _ctxScrTmp={fillStyle:'',fillRect(){},drawImage(){}},ctxScrash={};
    const _readFlipAudioSnapshot=()=>null,_applyScrash=()=>{renders++},_renderScrashAudioSource=()=>{};
    let extAudioMode=false,extMicOnlyMode=false,extAnalyser=null; const _scrTabLayerParams={};
    ${extractFunction(currentSource, '_scrashLoop')}
    for(let i=0;i<61;i++)_scrashLoop(1000+i*(1000/59.94));
    return { ticks:61,renders,raf };
  })();

  const stageCap=(() => {
    let _stagePreviewRunning=true,_stagePreviewLastFrameMs=0,renders=0,raf=0;
    const ctxStagePreview={},requestAnimationFrame=()=>{raf++;return raf};
    const _readFlipAudioSnapshot=()=>null,_stagePreviewGetSrc=()=>({}),runPipeline=()=>{renders++};
    const _stagePipelineForRender=()=>[],_stageCtlState={};
    let extAudioMode=false,extMicOnlyMode=false,extAnalyser=null;
    ${extractFunction(currentSource, '_stagePreviewLoop')}
    for(let i=0;i<61;i++)_stagePreviewLoop(1000+i*(1000/59.94));
    return { ticks:61,renders,raf };
  })();

  const saveDebounce=await (async () => {
    let _saveSettingsTimer=null,writes=0,writeAt=0,lastCallAt=0;
    const _writeSettings=()=>{_saveSettingsTimer=null;writes++;writeAt=performance.now()};
    ${extractFunction(currentSource, 'saveSettings')}
    for(let i=0;i<60;i++){saveSettings();lastCallAt=performance.now();await timeout(16);}
    await timeout(340);
    return { calls:60,writes,trailingMs:writeAt-lastCallAt };
  })();

  videoStream.getTracks().forEach(track=>track.stop());
  audioStream.getTracks().forEach(track=>track.stop());
  await probeCtx.close();
  return {
    performance:{ frames:90,base:baseStats,current:currentStats,reductionPct:(baseStats.meanMs-currentStats.meanMs)/baseStats.meanMs*100 },
    pixelDiff:{ frames:5,comparedPixels:W*H*5,diffPixels,diffBytes,maxDelta },
    allocations:{ simulatedSeconds:10,frames:300,scrashUint8Clamped:__trackedRig.allocations(),sonoFloat32:__sonoRig.allocations(),sonoResizeAllocations,sonoResizedLength:resizedSonoField.length,audioUint8AfterWarmup:__audioRig.allocations() },
    asciiCache,vhsCache,pipeContexts,scrashCap,stageCap,saveDebounce,
    harness:{ gumCalls:__t09.gumCalls,rafCallbacks:__t09.rafCallbacks,bankOscillators:__t09.bankOscillators },
  };
})()
`);

    assert(runtime.performance.reductionPct >= 30, `reduccion _applyScrash=${runtime.performance.reductionPct.toFixed(3)}% datos=${JSON.stringify(runtime.performance)}`);
    assert(runtime.pixelDiff.diffBytes === 0, `pixel diff bytes=${runtime.pixelDiff.diffBytes}`);
    assert(runtime.allocations.scrashUint8Clamped === 0, `alloc Uint8Clamped=${runtime.allocations.scrashUint8Clamped}`);
    assert(runtime.allocations.sonoFloat32 === 0, `alloc Float32 SONO=${runtime.allocations.sonoFloat32}`);
    assert(runtime.allocations.sonoResizeAllocations === 3 && runtime.allocations.sonoResizedLength === 128 * 96,
      `resize SONO=${JSON.stringify(runtime.allocations)}`);
    assert(runtime.allocations.audioUint8AfterWarmup === 0, `alloc Uint8 audio=${runtime.allocations.audioUint8AfterWarmup}`);
    assert(runtime.asciiCache.creates === 1, `canvas ASCII creados=${runtime.asciiCache.creates}`);
    assert(runtime.vhsCache.tileCount === 4 && runtime.vhsCache.unique === 4 && runtime.vhsCache.wraps, `pool VHS=${JSON.stringify(runtime.vhsCache)}`);
    assert(runtime.pipeContexts.willReadFrequently === 2, `pipe willReadFrequently=${runtime.pipeContexts.willReadFrequently}`);
    assert(runtime.scrashCap.renders <= 31 && runtime.stageCap.renders <= 31, `caps=${runtime.scrashCap.renders}/${runtime.stageCap.renders}`);
    assert(runtime.saveDebounce.writes === 1, `writes saveSettings=${runtime.saveDebounce.writes}`);
    assert(runtime.harness.gumCalls.video === 1 && runtime.harness.gumCalls.audio === 1, `gUM=${JSON.stringify(runtime.harness.gumCalls)}`);
    assert(runtime.harness.rafCallbacks >= 1 && runtime.harness.bankOscillators === 4, `arnes=${JSON.stringify(runtime.harness)}`);

    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert(exceptions.length === 0, `excepciones runtime=${exceptions.length}`);
    process.stdout.write(`${JSON.stringify({
      baseCommit:BASE_COMMIT,
      syntax:{ nodeCheckExit:syntax.status },
      ids:{ declared:ids.length,unique:new Set(ids).size,duplicates:duplicateIds.length,references:refs.length,missing:missingIds.length },
      staticMetrics,
      ...runtime,
      runtimeExceptions:exceptions.length,
    }, null, 2)}\n`);
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

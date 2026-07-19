# FLIP — Reporte técnico de estado (v71)

**Fecha:** 18 julio 2026 · **Producción:** https://saudaji.github.io/flipnote-filter/ · **Repo:** `github.com/saudaji/flipnote-filter`
**Audiencia:** dev que se incorpora al proyecto. Todo lo descrito está verificado en runtime, no es aspiracional.

---

## 1. Filosofía y stack

FLIP es una estación creativa audiovisual (estética Flipnote/DSi, glitch, ASCII art) que corre como **PWA en un solo archivo**: `docs/index.html` (~20,700 líneas: CSS + HTML + un único `<script>` no-module). Decisiones deliberadas:

- **Cero build, cero frameworks, cero npm.** Se edita el HTML directo. El único vendor es `docs/pretext.js` (layout de texto para el modo TYPO, ~50KB, import dinámico local con fallback a CDN).
- **Offline-first**: service worker `docs/sw.js` con cache-first. **Regla dura: cada deploy exige bump del nombre `CACHE`** (vamos en `v71`) o los clientes PWA nunca reciben la actualización. Es el error más caro de olvidar.
- **Deploy = `git push`** a `main`; GitHub Pages sirve `docs/`. El script `deploy.py` del root está **obsoleto** (apunta a `webapp/` que ya no existe).
- Dev server local: `node .claude/serve.js` (puerto 8742, estático).
- Excepción al "cero CDN": FLOW usa MediaPipe tasks-vision (~5MB WASM + modelo tflite) para segmentación de silueta. No vendorizado por peso; hay fallback procedural (§7.7).

## 2. Mapa de módulos (9 tabs)

Estado central: `activeTab` + `switchTab(tab)` — **navegar siempre por anclas/grep, los números de línea se corren**. `switchTab` togglea áreas (`.visible`), bottom bars, HUDs, body classes, y hace kick de los rAF loops. Un wrapper (patrón "V50") lo envuelve para llamar `relayout()`, `renderFlipNav()` y `_updateExportBar()`.

| Tab | id | Canvas | Loop | Qué hace |
|-----|----|--------|------|----------|
| CAM | `cam` | `#display` | `cameraLoop` | 7 familias de render: DSI (dither 1-bit), AUTO03, DLPHN, CASKIA, VFD, OSCAM, SLHT. Dispatch en `_renderCamEngineFrame` |
| ASCII | `ascii` | `#asciiCanvas` | `asciiLoop` | Submodo **classic** (grid de chars, worker OffscreenCanvas para preview) y **TYPO** (pretext, stickers con reflow, INK/PAPER) |
| SONO | `sono` | `#sonoCanvas` | `sonoLoop` | Visualizador reactivo (mic/archivo) |
| WMP | `wmp` | `#wmpCanvas` | `wmpLoop` | Visualizador presets SCOPE/FIRE/OCEAN/ALCHEMY |
| GLITCH | `scrash` | `#scrashCanvas` | `_scrashLoop` | Chain per-pixel chroma/drip/neon/wave/crush/hue/grain/chaos en `_applyScrash` |
| FUSION | `fusion` | `#fusionCanvas` | `_fusionLoop` | Pipeline en vivo: cam→CAM(familia)→GLITCH audio-driven |
| FLOW | `sflow` | `#sflowCanvas` | `_sfLoop`/`_sfLoopAudio` | Aura de glifos sobre silueta (MediaPipe) o blob procedural por audio |
| EDIT | `edit` | `#editCanvas` | `_editLoop` | Editor por capas sobre el pipeline (§4) |
| STAGE | `stage` | `#stageCanvas` | `_stageLoop` | Shell de performance (§5). Se entra desde EDIT (`#btnEditStage`), no desde la tab bar |

Convenciones UI: bottom bar por módulo (`#barX`), HUD encima (`#xHUD`, altura auto con CSS var `--x-hud-h` + ResizeObserver), toasts con `flipToast()` (cero `alert()`), touch targets ≥40-44px vía media queries `max-width:767/768px`.

## 3. El pipeline de render (keystone)

Contrato: `renderStep(srcCanvas, targetCtx, params, audio, t)`. Registrados en `FLIP_STEP_ENGINES`:

- **`cam`**: delega a `_renderCamEngineFrame(src, w, h, targetCtx, mirror, {path:'preview', now:t, family})`. `options.family` se resuelve en `_getCamEngineProfile` **sin mutar** los globals `camFamily`/`camVariant` ni body classes (eso solo pasa en `_applyCamState`, que el pipeline nunca llama) → familias por capa aisladas. **Caveat**: el *variant* (DAY/NIGHT/FLASH de VFD, `legacyMode`) sí lee globals — aislamiento a nivel familia, no variante.
- **`glitch`**: delega a `_applyScrash(srcCtx, dstCtx, w, h, t, audioMod)`. Params de los sliders globales `scr*Val` (deuda §7.1). `audioMod` = `{bassE, midE, trebE, rms}`.

`runPipeline(steps, sourceCanvas, outCtx, audio, t)`: copia la fuente al buffer A, corre los steps alternando ping-pong `_pipeA`/`_pipeB` (nunca lee y escribe el mismo canvas), blit final escalado a `outCtx`. Los renderers de CAM se auto-dimensionan de `targetCtx.canvas`.

Resolución de trabajo: 640×480 en EDIT; STAGE la degrada dinámicamente (§5).

## 4. EDIT

- Estado: `editSource = {type:'cam'|'photo'|'video'|'audio'}` y `editSteps = [{engine, on, family?}]` (máx 3 capas, motores repetibles).
- Fuentes: cámara global `vid`; foto/video con file input propio (**no** reutiliza el `handleFile` del viejo UPLOAD) — imagen con cover-fit, video en `<video playsinline muted loop>`; audio = `_getExtAudioSourceFrame(640,480)` por frame.
- UI por capa: bypass ◉, reorden ▲▼, ✕, paneles expandibles (uno a la vez, event delegation en `#editLayersList`): capa CAM → strip de 7 familias; capa GLITCH → 9 sliders (CHROMA/DRIP/NEON/WAVE/CRUSH/HUE/GRAIN/CHAOS/AUDIO REACT) + ANIMATE/SPEED, espejo de `#scr*`/`#vScr*` del tab GLITCH.
- Persistencia: `window._editPipeline` en `flipSettings`, validado al cargar; foto/video no restauran archivo → fallback a `cam` con toast.
- Export: SNAP (`_canvasToJpeg`+`saveBlob`) y REC (patrón §6.2).

## 5. STAGE

- Entrada: `#btnEditStage` → `switchTab('stage')` + `requestFullscreen()` (omitido en PWA standalone iOS). `body.stage-mode` oculta todo el chrome ajeno. Salida: ✕ o Escape.
- **Escenas**: `flipSettings.stageScenes` — 9 slots con la MISMA estructura que `_editPipeline` (escena ≡ proyecto, una sola forma serializada). Teclas 1-9 (desktop) y 9 pads táctiles 44px (móvil). Pad vacío = clona la escena activa; long-press 600ms = sobrescribe; conmutación por cut seco.
- **Presupuesto de frame duro**: el rAF se re-arma ANTES del trabajo (skip natural — un frame lento nunca encola). Promedio móvil de 10 frames > 24ms → baja resolución 640→512→384 (toast único "modo rápido"); <12ms por 60 frames → sube. Inspección: `window._stageGetWorkRes()`.
- Chrome desvanecible (3s, reaparece con pointer), grabación con ⏺/tecla R.
- Sin cámara: fuente cae a `_getExtAudioSourceFrame` → escenas 100% generativas del audio.

## 6. Los buses transversales

### 6.1 Bus de audio

`FlipAudioReact` (singleton): `attach(analyser)` / `read() → {bass, mid, treble, rms, transient}` 0..1, smoothing attack (~α0.6) / release (~α0.12) por feature, detector de onset (`transient` = rms instantáneo vs media móvil ×6). `read()` auto-resume el AudioContext suspendido.

Dos modos de fuente:

- **`extAudioMode` (desktop)**: panel ⚙ AUDIO → `startExtAudio()` → `getUserMedia(audio, sin AGC/EC/NS) → extAudioCtx → extInGainNode (SENSIBILIDAD 0.5-10x, 'flip_ext_gain') → extAnalyser → FlipAudioReact.attach`. **Reemplaza la cámara** (`body.ext-audio`).
- **`extMicOnlyMode` (móvil)**: botón 🎙 (`_initMicMobileButton`) → `startMicOnly()` con la misma cadena (`_buildExtAudioChain` compartido) pero **sin tocar la cámara**. Blindajes iOS: watchdog que detecta cuando Safari mata los video tracks al pedir el mic (300ms de gracia, re-adquiere con `startCamera` + hook `_sflowRestartCam`); watchdog inverso en el track de mic (ended/mute → reconstruye una vez); fallback de constraints (`OverconstrainedError` → `{audio:true}`); resume en `visibilitychange`. Feedback: anillo de nivel (CSS var `--mic-level`), estado ⚠ tras 3s sin señal; long-press 550ms cicla sensibilidad 3x→5x→8x. El panel ⚙ AUDIO también funciona en móvil (ACTIVAR delega a mic-only).

**Consumo**: condición canónica `(extAudioMode || extMicOnlyMode) && extAnalyser`; los branches "audio genera imagen" viven tras el check de `vid.videoWidth` (cámara tiene prioridad). Verificado el caso extremo: cámara denegada + mic → los 7 módulos visuales animan.

**Imagen desde audio**: `_getExtAudioSourceFrame(w,h)` — canvas offscreen con gradiente rotante (hue por graves), ondas/retícula/grano por bandas y polígono central con RMS. GLITCH tiene generador propio (`_renderScrashAudioSource`: 6 bandas de ondas full-width, fade radial + zoom-in, flash en transientes).

### 6.2 Captura y guardado

- Foto: `_canvasToJpeg(canvas)` (aplana sobre negro — evita fotos negras Android/Instagram con PNG alpha) → `saveBlob`.
- Video: `_createFlipRecordingJob(canvas, fps, bitrate, opts)` → captureStream + audio del `FlipAudioEngine` (efectos LOFI/SPRING/PLATE/ECHO; activar un efecto auto-arma el audio) → MediaRecorder con mime por plataforma (mp4 primero en iOS/Android, webm desktop). Límite 120s con contador.
- Ruteo: `saveBlob` según `flipAudioSettings.saveMode`: `'files'` = `<a download>`; `'share'` = `_shareOrDownload` (share sheet iOS). **Videos en modo share**: el finalize corre fuera de user gesture → CTA "↑ GUARDAR VIDEO" (`_promptShareSave`, single-prompt, autofallback a descarga a los 45s).

### 6.3 Persistencia (localStorage)

- `flipSettings`: paletas, cols ASCII por submodo, typo (font/palette/color/ink/paper), `scrAudioReactVal`, `_sfParams` (FLOW), `_editPipeline`, `stageScenes`. Todo validado/clampeado al restaurar.
- `flip_audio_settings`: aspect/resolution/audioMode/effects/saveMode/micEnabled.
- `flip_ext_gain`: sensibilidad compartida.
- `micEnabled=true` NO auto-arranca el mic (iOS exige gesto): el botón pulsa invitando al tap.

## 7. Deuda técnica y limitaciones conocidas

1. **Params de GLITCH son globales**: dos capas GLITCH comparten sliders. El estado por-capa es el siguiente refactor natural (mover `scr*Val` a `params` del step).
2. **Variant de CAM no aislado** en el override por capa (solo familia).
3. **ASCII no es step del pipeline**: su preview usa worker async (OffscreenCanvas) — incompatible con el contrato síncrono sin trabajo extra. EDIT/STAGE ofrecen CAM+GLITCH.
4. **SONO/WMP graban su audio limpio**: su path (`sonoAudioDest`/`wmpAudioDest`) no pasa por los efectos de `FlipAudioEngine`. Cirugía aparte ya diagnosticada.
5. **ASCII cols >~235 se ven como masa**: el canvas de salida (1024px) limita el glifo mínimo legible.
6. **STAGE sin crossfade** (cut seco): un crossfade = 2 pipelines simultáneos; presupuestar antes.
7. **FLOW sin internet**: MediaPipe viene de CDN; el modo audio (blob procedural) no lo necesita. `FLARE` alto usa shadowBlur (caro — knob calidad/costo deliberado).
8. **Validación Android en hardware real pendiente** (flujos verificados por simulación; iOS tiene blindajes probados contra simulación del kill de cámara).
9. Commits con `Committer` derivado del hostname (git sin user.email global) — cosmético.

## 8. Metodología de verificación (así se trabaja este repo)

No hay suite de tests. El QA es **verificación runtime medida** en cada cambio:

1. **Estático**: extraer el `<script>` → `node --check`; cross-check de `id=` vs `getElementById` (duplicados/rotos).
2. **Runtime en preview headless** con arnés de stubs — trampas mapeadas (perderlas cuesta horas):
   - Pane con `document.hidden=true` → **rAF congelado**: shim `requestAnimationFrame = cb => setTimeout(()=>cb(performance.now()),50)` ANTES de todo.
   - **Audio cross-AudioContext llega mudo**: wrappear `AudioContext.prototype.createMediaStreamSource` para devolver un GainNode del MISMO contexto con osciladores (banco estándar `[[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]` = freq + LFO; oscilador gateado para transientes).
   - Stub `getUserMedia`: video → `canvas.captureStream(30)` animado; audio → stream de un `MediaStreamAudioDestinationNode`.
   - `offsetParent` es `null` en `position:fixed` — usar `getComputedStyle` para visibilidad.
   - Timers en pane oculto throttleados a ~1s.
3. **Criterio**: pixel-diff numérico entre frames/estados (nunca "se ve bien"), comparaciones on/off en el MISMO build (los renders llevan `t` y `Math.random` — dos builds jamás dan frames idénticos), matrices de cobertura espacial cuando aplica.

Desarrollo orquestado con specs quirúrgicas por tarea (anclas de código, decisiones pre-tomadas, verificación obligatoria con números). Commits en español, `[feat]/[fix]`, cuerpo con mediciones.

## 9. Quick-start

```bash
git clone https://github.com/saudaji/flipnote-filter && cd flipnote-filter
node .claude/serve.js          # → http://localhost:8742
```

- Entrar: click "make it weird" (sin cámara, la app entra igual).
- Orientarse: grep por `switchTab`, `FLIP_STEP_ENGINES`, `runPipeline`, `FlipAudioReact`, `startExtAudio`, `startMicOnly`, `_applyScrash`, `_renderCamEngineFrame`, `_sfLoop`, `_editLoop`, `_stageLoop`, `saveBlob`, `saveSettings`. Cada bloque tiene banner `════`.
- Antes de tocar: §8. Antes de deployar: bump de `CACHE` en `docs/sw.js`, commit, push, y `curl .../sw.js | grep vXX` para confirmar Pages.

---

*Generado del estado real del repo en v71 (commit `b639eba`); comportamiento verificado en runtime durante el ciclo v59→v71.*

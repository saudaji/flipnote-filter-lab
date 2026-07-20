# Verificación T1 · SW offline + actualización segura

## Resumen de cambios

- `docs/sw.js`: `CORE_ASSETS` conserva la instalación atómica de `index.html`, manifest, `pretext.js` e íconos; `FONT_ASSETS` se instala con `Promise.allSettled`; `cacheMediaPipe` usa el caché persistente `flip-cdn-v1`; el handler `fetch` resuelve navegaciones contra `./index.html` con `ignoreSearch` y limita el caché runtime a los dos orígenes de MediaPipe. `CACHE` sigue siendo `flipnote-filter-lab-v73`.
- `docs/index.html`: `SLHT_MP_WASM`, `SLHT_MP_MODEL`, `MEDIAPIPE_WASM` y `MEDIAPIPE_MODEL` usan `@mediapipe/tasks-vision@0.10.35` y el modelo versionado `float16/1`. `_trackFlipRecorder`, `_hasActiveFlipRecording`, `_hasPendingFlipRecordingWork` y el conteo de finalización protegen las grabaciones. `_reloadFlipUpdateWhenSafe` y el wrapper de `switchTab` difieren la recarga hasta que grabación y guardado terminaron. El registro del SW distingue la primera instalación mediante `hadServiceWorkerController`.
- `docs/enochian.ttf`: eliminado; búsqueda en el repo encontró 0 referencias.

## Verificación estática

- Script único extraído de `docs/index.html` → `node --check -`: exit code **0**.
- `docs/sw.js` → `node --check docs/sw.js`: exit code **0**.
- `git diff --check`: exit code **0**.
- HTML: **1** script, **567** IDs, **0** IDs duplicados. Hay **1** referencia estática sin ID en el markup (`flipSettingsStyle`), que el script crea dinámicamente; no fue introducida por este ticket.
- MediaPipe: **4** apariciones de `@mediapipe/tasks-vision@0.10.35`, **2** paths de modelo `float16/1` y **0** apariciones de `@latest`/`float16/latest` en `docs/index.html`.
- Assets: **5/5** assets core presentes (**1,040,749 bytes**) y **4/4** fuentes opcionales presentes (**255,864 bytes**). `docs/enochian.ttf` presente: **0**.
- Valores lab preservados: `CACHE` v73 aparece **1** vez, bump a v74: **0**; `start_url === './'`: **1**; `scope === './'`: **1**.

## Criterios de aceptación

### Instalar PWA → modo avión → abre y CAM/ASCII/GLITCH funcionan

Arnés aislado del service worker:

- Instalación normal: `addAll` recibió **5** assets core; se intentaron **4** fuentes. Con **1** fallo de fuente simulado, la instalación resolvió (**1**) y llamó `skipWaiting` **1** vez; quedaron **8** entradas (5 core + 3 fuentes exitosas).
- Fallo core simulado: instalación rechazada **1** vez, `skipWaiting` **0** y fuentes intentadas **0**, confirmando que el bloque core sigue siendo atómico.
- Navegación de directorio con red caída: body cacheado correcto **1/1**, `ignoreSearch:true` **1/1**, llamadas de red **0**.
- Activación: cachés estáticos viejos restantes **0**, caché CDN persistente restante **1**, `clients.claim` **1**.
- Render offline de CAM/ASCII/GLITCH: pruebas pixel-diff ejecutadas **0**; **no verificado** en navegador por las restricciones descritas abajo.

### FLOW usado una vez con red → offline: segmentación funciona desde caché

Arnés de fetch online→offline sobre el mismo build:

- Primera petición jsDelivr: llamadas de red **1**, escrituras en `flip-cdn-v1` **1**.
- Segunda petición idéntica con red caída: llamadas de red adicionales **0**, body idéntico al online **1/1**.
- Modelo versionado de `storage.googleapis.com`: cacheado **1/1**.
- URL jsDelivr ajena a `@mediapipe`: cacheada **0**.
- Respuesta MediaPipe HTTP 404 simulada: cacheada **0**.
- Inferencia real offline / respuesta observada en DevTools o HAR: ejecuciones **0**; **no verificado** por no poder servir el SW sobre HTTP local ni descargar MediaPipe dentro del navegador de prueba.

### Primera visita: cero reloads

- Simulación completa del bloque de registro: página inicialmente sin controller, `clients.claim` simulado antes de `activated`, recargas solicitadas **0**.

### Deploy simulado durante REC: termina y guarda antes de recargar

- Deploy durante recorder en estado `recording`: diferido **1/1**; toast exacto `actualización lista al cerrar` **1**.
- Recargas mientras grababa: **0**.
- Recargas antes de iniciar finalize: **0**.
- Recargas durante `onFinalize`/guardado async: **0**.
- Duración simulada del guardado: **35 ms**.
- Recargas en el siguiente `switchTab` ya seguro: **1**; el guardado terminó **29 ms antes** de la recarga.
- Conteo final de jobs en finalización: **0**.

## No verificado y motivo

- No se pudo ejecutar el arnés headless de rAF/getUserMedia/osciladores ni obtener pixel-diffs: `node .claude/serve.js` falla al abrir `0.0.0.0:8742` con `listen EPERM`; el navegador conectado bloquea además URLs `file://` por política. Por tanto, CAM/ASCII/GLITCH en modo avión real y la inferencia MediaPipe offline real quedan **no verificadas**.
- No se instaló la PWA ni se probó en un dispositivo físico: requiere un origen HTTP/HTTPS controlado y hardware real. Conteo de pruebas de dispositivo: **0**.
- No hay HAR/DevTools real de la respuesta MediaPipe desde Cache Storage por la misma restricción. HAR producidos: **0**.

La lógica del SW, el updater y la carrera de finalización sí quedaron verificadas numéricamente mediante arneses VM que ejecutan directamente el código extraído de este build.

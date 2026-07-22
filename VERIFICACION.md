# Verificación T10 · EDIT: higiene de medios

## Resumen de cambios

- `docs/index.html` incorpora `_editReleaseMedia`, `_editMediaUrl` y `_editMediaGeneration` para centralizar la pausa y vaciado de `editVideoEl`, la revocación del object URL activo, el cierre de `_editPhotoImg` cuando es `ImageBitmap` y la invalidación de cargas asíncronas antiguas.
- Los handlers de fuentes de `_initEdit` liberan el medio anterior al elegir CAM, SONO, WMP o AUDIO y antes de aceptar un archivo nuevo. El fallback de imagen conserva su object URL en `_editMediaUrl` para revocarlo de forma determinista.
- `switchTab` llama a `window._editOnExit` solamente al abandonar EDIT. Si la fuente liberada era foto o video, el pipeline persistido vuelve a CAM para no conservar una fuente sin recurso.
- `.claude/verify-t10.js` verifica el script inline, IDs, runtime headless, saldo de object URLs, cierre de bitmaps, heap, pausa/vaciado del video y actividad visual por pixel-diff. Usa shim de `requestAnimationFrame`, stubs de `getUserMedia` y banco de cuatro osciladores.
- `docs/sw.js` y su nombre `CACHE` no fueron modificados.

## Criterios de aceptación y mediciones

### Cargar 5 videos seguidos mantiene memoria estable

- Tamaño de cada archivo WebM del arnés: **1,551,658 bytes**.
- `performance.memory.usedJSHeapSize` tras el primer video: **10,625,795 bytes**.
- `performance.memory.usedJSHeapSize` tras el quinto video: **9,405,427 bytes**.
- Delta firmado quinto menos primero: **−1,220,368 bytes**.
- Crecimiento retenido (`max(0, delta)`): **0 bytes**, menor que **1,551,658 bytes** (un video).
- Object URLs de EDIT vivos después de cada carga: **1, 1, 1, 1, 1**.
- URLs de video creados en las cinco cargas: **5**; revocaciones desde el fallback previo: **5** (fallback + cuatro videos reemplazados); saldo al terminar las cinco cargas: **1** URL de video activa.
- Video en cada carga: `paused=false`, `readyState=4` en **5/5** casos.
- Actividad del render después de la quinta carga: **786,432/786,432 píxeles cambiados**, delta RGB total **106,060,526** entre dos frames separados 250 ms.

Resultado: **cumple**; crecimiento retenido **0 < 1,551,658 bytes**.

### Salir de EDIT con fuente video pausa y libera el blob

- `paused`: **true**.
- Atributo `src`: **null**.
- Object URLs vivos atribuibles a EDIT: **0**.
- `_editMediaUrl`: **null**.
- `_editPhotoImg` retenidos: **0**.
- Fuente resultante: **cam**.
- Chrome conserva el texto histórico `blob:file:///…` en `currentSrc` después de `removeAttribute('src') + load()`, pero el registro instrumentado confirma `currentSrcLive=false`: ese blob fue revocado y no está vivo.

Resultado: **cumple**; elemento pausado y sin blob vivo.

## Cobertura adicional medida

- Cambio de VIDEO a AUDIO: `paused=true`, atributo `src=null`, `_editMediaUrl=null`, object URLs EDIT vivos **0**, `currentSrcLive=false`.
- Reemplazo de `ImageBitmap`: creados **1**, cerrados **1**, retenidos **0**.
- Fallback de imagen sin `createImageBitmap`: **1** URL activa al cargar; revocada al cargar el primer video.
- Saldo total de recursos EDIT durante el arnés: object URLs creados **7**, revocados **7**, vivos **0**; bitmaps creados **1**, cerrados **1**.
- Script inline: `node --check` exit **0**; scripts inline **1**.
- Integridad DOM: IDs HTML **567**, IDs dinámicos **8**, referencias `getElementById` **671**, duplicados **0**, referencias rotas **0**.
- Runtime headless: callbacks rAF **389**, llamadas stub `getUserMedia` video/audio **1/1**, osciladores del banco **4**, excepciones runtime **0**, duración **5,756 ms**.

## No verificado

- No se midió memoria nativa del decodificador, GPU ni el panel Memory en un dispositivo físico. El criterio se verificó con `performance.memory` preciso en Chrome headless y con instrumentación exacta de object URLs/bitmaps.
- No se hizo prueba en Safari/iOS o Android real; requiere dispositivo físico y queda declarado como no verificado.

# Verificación T8 — tiempo del pipeline y snapshot de audio

## Resumen

- `docs/index.html`: `rigT0`, `_rigSeconds` y `runPipeline` fijan el contrato único: los loops entregan timestamps rAF/`performance.now()` en milisegundos y cada `renderStep` recibe segundos relativos.
- `FLIP_STEP_ENGINES`, `_renderFlowblobStep` y `_renderVhsStep` adaptan sus unidades internas al nuevo contrato; CAM reconstruye su timestamp legacy en milisegundos en la frontera del motor.
- `_readFlipAudioSnapshot` hace una sola lectura de `FlipAudioReact` y devuelve un objeto congelado. `_scrashLoop`, `_fusionLoop`, `_editLoop`, el preview de STAGE y `_outLoop` reutilizan ese mismo snapshot durante todo el tick.
- `_applyScrash` ya no llama `FlipAudioReact.read()`. Su envelope vive como `_scrRuntime` no enumerable dentro del objeto `P` de cada capa y decae con `Math.exp(-dt / SCR_BURST_TAU)`; TAB, FUSION y el pipeline de prueba tienen objetos de estado independientes.
- `docs/sw.js` no fue modificado; el `CACHE` sigue en `flipnote-filter-lab-v80-rec-blindado`.

## Metodología

Se extrajo el único `<script>` de `docs/index.html` y se validó con `node --check`. El arnés headless determinista leyó ese mismo archivo y extrajo las implementaciones reales de `_applyScrash`, `_rigSeconds`, `runPipeline`, `FlipAudioReact` y `_readFlipAudioSnapshot`; usó canvas RGBA en memoria, shim de rAF, dos stubs de `getUserMedia` (audio/video) y el banco estándar de osciladores `[[90,1.3],[800,2.1],[3000,0.7],[9000,1.9]]`. Todas las comparaciones on/off se hicieron en este mismo build.

## Criterios de aceptación

1. **Período de ANIMATE igual en GLITCH TAB y una capa GLITCH de EDIT (tolerancia ±5%)**
   - 820 frames muestreados a 30 fps.
   - GLITCH TAB: período medido de **363 frames**.
   - GLITCH EDIT vía `runPipeline`: período medido de **363 frames**.
   - Diferencia relativa: **0.000%**.
   - Pixel-diff acumulado TAB vs EDIT: **0 bytes distintos**.

2. **Delta de hue consecutivo menor de 15° con banco de osciladores**
   - 60 frames muestreados a 30 fps.
   - Máximo del ángulo efectivo `treble * 90 * t`: **11.163566°**.
   - Máximo medido sobre el hue HSV de los píxeles renderizados: **13.293092°**.
   - Actividad confirmada: **28,928 bytes de píxel distintos** entre frames consecutivos.
   - Resultado: **13.293092° < 15°**.

3. **Misma duración del envelope con 1 y 3 capas GLITCH hasta 10%**
   - 1 capa: **13 frames / 433.333 ms**, valor terminal **0.090048**.
   - 3 capas: **13 frames / 433.333 ms**, valor terminal **0.090048**.
   - Diferencia: **0 frames / 0.000%**.
   - Dispersión del burst entre las 3 capas: **0.000000000**.

4. **Snapshot único e inmutable por tick**
   - Prueba de hue: **60 lecturas / 60 ticks = 1.000000 lectura por tick**.
   - Envelope de 1 capa: **14 lecturas / 14 ticks = 1.000000**.
   - Envelope de 3 capas: **14 lecturas / 14 ticks = 1.000000**; no aumentó con el número de capas.
   - Snapshots con `Object.isFrozen`: **60/60 verdaderos**.
   - Audio apagado vs snapshot todo-cero: **0 bytes distintos en 256 píxeles**.

## Chequeos adicionales

- `node --check` del script extraído: **exit 0**.
- `git diff --check`: **exit 0**.
- IDs: **567 declarados / 567 únicos / 0 duplicados**.
- Referencias literales `getElementById`: **671**; el único ID no estático (`flipSettingsStyle`) se crea explícitamente con `style.id`, por lo que hay **0 referencias rotas efectivas**.
- Shim de rAF ejercitado: **3 callbacks**; stub de `getUserMedia`: **2 llamadas** (video y audio).

## No verificado

- No se pudo ejecutar el build completo en un navegador de esta sesión: el sandbox rechazó abrir el servidor aislado en `127.0.0.1:8872` con `EPERM`, y el runtime de navegador reportó **0 backends disponibles**. Se sustituyó por el arnés headless de funciones extraídas descrito arriba; no se afirma verificación visual manual.
- No se probó en dispositivo físico ni con micrófono/cámara reales; requiere hardware y permisos fuera de este entorno.

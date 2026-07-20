# Verificación T3 · STAGE control: contrato de layout + móvil

## Resumen del cambio

- `docs/index.html`
  - `#stageArea.visible`: adopta el contrato fijo entre la tab-bar y la barra STAGE, con scroll vertical táctil.
  - `#barStage`: adopta posición fija, altura de 96 px, fondo/borde/z-index de las barras del proyecto y `safe-area-inset-bottom`.
  - `#barStage` móvil: distribuye sus seis acciones dentro de 375 px conservando iconos táctiles de 44 px.
  - `body.stage-mode` + `switchTab`: ocultan el riel global settings/mic/audio sólo durante STAGE, evitando que cubra controles del módulo.
  - `_initStageControl`, `_stageTouchIOS` y el listener de `btnStageOpenOut`: detectan iOS táctil, marcan la salida por ventana con `aria-disabled="true"`, impiden `window.open` y muestran el toast explicativo. Desktop conserva el flujo original.
- `.claude/verify-t03.js`: arnés headless reproducible con shim de rAF, stubs de `getUserMedia`, banco de osciladores, emulación táctil/iOS, conteos de hit-targets, rectángulos y pixel-diff.

## Criterios de aceptación y mediciones

Comando principal:

```sh
T03_BASE_URL=file:///Users/sagredo/atelier/flip-loop/wt/t03/docs/index.html node .claude/verify-t03.js
```

Resultado: exit `0`.

### 375×812 portrait, iOS táctil

- Primera fila: `top=54 px`; borde inferior de tab-bar: `40 px`; margen libre: `14 px`.
- Área STAGE: `top=40`, `bottom=716`, `clientHeight=676`, `scrollHeight=724`, recorrido de scroll `48 px`.
- Último estado al scroll máximo: `bottom=706 px`, 10 px antes del final útil (`716 px`).
- Controles: `28/28` alcanzables por scroll y `28/28` confirmados por `elementFromPoint`.
- Barra STAGE: `position=fixed`, `top=716`, `bottom=812`, altura `96 px`.
- Acciones de barra: `6/6` dentro del viewport y `6/6` clickeables por hit-test.
- Preview en el mismo build, dos frames separados 150 ms: `768/768` píxeles cambiaron; suma absoluta RGB `246946`.
- Puerta iOS: `aria-disabled=true`, opacidad `0.35`, llamadas a `window.open`: `0`, toast visible: `1` rectángulo.
- FOTO + REC permanecen despachables: `2/2` comandos observados por `BroadcastChannel`.
- Excepciones runtime: `0`.

### 852×393 landscape, iOS táctil

- Primera fila: `top=54 px`; borde inferior de tab-bar: `40 px`; margen libre: `14 px`.
- Área STAGE: `top=40`, `bottom=297`, `clientHeight=257`, `scrollHeight=592`, recorrido de scroll `335 px`.
- Último estado al scroll máximo: `bottom=287 px`, 10 px antes del final útil (`297 px`).
- Controles: `28/28` alcanzables por scroll y `28/28` confirmados por hit-test.
- Barra STAGE: `position=fixed`, `top=297`, `bottom=393`, altura `96 px`.
- Acciones de barra: `6/6` dentro del viewport y `6/6` clickeables.
- Preview, dos frames separados 150 ms: `768/768` píxeles cambiaron; suma absoluta RGB `247786`.
- Puerta iOS: `aria-disabled=true`, opacidad `0.35`, llamadas a `window.open`: `0`, toast visible: `1` rectángulo.
- FOTO + REC: `2/2` comandos observados.
- Excepciones runtime: `0`.

### Desktop 1280×720

- Primera fila: `top=54 px`; tab-bar termina en `40 px`; overlap superior: `0 px`.
- Área STAGE con tres capas + VHS: `clientHeight=584`, `scrollHeight=592`, recorrido `8 px`; controles `28/28` alcanzables y clickeables.
- Barra STAGE: altura `96 px`; acciones `6/6` visibles y `6/6` clickeables.
- Preview: `768/768` píxeles cambiaron; suma absoluta RGB `262846`.
- Puerta desktop: sin `aria-disabled`, opacidad `1`, llamadas a `window.open`: `1`.
- Excepciones runtime: `0`.

### Verificación estática y regresión STAGE/OUTPUT

- Script inline extraído: `1`; `node --check`: exit `0`.
- IDs HTML: `567`; IDs dinámicos: `8`; referencias `getElementById`: `670`; duplicados: `0`; referencias rotas: `0`.
- `git diff --check`: exit `0`.
- Arnés de regresión: `T02_CDP_PORT=24570 node .claude/verify-t02.js`, exit `0`.
- Primera imagen OUTPUT: `160 ms`; pixel-diff `768/768`, suma absoluta RGB `264018`.
- Carrera cámara: `15` mensajes, `1` llamada adicional a getUserMedia, `1` track vivo final.
- Carrera audio: `3` mensajes, `1` llamada adicional, `1` track vivo; al apagar, `0` tracks vivos.
- Grabación: `1` pista de video + `1` de audio tanto en entrada como en blob; blob `166509 bytes`; tracks finales `2/2 ended`.
- Excepciones runtime de la regresión: `0`.

## No verificado

- No se verificó en un iPhone/iPad físico ni en PWA standalone. La detección iOS, el bloqueo de `window.open`, el toast y ambos viewports se verificaron mediante emulación headless; el inset seguro distinto de cero requiere hardware/Safari real.
- `node .claude/serve.js` no pudo enlazar `0.0.0.0:8742`: el sandbox devolvió `EPERM` con el puerto libre. Por eso los arneses se ejecutaron sobre `file://`, el mismo fallback usado por `.claude/verify-t02.js`; la ejecución mediante dev server queda no verificada.

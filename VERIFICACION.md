# T12 · GLITCH → WebGL — verificación

## Resumen

- docs/index.html: _scrashWebGLEngine implementa un uber-shader WebGL1 para CHROMA, DRIP, NEON, WAVE, CRUSH, HUE, GRAIN, CHAOS, AUDIO REACT y las tres paletas de pythonization.
- _applyScrash(srcCtx, dstCtx, w, h, t, audioMod, p) conserva su firma. Intenta WebGL y, si el contexto no existe o falla, ejecuta sin cambios el cuerpo JS optimizado de T9 (buffer cacheado, ruido por fila y trigonometría hoisted).
- El shader usa u_resolution y offsets en píxeles; el canvas/textura se redimensiona desde w×h. No hay una constante 4:3.
- .claude/verify-t12.js: arnés reproducible en Chrome headless/CDP con matriz A/B, 300 frames medidos, cuatro aspectos FUSION, fallo real de contexto y STAGE sostenido.

## Criterios de aceptación

### 1. Menos de 1 ms/frame a 640×480

PASS en ANGLE Metal Renderer: Apple M4 (GPU integrada), 300 frames espaciados por frame con todos los efectos activos:

- promedio: **0.921 ms/frame**
- mediana: 1.000 ms
- p95: 1.500 ms
- máximo: 2.100 ms

El cronómetro rodea _applyScrash completo: upload de la fuente, uniforms, draw WebGL y copia al targetCtx 2D.

### 2. A/B de los nueve controles

PASS. La matriz off / low / high se generó en /var/folders/nd/x4q33dss7f1gl2t2p52n9jz00000gn/T/flip-t12-effects-matrix.png (576×1080, 548,566 bytes). Todos respondieron en ambos niveles y low↔high produjo una imagen distinta:

| Control | Low→High | Píxeles distintos en High | Delta RGB total en High |
|---|---:|---:|---:|
| CHROMA | 10→50 | 307,200 | 58,915,220 |
| DRIP | 25→100 | 32,640 | 6,587,668 |
| NEON | 25→100 | 307,200 | 108,445,314 |
| WAVE | 6→30 | 303,360 | 59,670,872 |
| CRUSH | 25→100 | 307,194 | 117,313,024 |
| HUE | 45°→180° | 307,180 | 86,741,439 |
| GRAIN | 25→100 | 305,789 | 39,970,725 |
| CHAOS | 25→100 | 92,163 | 23,495,879 |
| AUDIO REACT | 75→300 | 307,200 | 75,826,225 |

HUE usa 180° como extremo visual de la matriz: 360° es deliberadamente igual a 0° en el renderer legado y en el shader.

Controles adicionales:

- Pass-through con todos los efectos en cero: **0/307,200 píxeles distintos**.
- Paletas PY/SPY/IDE: 2/7/7 colores observados, **0 píxeles fuera de sus paletas**.

### 3. STAGE con VHS+GLITCH durante 60 s

PASS:

- _stageGetWorkRes(): **640 antes → 640 después**.
- Canvas de salida: 1280×960 antes y después; no degradó resolución.
- Último heartbeat: 28 fps, workRes=640; 60 heartbeats recibidos.
- WebGL seguía listo; 0 excepciones runtime.

### 4. Fallback JS forzando fallo de contexto

PASS. En una recarga donde getContext(webgl|experimental-webgl) devolvió null:

- _applyScrash devolvió path GPU=false y _scrashWebGLEngine.isReady() quedó false.
- El fallback procesó **3,072/3,072 píxeles** y emitió “GLITCH WebGL init failed, using JS fallback.”
- Dos renders fallback consecutivos reutilizaron el mismo _scrashOutBuffer.

## Aspectos variables de FUSION (T20)

PASS, con shader activo y salida modificada en los cuatro casos:

- 4:3: input/engine/output 640×480
- 1:1: input/engine/output 480×480
- 16:9: input/engine/output 854×480
- 9:16: input/engine/output 480×854

La regresión completa T20 también pasó: excentricidad del círculo 0% en cuatro aspectos, loop FUSION 1.0×, REC 480×854 de 2.211 s, y paridad de fuente/pipeline 0 píxeles.

## Verificación estática y regresiones

- Script inline extraído: node --check exit 0; un solo script inline.
- verify-t09.js: exit 0; fallback T9 34.03% más rápido que su baseline, pixel-diff 0/1,536,000, 0 allocations calientes.
- verify-t05.js: exit 0; ratio de ticks GLITCH 0.974, 0 excepciones.
- verify-t07.js: exit 0; CAM 10/10 y GLITCH 10/10 videos válidos, 0 zombie clobbers, 0 excepciones.
- T8/T20: exit 0 usando 0e46710 como control pre-T20. El wrapper versionado busca el bug pre-T20 en main y su precondición quedó obsoleta cuando T20 se mergeó; solo se redirigió esa lectura de control, sin modificar el arnés.
- git diff --check: exit 0.

## No verificado

- No se probó en GPU Android/iPhone física. Un fallo de compilación/contexto en esos dispositivos cae automáticamente al fallback JS verificado.

## Commit sugerido

[feat] migra GLITCH a WebGL con fallback JS

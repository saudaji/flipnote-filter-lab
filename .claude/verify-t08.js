#!/usr/bin/env node
'use strict';

// El arnés original de T08 no quedó versionado. T20 cubre la misma frontera
// FUSION/runPipeline y añade tiempo determinista, snapshot de audio inmutable,
// conteo de rAF, pixel-diff y REC; esta entrada conserva la regresión ejecutable.
const path = require('path');
const { spawnSync } = require('child_process');

const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-t20.js')], {
  cwd:path.join(__dirname, '..'),
  env:process.env,
  stdio:'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;

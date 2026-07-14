#!/usr/bin/env node
/*
 * Builds dist/sigmaboy.html — the whole app in a single self-contained file.
 * Works when opened by double-click (file://) and behind strict CSPs:
 * the engine worker is created from an embedded blob; if workers are
 * unavailable the engine runs on the main thread.
 *
 *   node build.js
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const css = read('css/style.css');
const chess = read('js/chess.js');
const engine = read('js/engine.js');
const pieces = read('js/pieces.js');
const sound = read('js/sound.js');
const app = read('js/app.js');
let nnue = '';
try { nnue = read('js/nnue.js'); } catch (e) { console.log('uyarı: js/nnue.js yok, NNUE olmadan paketleniyor'); }

// worker source = chess rules + nnue weights + engine (ASCII only → safe to base64 via latin1)
const workerSrc = chess + '\n' + nnue + '\n' + engine;
const workerB64 = Buffer.from(workerSrc, 'latin1').toString('base64');

let html = read('index.html');

// inline the stylesheet
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`);

// inline all scripts; engine source is embedded twice:
// as base64 for the blob worker and as a plain script for the main-thread fallback
const scripts = `
<script>
${chess}
</script>
${nnue ? '<script>\n' + nnue + '\n</script>' : ''}
<script>
${engine}
</script>
<script>
${pieces}
</script>
<script>
${sound}
</script>
<script>
window.SIGMA_ENGINE_SRC = atob('${workerB64}');
</script>
<script>
${app}
</script>
`;
html = html.replace(/<script src="js\/chess\.js"><\/script>[\s\S]*?<script src="js\/app\.js"><\/script>/, () => scripts);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'sigmaboy.html');
fs.writeFileSync(out, html);
console.log('yazıldı:', out, (html.length / 1024).toFixed(0) + ' KB');

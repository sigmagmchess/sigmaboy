/*
 * SigmaBoy — application UI
 */
(function () {
'use strict';

const $ = id => document.getElementById(id);
const { Position, START_FEN, mFrom, mTo, mPromo, mCapt, mIsCastle, mIsEp } = SC;
const Sound = window.SigmaSound;
const { pieceSvg } = window.SigmaPieces;

const PIECE_CODE = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
const UNI = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function codeAt(board, sq) {
  const p = board[sq];
  if (!p) return null;
  return (p > 0 ? 'w' : 'b') + PIECE_CODE[Math.abs(p)];
}
function winPct(cpWhite, mateWhite) {
  if (mateWhite != null) return mateWhite > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cpWhite)) - 1);
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function fmtScore(cpWhite, mateWhite) {
  if (mateWhite != null) return (mateWhite > 0 ? '+M' : '-M') + Math.abs(mateWhite);
  const p = cpWhite / 100;
  return (p > 0 ? '+' : '') + p.toFixed(1);
}

// ================================================================ engine ctl
class EngineCtl {
  constructor() {
    this.worker = null; this.local = null; this.loadingLocal = false;
    this.busy = false; this.queued = null;
    this.seq = 0; this.currentId = 0; this.currentResolve = null;
    this.onInfo = null; this.bookKeys = new Set();
  }
  init() {
    try {
      // single-file bundle embeds the worker source; repo layout loads it by path
      if (window.SIGMA_ENGINE_SRC) {
        const blob = new Blob([window.SIGMA_ENGINE_SRC], { type: 'text/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
      } else {
        this.worker = new Worker('js/engine.js');
      }
      this.worker.onmessage = e => this.handle(e.data);
      this.worker.onerror = () => { this.worker = null; this.fallback(); };
    } catch (e) { this.worker = null; this.fallback(); }
  }
  fallback() {
    if (this.local || this.loadingLocal) return;
    if (window.SigmaEngine) { // engine already on the page (bundle) → run on main thread
      this.local = new window.SigmaEngine.Engine();
      this.bookKeys = new Set(Object.keys(window.SigmaEngine.getBook()));
      this.pump();
      return;
    }
    this.loadingLocal = true;
    const s = document.createElement('script');
    s.src = 'js/engine.js';
    s.onload = () => {
      this.local = new window.SigmaEngine.Engine();
      this.bookKeys = new Set(Object.keys(window.SigmaEngine.getBook()));
      this.loadingLocal = false;
      this.pump();
    };
    document.head.appendChild(s);
  }
  handle(msg) {
    if (msg.type === 'boot') { if (msg.bookKeys) this.bookKeys = new Set(msg.bookKeys); return; }
    if (msg.type === 'info') {
      if (msg.id === this.currentId && this.onInfo) this.onInfo(msg);
      return;
    }
    if (msg.type === 'bestmove' && msg.id === this.currentId) {
      const r = this.currentResolve;
      this.busy = false; this.currentResolve = null;
      if (r) r(msg);
      this.pump();
    }
  }
  // latest-wins queue: a queued-but-unsent request is superseded (resolves null)
  request(params) {
    return new Promise(resolve => {
      if (this.queued) this.queued.resolve(null);
      this.queued = { params, resolve };
      this.pump();
    });
  }
  pump() {
    if (this.busy || !this.queued) return;
    if (!this.worker && !this.local) return;
    const q = this.queued;
    this.queued = null;
    this.busy = true;
    this.currentId = ++this.seq;
    this.currentResolve = q.resolve;
    if (this.worker) {
      this.worker.postMessage({ cmd: 'go', id: this.currentId, ...q.params });
    } else {
      const id = this.currentId;
      setTimeout(() => {
        this.local.setPosition(q.params.fen, q.params.moves);
        let result;
        try {
          result = this.local.go({
            ...q.params,
            movetime: Math.min(q.params.movetime || 1500, 2000),
            onInfo: info => { if (id === this.currentId && this.onInfo) this.onInfo({ id, ...info }); },
          });
        } catch (e) { result = { bestmove: null, error: String(e) }; }
        this.handle({ type: 'bestmove', id, ...result });
      }, 20);
    }
  }
  stop() { if (this.worker) this.worker.postMessage({ cmd: 'stop' }); }
}
const engine = new EngineCtl();

// ================================================================ state
const S = {
  mode: 'play',
  flipped: false,
  game: { startFen: START_FEN, moves: [], result: null }, // mainline
  line: null,       // currently viewed line (=== S.game or a variation object)
  view: -1,         // index into line.moves
  play: {
    active: false, engineColor: SC.BLACK, level: 5, useBook: true,
    tc: null, clocks: { w: 0, b: 0 }, timer: null, thinking: false, over: null,
  },
  ana: {
    on: true, multipv: 3, movetime: 4000,
    lines: [],                     // latest info per multipv
    report: null,                  // {evals, mates, best, classes, accW, accB}
    reportRunning: false,
  },
  editor: { pos: new Position(START_FEN), brush: 'cursor' },
  shapes: [],       // user-drawn {from,to,color} (from===to → circle)
  hintArrow: null,
  selected: -1, dests: [],
  pendingPromo: null,
  anaSeq: 0,
};
S.line = S.game;

const LEVEL_DESC = ['', 'Yeni başlayan (~600)', 'Acemi (~900)', 'Gelişen (~1200)', 'Orta düzey (~1600)',
  'Uzman (~2300)', 'Usta adayı (~2400)', 'Usta (~2500)', 'Kıdemli usta (~2550)', 'Büyükusta gücü (2600+)',
  'BATHANTAHA — nihai güç (30 sn/hamle)'];
const LEVEL_TIME = { 5: 400, 6: 1000, 7: 2500, 8: 6000, 9: 12000, 10: 30000 };

const CLASS_INFO = {
  brilliant:  { label: '!!', name: 'Parlak',        color: '#26c2a3' },
  great:      { label: '!',  name: 'Harika',        color: '#4a90d9' },
  best:       { label: '★',  name: 'En İyi',        color: '#81b64c' },
  excellent:  { label: '✓✓', name: 'Mükemmel',      color: '#96bc4b' },
  good:       { label: '✓',  name: 'İyi',           color: '#95b776' },
  book:       { label: '📖', name: 'Kitap',         color: '#a88865' },
  forced:     { label: '⇉',  name: 'Zorunlu',       color: '#8d8d8d' },
  inaccuracy: { label: '?!', name: 'Tutarsızlık',   color: '#f0c15c' },
  miss:       { label: '✗',  name: 'Kaçan Fırsat',  color: '#d9634f' },
  mistake:    { label: '?',  name: 'Hata',          color: '#e6912c' },
  blunder:    { label: '??', name: 'Vahim Hata',    color: '#ca3431' },
};

// ================================================================ view helpers
function viewFen() {
  return S.view < 0 ? S.line.startFen : S.line.moves[S.view].fenAfter;
}
let _vpCacheFen = null, _vpCache = null;
function viewPos() {
  const f = viewFen();
  if (_vpCacheFen !== f) { _vpCache = new Position(f); _vpCacheFen = f; }
  return _vpCache;
}
function atEnd() { return S.view === S.line.moves.length - 1; }
function lineUcis(uptoIncl) {
  const n = uptoIncl === undefined ? S.line.moves.length : uptoIncl + 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(S.line.moves[i].uci);
  return out;
}

// live full-history position of the mainline (for repetition-aware status)
function livePos() {
  const p = new Position(S.game.startFen);
  for (const mv of S.game.moves) { const m = p.moveFromUci(mv.uci); if (m) p.make(m); }
  return p;
}

// ================================================================ board DOM
const boardEl = $('board'), overlayEl = $('overlay'), wrapEl = $('board-wrap');
const squareEls = {}, pieceEls = {};

function buildBoard() {
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f;
    const el = document.createElement('div');
    el.className = 'sq ' + (((r + f) & 1) === 0 ? 'light' : 'dark');
    el.dataset.sq = sq;
    boardEl.appendChild(el);
    squareEls[sq] = el;
  }
  layoutSquares();
}

function visualXY(sq) {
  const r = sq >> 4, f = sq & 7;
  return {
    col: S.flipped ? 7 - f : f,
    row: S.flipped ? 7 - r : r,
  };
}
function layoutSquares() {
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f;
    const { col, row } = visualXY(sq);
    const el = squareEls[sq];
    el.style.left = col * 12.5 + '%';
    el.style.top = row * 12.5 + '%';
    // coordinates
    let coord = '';
    if (col === 0) coord += `<span class="coord rank">${8 - r}</span>`;
    if (row === 7) coord += `<span class="coord file">${String.fromCharCode(97 + f)}</span>`;
    el.innerHTML = coord;
  }
  for (const sq in pieceEls) placePieceEl(pieceEls[sq], +sq, false);
}

function placePieceEl(el, sq, animate) {
  const { col, row } = visualXY(sq);
  el.style.transition = animate ? 'left .13s ease, top .13s ease' : 'none';
  el.style.left = col * 12.5 + '%';
  el.style.top = row * 12.5 + '%';
}

function makePieceEl(code, sq) {
  const el = document.createElement('div');
  el.className = 'piece';
  el.dataset.code = code;
  el.innerHTML = pieceSvg(code[0], code[1]);
  placePieceEl(el, sq, false);
  boardEl.appendChild(el);
  return el;
}

function renderAll() {
  const pos = S.mode === 'editor' ? S.editor.pos : viewPos();
  const b = pos.board;
  for (const k in pieceEls) {
    const sq = +k, want = codeAt(b, sq);
    if (pieceEls[k].dataset.code !== want) { pieceEls[k].remove(); delete pieceEls[k]; }
  }
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const want = codeAt(b, sq);
    if (want && !pieceEls[sq]) pieceEls[sq] = makePieceEl(want, sq);
    else if (want && pieceEls[sq]) placePieceEl(pieceEls[sq], sq, false);
  }
  updateHighlights();
  drawShapes();
  updatePlayerBars();
}

// animate a known move on the board (logical state must already be updated)
function animateMove(mi, reverse) {
  let from = mFrom(mi), to = mTo(mi);
  if (reverse) { const t = from; from = to; to = t; }
  const el = pieceEls[from];
  if (!el) { renderAll(); return; }
  if (pieceEls[to]) { pieceEls[to].remove(); delete pieceEls[to]; }
  delete pieceEls[from];
  pieceEls[to] = el;
  placePieceEl(el, to, true);
  if (mIsCastle(mi)) {
    let rf, rt;
    if ((mTo(mi) & 7) === 6) { rf = mTo(mi) + 1; rt = mTo(mi) - 1; } else { rf = mTo(mi) - 2; rt = mTo(mi) + 1; }
    if (reverse) { const t = rf; rf = rt; rt = t; }
    const rel = pieceEls[rf];
    if (rel) { delete pieceEls[rf]; pieceEls[rt] = rel; placePieceEl(rel, rt, true); }
  }
  setTimeout(renderAll, 150);
}

function updateHighlights() {
  const pos = S.mode === 'editor' ? null : viewPos();
  for (const k in squareEls) {
    squareEls[k].classList.remove('lastmove', 'check', 'selected', 'dest', 'capture-dest');
  }
  if (!pos) return;
  if (S.view >= 0) {
    const mi = S.line.moves[S.view].mi;
    squareEls[mFrom(mi)].classList.add('lastmove');
    squareEls[mTo(mi)].classList.add('lastmove');
  }
  if (pos.inCheck()) squareEls[pos.kings[pos.side === SC.WHITE ? 0 : 1]].classList.add('check');
  if (S.selected >= 0) {
    squareEls[S.selected].classList.add('selected');
    for (const m of S.dests) {
      squareEls[mTo(m)].classList.add(SC.mIsCapture(m) ? 'capture-dest' : 'dest');
    }
  }
  updateClassBadge();
}

// classification badge on the destination square of the viewed move
function updateClassBadge() {
  const badge = $('class-badge');
  const rep = S.ana.report;
  if (S.mode !== 'analysis' || !rep || S.line !== S.game || S.view < 0 || !rep.classes[S.view]) {
    badge.classList.add('hidden');
    return;
  }
  const info = CLASS_INFO[rep.classes[S.view]];
  const to = mTo(S.line.moves[S.view].mi);
  const { col, row } = visualXY(to);
  badge.textContent = info.label;
  badge.style.background = info.color;
  badge.style.left = `calc(${(col + 1) * 12.5}% - 13px)`;
  badge.style.top = `calc(${row * 12.5}% - 5px)`;
  badge.classList.remove('hidden');
}

// ---------------------------------------------------------------- overlay
function sqCenter(sq) {
  const { col, row } = visualXY(sq);
  return { x: col * 100 + 50, y: row * 100 + 50 };
}
function arrowSvg(from, to, color, width) {
  const a = sqCenter(from), b = sqCenter(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return '';
  const ux = dx / len, uy = dy / len;
  const start = { x: a.x + ux * 18, y: a.y + uy * 18 };
  const head = 26;
  const tip = b, base = { x: b.x - ux * head, y: b.y - uy * head };
  const px = -uy, py = ux;
  return `<line x1="${start.x}" y1="${start.y}" x2="${base.x}" y2="${base.y}"
      stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="0.75"/>
    <polygon points="${tip.x},${tip.y} ${base.x + px * 14},${base.y + py * 14} ${base.x - px * 14},${base.y - py * 14}"
      fill="${color}" opacity="0.75"/>`;
}
function drawShapes() {
  let svg = '';
  for (const s of S.shapes) {
    if (s.from === s.to) {
      const c = sqCenter(s.from);
      svg += `<circle cx="${c.x}" cy="${c.y}" r="42" fill="none" stroke="${s.color}" stroke-width="7" opacity="0.75"/>`;
    } else svg += arrowSvg(s.from, s.to, s.color, 15);
  }
  // engine best line arrow (analysis)
  if (S.mode === 'analysis' && S.ana.on && S.ana.lines[0] && S.ana.lines[0].pv && S.ana.lines[0].pv.length) {
    const uci = S.ana.lines[0].pv[0];
    const from = SC.algToSq(uci.slice(0, 2)), to = SC.algToSq(uci.slice(2, 4));
    svg += arrowSvg(from, to, '#5b9bd1', 14);
  }
  if (S.hintArrow) svg += arrowSvg(S.hintArrow.from, S.hintArrow.to, '#e8a33d', 15);
  overlayEl.innerHTML = svg;
}

// ================================================================ input
let drag = null;

function evtSquare(e) {
  const rect = boardEl.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < 0 || x >= 1 || y < 0 || y >= 1) return -1;
  let col = Math.floor(x * 8), row = Math.floor(y * 8);
  if (S.flipped) { col = 7 - col; row = 7 - row; }
  return row * 16 + col;
}

function canMoveNow() {
  if (S.mode === 'editor') return false;
  if (S.pendingPromo) return false;
  if (S.mode === 'play') {
    if (!S.play.active || S.play.over || S.play.thinking) return false;
    if (!atEnd() || S.line !== S.game) return false;
    return viewPos().side !== S.play.engineColor;
  }
  return !S.ana.reportRunning;
}

function selectSquare(sq) {
  const pos = viewPos();
  const p = pos.board[sq];
  if (!p || (p > 0) !== (pos.side > 0)) { S.selected = -1; S.dests = []; updateHighlights(); return false; }
  S.selected = sq;
  S.dests = pos.legalMoves().filter(m => mFrom(m) === sq);
  updateHighlights();
  return true;
}

function tryMove(from, to) {
  const candidates = S.dests.filter(m => mFrom(m) === from && mTo(m) === to);
  S.selected = -1; S.dests = [];
  if (candidates.length === 0) { updateHighlights(); return false; }
  if (candidates.length > 1) { openPromoPicker(from, to, candidates); return true; }
  commitMove(candidates[0]);
  return true;
}

function openPromoPicker(from, to, candidates) {
  S.pendingPromo = { candidates };
  const picker = $('promo-picker');
  const color = viewPos().side === SC.WHITE ? 'w' : 'b';
  picker.innerHTML = '';
  for (const t of ['q', 'r', 'b', 'n']) {
    const btn = document.createElement('button');
    btn.innerHTML = pieceSvg(color, t);
    btn.onclick = () => {
      const typeNum = { q: 5, r: 4, b: 3, n: 2 }[t];
      const m = candidates.find(c => mPromo(c) === typeNum);
      picker.classList.add('hidden');
      S.pendingPromo = null;
      if (m) commitMove(m);
    };
    picker.appendChild(btn);
  }
  picker.classList.remove('hidden');
}

function commitMove(mi) {
  const pos = viewPos().clone();
  const san = pos.san(mi);
  const uci = pos.moveToUci(mi);
  const isCapture = SC.mIsCapture(mi);
  pos.make(mi);
  const entry = { uci, san, mi, fenAfter: pos.fen() };

  if (S.mode === 'analysis' && (S.line !== S.game || !atEnd())) {
    // deviation → variation (or continue existing variation)
    if (S.line !== S.game) {
      S.line.moves = S.line.moves.slice(0, S.view + 1);
      // same move as next variation move? just navigate
      S.line.moves.push(entry);
      S.view++;
    } else {
      const next = S.game.moves[S.view + 1];
      if (next && next.uci === uci) { setView(S.view + 1, 1); return; }
      const varLine = {
        startFen: S.game.startFen,
        moves: S.game.moves.slice(0, S.view + 1).concat([entry]),
        forkAt: S.view + 1,
        isVariation: true,
      };
      S.line = varLine;
      S.view = varLine.moves.length - 1;
    }
  } else {
    // append to current line (play mode mainline / analysis at end)
    S.line.moves.push(entry);
    S.view = S.line.moves.length - 1;
    if (S.line === S.game) S.ana.report = null; // mainline changed → stale report
  }

  _vpCacheFen = null;
  S.shapes = []; S.hintArrow = null;
  animateMove(mi, false);
  playMoveSound(mi, isCapture, pos);
  afterPositionChange();

  if (S.mode === 'play') {
    onClockMoveMade();
    const status = checkGameEnd();
    if (!status && viewPos().side === S.play.engineColor) engineMove();
  }
}

function playMoveSound(mi, isCapture, posAfter) {
  if (posAfter.inCheck()) Sound.check();
  else if (mPromo(mi)) Sound.promote();
  else if (mIsCastle(mi)) Sound.castle();
  else if (isCapture) Sound.capture();
  else Sound.move();
}

// pointer handlers
boardEl.addEventListener('contextmenu', e => e.preventDefault());

boardEl.addEventListener('pointerdown', e => {
  Sound.unlock();
  const sq = evtSquare(e);
  if (sq < 0) return;

  if (e.button === 2) {
    drag = { type: 'shape', from: sq, mods: e.shiftKey ? 'r' : e.altKey ? 'b' : e.ctrlKey ? 'y' : 'g' };
    return;
  }
  if (e.button !== 0) return;
  S.shapes = []; S.hintArrow = null; drawShapes();

  if (S.mode === 'editor') { editorPointerDown(sq, e); return; }

  if (!canMoveNow()) return;
  // click destination of a selected piece?
  if (S.selected >= 0 && S.dests.some(m => mTo(m) === sq) && sq !== S.selected) {
    tryMove(S.selected, sq);
    return;
  }
  if (selectSquare(sq)) startDrag(sq, e);
});

function startDrag(sq, e) {
  const el = pieceEls[sq];
  if (!el) return;
  drag = { type: 'piece', from: sq, el, moved: false };
  el.classList.add('dragging');
  boardEl.setPointerCapture(e.pointerId);
  moveDragEl(e);
}
function moveDragEl(e) {
  if (!drag || drag.type !== 'piece') return;
  const rect = boardEl.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  drag.el.style.transition = 'none';
  drag.el.style.left = (x / rect.width * 100 - 6.25) + '%';
  drag.el.style.top = (y / rect.height * 100 - 6.25) + '%';
  drag.moved = true;
}
boardEl.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.type === 'piece' || drag.type === 'editor-piece') moveDragEl(e);
});
boardEl.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  const sq = evtSquare(e);

  if (d.type === 'shape') {
    if (sq >= 0) {
      const colors = { g: '#68a94e', r: '#c4423c', b: '#4a7dbb', y: '#d8b13c' };
      const shape = { from: d.from, to: sq, color: colors[d.mods] };
      const idx = S.shapes.findIndex(s => s.from === shape.from && s.to === shape.to);
      if (idx >= 0) S.shapes.splice(idx, 1); else S.shapes.push(shape);
      drawShapes();
    }
    return;
  }
  if (d.type === 'editor-piece') { editorDrop(d, sq); return; }
  if (d.type === 'piece') {
    d.el.classList.remove('dragging');
    if (sq >= 0 && sq !== d.from && S.dests.some(m => mTo(m) === sq)) {
      tryMove(d.from, sq);
    } else {
      placePieceEl(d.el, d.from, false);
      if (sq === d.from && d.moved) { /* keep selection for click-move */ updateHighlights(); }
      else if (sq !== d.from) { S.selected = -1; S.dests = []; updateHighlights(); Sound.illegal(); }
    }
  }
});

// ================================================================ navigation
function setView(i, animDir) {
  const prev = S.view;
  i = clamp(i, -1, S.line.moves.length - 1);
  if (i === prev) return;
  S.view = i;
  _vpCacheFen = null;
  S.selected = -1; S.dests = []; S.shapes = []; S.hintArrow = null;
  if (animDir === 1 && i === prev + 1) animateMove(S.line.moves[i].mi, false);
  else if (animDir === -1 && prev === i + 1 && prev >= 0) animateMove(S.line.moves[prev].mi, true);
  else renderAll();
  afterPositionChange();
}
function nav(cmd) {
  if (cmd === 'start') setView(-1);
  else if (cmd === 'prev') setView(S.view - 1, -1);
  else if (cmd === 'next') setView(S.view + 1, 1);
  else if (cmd === 'end') setView(S.line.moves.length - 1);
}
document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => nav(b.dataset.nav)));
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft') { nav('prev'); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { nav('next'); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { nav('start'); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { nav('end'); e.preventDefault(); }
  else if (e.key === 'f' || e.key === 'F') flipBoard();
});

function afterPositionChange() {
  renderMoveList();
  updateEvalBarFromKnown();
  if (S.mode === 'analysis') requestLiveAnalysis();
  drawShapes();
  updatePlayerBars();
  updateHighlights();
}

// ================================================================ move list
function renderMoveList() {
  const listId = S.mode === 'play' ? 'movelist-play' : 'movelist-ana';
  const ol = $(listId);
  if (!ol) return;
  ol.innerHTML = '';
  const mainMoves = S.game.moves;
  const startPos = new Position(S.game.startFen);
  let moveNo = startPos.fullmove;
  let whiteToMove = startPos.side === SC.WHITE;
  const rep = S.ana.report;

  const frag = document.createDocumentFragment();
  let li = null;
  if (!whiteToMove && mainMoves.length) {
    li = document.createElement('li');
    li.innerHTML = `<span class="mno">${moveNo}.</span><span class="mv ellips">…</span>`;
    frag.appendChild(li);
  }
  mainMoves.forEach((mv, i) => {
    if (whiteToMove || !li) {
      li = document.createElement('li');
      li.innerHTML = `<span class="mno">${moveNo}.</span>`;
      frag.appendChild(li);
    }
    const span = document.createElement('span');
    span.className = 'mv';
    if (S.line === S.game && i === S.view) span.classList.add('current');
    let badge = '';
    if (rep && rep.classes[i] && S.mode === 'analysis') {
      const ci = CLASS_INFO[rep.classes[i]];
      badge = `<i class="mbadge" style="background:${ci.color}">${ci.label}</i>`;
    }
    span.innerHTML = mv.san + badge;
    span.addEventListener('click', () => { backToMainline(false); setView(i); });
    li.appendChild(span);
    if (!whiteToMove) moveNo++;
    whiteToMove = !whiteToMove;
  });
  ol.appendChild(frag);
  const cur = ol.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });

  // variation box
  const vbox = $('variation-box');
  if (S.mode === 'analysis' && S.line !== S.game) {
    vbox.classList.remove('hidden');
    const vm = $('variation-moves');
    vm.innerHTML = '';
    for (let i = S.line.forkAt; i < S.line.moves.length; i++) {
      const span = document.createElement('span');
      span.className = 'mv' + (i === S.view ? ' current' : '');
      const num = Math.floor((i + (startPos.side === SC.BLACK ? 1 : 0)) / 2) + startPos.fullmove;
      const isW = (i % 2 === 0) === (startPos.side === SC.WHITE);
      span.textContent = (isW ? num + '.' : (i === S.line.forkAt ? num + '…' : '')) + S.line.moves[i].san;
      span.addEventListener('click', () => setView(i));
      vm.appendChild(span);
    }
  } else vbox.classList.add('hidden');
}

function backToMainline(render) {
  if (S.line === S.game) return;
  S.line = S.game;
  S.view = clamp(S.view, -1, S.game.moves.length - 1);
  _vpCacheFen = null;
  if (render !== false) { renderAll(); afterPositionChange(); }
}
$('btn-back-main').addEventListener('click', () => { backToMainline(); });

// ================================================================ player bars
function updatePlayerBars() {
  const topIsBlack = !S.flipped;
  const nTop = $('pname-top'), nBot = $('pname-bottom');
  if (S.mode === 'play' && S.play.active) {
    const engineName = S.play.level >= 10 ? 'VEGA · BATHANTAHA' : `VEGA · Seviye ${S.play.level}`;
    const humanName = 'Sen';
    const engineIsWhite = S.play.engineColor === SC.WHITE;
    const topWhite = S.flipped;
    nTop.textContent = (topWhite === engineIsWhite) ? engineName : humanName;
    nBot.textContent = (topWhite === engineIsWhite) ? humanName : engineName;
  } else {
    nTop.textContent = topIsBlack ? 'Siyah' : 'Beyaz';
    nBot.textContent = topIsBlack ? 'Beyaz' : 'Siyah';
  }
  renderCaptured();
  renderClocks();
}

function countPieces(fen) {
  const counts = {};
  for (const ch of fen.split(' ')[0]) {
    if (/[pnbrqkPNBRQK]/.test(ch)) counts[ch] = (counts[ch] || 0) + 1;
  }
  return counts;
}
function renderCaptured() {
  const start = countPieces(S.game.startFen);
  const now = countPieces(S.mode === 'editor' ? S.editor.pos.fen() : viewFen());
  const capturedByWhite = [], capturedByBlack = [];
  let matW = 0, matB = 0;
  for (const t of ['p', 'n', 'b', 'r', 'q']) {
    const bLost = (start[t] || 0) - (now[t] || 0);
    const wLost = (start[t.toUpperCase()] || 0) - (now[t.toUpperCase()] || 0);
    for (let i = 0; i < bLost; i++) { capturedByWhite.push(UNI[t]); matW += VAL[t]; }
    for (let i = 0; i < wLost; i++) { capturedByBlack.push(UNI[t]); matB += VAL[t]; }
  }
  const diff = matW - matB;
  const whiteHtml = capturedByWhite.join('') + (diff > 0 ? ` <b>+${diff}</b>` : '');
  const blackHtml = capturedByBlack.join('') + (diff < 0 ? ` <b>+${-diff}</b>` : '');
  const topIsWhite = S.flipped;
  $('pcapt-top').innerHTML = topIsWhite ? whiteHtml : blackHtml;
  $('pcapt-bottom').innerHTML = topIsWhite ? blackHtml : whiteHtml;
}

// ================================================================ clocks
function fmtClock(ms) {
  if (ms == null) return '--:--';
  ms = Math.max(0, ms);
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function renderClocks() {
  const show = S.mode === 'play' && S.play.active && S.play.tc;
  const ct = $('pclock-top'), cb = $('pclock-bottom');
  ct.style.visibility = show ? 'visible' : 'hidden';
  cb.style.visibility = show ? 'visible' : 'hidden';
  if (!show) return;
  const topIsWhite = S.flipped;
  const wc = S.play.clocks.w, bc = S.play.clocks.b;
  ct.textContent = fmtClock(topIsWhite ? wc : bc);
  cb.textContent = fmtClock(topIsWhite ? bc : wc);
  const turn = livePosSideFast();
  ct.classList.toggle('running', S.play.active && !S.play.over && (topIsWhite ? turn === SC.WHITE : turn === SC.BLACK));
  cb.classList.toggle('running', S.play.active && !S.play.over && (topIsWhite ? turn === SC.BLACK : turn === SC.WHITE));
  ct.classList.toggle('low', (topIsWhite ? wc : bc) < 20000);
  cb.classList.toggle('low', (topIsWhite ? bc : wc) < 20000);
}
function livePosSideFast() {
  const f = S.game.moves.length ? S.game.moves[S.game.moves.length - 1].fenAfter : S.game.startFen;
  return f.split(' ')[1] === 'w' ? SC.WHITE : SC.BLACK;
}
let lastTick = 0;
function startClock() {
  stopClock();
  if (!S.play.tc) return;
  lastTick = performance.now();
  S.play.timer = setInterval(() => {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    const side = livePosSideFast() === SC.WHITE ? 'w' : 'b';
    S.play.clocks[side] -= dt;
    if (S.play.clocks[side] <= 0) {
      S.play.clocks[side] = 0;
      endGame(side === 'w' ? 'timeout-w' : 'timeout-b');
    }
    renderClocks();
  }, 100);
}
function stopClock() { if (S.play.timer) { clearInterval(S.play.timer); S.play.timer = null; } }
function onClockMoveMade() {
  if (!S.play.tc) return;
  // increment for the side that just moved
  const moved = livePosSideFast() === SC.WHITE ? 'b' : 'w';
  S.play.clocks[moved] += S.play.tc.inc * 1000;
  renderClocks();
}

// ================================================================ play mode
function startGame(startFen) {
  const colorBtn = document.querySelector('#color-seg .active');
  let humanColor = colorBtn.dataset.v;
  if (humanColor === 'random') humanColor = Math.random() < 0.5 ? 'w' : 'b';
  S.play.engineColor = humanColor === 'w' ? SC.BLACK : SC.WHITE;
  S.play.level = +$('level-range').value;
  S.play.useBook = $('book-check').checked;
  const tcVal = $('time-select').value;
  if (tcVal === '0') S.play.tc = null;
  else {
    const [base, inc] = tcVal.split(',').map(Number);
    S.play.tc = { base, inc };
  }

  S.game = { startFen: startFen || START_FEN, moves: [], result: null };
  S.line = S.game;
  S.view = -1;
  _vpCacheFen = null;
  S.play.active = true;
  S.play.over = null;
  S.play.thinking = false;
  S.play.clocks = S.play.tc ? { w: S.play.tc.base * 1000, b: S.play.tc.base * 1000 } : { w: null, b: null };
  S.ana.report = null;
  S.shapes = [];
  S.flipped = humanColor === 'b';
  layoutSquares();

  $('newgame-card').classList.add('hidden');
  $('game-card').classList.remove('hidden');
  hideResultOverlay();
  if (engine.worker) engine.worker.postMessage({ cmd: 'newgame' });

  renderAll();
  afterPositionChange();
  startClock();

  if (viewPos().side === S.play.engineColor) engineMove();
}

async function engineMove() {
  if (!S.play.active || S.play.over) return;
  S.play.thinking = true;
  $('engine-status').textContent = S.play.level >= 10 ? 'VEGA derin düşünüyor (BATHANTAHA)…' : 'VEGA düşünüyor…';
  const level = S.play.level;
  const params = {
    fen: S.game.startFen,
    moves: S.game.moves.map(m => m.uci),
    useBook: S.play.useBook,
  };
  if (level <= 4) params.level = level;
  else { params.movetime = LEVEL_TIME[level]; params.depth = 64; }

  const res = await engine.request(params);
  S.play.thinking = false;
  $('engine-status').textContent = '';
  if (!res || !S.play.active || S.play.over) return;
  if (!res.bestmove) { checkGameEnd(); return; }

  // make sure we're at the live end of the mainline
  S.line = S.game;
  S.view = S.game.moves.length - 1;
  _vpCacheFen = null;
  const mi = viewPos().moveFromUci(res.bestmove);
  if (!mi) return;
  commitMove(mi);
}

function checkGameEnd() {
  if (S.mode !== 'play' || !S.play.active) return null;
  const lp = livePos();
  const st = lp.gameStatus();
  if (st !== 'playing') { endGame(st); return st; }
  return null;
}

// game-result overlay: shown on game end, dismissed by a single click anywhere
let resultDismisser = null;
function showResultOverlay() {
  $('game-result').classList.remove('hidden');
  // arm the dismisser a beat later so the move that ended the game doesn't close it
  setTimeout(() => {
    if (resultDismisser || $('game-result').classList.contains('hidden')) return;
    resultDismisser = e => {
      if (e.target.closest && e.target.closest('#game-result button')) return; // let its buttons work
      hideResultOverlay();
    };
    document.addEventListener('pointerdown', resultDismisser, true);
  }, 400);
}
function hideResultOverlay() {
  $('game-result').classList.add('hidden');
  if (resultDismisser) {
    document.removeEventListener('pointerdown', resultDismisser, true);
    resultDismisser = null;
  }
}

function endGame(status) {
  if (S.play.over) return;
  S.play.over = status;
  stopClock();
  Sound.gameEnd();
  const engineWhite = S.play.engineColor === SC.WHITE;
  let text = '', result = '';
  const lp = livePos();
  switch (status) {
    case 'checkmate': {
      const winnerWhite = lp.side === SC.BLACK; // side to move is mated
      text = (winnerWhite ? 'Beyaz' : 'Siyah') + ' mat etti!';
      result = winnerWhite ? '1-0' : '0-1';
      const humanWon = winnerWhite !== engineWhite;
      text += humanWon ? ' 🎉 Kazandın!' : ' VEGA kazandı.';
      break;
    }
    case 'stalemate': text = 'Pat — berabere.'; result = '1/2-1/2'; break;
    case 'fifty': text = '50 hamle kuralı — berabere.'; result = '1/2-1/2'; break;
    case 'threefold': text = 'Üç kez tekrar — berabere.'; result = '1/2-1/2'; break;
    case 'material': text = 'Yetersiz materyal — berabere.'; result = '1/2-1/2'; break;
    case 'timeout-w': text = 'Beyazın süresi bitti.'; result = '0-1'; break;
    case 'timeout-b': text = 'Siyahın süresi bitti.'; result = '1-0'; break;
    case 'resign': {
      const humanWhite = !engineWhite;
      text = 'Terk ettin. VEGA kazandı.';
      result = humanWhite ? '0-1' : '1-0';
      break;
    }
  }
  S.game.result = result;
  $('game-result-text').textContent = text;
  showResultOverlay();
  renderClocks();
}

$('btn-start').addEventListener('click', () => startGame());
function backToNewGame() {
  hideResultOverlay();
  $('newgame-card').classList.remove('hidden');
  $('game-card').classList.add('hidden');
  S.play.active = false;
  stopClock();
}
$('btn-rematch').addEventListener('click', backToNewGame);
$('btn-newgame').addEventListener('click', backToNewGame);
$('btn-resign').addEventListener('click', () => {
  if (S.play.active && !S.play.over) endGame('resign');
});
$('btn-undo').addEventListener('click', () => {
  if (!S.play.active || S.play.thinking) return;
  const humanColor = -S.play.engineColor;
  let n = S.game.moves.length;
  if (n === 0) return;
  // undo back to a position where it's the human's turn
  const lastFenSide = livePosSideFast();
  let remove = lastFenSide === humanColor ? 2 : 1;
  remove = Math.min(remove, n);
  S.game.moves.length = n - remove;
  S.play.over = null;
  hideResultOverlay();
  S.view = S.game.moves.length - 1;
  S.line = S.game;
  _vpCacheFen = null;
  renderAll();
  afterPositionChange();
  if (S.play.active && viewPos().side === S.play.engineColor) engineMove();
});
$('btn-hint').addEventListener('click', async () => {
  if (!canMoveNow()) return;
  $('engine-status').textContent = 'İpucu hesaplanıyor…';
  const res = await engine.request({
    fen: S.game.startFen, moves: S.game.moves.map(m => m.uci),
    movetime: 800, depth: 64,
  });
  $('engine-status').textContent = '';
  if (res && res.bestmove) {
    S.hintArrow = { from: SC.algToSq(res.bestmove.slice(0, 2)), to: SC.algToSq(res.bestmove.slice(2, 4)) };
    drawShapes();
  }
});
$('level-range').addEventListener('input', () => {
  $('level-label').textContent = $('level-range').value;
  $('level-desc').textContent = LEVEL_DESC[+$('level-range').value];
});
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (seg.id === 'stm-seg') editorApplySideToMove();
  });
});

// ================================================================ eval bar
function setEvalBar(cpWhite, mateWhite) {
  const pct = winPct(cpWhite, mateWhite);
  $('evalbar-white').style.height = pct + '%';
  const num = $('evalbar-num');
  num.textContent = mateWhite != null
    ? (Math.abs(mateWhite) < 1 ? '#' : 'M' + Math.abs(mateWhite))
    : Math.abs(cpWhite / 100).toFixed(1);
  num.classList.toggle('black-side', pct >= 50);
}
function updateEvalBarFromKnown() {
  // during navigation with a finished report, use stored evals
  const rep = S.ana.report;
  if (S.mode === 'analysis' && rep && S.line === S.game) {
    const i = S.view + 1;
    if (rep.evals[i] !== undefined) setEvalBar(rep.evals[i], rep.mates[i]);
  }
}

// ================================================================ analysis
function requestLiveAnalysis() {
  if (S.mode !== 'analysis' || !S.ana.on || S.ana.reportRunning) return;
  const seq = ++S.anaSeq;
  S.ana.lines = [];
  renderEngineLines();
  const pos = viewPos();
  if (pos.legalMoves().length === 0) {
    $('ana-score').textContent = pos.inCheck() ? 'MAT' : 'PAT';
    $('ana-depth').textContent = '';
    return;
  }
  const params = {
    fen: S.line.startFen,
    moves: lineUcis(S.view),
    movetime: S.ana.movetime,
    depth: 30,
    multipv: S.ana.multipv,
  };
  engine.onInfo = info => {
    if (seq !== S.anaSeq) return;
    const k = (info.multipv || 1) - 1;
    S.ana.lines[k] = info;
    if (k === 0) {
      const stm = viewPos().side;
      const cpW = stm === SC.WHITE ? info.score : -info.score;
      let mateW = null;
      if (Math.abs(info.score) > 30000 - 1000) {
        const plies = 31000 - Math.abs(info.score);
        mateW = Math.sign(info.score) * Math.max(1, Math.ceil(plies / 2));
        if (stm === SC.BLACK) mateW = -mateW;
      }
      $('ana-score').textContent = fmtScore(cpW, mateW);
      $('ana-depth').textContent = 'derinlik ' + info.depth;
      setEvalBar(cpW, mateW);
      drawShapes();
    }
    renderEngineLines();
  };
  engine.request(params).then(res => {
    if (seq !== S.anaSeq || !res) return;
    // final lines from result (may include deeper info)
    if (res.lines && res.lines.length) {
      S.ana.lines = res.lines.map((l, i2) => ({ depth: l.depth, score: l.score, pv: l.pv, multipv: i2 + 1 }));
      renderEngineLines();
    }
  });
}

function sanLine(fen, ucis, maxN) {
  const p = new Position(fen);
  const out = [];
  let num = p.fullmove;
  for (let i = 0; i < ucis.length && i < (maxN || 10); i++) {
    const m = p.moveFromUci(ucis[i]);
    if (!m) break;
    const san = p.san(m);
    if (p.side === SC.WHITE) out.push(num + '.' + san);
    else { out.push(i === 0 ? num + '…' + san : san); num++; }
    p.make(m);
  }
  return out.join(' ');
}

function renderEngineLines() {
  const box = $('engine-lines');
  if (!S.ana.on) { box.innerHTML = '<div class="lines-off">Motor kapalı</div>'; return; }
  let html = '';
  const stm = viewPos().side;
  for (let k = 0; k < S.ana.multipv; k++) {
    const l = S.ana.lines[k];
    if (!l || !l.pv || !l.pv.length) { html += `<div class="eline"><span class="escore">…</span></div>`; continue; }
    const cpW = stm === SC.WHITE ? l.score : -l.score;
    let mateW = null;
    if (Math.abs(l.score) > 29000) {
      const plies = 31000 - Math.abs(l.score);
      mateW = Math.sign(l.score) * Math.max(1, Math.ceil(plies / 2));
      if (stm === SC.BLACK) mateW = -mateW;
    }
    const cls = cpW >= 50 ? 'white-good' : cpW <= -50 ? 'black-good' : '';
    html += `<div class="eline" data-uci="${l.pv[0]}">
      <span class="escore ${cls}">${fmtScore(cpW, mateW)}</span>
      <span class="epv">${sanLine(viewFen(), l.pv, 9)}</span></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.eline[data-uci]').forEach(el => {
    el.addEventListener('click', () => {
      const mi = viewPos().moveFromUci(el.dataset.uci);
      if (mi && canMoveNow()) commitMove(mi);
    });
  });
}

$('engine-toggle').addEventListener('change', e => {
  S.ana.on = e.target.checked;
  if (S.ana.on) requestLiveAnalysis();
  else { S.anaSeq++; engine.stop(); renderEngineLines(); drawShapes(); }
});
$('multipv-select').addEventListener('change', e => {
  S.ana.multipv = +e.target.value;
  requestLiveAnalysis();
});

// ---------------------------------------------------------------- full report
async function runFullAnalysis() {
  if (S.ana.reportRunning) return;
  if (S.game.moves.length === 0) { alert('Analiz edilecek hamle yok.'); return; }
  backToMainline(false);
  S.ana.reportRunning = true;
  S.anaSeq++; // cancel live analysis
  const perMove = +$('ana-speed').value;
  const progWrap = $('analysis-progress'), fill = $('analysis-progress-fill'), ptext = $('analysis-progress-text');
  progWrap.classList.remove('hidden');
  $('report').classList.add('hidden');

  const n = S.game.moves.length;
  const fens = [S.game.startFen];
  for (const mv of S.game.moves) fens.push(mv.fenAfter);

  const evals = [], mates = [], bests = [], seconds = [], legals = [];
  for (let i = 0; i <= n; i++) {
    fill.style.width = (i / (n + 1) * 100) + '%';
    ptext.textContent = `Konum ${i + 1} / ${n + 1} inceleniyor…`;
    const pos = new Position(fens[i]);
    const nLegal = pos.legalMoves().length;
    legals.push(nLegal);
    if (nLegal === 0) {
      const mateNow = pos.inCheck();
      const stmW = pos.side === SC.WHITE;
      evals.push(mateNow ? (stmW ? -12000 : 12000) : 0);
      mates.push(mateNow ? (stmW ? -0.5 : 0.5) : null); // display as M0-ish
      bests.push(null); seconds.push(null);
      continue;
    }
    // two lines: the second-best move feeds "great/brilliant" detection
    const res = await engine.request({ fen: fens[i], movetime: perMove, depth: 30, multipv: 2 });
    if (!res) { legals.pop(); i--; continue; } // superseded (shouldn't happen) → retry
    const stm = fens[i].split(' ')[1];
    let cpW = stm === 'w' ? res.score : -res.score;
    let mateW = res.mate != null ? (stm === 'w' ? res.mate : -res.mate) : null;
    if (mateW != null) cpW = mateW > 0 ? 12000 : -12000;
    evals.push(cpW); mates.push(mateW); bests.push(res.bestmove);
    const l2 = res.lines && res.lines[1];
    seconds.push(l2 ? { score: l2.score, mate: l2.mate } : null); // mover perspective
  }

  // classify
  const classes = [];
  let sumW = 0, cntW = 0, sumB = 0, cntB = 0;
  const counts = {};
  for (let i = 0; i < n; i++) {
    const moverWhite = fens[i].split(' ')[1] === 'w';
    const before = winPct(evals[i], mates[i]);
    const after = winPct(evals[i + 1], mates[i + 1]);
    const wBefore = moverWhite ? before : 100 - before;   // mover's win% with best play
    const wAfter = moverWhite ? after : 100 - after;      // mover's win% after the played move
    const drop = Math.max(0, wBefore - wAfter);
    const played = S.game.moves[i].uci;
    const isBook = engine.bookKeys.has(fenKeyOf(fens[i]));
    // gap between best and second-best move (mover win%) — "how critical was this choice"
    const sec = seconds[i];
    const gap = sec ? wBefore - winPct(sec.score, sec.mate) : null;
    let cls;
    if (legals[i] === 1) cls = 'forced';
    else if (isBook && i < 24) cls = 'book';
    else if (played === bests[i] || drop <= 0.4) {
      cls = played === bests[i] ? 'best' : 'excellent';
      if (cls === 'best') {
        // brilliant: a real sacrifice that keeps the position healthy,
        // in a game that wasn't already decided
        if (isSacrifice(fens, i) && wBefore < 92 && wAfter > 40) cls = 'brilliant';
        // great: the only good move — every alternative loses serious ground
        else if (gap != null && gap >= 18 && wAfter >= 40) cls = 'great';
      }
    }
    else if (drop <= 2) cls = 'excellent';
    else if (drop <= 5) cls = 'good';
    else if (wBefore >= 72 && drop >= 10 && wAfter >= 40) cls = 'miss'; // missed a big chance but still fine
    else if (drop <= 10) cls = 'inaccuracy';
    else if (drop <= 20) cls = 'mistake';
    else cls = 'blunder';
    classes.push(cls);
    counts[cls] = (counts[cls] || 0) + 1;

    const acc = clamp(103.1668 * Math.exp(-0.04354 * drop) - 3.1669, 0, 100);
    if (moverWhite) { sumW += acc; cntW++; } else { sumB += acc; cntB++; }
  }

  S.ana.report = {
    evals, mates, bests, classes,
    accW: cntW ? sumW / cntW : 100,
    accB: cntB ? sumB / cntB : 100,
    counts,
  };
  S.ana.reportRunning = false;
  progWrap.classList.add('hidden');
  renderReport();
  renderMoveList();
  drawGraph();
  updateEvalBarFromKnown();
  updateHighlights();
  requestLiveAnalysis();
}

function fenKeyOf(fen) {
  const f = fen.split(' ');
  return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3];
}

// material-based sacrifice detection for "brilliant":
// mover's material balance dips by a minor piece or more within two plies
function isSacrifice(fens, i) {
  if (i + 1 >= fens.length) return false;
  const moverWhite = fens[i].split(' ')[1] === 'w';
  const m0 = materialOf(fens[i], moverWhite);
  let worst = materialOf(fens[i + 1], moverWhite);
  if (i + 2 < fens.length) worst = Math.min(worst, materialOf(fens[i + 2], moverWhite));
  return worst - m0 <= -2.5;
}
function materialOf(fen, forWhite) {
  const c = countPieces(fen);
  let w = 0, b = 0;
  for (const t of ['p', 'n', 'b', 'r', 'q']) {
    w += (c[t.toUpperCase()] || 0) * VAL[t];
    b += (c[t] || 0) * VAL[t];
  }
  return forWhite ? w - b : b - w;
}

function renderReport() {
  const rep = S.ana.report;
  if (!rep) return;
  $('report').classList.remove('hidden');
  $('acc-white').textContent = rep.accW.toFixed(1) + '%';
  $('acc-black').textContent = rep.accB.toFixed(1) + '%';
  const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'miss', 'mistake', 'blunder'];
  let html = '';
  for (const k of order) {
    if (!rep.counts[k]) continue;
    const ci = CLASS_INFO[k];
    html += `<tr><td><i class="mbadge" style="background:${ci.color}">${ci.label}</i> ${ci.name}</td><td>${rep.counts[k]}</td></tr>`;
  }
  $('class-table').innerHTML = html;
}

$('btn-full-analysis').addEventListener('click', runFullAnalysis);
$('btn-analyze-game').addEventListener('click', () => {
  switchMode('analysis');
  runFullAnalysis();
});

// ---------------------------------------------------------------- eval graph
const graphEl = $('eval-graph');
function drawGraph() {
  const rep = S.ana.report;
  const ctx = graphEl.getContext('2d');
  const W = graphEl.width = graphEl.clientWidth * (window.devicePixelRatio || 1);
  const H = graphEl.height = 90 * (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1c1a18';
  ctx.fillRect(0, 0, W, H);
  if (!rep) return;
  const n = rep.evals.length;
  if (n < 2) return;
  const xOf = i => i / (n - 1) * W;
  const yOf = cp => {
    const v = clamp(cp / 100, -8, 8);
    return H / 2 - (v / 8) * (H / 2 - 4);
  };
  // area
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(rep.evals[i]));
  ctx.lineTo(W, H / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(240,238,232,0.85)';
  ctx.fill();
  // baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  // mistakes/blunders dots
  for (let i = 0; i < rep.classes.length; i++) {
    const c = rep.classes[i];
    if (c !== 'mistake' && c !== 'blunder' && c !== 'inaccuracy' && c !== 'brilliant' && c !== 'great' && c !== 'miss') continue;
    ctx.beginPath();
    ctx.arc(xOf(i + 1), yOf(rep.evals[i + 1]), 3.5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fillStyle = CLASS_INFO[c].color;
    ctx.fill();
  }
  // current position marker
  if (S.line === S.game) {
    const x = xOf(S.view + 1);
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
}
graphEl.addEventListener('click', e => {
  const rep = S.ana.report;
  if (!rep) return;
  const rect = graphEl.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  const idx = Math.round(frac * (rep.evals.length - 1)) - 1;
  backToMainline(false);
  setView(clamp(idx, -1, S.game.moves.length - 1));
});

// ================================================================ import/export
function detectFen(text) {
  return /^\s*([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+\s+[wb]\s+(-|[KQkq]+)\s+(-|[a-h][36])(\s+\d+\s+\d+)?\s*$/.test(text);
}
$('btn-import').addEventListener('click', () => {
  const text = $('pgn-box').value.trim();
  if (!text) return;
  if (detectFen(text)) {
    try {
      const p = new Position(text);
      loadGame(p.fen(), []);
    } catch (e) { alert('Geçersiz FEN.'); }
    return;
  }
  // PGN
  const headers = SC.pgnHeaders(text);
  const startFen = headers.FEN && headers.SetUp === '1' ? headers.FEN : (headers.FEN || START_FEN);
  const sans = SC.parsePgnMoves(text);
  const p = new Position(startFen);
  const moves = [];
  for (const san of sans) {
    const mi = p.moveFromSan(san);
    if (!mi) break;
    const sanClean = p.san(mi);
    const uci = p.moveToUci(mi);
    p.make(mi);
    moves.push({ uci, san: sanClean, mi, fenAfter: p.fen() });
  }
  if (moves.length === 0 && sans.length > 0) { alert('PGN çözümlenemedi.'); return; }
  loadGame(startFen, moves);
});

function loadGame(startFen, moves) {
  S.game = { startFen, moves, result: null };
  S.line = S.game;
  S.view = moves.length - 1;
  _vpCacheFen = null;
  S.ana.report = null;
  S.play.active = false;
  stopClock();
  $('report').classList.add('hidden');
  renderAll();
  afterPositionChange();
  drawGraph();
}

function buildPgn() {
  const lines = [];
  lines.push('[Event "SigmaBoy"]');
  lines.push(`[Date "${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]`);
  if (S.game.startFen !== START_FEN) {
    lines.push('[SetUp "1"]');
    lines.push(`[FEN "${S.game.startFen}"]`);
  }
  lines.push(`[Result "${S.game.result || '*'}"]`);
  lines.push('');
  const p = new Position(S.game.startFen);
  let out = '', num = p.fullmove;
  let white = p.side === SC.WHITE;
  if (!white && S.game.moves.length) out += num + '... ';
  for (const mv of S.game.moves) {
    if (white) out += num + '. ';
    out += mv.san + ' ';
    if (!white) num++;
    white = !white;
  }
  out += S.game.result || '*';
  lines.push(out.trim());
  return lines.join('\n');
}
$('btn-export-pgn').addEventListener('click', () => {
  const pgn = buildPgn();
  navigator.clipboard.writeText(pgn).catch(() => {});
  $('pgn-box').value = pgn;
});
$('btn-export-fen').addEventListener('click', () => {
  const fen = viewFen();
  navigator.clipboard.writeText(fen).catch(() => {});
  $('pgn-box').value = fen;
});

// ================================================================ editor
function buildPalettes() {
  const mk = (colorChar, containerId) => {
    const cont = $(containerId);
    for (const t of ['k', 'q', 'r', 'b', 'n', 'p']) {
      const btn = document.createElement('button');
      btn.className = 'palette-piece';
      btn.dataset.brush = colorChar + t;
      btn.innerHTML = pieceSvg(colorChar, t);
      btn.addEventListener('click', () => setBrush(colorChar + t));
      cont.appendChild(btn);
    }
  };
  mk('w', 'palette-white');
  mk('b', 'palette-black');
  $('brush-trash').addEventListener('click', () => setBrush('trash'));
  $('brush-cursor').addEventListener('click', () => setBrush('cursor'));
}
function setBrush(b) {
  S.editor.brush = b;
  document.querySelectorAll('.palette-piece').forEach(el => {
    el.classList.toggle('active', el.dataset.brush === b ||
      (b === 'trash' && el.id === 'brush-trash') || (b === 'cursor' && el.id === 'brush-cursor'));
  });
}

const CODE_TO_NUM = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
function editorSet(sq, code) {
  const pos = S.editor.pos;
  if (!code) pos.board[sq] = 0;
  else pos.board[sq] = CODE_TO_NUM[code[1]] * (code[0] === 'w' ? 1 : -1);
  editorAfterChange();
}
function editorPointerDown(sq, e) {
  const brush = S.editor.brush;
  const pos = S.editor.pos;
  if (brush === 'cursor') {
    if (pos.board[sq]) {
      const el = pieceEls[sq];
      drag = { type: 'editor-piece', from: sq, el, code: codeAt(pos.board, sq) };
      el.classList.add('dragging');
      boardEl.setPointerCapture(e.pointerId);
      moveDragEl(e);
    }
    return;
  }
  if (brush === 'trash') { editorSet(sq, null); return; }
  const cur = codeAt(pos.board, sq);
  editorSet(sq, cur === brush ? null : brush);
}
function editorDrop(d, sq) {
  d.el.classList.remove('dragging');
  const pos = S.editor.pos;
  if (sq < 0) { pos.board[d.from] = 0; }
  else if (sq !== d.from) {
    pos.board[sq] = pos.board[d.from];
    pos.board[d.from] = 0;
  }
  editorAfterChange();
}
boardEl.addEventListener('pointerdown', e => {
  // right-click delete in editor
  if (S.mode === 'editor' && e.button === 2) {
    const sq = evtSquare(e);
    if (sq >= 0) { editorSet(sq, null); drag = null; }
  }
});

function editorApplySideToMove() {
  if (S.mode !== 'editor') return;
  const v = document.querySelector('#stm-seg .active').dataset.v;
  S.editor.pos.side = v === 'w' ? SC.WHITE : SC.BLACK;
  editorAfterChange(true);
}
function editorCastlingFromChecks() {
  let c = 0;
  if ($('cr-K').checked) c |= SC.CR_WK;
  if ($('cr-Q').checked) c |= SC.CR_WQ;
  if ($('cr-k').checked) c |= SC.CR_BK;
  if ($('cr-q').checked) c |= SC.CR_BQ;
  return c;
}
['cr-K', 'cr-Q', 'cr-k', 'cr-q'].forEach(id => $(id).addEventListener('change', () => editorAfterChange(true)));

function editorAfterChange(noRender) {
  const pos = S.editor.pos;
  const b = pos.board;
  // auto-limit castling rights to plausible ones
  let c = editorCastlingFromChecks();
  if (b[116] !== 6) c &= ~(SC.CR_WK | SC.CR_WQ);
  if (b[119] !== 4) c &= ~SC.CR_WK;
  if (b[112] !== 4) c &= ~SC.CR_WQ;
  if (b[4] !== -6) c &= ~(SC.CR_BK | SC.CR_BQ);
  if (b[7] !== -4) c &= ~SC.CR_BK;
  if (b[0] !== -4) c &= ~SC.CR_BQ;
  pos.castling = c;
  pos.ep = -1; pos.halfmove = 0; pos.fullmove = 1;
  $('fen-input').value = pos.fen();
  editorValidate();
  if (!noRender) renderAll();
}

function editorValidate() {
  const b = S.editor.pos.board;
  let wk = 0, bk = 0, badPawn = false;
  let wkSq = -1, bkSq = -1;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    if (b[sq] === 6) { wk++; wkSq = sq; }
    if (b[sq] === -6) { bk++; bkSq = sq; }
    if (Math.abs(b[sq]) === 1 && ((sq >> 4) === 0 || (sq >> 4) === 7)) badPawn = true;
  }
  const warn = $('editor-warning');
  let msg = '';
  if (wk !== 1 || bk !== 1) msg = 'Her renkten tam bir şah olmalı.';
  else if (badPawn) msg = 'Piyonlar 1. veya 8. sırada olamaz.';
  else {
    const p = new Position(S.editor.pos.fen());
    if (p.isAttacked(p.kings[p.side === SC.WHITE ? 1 : 0], p.side))
      msg = 'Hamle sırası olmayan taraf şahta olamaz.';
  }
  warn.textContent = msg;
  warn.classList.toggle('hidden', !msg);
  const valid = !msg;
  $('btn-play-from').disabled = !valid;
  $('btn-analyze-from').disabled = !valid;
  return valid;
}

$('fen-input').addEventListener('change', () => {
  try {
    const p = new Position($('fen-input').value.trim());
    S.editor.pos = p;
    syncEditorControlsFromPos();
    renderAll();
    editorValidate();
  } catch (e) { editorValidate(); }
});
function syncEditorControlsFromPos() {
  const pos = S.editor.pos;
  document.querySelectorAll('#stm-seg button').forEach(bt =>
    bt.classList.toggle('active', bt.dataset.v === (pos.side === SC.WHITE ? 'w' : 'b')));
  $('cr-K').checked = !!(pos.castling & SC.CR_WK);
  $('cr-Q').checked = !!(pos.castling & SC.CR_WQ);
  $('cr-k').checked = !!(pos.castling & SC.CR_BK);
  $('cr-q').checked = !!(pos.castling & SC.CR_BQ);
}

$('btn-startpos').addEventListener('click', () => {
  S.editor.pos = new Position(START_FEN);
  syncEditorControlsFromPos();
  editorAfterChange();
});
$('btn-clear').addEventListener('click', () => {
  S.editor.pos = new Position('8/8/8/8/8/8/8/8 w - - 0 1');
  syncEditorControlsFromPos();
  editorAfterChange();
});
$('btn-play-from').addEventListener('click', () => {
  if (!editorValidate()) return;
  const fen = S.editor.pos.fen();
  switchMode('play');
  startGame(fen);
});
$('btn-analyze-from').addEventListener('click', () => {
  if (!editorValidate()) return;
  const fen = S.editor.pos.fen();
  switchMode('analysis');
  loadGame(fen, []);
});

// ================================================================ modes / top bar
function switchMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  S.anaSeq++;
  engine.stop();
  S.selected = -1; S.dests = []; S.shapes = []; S.hintArrow = null;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('panel-play').classList.toggle('hidden', mode !== 'play');
  $('panel-analysis').classList.toggle('hidden', mode !== 'analysis');
  $('panel-editor').classList.toggle('hidden', mode !== 'editor');
  $('evalbar').classList.toggle('hidden', mode !== 'analysis');
  document.body.classList.toggle('editor-mode', mode === 'editor');
  if (mode === 'editor') {
    // seed the editor with the position on the board
    S.editor.pos = new Position(viewFen());
    syncEditorControlsFromPos();
    editorAfterChange(true);
  }
  renderAll();
  if (mode !== 'editor') afterPositionChange();
  if (mode === 'analysis') drawGraph();
}
document.querySelectorAll('#tabs .tab').forEach(t =>
  t.addEventListener('click', () => switchMode(t.dataset.mode)));

function flipBoard() {
  S.flipped = !S.flipped;
  layoutSquares();
  renderAll();
  drawShapes();
  updateClassBadge();
}
$('btn-flip').addEventListener('click', flipBoard);

$('btn-sound').addEventListener('click', () => {
  Sound.setEnabled(!Sound.isEnabled());
  $('btn-sound').textContent = Sound.isEnabled() ? '🔊' : '🔇';
  localStorage.setItem('sb-sound', Sound.isEnabled() ? '1' : '0');
});
$('theme-select').addEventListener('change', e => {
  document.body.dataset.theme = e.target.value;
  localStorage.setItem('sb-theme', e.target.value);
});

// ================================================================ init
function init() {
  const theme = localStorage.getItem('sb-theme') || 'green';
  document.body.dataset.theme = theme;
  $('theme-select').value = theme;
  if (localStorage.getItem('sb-sound') === '0') { Sound.setEnabled(false); $('btn-sound').textContent = '🔇'; }

  buildBoard();
  buildPalettes();
  engine.init();
  renderAll();
  renderMoveList();
  $('level-desc').textContent = LEVEL_DESC[5];
  window.addEventListener('resize', () => { drawGraph(); });
}
init();

})();

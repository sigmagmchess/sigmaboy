/*
 * SigmaBoy engine — alpha-beta search with:
 *   iterative deepening, aspiration windows, PVS, transposition table,
 *   null-move pruning, late move reductions, futility pruning,
 *   killer moves, history heuristic, MVV-LVA ordering,
 *   quiescence search with check evasions and delta pruning,
 *   tapered PeSTO-style evaluation + pawn structure / king safety / mobility,
 *   multi-PV analysis and an opening book.
 *
 * Runs inside a Web Worker (importScripts) or in Node/main thread for tests.
 */
(function (global) {
'use strict';

if (typeof importScripts === 'function' && !global.SC) importScripts('chess.js');
if (typeof importScripts === 'function' && !global.SigmaNNUE) {
  try { importScripts('nnue.js'); } catch (e) { /* net yoksa klasik değerlendirme kullanılır */ }
}
const SC = global.SC || (typeof require !== 'undefined' ? require('./chess.js') : null);
if (!global.SigmaNNUE && typeof require !== 'undefined') {
  try { require('./nnue.js'); } catch (e) { /* optional */ }
}

const { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK } = SC;
const { mFrom, mTo, mPiece, mCapt, mPromo, mIsCapture } = SC;

// ================================================================ evaluation
// tapered middlegame/endgame values (PeSTO-inspired)
const MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
const EG_VAL = [0, 94, 281, 297, 512, 936, 0];
const SEE_VAL = [0, 100, 320, 330, 500, 950, 20000];

// piece-square tables, index 0 = a8 ... 63 = h1 (white perspective)
const MG_PST = [null,
  [ // pawn
    0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20,
    -14,13,6,21,23,12,17,-23, -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12,
    -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0 ],
  [ // knight
    -167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44,
    -9,17,19,53,37,69,18,22, -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16,
    -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23 ],
  [ // bishop
    -29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2,
    -4,5,19,50,37,37,7,-2, -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10,
    4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21 ],
  [ // rook
    32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16,
    -24,-11,7,26,24,35,-8,-20, -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33,
    -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26 ],
  [ // queen
    -28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57,
    -27,-27,-16,-16,-1,17,-2,1, -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5,
    -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50 ],
  [ // king
    -65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22,
    -17,-20,-12,-27,-30,-25,-14,-36, -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27,
    1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14 ],
];
const EG_PST = [null,
  [ // pawn
    0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84,
    32,24,13,5,-2,4,17,17, 13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8,
    13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0 ],
  [ // knight
    -58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41,
    -17,3,22,22,22,11,8,-18, -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22,
    -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64 ],
  [ // bishop
    -14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4,
    -3,9,12,9,14,10,3,2, -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15,
    -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17 ],
  [ // rook
    13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3,
    4,3,13,1,2,1,-1,2, 3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16,
    -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20 ],
  [ // queen
    -9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9,
    3,22,24,45,57,40,57,36, -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5,
    -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41 ],
  [ // king
    -74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13,
    -8,22,24,27,26,33,26,3, -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9,
    -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43 ],
];

const PHASE_W = [0, 0, 1, 1, 2, 4, 0]; // per piece type; total 24

const PASSED_MG = [0, 5, 8, 12, 20, 35, 60, 0];   // by advancement (rank steps from own side)
const PASSED_EG = [0, 12, 20, 32, 55, 95, 150, 0];
const BISHOP_PAIR_MG = 25, BISHOP_PAIR_EG = 45;
const DOUBLED_MG = -8, DOUBLED_EG = -16;
const ISOLATED_MG = -12, ISOLATED_EG = -8;
const ROOK_OPEN_MG = 28, ROOK_SEMI_MG = 12, ROOK_OPEN_EG = 8, ROOK_SEMI_EG = 6;
const TEMPO = 14;

const MOB_MG = [0, 0, 4, 4, 2, 1, 0];
const MOB_EG = [0, 0, 3, 4, 3, 2, 0];

const KNIGHT_D = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_D = [-17, -15, 15, 17];
const ROOK_D   = [-16, -1, 1, 16];
const QUEEN_D  = [-17, -16, -15, -1, 1, 15, 16, 17];
const KING_D   = QUEEN_D;

// king-zone attack units → middlegame penalty for the defender
const KS_WEIGHT = [0, 0, 2, 2, 3, 5, 0]; // per piece type per attacked zone square
const KS_TABLE = (() => {
  const t = new Int16Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.min(250, (i * i * 3) >> 2);
  return t;
})();

// reusable evaluation scratch buffers (avoid per-node allocation)
const EV_wFile = new Int8Array(10), EV_bFile = new Int8Array(10);
// sized generously: editor positions may hold more than 8 pawns per side
const EV_wPawns = new Uint8Array(64), EV_bPawns = new Uint8Array(64);
const EV_zoneW = new Uint8Array(136), EV_zoneB = new Uint8Array(136);

// returns score in centipawns from the side-to-move perspective
function evaluate(pos) {
  const b = pos.board;
  let mg = 0, eg = 0, phase = 0;
  let wBishops = 0, bBishops = 0, wQueens = 0, bQueens = 0;

  // pawn pre-pass: file counts + squares (reusable buffers)
  EV_wFile.fill(0); EV_bFile.fill(0);
  let wpc = 0, bpc = 0;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (p === PAWN) { EV_wFile[(sq & 7) + 1]++; EV_wPawns[wpc++] = sq; }
    else if (p === -PAWN) { EV_bFile[(sq & 7) + 1]++; EV_bPawns[bpc++] = sq; }
  }

  // king attack zones (own king square + neighbors)
  EV_zoneW.fill(0); EV_zoneB.fill(0);
  const wk = pos.kings[0], bk = pos.kings[1];
  EV_zoneW[wk] = 1; EV_zoneB[bk] = 1;
  for (let i = 0; i < 8; i++) {
    let t = wk + KING_D[i];
    if (!(t & 0x88)) EV_zoneW[t] = 1;
    t = bk + KING_D[i];
    if (!(t & 0x88)) EV_zoneB[t] = 1;
  }
  let unitsOnW = 0, unitsOnB = 0; // attack units against each king

  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p > 0 ? p : -p;
    const white = p > 0;
    const idx = white ? ((sq >> 4) << 3) | (sq & 7) : (((sq >> 4) << 3) | (sq & 7)) ^ 56;
    const sgn = white ? 1 : -1;

    mg += sgn * (MG_VAL[t] + MG_PST[t][idx]);
    eg += sgn * (EG_VAL[t] + EG_PST[t][idx]);
    phase += PHASE_W[t];

    if (t === BISHOP) { if (white) wBishops++; else bBishops++; }
    else if (t === QUEEN) { if (white) wQueens++; else bQueens++; }

    // mobility + king-zone attacks in one scan
    if (t >= KNIGHT && t <= QUEEN) {
      let mob = 0;
      const kw = KS_WEIGHT[t];
      if (t === KNIGHT) {
        for (let i = 0; i < 8; i++) {
          const to = sq + KNIGHT_D[i];
          if (to & 0x88) continue;
          if (b[to] === 0 || (b[to] > 0) !== white) mob++;
          if (white) { if (EV_zoneB[to]) unitsOnB += kw; }
          else if (EV_zoneW[to]) unitsOnW += kw;
        }
      } else {
        const dirs = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : QUEEN_D;
        const nd = t === QUEEN ? 8 : 4;
        for (let i = 0; i < nd; i++) {
          const d = dirs[i];
          for (let to = sq + d; !(to & 0x88); to += d) {
            if (white) { if (EV_zoneB[to]) unitsOnB += kw; }
            else if (EV_zoneW[to]) unitsOnW += kw;
            if (b[to] === 0) { mob++; continue; }
            if ((b[to] > 0) !== white) mob++;
            break;
          }
        }
      }
      mg += sgn * MOB_MG[t] * mob;
      eg += sgn * MOB_EG[t] * mob;
    }

    // rook on (semi-)open file
    if (t === ROOK) {
      const f = (sq & 7) + 1;
      const own = white ? EV_wFile[f] : EV_bFile[f];
      const opp = white ? EV_bFile[f] : EV_wFile[f];
      if (own === 0) {
        if (opp === 0) { mg += sgn * ROOK_OPEN_MG; eg += sgn * ROOK_OPEN_EG; }
        else { mg += sgn * ROOK_SEMI_MG; eg += sgn * ROOK_SEMI_EG; }
      }
    }
  }

  if (wBishops >= 2) { mg += BISHOP_PAIR_MG; eg += BISHOP_PAIR_EG; }
  if (bBishops >= 2) { mg -= BISHOP_PAIR_MG; eg -= BISHOP_PAIR_EG; }

  // king safety: attack units → table (halved without the attacker's queen)
  if (!wQueens) unitsOnB >>= 1;
  if (!bQueens) unitsOnW >>= 1;
  mg += KS_TABLE[unitsOnB > 63 ? 63 : unitsOnB];
  mg -= KS_TABLE[unitsOnW > 63 ? 63 : unitsOnW];

  // pawn structure
  for (let i = 0; i < wpc; i++) {
    const sq = EV_wPawns[i];
    const f = (sq & 7) + 1, r = sq >> 4;
    if (EV_wFile[f] > 1) { mg += DOUBLED_MG >> 1; eg += DOUBLED_EG >> 1; }
    if (EV_wFile[f - 1] === 0 && EV_wFile[f + 1] === 0) { mg += ISOLATED_MG; eg += ISOLATED_EG; }
    if (!hasEnemyPawnAhead(b, sq, true)) {
      const adv = 7 - r;
      let pm = PASSED_MG[adv] || 0, pe = PASSED_EG[adv] || 0;
      if (b[sq - 16]) { pm = (pm * 2 / 3) | 0; pe = (pe * 2 / 3) | 0; } // blockaded
      mg += pm; eg += pe;
    }
  }
  for (let i = 0; i < bpc; i++) {
    const sq = EV_bPawns[i];
    const f = (sq & 7) + 1, r = sq >> 4;
    if (EV_bFile[f] > 1) { mg -= DOUBLED_MG >> 1; eg -= DOUBLED_EG >> 1; }
    if (EV_bFile[f - 1] === 0 && EV_bFile[f + 1] === 0) { mg -= ISOLATED_MG; eg -= ISOLATED_EG; }
    if (!hasEnemyPawnAhead(b, sq, false)) {
      const adv = r;
      let pm = PASSED_MG[adv] || 0, pe = PASSED_EG[adv] || 0;
      if (b[sq + 16]) { pm = (pm * 2 / 3) | 0; pe = (pe * 2 / 3) | 0; }
      mg -= pm; eg -= pe;
    }
  }

  // king pawn shield (middlegame)
  mg += kingShield(b, pos.kings[0], true);
  mg -= kingShield(b, pos.kings[1], false);

  if (phase > 24) phase = 24;
  let score = ((mg * phase) + (eg * (24 - phase))) / 24 | 0;
  score = pos.side === WHITE ? score : -score;
  return score + TEMPO;
}

// scan same + adjacent files ahead of the pawn for enemy pawns
function hasEnemyPawnAhead(b, sq, white) {
  const dir = white ? -16 : 16;
  const enemy = white ? -PAWN : PAWN;
  for (let t = sq + dir; !(t & 0x88); t += dir) {
    if (b[t] === enemy) return true;
    if (!((t - 1) & 0x88) && b[t - 1] === enemy) return true;
    if (!((t + 1) & 0x88) && b[t + 1] === enemy) return true;
  }
  return false;
}

function kingShield(b, ksq, white) {
  const r = ksq >> 4;
  // only meaningful when the king is on its own back two ranks
  if (white && r < 6) return 0;
  if (!white && r > 1) return 0;
  const dir = white ? -16 : 16;
  const own = white ? PAWN : -PAWN;
  let score = 0;
  for (let df = -1; df <= 1; df++) {
    const s1 = ksq + dir + df, s2 = ksq + 2 * dir + df;
    if (!(s1 & 0x88) && b[s1] === own) score += 12;
    else if (!(s2 & 0x88) && b[s2] === own) score += 6;
    else score -= 10;
  }
  return score;
}

// ================================================================ NNUE
// 768 → H (clipped ReLU) → 1, side-to-move perspective, int16 quantized.
// distilled from Stockfish 18 Lite static evaluation.
let NN = null, NN_ACC = null;
function initNNUE(raw) {
  const dec = s => {
    if (typeof Buffer !== 'undefined') {
      const b = Buffer.from(s, 'base64');
      return new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
    }
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Int16Array(u.buffer);
  };
  NN = { H: raw.H, W1: dec(raw.W1), B1: dec(raw.B1), W2: dec(raw.W2), B2: raw.B2 };
  NN_ACC = new Int32Array(raw.H);
}
if (global.SigmaNNUE) { try { initNNUE(global.SigmaNNUE); } catch (e) { NN = null; } }

// feature indices for a signed piece on an 0x88 square, both perspectives
function nnFeatW(p, sq) {
  const t = (p > 0 ? p : -p) - 1;
  const sq64 = ((sq >> 4) << 3) | (sq & 7);
  return ((p > 0 ? t : t + 6) << 6) | sq64;
}
function nnFeatB(p, sq) {
  const t = (p > 0 ? p : -p) - 1;
  const sq64 = (((sq >> 4) << 3) | (sq & 7)) ^ 56;
  return ((p < 0 ? t : t + 6) << 6) | sq64;
}

// returns cp from side-to-move perspective
function nnueEval(pos) {
  const H = NN.H, W1 = NN.W1, W2 = NN.W2, acc = NN_ACC;
  const b = pos.board;
  const white = pos.side === WHITE;
  for (let h = 0; h < H; h++) acc[h] = NN.B1[h];
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = (p > 0 ? p : -p) - 1;                 // 0..5
    const own = (p > 0) === white;
    let sq64 = ((sq >> 4) << 3) | (sq & 7);         // a8=0 … h1=63
    if (!white) sq64 ^= 56;                         // perspective flip
    const base = (((own ? t : t + 6) << 6) | sq64) * H;
    for (let h = 0; h < H; h++) acc[h] += W1[base + h];
  }
  let out = NN.B2 * 1024;                           // align scales (see train.js)
  for (let h = 0; h < H; h++) {
    let v = acc[h];
    if (v < 0) v = 0; else if (v > 1024) v = 1024;  // clipped ReLU (scale 1024)
    out += W2[h] * v;
  }
  return ((out * 400) / 524288) | 0;
}

// ================================================================ search
const INF = 32000, MATE = 31000, MATE_BOUND = 30000;
const TT_SIZE = 1 << 21, TT_MASK = TT_SIZE - 1;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
const MAX_PLY = 96;

// log-based late-move-reduction table [depth][moveNumber]
const LMR_TABLE = (() => {
  const t = [];
  for (let d = 0; d < 64; d++) {
    t.push(new Int8Array(64));
    for (let m = 0; m < 64; m++) {
      t[d][m] = (d > 0 && m > 0) ? Math.max(0, Math.round(0.5 + Math.log(d) * Math.log(m) / 2.4)) : 0;
    }
  }
  return t;
})();

// static-exchange-evaluation scratch buffers
const SEE_GAIN = new Int32Array(34);
const SEE_RS = new Int32Array(34), SEE_RP = new Int32Array(34);

class AbortSearch extends Error {}

class Engine {
  constructor() {
    this.pos = new SC.Position();
    this.allocTT(TT_SIZE);
    this.age = 0;
    this.killer1 = new Int32Array(MAX_PLY);
    this.killer2 = new Int32Array(MAX_PLY);
    this.history = new Int32Array(2 * 7 * 128);
    this.counter = new Int32Array(2 * 7 * 128); // countermove heuristic
    this.evalStack = new Int32Array(MAX_PLY);
    this.excludedMove = new Int32Array(MAX_PLY);
    this.pvTable = [];
    this.pvLen = new Int32Array(MAX_PLY);
    this.scoreBufs = [];
    for (let i = 0; i < MAX_PLY; i++) {
      this.pvTable.push(new Int32Array(MAX_PLY));
      this.scoreBufs.push(new Int32Array(256));
    }
    // 'nnue' | 'hce' | 'blend' — hce is the measured-strongest default;
    // nnue mode is available and used when it wins the eval playoff
    this.evalMode = 'hce';
    // incremental NNUE accumulators: one pair (white/black perspective) per ply level
    if (NN) {
      this.accW = []; this.accB = [];
      for (let i = 0; i < MAX_PLY + 8; i++) { this.accW.push(new Int32Array(NN.H)); this.accB.push(new Int32Array(NN.H)); }
    }
    this.accLevel = 0;
    this.nodes = 0;
    this.stopFlag = false;
    this.deadline = Infinity;
    this.rndState = 0x1234567 ^ (Date.now() & 0xffff);
  }

  eval_(pos) {
    if (NN && this.evalMode === 'nnue') return this.nnueFast(pos);
    if (NN && this.evalMode === 'blend') return (this.nnueFast(pos) + evaluate(pos)) >> 1;
    return evaluate(pos);
  }

  // rebuild accumulators for the root position (called once per go)
  refreshAcc() {
    if (!NN || this.evalMode === 'hce') return;
    const H = NN.H, W1 = NN.W1;
    const aw = this.accW[0], ab = this.accB[0];
    for (let h = 0; h < H; h++) { aw[h] = NN.B1[h]; ab[h] = NN.B1[h]; }
    const b = this.pos.board;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p) continue;
      const bw = nnFeatW(p, sq) * H, bb = nnFeatB(p, sq) * H;
      for (let h = 0; h < H; h++) { aw[h] += W1[bw + h]; ab[h] += W1[bb + h]; }
    }
    this.accLevel = 0;
  }

  accApply(p, sq, sign) {
    const H = NN.H, W1 = NN.W1;
    const aw = this.accW[this.accLevel], ab = this.accB[this.accLevel];
    const bw = nnFeatW(p, sq) * H, bb = nnFeatB(p, sq) * H;
    if (sign > 0) for (let h = 0; h < H; h++) { aw[h] += W1[bw + h]; ab[h] += W1[bb + h]; }
    else for (let h = 0; h < H; h++) { aw[h] -= W1[bw + h]; ab[h] -= W1[bb + h]; }
  }

  // make/unmake wrappers that keep the accumulators in sync
  makeNN(m) {
    const pos = this.pos;
    const us = pos.side; // mover (before make)
    pos.make(m);
    if (!NN || this.evalMode === 'hce') return;
    const lv = this.accLevel;
    this.accW[lv + 1].set(this.accW[lv]);
    this.accB[lv + 1].set(this.accB[lv]);
    this.accLevel = lv + 1;
    const from = m & 127, to = (m >> 7) & 127;
    const piece = (m >> 14) & 7, capt = (m >> 17) & 7, promo = (m >> 20) & 7;
    this.accApply(piece * us, from, -1);
    if (m & SC.F_EP) this.accApply(-us, to + (us === WHITE ? 16 : -16), -1);
    else if (capt) this.accApply(capt * -us, to, -1);
    this.accApply((promo || piece) * us, to, 1);
    if (m & SC.F_CASTLE) {
      let rf, rt;
      if ((to & 7) === 6) { rf = to + 1; rt = to - 1; } else { rf = to - 2; rt = to + 1; }
      this.accApply(ROOK * us, rf, -1);
      this.accApply(ROOK * us, rt, 1);
    }
  }

  unmakeNN() {
    this.pos.unmake();
    if (NN && this.evalMode !== 'hce') this.accLevel--;
  }

  makeNullNN() {
    this.pos.makeNull();
    if (!NN || this.evalMode === 'hce') return;
    const lv = this.accLevel;
    this.accW[lv + 1].set(this.accW[lv]);
    this.accB[lv + 1].set(this.accB[lv]);
    this.accLevel = lv + 1;
  }

  unmakeNullNN() {
    this.pos.unmakeNull();
    if (NN && this.evalMode !== 'hce') this.accLevel--;
  }

  // output layer over the maintained accumulator (stm perspective)
  nnueFast(pos) {
    const H = NN.H, W2 = NN.W2;
    const acc = pos.side === WHITE ? this.accW[this.accLevel] : this.accB[this.accLevel];
    let out = NN.B2 * 1024;
    for (let h = 0; h < H; h++) {
      let v = acc[h];
      if (v < 0) v = 0; else if (v > 1024) v = 1024;
      out += W2[h] * v;
    }
    return ((out * 400) / 524288) | 0;
  }

  allocTT(entries) {
    this.ttEntries = entries;
    this.ttMask = entries - 1;
    this.ttKey   = new Int32Array(entries);
    this.ttMove  = new Int32Array(entries);
    this.ttScore = new Int16Array(entries);
    this.ttDepth = new Int8Array(entries);
    this.ttFlag  = new Uint8Array(entries);
    this.ttAge   = new Uint8Array(entries);
  }

  // hash table size in megabytes (~13 bytes/entry, rounded to a power of two)
  resizeTT(mb) {
    let entries = 1 << 18;
    while ((entries << 1) * 13 <= mb * 1024 * 1024 && entries < (1 << 25)) entries <<= 1;
    if (entries !== this.ttEntries) this.allocTT(entries);
  }

  rnd() { // xorshift for level-based randomness
    let s = this.rndState;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.rndState = s;
    return s / 4294967296;
  }

  clearTables() {
    this.ttKey.fill(0); this.ttMove.fill(0); this.ttScore.fill(0);
    this.ttDepth.fill(0); this.ttFlag.fill(0); this.ttAge.fill(0);
    this.history.fill(0); this.counter.fill(0);
    this.killer1.fill(0); this.killer2.fill(0);
  }

  setPosition(fen, ucis) {
    this.pos.load(fen || SC.START_FEN);
    if (ucis) for (const u of ucis) {
      const m = this.pos.moveFromUci(u);
      if (m) this.pos.make(m);
    }
  }

  checkTime() {
    if (this.stopFlag) throw new AbortSearch();
    if ((this.nodes & 2047) === 0 && Date.now() > this.deadline) throw new AbortSearch();
  }

  histIdx(side, piece, to) { return (side === WHITE ? 0 : 7 * 128) + piece * 128 + (to & 127); }

  // countermove slot for the move that led to the current position
  cmIdx(prevMove, sideToMove) {
    return (sideToMove === WHITE ? 0 : 7 * 128) + mPiece(prevMove) * 128 + (mTo(prevMove) & 127);
  }

  // smallest attacker of `to` for `side`, honoring pieces removed during SEE
  smallestAttacker(to, side) {
    const b = this.pos.board;
    let t;
    if (side === WHITE) {
      t = to + 15; if (!(t & 0x88) && b[t] === PAWN) return t;
      t = to + 17; if (!(t & 0x88) && b[t] === PAWN) return t;
    } else {
      t = to - 15; if (!(t & 0x88) && b[t] === -PAWN) return t;
      t = to - 17; if (!(t & 0x88) && b[t] === -PAWN) return t;
    }
    const kn = KNIGHT * side;
    for (let i = 0; i < 8; i++) {
      t = to + KNIGHT_D[i];
      if (!(t & 0x88) && b[t] === kn) return t;
    }
    const bi = BISHOP * side, ro = ROOK * side, qu = QUEEN * side;
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_D[i];
      for (t = to + d; !(t & 0x88); t += d) { const p = b[t]; if (p) { if (p === bi) return t; break; } }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_D[i];
      for (t = to + d; !(t & 0x88); t += d) { const p = b[t]; if (p) { if (p === ro) return t; break; } }
    }
    for (let i = 0; i < 8; i++) {
      const d = QUEEN_D[i];
      for (t = to + d; !(t & 0x88); t += d) { const p = b[t]; if (p) { if (p === qu) return t; break; } }
    }
    const ki = KING * side;
    for (let i = 0; i < 8; i++) {
      t = to + KING_D[i];
      if (!(t & 0x88) && b[t] === ki) return t;
    }
    return -1;
  }

  // static exchange evaluation: expected material outcome of a capture (cp)
  see(m) {
    if (m & SC.F_EP) return 0;
    const b = this.pos.board;
    const to = mTo(m), from = mFrom(m);
    let d = 0, nr = 0;
    SEE_GAIN[0] = SEE_VAL[mCapt(m)];
    let occupierVal = SEE_VAL[mPiece(m)];
    SEE_RS[nr] = from; SEE_RP[nr++] = b[from]; b[from] = 0;
    let side = -this.pos.side;
    for (;;) {
      const a = this.smallestAttacker(to, side);
      if (a < 0 || d >= 30) break;
      d++;
      SEE_GAIN[d] = occupierVal - SEE_GAIN[d - 1];
      if (Math.max(-SEE_GAIN[d - 1], SEE_GAIN[d]) < 0) break;
      occupierVal = SEE_VAL[b[a] > 0 ? b[a] : -b[a]];
      SEE_RS[nr] = a; SEE_RP[nr++] = b[a]; b[a] = 0;
      side = -side;
    }
    while (nr > 0) { nr--; b[SEE_RS[nr]] = SEE_RP[nr]; }
    while (d > 0) { SEE_GAIN[d - 1] = -Math.max(-SEE_GAIN[d - 1], SEE_GAIN[d]); d--; }
    return SEE_GAIN[0];
  }

  scoreMoves(moves, ttMove, ply) {
    const pos = this.pos;
    const scores = moves.length <= 256 ? this.scoreBufs[ply] : new Int32Array(moves.length);
    const prevM = pos.lastMove();
    const cm = prevM ? this.counter[this.cmIdx(prevM, pos.side)] : 0;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (m === ttMove) { scores[i] = 2000000000; continue; }
      const capt = mCapt(m), promo = mPromo(m);
      if (capt) scores[i] = 1000000000 + capt * 100 - mPiece(m) + (promo === QUEEN ? 500 : 0);
      else if (promo === QUEEN) scores[i] = 999000000;
      else if (promo) scores[i] = 500000;
      else if (m === this.killer1[ply]) scores[i] = 900000000;
      else if (m === cm) scores[i] = 850000000;
      else if (m === this.killer2[ply]) scores[i] = 800000000;
      else scores[i] = this.history[this.histIdx(pos.side, mPiece(m), mTo(m))];
    }
    return scores;
  }

  pickMove(moves, scores, start) {
    let bi = start;
    for (let i = start + 1; i < moves.length; i++) if (scores[i] > scores[bi]) bi = i;
    if (bi !== start) {
      const tm = moves[bi]; moves[bi] = moves[start]; moves[start] = tm;
      const ts = scores[bi]; scores[bi] = scores[start]; scores[start] = ts;
    }
    return moves[start];
  }

  qsearch(alpha, beta, ply) {
    this.nodes++;
    this.checkTime();
    const pos = this.pos;
    if (ply >= MAX_PLY - 1) return this.eval_(pos);

    // TT probe: any stored depth bounds a quiescence node
    const idx = (pos.hashLo & this.ttMask) >>> 0;
    let ttMove = 0;
    if (this.ttKey[idx] === pos.hashHi && this.ttFlag[idx] !== 0) {
      ttMove = this.ttMove[idx];
      let ts = this.ttScore[idx];
      if (ts > MATE_BOUND) ts -= ply; else if (ts < -MATE_BOUND) ts += ply;
      const f = this.ttFlag[idx];
      if (f === TT_EXACT) return ts;
      if (f === TT_LOWER && ts >= beta) return ts;
      if (f === TT_UPPER && ts <= alpha) return ts;
    }

    const origAlpha = alpha;
    const inCheck = pos.inCheck();
    let best, bestMove = 0;
    if (inCheck) {
      best = -MATE + ply; // will be overwritten unless mated
    } else {
      best = this.eval_(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }

    const moves = pos.genMoves(!inCheck);
    const scores = this.scoreMoves(moves, ttMove, ply);
    let legal = 0;
    for (let i = 0; i < moves.length; i++) {
      const m = this.pickMove(moves, scores, i);
      if (!inCheck && !mPromo(m)) {
        const capt = mCapt(m);
        // delta pruning
        if (best + SEE_VAL[capt] + 200 <= alpha) continue;
        // skip losing captures (SEE)
        if (SEE_VAL[capt] < SEE_VAL[mPiece(m)] && this.see(m) < 0) continue;
      }
      this.makeNN(m);
      if (pos.illegalAfterMove()) { this.unmakeNN(); continue; }
      legal++;
      const score = -this.qsearch(-beta, -alpha, ply + 1);
      this.unmakeNN();
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }
    if (inCheck && legal === 0) return -MATE + ply;

    // store as depth-0: never displaces deeper same-generation entries
    if (this.ttFlag[idx] === 0 || this.ttAge[idx] !== this.age || this.ttDepth[idx] <= 0) {
      let ss = best;
      if (ss > MATE_BOUND) ss += ply; else if (ss < -MATE_BOUND) ss -= ply;
      this.ttKey[idx] = pos.hashHi;
      this.ttMove[idx] = bestMove;
      this.ttScore[idx] = ss;
      this.ttDepth[idx] = 0;
      this.ttFlag[idx] = best >= beta ? TT_LOWER : best > origAlpha ? TT_EXACT : TT_UPPER;
      this.ttAge[idx] = this.age;
    }
    return best;
  }

  search(depth, alpha, beta, ply, nullOk) {
    const pos = this.pos;
    this.pvLen[ply] = 0;

    if (ply > 0) {
      if (pos.halfmove >= 100 || pos.repetitionCount() >= 1) { this.nodes++; return 0; }
      // mate distance pruning
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;
    }

    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.qsearch(alpha, beta, ply);

    this.nodes++;
    this.checkTime();
    if (ply >= MAX_PLY - 1) return this.eval_(pos);

    const isPv = beta - alpha > 1;

    // transposition table probe
    const excluded = this.excludedMove[ply];
    const idx = (pos.hashLo & this.ttMask) >>> 0;
    let ttMove = 0, ttHitDepth = -1, ttHitScore = 0, ttHitFlag = 0;
    if (this.ttKey[idx] === pos.hashHi && this.ttFlag[idx] !== 0) {
      ttMove = this.ttMove[idx];
      ttHitDepth = this.ttDepth[idx];
      ttHitScore = this.ttScore[idx];
      ttHitFlag = this.ttFlag[idx];
      if (!isPv && ply > 0 && !excluded && ttHitDepth >= depth) {
        let s = ttHitScore;
        if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
        if (ttHitFlag === TT_EXACT) return s;
        if (ttHitFlag === TT_LOWER && s >= beta) return s;
        if (ttHitFlag === TT_UPPER && s <= alpha) return s;
      }
    }

    const staticEval = inCheck ? -INF : this.eval_(pos);
    this.evalStack[ply] = staticEval;
    const improving = !inCheck && ply >= 2 && staticEval > this.evalStack[ply - 2];

    if (!isPv && !inCheck && !excluded && Math.abs(beta) < MATE_BOUND) {
      // reverse futility pruning (static null move)
      if (depth <= 6 && staticEval - (improving ? 70 : 90) * depth >= beta)
        return staticEval;

      // razoring: hopeless shallow nodes drop to quiescence
      if (depth <= 2 && staticEval + 200 + 150 * depth < alpha) {
        const v = this.qsearch(alpha, beta, ply);
        if (v < alpha) return v;
      }

      // null-move pruning
      if (nullOk && depth >= 3 && staticEval >= beta && pos.hasNonPawnMaterial(pos.side)) {
        const R = 3 + (depth >> 3) + (staticEval - beta > 200 ? 1 : 0);
        this.makeNullNN();
        let score;
        try {
          score = -this.search(Math.max(0, depth - 1 - R), -beta, -beta + 1, ply + 1, false);
        } finally {
          this.unmakeNullNN();
        }
        if (score >= beta && score < MATE_BOUND) return beta;
      }
    }

    // internal iterative deepening: get a TT move for ordering in PV nodes
    if (isPv && !ttMove && depth >= 5) {
      this.search(depth - 2, alpha, beta, ply, false);
      if (this.ttKey[idx] === pos.hashHi) ttMove = this.ttMove[idx];
    }

    const futile = !isPv && !inCheck && depth <= 3 && staticEval + 100 + 120 * depth <= alpha;
    const lmpMax = improving ? 4 + depth * depth : 2 + ((depth * depth) >> 1);

    const moves = pos.genMoves(false);
    const scores = this.scoreMoves(moves, ttMove, ply);
    const prevM = pos.lastMove();

    // singular extension: is the TT move the only move that holds?
    let singularExt = 0;
    if (ply > 0 && !excluded && depth >= 8 && ttMove &&
        ttHitDepth >= depth - 3 && ttHitFlag !== TT_UPPER &&
        Math.abs(ttHitScore) < MATE_BOUND) {
      const sBeta = ttHitScore - 2 * depth;
      this.excludedMove[ply] = ttMove;
      const v = this.search(depth >> 1, sBeta - 1, sBeta, ply, false);
      this.excludedMove[ply] = 0;
      if (v < sBeta) singularExt = 1; // every alternative fails low → extend the TT move
    }

    let legal = 0, bestScore = -INF, bestMove = 0, ttStoreFlag = TT_UPPER;
    for (let i = 0; i < moves.length; i++) {
      const m = this.pickMove(moves, scores, i);
      if (m === excluded) continue;
      const capt = mCapt(m), promo = mPromo(m);
      const quiet = !mIsCapture(m) && !promo;

      if (!isPv && !inCheck && bestScore > -MATE_BOUND && legal > 0) {
        // late move (move-count) pruning of quiets at shallow depth
        if (quiet && depth <= 5 && legal >= lmpMax) continue;
        // prune clearly losing captures at shallow depth (SEE)
        if (capt && !promo && depth <= 4 &&
            SEE_VAL[capt] < SEE_VAL[mPiece(m)] && this.see(m) < -80 * depth) continue;
      }

      this.makeNN(m);
      if (pos.illegalAfterMove()) { this.unmakeNN(); continue; }
      legal++;
      const givesCheck = pos.inCheck();

      if (futile && quiet && legal > 1 && !givesCheck) { this.unmakeNN(); continue; }

      const ext = (m === ttMove && singularExt) ? 1 : 0;
      let score;
      try {
        if (legal === 1) {
          score = -this.search(depth - 1 + ext, -beta, -alpha, ply + 1, true);
        } else {
          // late move reductions (log table)
          let R = 0;
          if (quiet && depth >= 3 && !inCheck && !givesCheck && legal > 2) {
            R = LMR_TABLE[depth > 63 ? 63 : depth][legal > 63 ? 63 : legal];
            if (isPv) R--;
            if (!improving) R++;
            if (m === this.killer1[ply] || m === this.killer2[ply]) R--;
            if (R < 0) R = 0;
            const maxR = depth - 2;
            if (R > maxR) R = maxR > 0 ? maxR : 0;
          }
          score = -this.search(depth - 1 - R, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && R > 0)
            score = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && score < beta)
            score = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
        }
      } finally {
        this.unmakeNN();
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          ttStoreFlag = TT_EXACT;
          // update PV
          this.pvTable[ply][0] = m;
          const childLen = this.pvLen[ply + 1];
          for (let j = 0; j < childLen; j++) this.pvTable[ply][j + 1] = this.pvTable[ply + 1][j];
          this.pvLen[ply] = childLen + 1;
          if (alpha >= beta) {
            ttStoreFlag = TT_LOWER;
            if (quiet) {
              if (this.killer1[ply] !== m) { this.killer2[ply] = this.killer1[ply]; this.killer1[ply] = m; }
              if (prevM) this.counter[this.cmIdx(prevM, pos.side)] = m;
              const hi = this.histIdx(pos.side, mPiece(m), mTo(m));
              this.history[hi] += depth * depth;
              if (this.history[hi] > 400000) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }

    if (legal === 0) {
      if (excluded) return alpha; // only the excluded move was legal → fail low vs sBeta window
      return inCheck ? -MATE + ply : 0;
    }

    // store to TT (prefer deeper / fresher entries; never from exclusion searches)
    if (!excluded && (this.ttFlag[idx] === 0 || this.ttAge[idx] !== this.age ||
        depth >= this.ttDepth[idx] || ttStoreFlag === TT_EXACT)) {
      let stScore = bestScore;
      if (stScore > MATE_BOUND) stScore += ply; else if (stScore < -MATE_BOUND) stScore -= ply;
      this.ttKey[idx] = pos.hashHi;
      this.ttMove[idx] = bestMove;
      this.ttScore[idx] = stScore;
      this.ttDepth[idx] = depth;
      this.ttFlag[idx] = ttStoreFlag;
      this.ttAge[idx] = this.age;
    }

    return bestScore;
  }

  // search the root position; returns {move, score, pv, depth}
  // opts: {depth, movetime, multipv, excluded:[moveInts], onInfo}
  searchRoot(maxDepth, excluded, onInfo, multipvIdx) {
    const pos = this.pos;
    const rootMoves = pos.legalMoves().filter(m => !excluded.has(m));
    if (rootMoves.length === 0) return null;

    let best = { move: rootMoves[0], score: -INF, pv: [rootMoves[0]], depth: 0 };
    let prevScore = 0;
    let rootCnt = null; // subtree node counts from the last completed iteration

    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = depth >= 5 ? prevScore - 35 : -INF;
      let beta  = depth >= 5 ? prevScore + 35 : INF;
      let iterBest = null;

      for (;;) { // aspiration loop
        iterBest = null;
        let a = alpha;
        const scores = this.scoreMoves(rootMoves, best.move, 0);
        // root ordering: big subtrees first (they contain the critical replies)
        if (rootCnt) {
          for (let i = 0; i < rootMoves.length; i++) {
            if (scores[i] >= 2000000000) continue; // keep the PV move on top
            const c = rootCnt.get(rootMoves[i]);
            if (c !== undefined) scores[i] = c > 1899000000 ? 1899000000 : 1000000 + c;
          }
        }
        const cnt = new Map();
        let aborted = false;

        for (let i = 0; i < rootMoves.length; i++) {
          const m = this.pickMove(rootMoves, scores, i);
          const n0 = this.nodes;
          this.makeNN(m);
          let score;
          try {
            if (i === 0) score = -this.search(depth - 1, -beta, -a, 1, true);
            else {
              score = -this.search(depth - 1, -a - 1, -a, 1, true);
              if (score > a && score < beta) score = -this.search(depth - 1, -beta, -a, 1, true);
            }
          } catch (e) {
            this.unmakeNN();
            if (e instanceof AbortSearch) { aborted = true; break; }
            throw e;
          }
          this.unmakeNN();
          cnt.set(m, this.nodes - n0);
          if (score > a || i === 0) {
            a = Math.max(a, score);
            const pv = [m];
            for (let j = 0; j < this.pvLen[1]; j++) pv.push(this.pvTable[1][j]);
            iterBest = { move: m, score, pv, depth };
          }
          if (a >= beta) break;
        }

        if (aborted) {
          // keep result from last fully searched iteration
          return best.depth > 0 ? best : (iterBest || best);
        }
        if (iterBest && iterBest.score <= alpha && alpha > -INF) { alpha = Math.max(-INF, alpha - 150); continue; }
        if (iterBest && iterBest.score >= beta && beta < INF) { beta = Math.min(INF, beta + 150); continue; }
        rootCnt = cnt;
        break;
      }

      if (iterBest) {
        best = iterBest;
        prevScore = iterBest.score;
        if (onInfo) onInfo({
          depth, multipv: (multipvIdx || 0) + 1,
          score: iterBest.score, pv: iterBest.pv.map(m2 => this.uciOf(m2, iterBest.pv)),
          pvMoves: iterBest.pv.slice(),
          nodes: this.nodes,
        });
      }
      // stop early if a forced mate is found and confirmed a couple plies deep
      if (Math.abs(best.score) > MATE_BOUND && depth >= 6) break;
      if (Date.now() > this.softDeadline) break;
    }
    return best;
  }

  uciOf(m) {
    let s = SC.sqToAlg(mFrom(m)) + SC.sqToAlg(mTo(m));
    if (mPromo(m)) s += SC.PIECE_LETTER[mPromo(m)];
    return s;
  }

  /*
   * opts: { depth, movetime, multipv, level, useBook, onInfo }
   * returns { bestmove(uci|null), score, mate, pv, lines:[{...}] }
   */
  go(opts) {
    const o = opts || {};
    this.stopFlag = false;
    this.nodes = 0;
    const movetime = o.movetime || 0;
    const maxDepth = Math.min(o.depth || 64, MAX_PLY - 8);
    const now = Date.now();
    this.deadline = movetime ? now + movetime : Infinity;
    this.softDeadline = movetime ? now + movetime * 0.6 : Infinity;
    this.age = (this.age + 1) & 255;
    this.killer1.fill(0); this.killer2.fill(0);
    for (let k = 0; k < this.history.length; k++) this.history[k] = (this.history[k] / 8) | 0;

    // opening book
    if (o.useBook && BOOK) {
      const key = this.pos.fenKey();
      const entries = BOOK[key];
      if (entries && entries.length) {
        let total = 0;
        for (const e of entries) total += e[1];
        let r = this.rnd() * total;
        let choice = entries[0][0];
        for (const e of entries) { r -= e[1]; if (r <= 0) { choice = e[0]; break; } }
        if (this.pos.moveFromUci(choice)) {
          return { bestmove: choice, score: 0, mate: null, pv: [choice], lines: [], book: true };
        }
      }
    }

    this.refreshAcc();

    // weak levels: shallow full-width root scoring + noisy pick
    if (o.level && o.level <= 4) return this.goWeak(o);

    const multipv = Math.max(1, Math.min(o.multipv || 1, 5));
    const excluded = new Set();
    const lines = [];
    let first = null;
    for (let k = 0; k < multipv; k++) {
      if (movetime) {
        // split the remaining time budget across the remaining PV lines
        const remaining = this.deadline - Date.now();
        if (remaining <= 0 && k > 0) break;
        this.softDeadline = Date.now() + Math.max(50, remaining / (multipv - k)) * 0.6;
      }
      const res = this.searchRoot(maxDepth, excluded, o.onInfo, k);
      if (!res) break;
      lines.push(res);
      excluded.add(res.move);
      if (k === 0) first = res;
    }
    if (!first) return { bestmove: null, score: 0, mate: null, pv: [], lines: [] };

    const mate = Math.abs(first.score) > MATE_BOUND ? Math.sign(first.score) * (MATE - Math.abs(first.score) + 1 >> 1) : null;
    return {
      bestmove: this.uciOf(first.move),
      score: first.score,
      mate,
      pv: first.pv.map(m => this.uciOf(m)),
      lines: lines.map(l => ({
        move: this.uciOf(l.move), score: l.score,
        mate: Math.abs(l.score) > MATE_BOUND ? Math.sign(l.score) * (MATE - Math.abs(l.score) + 1 >> 1) : null,
        pv: l.pv.map(m => this.uciOf(m)), depth: l.depth,
      })),
      nodes: this.nodes,
    };
  }

  // shallow search with score noise → human-ish weak play
  goWeak(o) {
    const level = o.level;
    const depth = level;                     // 1..4
    const noise = [0, 320, 190, 100, 45][level] || 45;
    const pos = this.pos;
    const rootMoves = pos.legalMoves();
    if (rootMoves.length === 0) return { bestmove: null, score: 0, mate: null, pv: [], lines: [] };
    this.deadline = Date.now() + 4000;
    this.softDeadline = Infinity;

    const scored = [];
    for (const m of rootMoves) {
      this.makeNN(m);
      let s;
      try { s = -this.search(depth - 1, -INF, INF, 1, true); }
      catch (e) { if (e instanceof AbortSearch) { this.unmakeNN(); break; } this.unmakeNN(); throw e; }
      this.unmakeNN();
      scored.push({ m, s: s + (this.rnd() * 2 - 1) * noise });
    }
    scored.sort((a, b2) => b2.s - a.s);
    const pick = scored[0];
    return {
      bestmove: this.uciOf(pick.m), score: Math.round(pick.s), mate: null,
      pv: [this.uciOf(pick.m)], lines: [], nodes: this.nodes,
    };
  }

  stop() { this.stopFlag = true; }
}

// ================================================================ opening book
// built from well-known theory lines at load time
const BOOK_LINES = [
  // Italian / Giuoco Piano
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 a4 Ba7 h3 h6',
  'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 c3 d6 O-O a6 Re1 Ba7 Bb3 O-O h3 h6',
  // Two Knights
  'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2 h6 Nf3 e4 Ne5 Bd6',
  // Ruy Lopez main
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7',
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O a4 Bb7 d3 d6 Nbd2 Na5',
  // Berlin
  'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8 h3 Ke8 Nc3 h5',
  // Petroff
  'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Bd6 O-O O-O c4 c6 Nc3 Nxc3 bxc3 dxc4 Bxc4 Bf5',
  // Scotch
  'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6 b3 g6',
  // Sicilian Najdorf
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O Be3 Be6 Qd2 Nbd7',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7',
  // Sicilian Dragon
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 Bc4 Bd7 O-O-O Rc8',
  // Sicilian Sveshnikov
  'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5 Nd5 Be7 Bxf6 Bxf6',
  // Sicilian Taimanov / Kan
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Qd2 Nf6 O-O-O Bb4 f3 Ne5',
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Bc5 Nb3 Ba7 O-O Nc6 Qe2 d6 Be3 Nf6',
  // Alapin
  'e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6 Bc4 Nb6 Bb5 dxe5 Nxe5 Bd7',
  // French
  'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7 Qxg7 Rg8 Qxh7 cxd4 Ne2 Nbc6',
  'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7 f4 O-O Nf3 c5 Qd2 Nc6',
  'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2 cxd4 cxd4 f6 exf6 Nxf6 O-O Bd6',
  // Caro-Kann
  'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6',
  'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 Nd7 O-O Bg6 Nbd2 Nh6 Nb3 Nf5 a4 Be7',
  'e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Bb4 cxd5 Nxd5 Bd2 Nc6 Bd3 Be7',
  // Pirc / Modern
  'e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6 Qxh6 Bb7',
  // Scandinavian
  'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Qe2 Bb4 O-O-O Nbd7',
  // QGD
  'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 Be2 Bb7 Bxf6 Bxf6 cxd5 exd5 O-O',
  'd4 d5 c4 e6 Nc3 Be7 cxd5 exd5 Bf4 c6 e3 Bf5 Qb3 Qb6 Nf3 Ne7 Be2 Nd7',
  'd4 Nf6 c4 e6 Nf3 d5 Nc3 Be7 Bg5 h6 Bh4 O-O e3 b6 Be2 Bb7 Bxf6 Bxf6 cxd5 exd5',
  // QGA
  'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6 dxc5 Bxc5 Qxd8+ Kxd8 Nbd2 Ke7',
  // Slav
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4 O-O Nbd7 Qe2 Bg6 e4 O-O',
  'd4 d5 c4 c6 Nf3 Nf6 e3 Bf5 Nc3 e6 Nh4 Bg6 Nxg6 hxg6 Bd3 Nbd7 O-O Bd6',
  // Semi-Slav Meran
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 Bb7 O-O a6 e4 c5',
  // Nimzo-Indian
  'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O cxd4 exd4 dxc4 Bxc4 b6 Bg5 Bb7',
  'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6 Bg5 Bb7 f3 h6 Bh4 d5',
  // Queen's Indian
  'd4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7 Bg2 c6 Bc3 d5 Ne5 Nfd7 Nxd7 Nxd7',
  // King's Indian
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7 Ne1 Nd7 Be3 f5 f3 f4',
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5 Qd2 f5 O-O-O Nd7',
  // Grünfeld
  'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5 Rb1 O-O Be2 cxd4 cxd4 Qa5+',
  // Catalan
  'd4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6 Qxc4 b5 Qc2 Bb7 Bd2 Be4',
  // London
  'd4 d5 Bf4 Nf6 e3 c5 Nf3 Nc6 Nbd2 e6 c3 Bd6 Bg3 O-O Bd3 b6 e4 Be7',
  'd4 Nf6 Bf4 g6 Nc3 d5 e3 Bg7 h4 c5 dxc5 Qa5 Nf3 Ne4 Qd4 Nxc3 Qxc3? Qxc3+',
  // Trompowsky
  'd4 Nf6 Bg5 Ne4 Bf4 c5 f3 Qa5+ c3 Nf6 d5 Qb6 Bc1 e6 c4 exd5 cxd5 c4',
  // English
  'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 d3 O-O Be3 f5',
  'c4 c5 Nf3 Nf6 d4 cxd4 Nxd4 e6 g3 Qc7 Nc3 a6 Bg2 Nc6 O-O Bc5 Nb3 Be7',
  'c4 Nf6 Nc3 e5 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 a3 O-O b4 Be6',
  // Reti
  'Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O Nbd2 c5 e4 Nc6 Re1 b5 exd5 exd5',
  'Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O d3 d6 e4 e5 Nc3 Nc6 h3 h6',
  // Dutch
  'd4 f5 g3 Nf6 Bg2 e6 Nf3 Be7 O-O O-O c4 d6 Nc3 Qe8 Re1 Qg6 e4 fxe4 Nxe4 Nxe4 Rxe4',
  // Benoni / Benko
  'd4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7 h3 O-O Bd3 b5 Bxb5 Nxe4',
  'd4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 g6 Nc3 Bxa6 g3 d6 Bg2 Bg7 Nf3 Nbd7',
];

let BOOK = null;
function buildBook() {
  BOOK = Object.create(null);
  const pos = new SC.Position();
  for (const line of BOOK_LINES) {
    pos.load(SC.START_FEN);
    const sans = line.split(/\s+/);
    let ok = true;
    for (const sanTok of sans) {
      if (!/^[a-hRNBQKO]/.test(sanTok) || /[?]/.test(sanTok)) { ok = false; break; }
      const key = pos.fenKey();
      const m = pos.moveFromSan(sanTok);
      if (!m) { ok = false; break; }
      const uci = pos.moveToUci(m);
      let entries = BOOK[key];
      if (!entries) entries = BOOK[key] = [];
      const found = entries.find(e => e[0] === uci);
      if (found) found[1]++; else entries.push([uci, 1]);
      pos.make(m);
    }
  }
}
buildBook();

const EngineAPI = { Engine, evaluate, nnueEval: p2 => NN ? nnueEval(p2) : null, hasNNUE: () => !!NN, AbortSearch, getBook: () => BOOK };
if (typeof module !== 'undefined' && module.exports) module.exports = EngineAPI;
global.SigmaEngine = EngineAPI;

// ================================================================ worker glue
if (typeof importScripts === 'function' && typeof postMessage === 'function') {
  const engine = new Engine();
  let busy = false;
  let stopRequested = false;
  let pending = null;
  let pendingOpts = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function applyOpts(data) {
    if (data.hashMb) engine.resizeTT(data.hashMb);
    postMessage({ type: 'ready', id: data.id });
  }

  async function runGo(payload) {
    busy = true;
    stopRequested = false;
    const id = payload.id;
    const cpu = Math.max(25, Math.min(100, payload.cpu || 100));
    const isWeak = payload.level && payload.level <= 4;
    const infinite = !payload.movetime && !isWeak;

    // suppress out-of-order info lines when the sliced search restarts iterations
    const maxDepthSeen = Object.create(null);
    const onInfo = info => {
      const k = info.multipv || 1;
      if (info.depth >= (maxDepthSeen[k] || 0)) {
        maxDepthSeen[k] = info.depth;
        postMessage({ type: 'info', id, ...info });
      }
    };

    let result = null;
    try {
      if (isWeak || (!infinite && cpu >= 100)) {
        // single-shot search
        result = engine.go({ ...payload, onInfo });
      } else {
        /*
         * sliced search: run bounded work slices; the transposition table
         * carries progress across slices, and yielding between slices lets
         * "stop" / new "go" messages through. cpu<100 sleeps between slices
         * (duty cycle): %50 → half the CPU, same depth in twice the time.
         */
        const sliceMs = infinite ? 600 : 200;
        const maxDepth = payload.depth || 64;
        let workLeft = infinite ? Infinity : payload.movetime;
        let firstBook = payload.useBook;
        let bestDepth = -1;
        const wallCap = Date.now() + 15 * 60 * 1000; // yetim kalmış sonsuz arama emniyeti
        while (!stopRequested && workLeft > 0 && Date.now() < wallCap) {
          const w = Math.min(sliceMs, workLeft);
          const r = engine.go({ ...payload, useBook: firstBook, movetime: w, depth: maxDepth, onInfo });
          firstBook = false;
          const dReached = r && r.lines && r.lines[0] ? r.lines[0].depth : 0;
          // kesilen son dilim daha sığ kalabilir — yalnızca daha derin sonucu benimse
          if (r && r.bestmove && dReached >= bestDepth) { result = r; bestDepth = dReached; }
          if (r && r.book) break;                                    // opening book hit
          workLeft -= w;
          if (dReached >= maxDepth) break;                           // depth cap reached
          if (r && r.mate != null && !infinite) break;               // forced mate found
          if (cpu < 100) await sleep(Math.max(10, (w * (100 - cpu)) / cpu));
          else await sleep(0);                                       // let messages in
        }
      }
    } catch (e) {
      result = { bestmove: null, error: String((e && e.message) || e) };
    }
    busy = false;
    postMessage({ type: 'bestmove', id, ...(result || { bestmove: null, pv: [], lines: [] }) });
    if (pendingOpts) { const o = pendingOpts; pendingOpts = null; applyOpts(o); }
    if (pending) { const p = pending; pending = null; handle(p); }
  }

  function handle(data) {
    switch (data.cmd) {
      case 'position':
        if (busy) { stopRequested = true; engine.stop(); pending = data; return; }
        engine.setPosition(data.fen, data.moves);
        postMessage({ type: 'ready', id: data.id });
        break;
      case 'go':
        if (busy) { stopRequested = true; engine.stop(); pending = data; return; }
        if (data.fen !== undefined) engine.setPosition(data.fen, data.moves);
        runGo(data);
        break;
      case 'stop':
        stopRequested = true;
        engine.stop();
        pending = null;
        break;
      case 'setoption':
        if (busy) { pendingOpts = data; return; } // arama bitince uygula
        applyOpts(data);
        break;
      case 'newgame':
        engine.clearTables();
        postMessage({ type: 'ready', id: data.id });
        break;
    }
  }

  onmessage = e => handle(e.data);
  postMessage({ type: 'boot', bookKeys: Object.keys(BOOK) });
}

})(typeof self !== 'undefined' ? self : globalThis);

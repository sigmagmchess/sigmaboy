/*
 * SigmaBoy chess rules library (0x88 board representation)
 * Works in browser (window.SC), Web Worker (self.SC) and Node (module.exports).
 */
(function (global) {
'use strict';

// ---------------------------------------------------------------- constants
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 1, BLACK = -1;

const CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;

// move flag bits (above bit 22)
const F_EP = 1 << 23, F_CASTLE = 1 << 24, F_DOUBLE = 1 << 25;

const KNIGHT_D = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_D = [-17, -15, 15, 17];
const ROOK_D   = [-16, -1, 1, 16];
const KING_D   = [-17, -16, -15, -1, 1, 15, 16, 17];

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_LETTER = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

// castling-rights update masks, indexed by square
const CAST_MASK = new Uint8Array(128).fill(15);
CAST_MASK[116] = 15 & ~(CR_WK | CR_WQ); // e1
CAST_MASK[112] = 15 & ~CR_WQ;           // a1
CAST_MASK[119] = 15 & ~CR_WK;           // h1
CAST_MASK[4]   = 15 & ~(CR_BK | CR_BQ); // e8
CAST_MASK[0]   = 15 & ~CR_BQ;           // a8
CAST_MASK[7]   = 15 & ~CR_BK;           // h8

// ---------------------------------------------------------------- zobrist
// deterministic xorshift PRNG so hashes are stable across sessions
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}
const rngLo = makeRng(0x9e3779b9), rngHi = makeRng(0x7f4a7c15);
const Z_PIECE_LO = [], Z_PIECE_HI = [];
for (let p = 0; p < 12; p++) {
  Z_PIECE_LO.push(new Int32Array(128));
  Z_PIECE_HI.push(new Int32Array(128));
  for (let s = 0; s < 128; s++) { Z_PIECE_LO[p][s] = rngLo() | 0; Z_PIECE_HI[p][s] = rngHi() | 0; }
}
const Z_SIDE_LO = rngLo() | 0, Z_SIDE_HI = rngHi() | 0;
const Z_CAST_LO = new Int32Array(16), Z_CAST_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { Z_CAST_LO[i] = rngLo() | 0; Z_CAST_HI[i] = rngHi() | 0; }
const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rngLo() | 0; Z_EP_HI[i] = rngHi() | 0; }

function zPieceIndex(signedPiece) {
  // white piece types map to 0..5, black to 6..11
  return signedPiece > 0 ? signedPiece - 1 : 5 - signedPiece; // -1 -> 6, -6 -> 11
}

// ---------------------------------------------------------------- helpers
function sqToAlg(sq) {
  return String.fromCharCode(97 + (sq & 15)) + (8 - (sq >> 4));
}
function algToSq(str) {
  return (8 - (str.charCodeAt(1) - 48)) * 16 + (str.charCodeAt(0) - 97);
}
function encodeMove(from, to, piece, capt, promo, flags) {
  return from | (to << 7) | (piece << 14) | (capt << 17) | (promo << 20) | flags;
}
const mFrom  = m => m & 127;
const mTo    = m => (m >> 7) & 127;
const mPiece = m => (m >> 14) & 7;
const mCapt  = m => (m >> 17) & 7;
const mPromo = m => (m >> 20) & 7;
const mIsEp     = m => (m & F_EP) !== 0;
const mIsCastle = m => (m & F_CASTLE) !== 0;
const mIsCapture = m => ((m >> 17) & 7) !== 0 || (m & F_EP) !== 0;

// ---------------------------------------------------------------- Position
class Position {
  constructor(fen) {
    this.board = new Int8Array(128);
    this.load(fen || START_FEN);
  }

  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board.fill(0);
    this.kings = [-1, -1]; // [white, black]
    let sq = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { sq = (sq & ~15) + 16; continue; }
      if (ch >= '1' && ch <= '8') { sq += ch.charCodeAt(0) - 48; continue; }
      const lower = ch.toLowerCase();
      const type = PIECE_LETTER.indexOf(lower);
      const color = ch === lower ? BLACK : WHITE;
      this.board[sq] = type * color;
      if (type === KING) this.kings[color === WHITE ? 0 : 1] = sq;
      sq++;
    }
    this.side = (parts[1] || 'w') === 'w' ? WHITE : BLACK;
    this.castling = 0;
    const cr = parts[2] || '-';
    if (cr.indexOf('K') >= 0) this.castling |= CR_WK;
    if (cr.indexOf('Q') >= 0) this.castling |= CR_WQ;
    if (cr.indexOf('k') >= 0) this.castling |= CR_BK;
    if (cr.indexOf('q') >= 0) this.castling |= CR_BQ;
    this.ep = (parts[3] && parts[3] !== '-') ? algToSq(parts[3]) : -1;
    this.halfmove = parseInt(parts[4] || '0', 10) || 0;
    this.fullmove = parseInt(parts[5] || '1', 10) || 1;
    // undo stacks
    this.usCast = []; this.usEp = []; this.usHalf = [];
    this.usLo = []; this.usHi = []; this.usMove = [];
    this.computeHash();
    return this;
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p) { const zi = zPieceIndex(p); lo ^= Z_PIECE_LO[zi][sq]; hi ^= Z_PIECE_HI[zi][sq]; }
    }
    if (this.side === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
    lo ^= Z_CAST_LO[this.castling]; hi ^= Z_CAST_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    this.hashLo = lo | 0; this.hashHi = hi | 0;
  }

  fen() {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        const letter = PIECE_LETTER[Math.abs(p)];
        out += p > 0 ? letter.toUpperCase() : letter;
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    out += this.side === WHITE ? ' w ' : ' b ';
    let cr = '';
    if (this.castling & CR_WK) cr += 'K';
    if (this.castling & CR_WQ) cr += 'Q';
    if (this.castling & CR_BK) cr += 'k';
    if (this.castling & CR_BQ) cr += 'q';
    out += (cr || '-') + ' ';
    out += this.ep >= 0 ? sqToAlg(this.ep) : '-';
    out += ' ' + this.halfmove + ' ' + this.fullmove;
    return out;
  }

  // first four FEN fields — used as repetition / book key
  fenKey() {
    const f = this.fen().split(' ');
    return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3];
  }

  clone() { return new Position(this.fen()); }

  // is `sq` attacked by side `by`?
  isAttacked(sq, by) {
    const b = this.board;
    if (by === WHITE) {
      if (b[sq + 15] === PAWN || b[sq + 17] === PAWN) return true;
    } else {
      if (b[sq - 15] === -PAWN || b[sq - 17] === -PAWN) return true;
    }
    const n = KNIGHT * by, k = KING * by;
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_D[i];
      if (!(t & 0x88) && b[t] === n) return true;
    }
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_D[i];
      if (!(t & 0x88) && b[t] === k) return true;
    }
    const bp = BISHOP * by, qp = QUEEN * by, rp = ROOK * by;
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_D[i];
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (p) { if (p === bp || p === qp) return true; break; }
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_D[i];
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (p) { if (p === rp || p === qp) return true; break; }
      }
    }
    return false;
  }

  inCheck(side) {
    side = side || this.side;
    return this.isAttacked(this.kings[side === WHITE ? 0 : 1], -side);
  }

  // after make(): did the side that just moved leave its king attacked?
  illegalAfterMove() {
    const mover = -this.side;
    return this.isAttacked(this.kings[mover === WHITE ? 0 : 1], this.side);
  }

  // pseudo-legal move generation. capsOnly => captures + promotions (quiescence)
  genMoves(capsOnly) {
    const moves = [];
    const b = this.board, us = this.side, them = -us;
    const dir = us === WHITE ? -16 : 16;
    const startRank = us === WHITE ? 6 : 1;
    const promoRank = us === WHITE ? 0 : 7;

    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (p === 0 || (p > 0) !== (us > 0)) continue;
      const type = p * us; // abs

      if (type === PAWN) {
        const fwd = sq + dir;
        if (!b[fwd]) {
          if ((fwd >> 4) === promoRank) {
            moves.push(encodeMove(sq, fwd, PAWN, 0, QUEEN, 0));
            if (!capsOnly) {
              moves.push(encodeMove(sq, fwd, PAWN, 0, ROOK, 0));
              moves.push(encodeMove(sq, fwd, PAWN, 0, BISHOP, 0));
              moves.push(encodeMove(sq, fwd, PAWN, 0, KNIGHT, 0));
            }
          } else if (!capsOnly) {
            moves.push(encodeMove(sq, fwd, PAWN, 0, 0, 0));
            if ((sq >> 4) === startRank && !b[fwd + dir])
              moves.push(encodeMove(sq, fwd + dir, PAWN, 0, 0, F_DOUBLE));
          }
        }
        for (let side2 = -1; side2 <= 1; side2 += 2) {
          const to = sq + dir + side2;
          if (to & 0x88) continue;
          const tp = b[to];
          if (tp && (tp > 0) === (them > 0)) {
            const capt = tp * them;
            if ((to >> 4) === promoRank) {
              moves.push(encodeMove(sq, to, PAWN, capt, QUEEN, 0));
              moves.push(encodeMove(sq, to, PAWN, capt, ROOK, 0));
              moves.push(encodeMove(sq, to, PAWN, capt, BISHOP, 0));
              moves.push(encodeMove(sq, to, PAWN, capt, KNIGHT, 0));
            } else {
              moves.push(encodeMove(sq, to, PAWN, capt, 0, 0));
            }
          } else if (to === this.ep && this.ep >= 0) {
            moves.push(encodeMove(sq, to, PAWN, PAWN, 0, F_EP));
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const deltas = type === KNIGHT ? KNIGHT_D : KING_D;
        for (let i = 0; i < 8; i++) {
          const to = sq + deltas[i];
          if (to & 0x88) continue;
          const tp = b[to];
          if (tp === 0) { if (!capsOnly) moves.push(encodeMove(sq, to, type, 0, 0, 0)); }
          else if ((tp > 0) === (them > 0)) moves.push(encodeMove(sq, to, type, tp * them, 0, 0));
        }
        continue;
      }

      // sliders
      const dirs = type === BISHOP ? BISHOP_D : type === ROOK ? ROOK_D : KING_D;
      const nd = type === QUEEN ? 8 : 4;
      for (let i = 0; i < nd; i++) {
        const d = dirs[i];
        for (let to = sq + d; !(to & 0x88); to += d) {
          const tp = b[to];
          if (tp === 0) { if (!capsOnly) moves.push(encodeMove(sq, to, type, 0, 0, 0)); continue; }
          if ((tp > 0) === (them > 0)) moves.push(encodeMove(sq, to, type, tp * them, 0, 0));
          break;
        }
      }
    }

    // castling
    if (!capsOnly) {
      if (us === WHITE) {
        if ((this.castling & CR_WK) && !b[117] && !b[118] &&
            !this.isAttacked(116, BLACK) && !this.isAttacked(117, BLACK) && !this.isAttacked(118, BLACK))
          moves.push(encodeMove(116, 118, KING, 0, 0, F_CASTLE));
        if ((this.castling & CR_WQ) && !b[115] && !b[114] && !b[113] &&
            !this.isAttacked(116, BLACK) && !this.isAttacked(115, BLACK) && !this.isAttacked(114, BLACK))
          moves.push(encodeMove(116, 114, KING, 0, 0, F_CASTLE));
      } else {
        if ((this.castling & CR_BK) && !b[5] && !b[6] &&
            !this.isAttacked(4, WHITE) && !this.isAttacked(5, WHITE) && !this.isAttacked(6, WHITE))
          moves.push(encodeMove(4, 6, KING, 0, 0, F_CASTLE));
        if ((this.castling & CR_BQ) && !b[3] && !b[2] && !b[1] &&
            !this.isAttacked(4, WHITE) && !this.isAttacked(3, WHITE) && !this.isAttacked(2, WHITE))
          moves.push(encodeMove(4, 2, KING, 0, 0, F_CASTLE));
      }
    }
    return moves;
  }

  legalMoves() {
    const out = [];
    const pseudo = this.genMoves(false);
    for (let i = 0; i < pseudo.length; i++) {
      this.make(pseudo[i]);
      if (!this.illegalAfterMove()) out.push(pseudo[i]);
      this.unmake();
    }
    return out;
  }

  make(m) {
    const us = this.side, them = -us;
    const from = m & 127, to = (m >> 7) & 127;
    const piece = (m >> 14) & 7, capt = (m >> 17) & 7, promo = (m >> 20) & 7;
    const b = this.board;

    this.usCast.push(this.castling); this.usEp.push(this.ep);
    this.usHalf.push(this.halfmove); this.usLo.push(this.hashLo); this.usHi.push(this.hashHi);
    this.usMove.push(m);

    let lo = this.hashLo, hi = this.hashHi;
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }

    // remove moving piece from origin
    let zi = zPieceIndex(piece * us);
    b[from] = 0; lo ^= Z_PIECE_LO[zi][from]; hi ^= Z_PIECE_HI[zi][from];

    // remove captured piece
    if (m & F_EP) {
      const capSq = to + (us === WHITE ? 16 : -16);
      b[capSq] = 0;
      const czi = zPieceIndex(PAWN * them);
      lo ^= Z_PIECE_LO[czi][capSq]; hi ^= Z_PIECE_HI[czi][capSq];
    } else if (capt) {
      const czi = zPieceIndex(capt * them);
      lo ^= Z_PIECE_LO[czi][to]; hi ^= Z_PIECE_HI[czi][to];
    }

    // place piece (or promotion) at destination
    const placed = (promo || piece) * us;
    b[to] = placed;
    zi = zPieceIndex(placed);
    lo ^= Z_PIECE_LO[zi][to]; hi ^= Z_PIECE_HI[zi][to];

    if (piece === KING) {
      this.kings[us === WHITE ? 0 : 1] = to;
      if (m & F_CASTLE) {
        let rFrom, rTo;
        if ((to & 7) === 6) { rFrom = to + 1; rTo = to - 1; } // king side
        else { rFrom = to - 2; rTo = to + 1; }                 // queen side
        const rzi = zPieceIndex(ROOK * us);
        b[rTo] = ROOK * us; b[rFrom] = 0;
        lo ^= Z_PIECE_LO[rzi][rFrom] ^ Z_PIECE_LO[rzi][rTo];
        hi ^= Z_PIECE_HI[rzi][rFrom] ^ Z_PIECE_HI[rzi][rTo];
      }
    }

    // castling rights
    lo ^= Z_CAST_LO[this.castling]; hi ^= Z_CAST_HI[this.castling];
    this.castling &= CAST_MASK[from] & CAST_MASK[to];
    lo ^= Z_CAST_LO[this.castling]; hi ^= Z_CAST_HI[this.castling];

    // en passant square
    if (m & F_DOUBLE) {
      this.ep = (from + to) >> 1;
      lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7];
    } else {
      this.ep = -1;
    }

    this.halfmove = (piece === PAWN || capt) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.side = them;
    lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI;
    this.hashLo = lo | 0; this.hashHi = hi | 0;
  }

  unmake() {
    const m = this.usMove.pop();
    const them = this.side, us = -them;
    const from = m & 127, to = (m >> 7) & 127;
    const piece = (m >> 14) & 7, capt = (m >> 17) & 7;
    const b = this.board;

    b[from] = piece * us;
    if (m & F_EP) {
      b[to] = 0;
      b[to + (us === WHITE ? 16 : -16)] = PAWN * them;
    } else {
      b[to] = capt ? capt * them : 0;
    }

    if (piece === KING) {
      this.kings[us === WHITE ? 0 : 1] = from;
      if (m & F_CASTLE) {
        if ((to & 7) === 6) { b[to + 1] = ROOK * us; b[to - 1] = 0; }
        else { b[to - 2] = ROOK * us; b[to + 1] = 0; }
      }
    }

    this.castling = this.usCast.pop();
    this.ep = this.usEp.pop();
    this.halfmove = this.usHalf.pop();
    this.hashLo = this.usLo.pop();
    this.hashHi = this.usHi.pop();
    if (us === BLACK) this.fullmove--;
    this.side = us;
  }

  makeNull() {
    this.usCast.push(this.castling); this.usEp.push(this.ep);
    this.usHalf.push(this.halfmove); this.usLo.push(this.hashLo); this.usHi.push(this.hashHi);
    this.usMove.push(0);
    let lo = this.hashLo, hi = this.hashHi;
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    this.ep = -1;
    this.side = -this.side;
    this.halfmove++;
    lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI;
    this.hashLo = lo | 0; this.hashHi = hi | 0;
  }

  unmakeNull() {
    this.usMove.pop();
    this.castling = this.usCast.pop();
    this.ep = this.usEp.pop();
    this.halfmove = this.usHalf.pop();
    this.hashLo = this.usLo.pop();
    this.hashHi = this.usHi.pop();
    this.side = -this.side;
  }

  // number of previous occurrences of the current position (same side to move)
  repetitionCount() {
    let count = 0;
    const n = this.usLo.length;
    const limit = Math.min(this.halfmove, n);
    for (let i = 2; i <= limit; i += 2) {
      if (this.usLo[n - i] === this.hashLo && this.usHi[n - i] === this.hashHi) count++;
    }
    return count;
  }

  hasNonPawnMaterial(side) {
    const b = this.board;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq] * side;
      if (p >= KNIGHT && p <= QUEEN) return true;
    }
    return false;
  }

  insufficientMaterial() {
    let minors = 0, bishopsColor = -1, sameColorBishops = true, other = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const t = Math.abs(this.board[sq]);
      if (t === 0 || t === KING) continue;
      if (t === KNIGHT) minors++;
      else if (t === BISHOP) {
        minors++;
        const col = ((sq >> 4) + (sq & 7)) & 1;
        if (bishopsColor === -1) bishopsColor = col;
        else if (bishopsColor !== col) sameColorBishops = false;
      } else other++;
    }
    if (other > 0) return false;
    if (minors <= 1) return true;
    // only bishops, all on the same color complex
    let knightCount = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (Math.abs(this.board[sq]) === KNIGHT) knightCount++;
    }
    return knightCount === 0 && sameColorBishops;
  }

  // 'playing' | 'checkmate' | 'stalemate' | 'fifty' | 'threefold' | 'material'
  gameStatus() {
    if (this.legalMoves().length === 0)
      return this.inCheck() ? 'checkmate' : 'stalemate';
    if (this.halfmove >= 100) return 'fifty';
    if (this.repetitionCount() >= 2) return 'threefold';
    if (this.insufficientMaterial()) return 'material';
    return 'playing';
  }

  // ------------------------------------------------------------- notation
  moveToUci(m) {
    let s = sqToAlg(mFrom(m)) + sqToAlg(mTo(m));
    if (mPromo(m)) s += PIECE_LETTER[mPromo(m)];
    return s;
  }

  moveFromUci(uci) {
    const legal = this.legalMoves();
    for (const m of legal) if (this.moveToUci(m) === uci) return m;
    return 0;
  }

  san(m) {
    const piece = mPiece(m), from = mFrom(m), to = mTo(m);
    let s;
    if (mIsCastle(m)) {
      s = (to & 7) === 6 ? 'O-O' : 'O-O-O';
    } else {
      s = '';
      if (piece !== PAWN) {
        s += PIECE_LETTER[piece].toUpperCase();
        // disambiguation
        let sameFile = false, sameRank = false, others = false;
        for (const o of this.legalMoves()) {
          if (o === m || mPiece(o) !== piece || mTo(o) !== to) continue;
          others = true;
          if ((mFrom(o) & 7) === (from & 7)) sameFile = true;
          if ((mFrom(o) >> 4) === (from >> 4)) sameRank = true;
        }
        if (others) {
          if (!sameFile) s += String.fromCharCode(97 + (from & 7));
          else if (!sameRank) s += String(8 - (from >> 4));
          else s += sqToAlg(from);
        }
      } else if (mIsCapture(m)) {
        s += String.fromCharCode(97 + (from & 7));
      }
      if (mIsCapture(m)) s += 'x';
      s += sqToAlg(to);
      if (mPromo(m)) s += '=' + PIECE_LETTER[mPromo(m)].toUpperCase();
    }
    this.make(m);
    if (this.inCheck()) s += this.legalMoves().length === 0 ? '#' : '+';
    this.unmake();
    return s;
  }

  moveFromSan(san) {
    const clean = san.replace(/[+#!?]+$/g, '').replace(/0/g, 'O');
    const legal = this.legalMoves();
    for (const m of legal) {
      const s = this.san(m).replace(/[+#]+$/g, '');
      if (s === clean) return m;
    }
    // lenient retry: strip x, = and compare
    const norm = t => t.replace(/[x=+#!?]/g, '');
    for (const m of legal) {
      if (norm(this.san(m)) === norm(clean)) return m;
    }
    return 0;
  }
}

// ---------------------------------------------------------------- PGN
function pgnStripped(pgn) {
  // remove comments, variations, NAGs and headers
  let s = pgn.replace(/\r/g, '');
  s = s.replace(/^\s*\[[^\]]*\]\s*$/gm, ' ');
  s = s.replace(/\{[^}]*\}/g, ' ');
  let depth = 0, out = '';
  for (const ch of s) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (depth === 0) out += ch;
  }
  out = out.replace(/\$\d+/g, ' ');
  return out;
}

function parsePgnMoves(pgn) {
  const text = pgnStripped(pgn);
  const tokens = text.split(/\s+/).filter(Boolean);
  const sans = [];
  for (const t of tokens) {
    if (/^\d+\.+$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
    const clean = t.replace(/^\d+\.+/, '');
    if (clean) sans.push(clean);
  }
  return sans;
}

function pgnHeaders(pgn) {
  const headers = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]/gm;
  let m;
  while ((m = re.exec(pgn)) !== null) headers[m[1]] = m[2];
  return headers;
}

// ---------------------------------------------------------------- perft
function perft(pos, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  const moves = pos.genMoves(false);
  for (let i = 0; i < moves.length; i++) {
    pos.make(moves[i]);
    if (!pos.illegalAfterMove()) nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmake();
  }
  return nodes;
}

const SC = {
  EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  CR_WK, CR_WQ, CR_BK, CR_BQ, F_EP, F_CASTLE, F_DOUBLE,
  START_FEN, PIECE_LETTER,
  Position, perft,
  sqToAlg, algToSq, encodeMove,
  mFrom, mTo, mPiece, mCapt, mPromo, mIsEp, mIsCastle, mIsCapture,
  parsePgnMoves, pgnHeaders,
};

if (typeof module !== 'undefined' && module.exports) module.exports = SC;
global.SC = SC;

})(typeof self !== 'undefined' ? self : globalThis);

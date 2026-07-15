/*
 * VEGA 2 — bitboard C++ UCI chess engine (magic bitboards)
 *
 * Same search as vega.cpp (PVS, TT, null-move, LMR/LMP, SEE, qsearch-TT,
 * killer/countermove/history, IID, root subtree ordering) on a bitboard
 * board representation: precomputed knight/king/pawn attacks, runtime-
 * generated magic tables for sliders, popcount mobility, mask-based
 * pawn structure and king safety.
 *
 * Build:  g++ -O2 -std=c++17 -o vega2 vega2.cpp
 * Usage:  UCI; extra commands: "perft N", "bench"
 */
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <string>
#include <vector>
#include <sstream>
#include <iostream>
#include <chrono>
#include <algorithm>
#include <thread>
#include <atomic>

using namespace std;
using U64 = uint64_t;
using Clock = chrono::steady_clock;

// ----------------------------------------------------------------- basics
// squares: a1=0 … h1=7 … a8=56 … h8=63
enum { PAWN = 1, KNIGHT, BISHOP, ROOK, QUEEN, KING };
enum { WHITE = 0, BLACK = 1 };
enum { CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8 };

static const int F_EP = 1 << 21, F_CASTLE = 1 << 22, F_DOUBLE = 1 << 23;

static inline int mFrom(int m)  { return m & 63; }
static inline int mTo(int m)    { return (m >> 6) & 63; }
static inline int mPiece(int m) { return (m >> 12) & 7; }
static inline int mCapt(int m)  { return (m >> 15) & 7; }
static inline int mPromo(int m) { return (m >> 18) & 7; }
static inline int encodeMove(int f, int t, int p, int c, int pr, int fl) {
  return f | (t << 6) | (p << 12) | (c << 15) | (pr << 18) | fl;
}
static inline bool isCapture(int m) { return mCapt(m) != 0 || (m & F_EP); }

static inline int lsb(U64 b) { return __builtin_ctzll(b); }
static inline int popLsb(U64& b) { int s = lsb(b); b &= b - 1; return s; }
static inline int popcnt(U64 b) { return __builtin_popcountll(b); }

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static const char PIECE_CH[7] = {' ', 'p', 'n', 'b', 'r', 'q', 'k'};

static string sqName(int sq) {
  string s;
  s += char('a' + (sq & 7));
  s += char('1' + (sq >> 3));
  return s;
}
static int nameSq(const string& s) { return (s[1] - '1') * 8 + (s[0] - 'a'); }

// ----------------------------------------------------------------- attack tables
static U64 knightAtt[64], kingAtt[64], pawnAtt[2][64];
static U64 fileMask[8], adjFileMask[8], passedMask[2][64], shield1[2][64], shield2[2][64];

static U64 slidingAttack(int sq, U64 block, const int* dr, const int* df, int nd) {
  U64 att = 0;
  int r0 = sq >> 3, f0 = sq & 7;
  for (int i = 0; i < nd; i++) {
    for (int r = r0 + dr[i], f = f0 + df[i]; r >= 0 && r < 8 && f >= 0 && f < 8; r += dr[i], f += df[i]) {
      int s = r * 8 + f;
      att |= 1ULL << s;
      if (block & (1ULL << s)) break;
    }
  }
  return att;
}
static const int ROOK_DR[4] = {1, -1, 0, 0}, ROOK_DF[4] = {0, 0, 1, -1};
static const int BISH_DR[4] = {1, 1, -1, -1}, BISH_DF[4] = {1, -1, 1, -1};

// magic bitboards (magics found at startup)
struct Magic { U64 mask, magic; int shift; U64* att; };
static Magic rookM[64], bishM[64];
static vector<U64> magicTable;

static U64 rng64s = 0xDEADBEEFCAFE1234ULL;
static U64 rnd64() {
  rng64s ^= rng64s << 13; rng64s ^= rng64s >> 7; rng64s ^= rng64s << 17;
  return rng64s;
}
static U64 rndSparse() { return rnd64() & rnd64() & rnd64(); }

static U64 relevantMask(int sq, bool bishop) {
  U64 edges = 0;
  int r0 = sq >> 3, f0 = sq & 7;
  const int* dr = bishop ? BISH_DR : ROOK_DR;
  const int* df = bishop ? BISH_DF : ROOK_DF;
  U64 att = 0;
  for (int i = 0; i < 4; i++) {
    for (int r = r0 + dr[i], f = f0 + df[i];; r += dr[i], f += df[i]) {
      int nr = r + dr[i], nf = f + df[i];
      if (r < 0 || r > 7 || f < 0 || f > 7) break;
      if (nr < 0 || nr > 7 || nf < 0 || nf > 7) break; // exclude edge squares
      att |= 1ULL << (r * 8 + f);
    }
  }
  (void)edges;
  return att;
}

static void initMagics(bool bishop, Magic* M) {
  for (int sq = 0; sq < 64; sq++) {
    U64 mask = relevantMask(sq, bishop);
    int bits = popcnt(mask);
    int size = 1 << bits;
    // enumerate occupancy subsets + reference attacks
    vector<U64> occs(size), refs(size);
    U64 occ = 0;
    for (int i = 0; i < size; i++) {
      occs[i] = occ;
      refs[i] = slidingAttack(sq, occ, bishop ? BISH_DR : ROOK_DR, bishop ? BISH_DF : ROOK_DF, 4);
      occ = (occ - mask) & mask; // carry-rippler
    }
    // find a collision-free magic
    vector<U64> table(size);
    U64 magic;
    for (;;) {
      magic = rndSparse();
      if (popcnt((mask * magic) >> 56) < 6) continue;
      fill(table.begin(), table.end(), ~0ULL);
      bool ok = true;
      for (int i = 0; i < size && ok; i++) {
        int idx = int((occs[i] * magic) >> (64 - bits));
        if (table[idx] == ~0ULL) table[idx] = refs[i];
        else if (table[idx] != refs[i]) ok = false;
      }
      if (ok) break;
    }
    size_t off = magicTable.size();
    magicTable.insert(magicTable.end(), table.begin(), table.end());
    M[sq] = {mask, magic, 64 - bits, (U64*)off}; // offset; fixed up after all inserts
  }
}

static inline U64 bishopAtt(int sq, U64 occ) {
  const Magic& m = bishM[sq];
  return m.att[((occ & m.mask) * m.magic) >> m.shift];
}
static inline U64 rookAtt(int sq, U64 occ) {
  const Magic& m = rookM[sq];
  return m.att[((occ & m.mask) * m.magic) >> m.shift];
}
static inline U64 queenAtt(int sq, U64 occ) { return bishopAtt(sq, occ) | rookAtt(sq, occ); }

static void initTables() {
  initMagics(false, rookM);
  initMagics(true, bishM);
  // fix up offsets into the final contiguous table
  for (int sq = 0; sq < 64; sq++) {
    rookM[sq].att = magicTable.data() + (size_t)rookM[sq].att;
    bishM[sq].att = magicTable.data() + (size_t)bishM[sq].att;
  }
  for (int sq = 0; sq < 64; sq++) {
    int r = sq >> 3, f = sq & 7;
    U64 n = 0, k = 0;
    const int ndr[8] = {2, 2, -2, -2, 1, 1, -1, -1}, ndf[8] = {1, -1, 1, -1, 2, -2, 2, -2};
    for (int i = 0; i < 8; i++) {
      int rr = r + ndr[i], ff = f + ndf[i];
      if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) n |= 1ULL << (rr * 8 + ff);
    }
    for (int dr = -1; dr <= 1; dr++)
      for (int df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        int rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) k |= 1ULL << (rr * 8 + ff);
      }
    knightAtt[sq] = n;
    kingAtt[sq] = k;
    pawnAtt[WHITE][sq] = 0;
    pawnAtt[BLACK][sq] = 0;
    if (r < 7) {
      if (f > 0) pawnAtt[WHITE][sq] |= 1ULL << (sq + 7);
      if (f < 7) pawnAtt[WHITE][sq] |= 1ULL << (sq + 9);
    }
    if (r > 0) {
      if (f > 0) pawnAtt[BLACK][sq] |= 1ULL << (sq - 9);
      if (f < 7) pawnAtt[BLACK][sq] |= 1ULL << (sq - 7);
    }
  }
  for (int f = 0; f < 8; f++) {
    fileMask[f] = 0x0101010101010101ULL << f;
    adjFileMask[f] = (f > 0 ? fileMask[f - 1] : 0) | (f < 7 ? fileMask[f + 1] : 0);
  }
  for (int sq = 0; sq < 64; sq++) {
    int r = sq >> 3, f = sq & 7;
    U64 span = fileMask[f] | adjFileMask[f];
    U64 ahead = 0, behind = 0;
    for (int rr = r + 1; rr < 8; rr++) ahead |= 0xFFULL << (rr * 8);
    for (int rr = r - 1; rr >= 0; rr--) behind |= 0xFFULL << (rr * 8);
    passedMask[WHITE][sq] = span & ahead;
    passedMask[BLACK][sq] = span & behind;
    U64 s3 = fileMask[f] | adjFileMask[f];
    shield1[WHITE][sq] = (r < 7) ? (s3 & (0xFFULL << ((r + 1) * 8))) : 0;
    shield2[WHITE][sq] = (r < 6) ? (s3 & (0xFFULL << ((r + 2) * 8))) : 0;
    shield1[BLACK][sq] = (r > 0) ? (s3 & (0xFFULL << ((r - 1) * 8))) : 0;
    shield2[BLACK][sq] = (r > 1) ? (s3 & (0xFFULL << ((r - 2) * 8))) : 0;
  }
}

// ----------------------------------------------------------------- zobrist
static U64 Z_PIECE[2][7][64], Z_SIDE, Z_CAST[16], Z_EP[8];
static void initZobrist() {
  for (auto& c : Z_PIECE) for (auto& t : c) for (auto& v : t) v = rnd64();
  Z_SIDE = rnd64();
  for (auto& v : Z_CAST) v = rnd64();
  for (auto& v : Z_EP) v = rnd64();
}

// ----------------------------------------------------------------- position
struct Undo { uint8_t cast; int8_t ep; int16_t half; U64 hash; int move; };

struct Position {
  U64 bb[2][7];      // [color][piecetype 1..6]; [c][0] = all pieces of color
  int8_t sqPiece[64]; // piece type at square (0 empty)
  int8_t sqColor[64]; // color at square (-1 empty)
  int side;           // WHITE / BLACK
  int castling, ep, halfmove, fullmove;
  U64 hash;
  vector<Undo> st;

  U64 occ() const { return bb[WHITE][0] | bb[BLACK][0]; }
  int kingSq(int c) const { return lsb(bb[c][KING]); }

  void put(int c, int t, int sq) {
    bb[c][t] |= 1ULL << sq; bb[c][0] |= 1ULL << sq;
    sqPiece[sq] = int8_t(t); sqColor[sq] = int8_t(c);
    hash ^= Z_PIECE[c][t][sq];
  }
  void del(int c, int t, int sq) {
    bb[c][t] &= ~(1ULL << sq); bb[c][0] &= ~(1ULL << sq);
    sqPiece[sq] = 0; sqColor[sq] = -1;
    hash ^= Z_PIECE[c][t][sq];
  }

  void load(const string& fen) {
    memset(bb, 0, sizeof(bb));
    memset(sqPiece, 0, sizeof(sqPiece));
    memset(sqColor, -1, sizeof(sqColor));
    hash = 0;
    st.clear();
    st.reserve(1024);
    istringstream ss(fen);
    string b, stm, cr, eps;
    ss >> b >> stm >> cr >> eps;
    halfmove = 0; fullmove = 1;
    ss >> halfmove >> fullmove;
    int r = 7, f = 0;
    for (char c : b) {
      if (c == '/') { r--; f = 0; continue; }
      if (c >= '1' && c <= '8') { f += c - '0'; continue; }
      int t = 0;
      switch (tolower(c)) {
        case 'p': t = PAWN; break; case 'n': t = KNIGHT; break;
        case 'b': t = BISHOP; break; case 'r': t = ROOK; break;
        case 'q': t = QUEEN; break; case 'k': t = KING; break;
      }
      put(isupper(c) ? WHITE : BLACK, t, r * 8 + f);
      f++;
    }
    side = (stm == "w") ? WHITE : BLACK;
    if (side == BLACK) hash ^= Z_SIDE;
    castling = 0;
    if (cr.find('K') != string::npos) castling |= CR_WK;
    if (cr.find('Q') != string::npos) castling |= CR_WQ;
    if (cr.find('k') != string::npos) castling |= CR_BK;
    if (cr.find('q') != string::npos) castling |= CR_BQ;
    hash ^= Z_CAST[castling];
    ep = (eps.size() == 2) ? nameSq(eps) : -1;
    if (ep >= 0) hash ^= Z_EP[ep & 7];
  }

  bool isAttacked(int sq, int by) const {
    if (pawnAtt[by ^ 1][sq] & bb[by][PAWN]) return true;
    if (knightAtt[sq] & bb[by][KNIGHT]) return true;
    if (kingAtt[sq] & bb[by][KING]) return true;
    U64 o = occ();
    if (bishopAtt(sq, o) & (bb[by][BISHOP] | bb[by][QUEEN])) return true;
    if (rookAtt(sq, o) & (bb[by][ROOK] | bb[by][QUEEN])) return true;
    return false;
  }
  bool inCheck() const { return isAttacked(kingSq(side), side ^ 1); }
  bool illegalAfterMove() const { return isAttacked(kingSq(side ^ 1), side); }

  int genMoves(int* out, bool capsOnly) const {
    int n = 0;
    const int us = side, them = side ^ 1;
    const U64 own = bb[us][0], opp = bb[them][0], all = own | opp;
    const int fwd = us == WHITE ? 8 : -8;
    const U64 rank3 = us == WHITE ? 0x0000000000FF0000ULL : 0x0000FF0000000000ULL;
    const U64 promoRank = us == WHITE ? 0xFF00000000000000ULL : 0x00000000000000FFULL;

    // pawns
    U64 pawns = bb[us][PAWN];
    U64 push1 = (us == WHITE ? pawns << 8 : pawns >> 8) & ~all;
    if (!capsOnly) {
      U64 push2 = (us == WHITE ? (push1 & rank3) << 8 : (push1 & rank3) >> 8) & ~all;
      U64 p1 = push1 & ~promoRank;
      while (p1) { int to = popLsb(p1); out[n++] = encodeMove(to - fwd, to, PAWN, 0, 0, 0); }
      while (push2) { int to = popLsb(push2); out[n++] = encodeMove(to - 2 * fwd, to, PAWN, 0, 0, F_DOUBLE); }
    }
    U64 pp = push1 & promoRank;
    while (pp) {
      int to = popLsb(pp);
      out[n++] = encodeMove(to - fwd, to, PAWN, 0, QUEEN, 0);
      if (!capsOnly) {
        out[n++] = encodeMove(to - fwd, to, PAWN, 0, ROOK, 0);
        out[n++] = encodeMove(to - fwd, to, PAWN, 0, BISHOP, 0);
        out[n++] = encodeMove(to - fwd, to, PAWN, 0, KNIGHT, 0);
      }
    }
    U64 pw = pawns;
    while (pw) {
      int from = popLsb(pw);
      U64 caps = pawnAtt[us][from] & opp & ~bb[them][KING];
      while (caps) {
        int to = popLsb(caps);
        int capt = sqPiece[to];
        if ((1ULL << to) & promoRank) {
          out[n++] = encodeMove(from, to, PAWN, capt, QUEEN, 0);
          out[n++] = encodeMove(from, to, PAWN, capt, ROOK, 0);
          out[n++] = encodeMove(from, to, PAWN, capt, BISHOP, 0);
          out[n++] = encodeMove(from, to, PAWN, capt, KNIGHT, 0);
        } else out[n++] = encodeMove(from, to, PAWN, capt, 0, 0);
      }
      if (ep >= 0 && (pawnAtt[us][from] & (1ULL << ep)))
        out[n++] = encodeMove(from, ep, PAWN, PAWN, 0, F_EP);
    }

    // knights, king (enemy king is never a capture target)
    U64 kn = bb[us][KNIGHT];
    const U64 noK = ~bb[them][KING];
    const U64 target = (capsOnly ? opp : ~own) & noK;
    while (kn) {
      int from = popLsb(kn);
      U64 att = knightAtt[from] & target;
      while (att) { int to = popLsb(att); out[n++] = encodeMove(from, to, KNIGHT, sqPiece[to], 0, 0); }
    }
    {
      int from = kingSq(us);
      U64 att = kingAtt[from] & target;
      while (att) { int to = popLsb(att); out[n++] = encodeMove(from, to, KING, sqPiece[to], 0, 0); }
    }

    // sliders
    U64 bi = bb[us][BISHOP];
    while (bi) {
      int from = popLsb(bi);
      U64 att = bishopAtt(from, all) & target;
      while (att) { int to = popLsb(att); out[n++] = encodeMove(from, to, BISHOP, sqPiece[to], 0, 0); }
    }
    U64 ro = bb[us][ROOK];
    while (ro) {
      int from = popLsb(ro);
      U64 att = rookAtt(from, all) & target;
      while (att) { int to = popLsb(att); out[n++] = encodeMove(from, to, ROOK, sqPiece[to], 0, 0); }
    }
    U64 qu = bb[us][QUEEN];
    while (qu) {
      int from = popLsb(qu);
      U64 att = queenAtt(from, all) & target;
      while (att) { int to = popLsb(att); out[n++] = encodeMove(from, to, QUEEN, sqPiece[to], 0, 0); }
    }

    // castling
    if (!capsOnly) {
      if (us == WHITE) {
        if ((castling & CR_WK) && !(all & 0x60ULL) &&
            !isAttacked(4, BLACK) && !isAttacked(5, BLACK) && !isAttacked(6, BLACK))
          out[n++] = encodeMove(4, 6, KING, 0, 0, F_CASTLE);
        if ((castling & CR_WQ) && !(all & 0x0EULL) &&
            !isAttacked(4, BLACK) && !isAttacked(3, BLACK) && !isAttacked(2, BLACK))
          out[n++] = encodeMove(4, 2, KING, 0, 0, F_CASTLE);
      } else {
        if ((castling & CR_BK) && !(all & 0x6000000000000000ULL) &&
            !isAttacked(60, WHITE) && !isAttacked(61, WHITE) && !isAttacked(62, WHITE))
          out[n++] = encodeMove(60, 62, KING, 0, 0, F_CASTLE);
        if ((castling & CR_BQ) && !(all & 0x0E00000000000000ULL) &&
            !isAttacked(60, WHITE) && !isAttacked(59, WHITE) && !isAttacked(58, WHITE))
          out[n++] = encodeMove(60, 58, KING, 0, 0, F_CASTLE);
      }
    }
    return n;
  }

  void make(int m) {
    const int us = side, them = side ^ 1;
    const int from = mFrom(m), to = mTo(m);
    const int piece = mPiece(m), capt = mCapt(m), promo = mPromo(m);

    st.push_back({uint8_t(castling), int8_t(ep), int16_t(halfmove), hash, m});
    if (ep >= 0) hash ^= Z_EP[ep & 7];

    del(us, piece, from);
    if (m & F_EP) del(them, PAWN, us == WHITE ? to - 8 : to + 8);
    else if (capt) del(them, capt, to);
    put(us, promo ? promo : piece, to);

    if ((m & F_CASTLE)) {
      if (to == 6)  { del(WHITE, ROOK, 7);  put(WHITE, ROOK, 5); }
      else if (to == 2)  { del(WHITE, ROOK, 0);  put(WHITE, ROOK, 3); }
      else if (to == 62) { del(BLACK, ROOK, 63); put(BLACK, ROOK, 61); }
      else               { del(BLACK, ROOK, 56); put(BLACK, ROOK, 59); }
    }

    hash ^= Z_CAST[castling];
    static const uint8_t MASKS[64] = {
      13,15,15,15,12,15,15,14, 15,15,15,15,15,15,15,15,
      15,15,15,15,15,15,15,15, 15,15,15,15,15,15,15,15,
      15,15,15,15,15,15,15,15, 15,15,15,15,15,15,15,15,
      15,15,15,15,15,15,15,15,  7,15,15,15, 3,15,15,11,
    };
    castling &= MASKS[from] & MASKS[to];
    hash ^= Z_CAST[castling];

    if (m & F_DOUBLE) { ep = (from + to) >> 1; hash ^= Z_EP[ep & 7]; }
    else ep = -1;

    halfmove = (piece == PAWN || capt) ? 0 : halfmove + 1;
    if (us == BLACK) fullmove++;
    side = them;
    hash ^= Z_SIDE;
  }

  void unmake() {
    const Undo& u = st.back();
    const int m = u.move;
    const int them = side, us = side ^ 1;
    const int from = mFrom(m), to = mTo(m);
    const int piece = mPiece(m), capt = mCapt(m), promo = mPromo(m);

    U64 savedHash = u.hash; // put/del below scramble hash; restore at the end
    del(us, promo ? promo : piece, to);
    put(us, piece, from);
    if (m & F_EP) put(them, PAWN, us == WHITE ? to - 8 : to + 8);
    else if (capt) put(them, capt, to);
    if (m & F_CASTLE) {
      if (to == 6)  { del(WHITE, ROOK, 5);  put(WHITE, ROOK, 7); }
      else if (to == 2)  { del(WHITE, ROOK, 3);  put(WHITE, ROOK, 0); }
      else if (to == 62) { del(BLACK, ROOK, 61); put(BLACK, ROOK, 63); }
      else               { del(BLACK, ROOK, 59); put(BLACK, ROOK, 56); }
    }
    castling = u.cast; ep = u.ep; halfmove = u.half; hash = savedHash;
    if (us == BLACK) fullmove--;
    side = us;
    st.pop_back();
  }

  void makeNull() {
    st.push_back({uint8_t(castling), int8_t(ep), int16_t(halfmove), hash, 0});
    if (ep >= 0) hash ^= Z_EP[ep & 7];
    ep = -1;
    halfmove++;
    side ^= 1;
    hash ^= Z_SIDE;
  }
  void unmakeNull() {
    const Undo& u = st.back();
    castling = u.cast; ep = u.ep; halfmove = u.half; hash = u.hash;
    side ^= 1;
    st.pop_back();
  }

  int lastMove() const { return st.empty() ? 0 : st.back().move; }
  bool isRepetition() const {
    int n = (int)st.size(), limit = min(halfmove, n);
    for (int i = 2; i <= limit; i += 2)
      if (st[n - i].hash == hash) return true;
    return false;
  }
  bool hasNonPawnMaterial(int c) const {
    return (bb[c][KNIGHT] | bb[c][BISHOP] | bb[c][ROOK] | bb[c][QUEEN]) != 0;
  }
};

// ----------------------------------------------------------------- perft
static U64 perft(Position& pos, int depth) {
  if (depth == 0) return 1;
  int moves[256];
  int n = pos.genMoves(moves, false);
  U64 nodes = 0;
  for (int i = 0; i < n; i++) {
    pos.make(moves[i]);
    if (!pos.illegalAfterMove()) nodes += depth == 1 ? 1 : perft(pos, depth - 1);
    pos.unmake();
  }
  return nodes;
}

// ----------------------------------------------------------------- eval (PeSTO + terms)
static const int MG_VAL[7] = {0, 82, 337, 365, 477, 1025, 0};
static const int EG_VAL[7] = {0, 94, 281, 297, 512, 936, 0};
static const int SEE_VAL[7] = {0, 100, 320, 330, 500, 950, 20000};

// tables printed with a8 first (index 0 = a8): white uses sq^56, black uses sq
static const int MG_PST[7][64] = { {0},
  { 0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20,
    -14,13,6,21,23,12,17,-23, -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12,
    -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0 },
  { -167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44,
    -9,17,19,53,37,69,18,22, -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16,
    -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23 },
  { -29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2,
    -4,5,19,50,37,37,7,-2, -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10,
    4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21 },
  { 32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16,
    -24,-11,7,26,24,35,-8,-20, -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33,
    -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26 },
  { -28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57,
    -27,-27,-16,-16,-1,17,-2,1, -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5,
    -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50 },
  { -65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22,
    -17,-20,-12,-27,-30,-25,-14,-36, -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27,
    1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14 },
};
static const int EG_PST[7][64] = { {0},
  { 0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84,
    32,24,13,5,-2,4,17,17, 13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8,
    13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0 },
  { -58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41,
    -17,3,22,22,22,11,8,-18, -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22,
    -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64 },
  { -14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4,
    -3,9,12,9,14,10,3,2, -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15,
    -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17 },
  { 13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3,
    4,3,13,1,2,1,-1,2, 3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16,
    -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20 },
  { -9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9,
    3,22,24,45,57,40,57,36, -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5,
    -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41 },
  { -74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13,
    -8,22,24,27,26,33,26,3, -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9,
    -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43 },
};

static const int PHASE_W[7] = {0, 0, 1, 1, 2, 4, 0};
static const int PASSED_MG[8] = {0, 5, 8, 12, 20, 35, 60, 0};
static const int PASSED_EG[8] = {0, 12, 20, 32, 55, 95, 150, 0};
static const int MOB_MG[7] = {0, 0, 4, 4, 2, 1, 0};
static const int MOB_EG[7] = {0, 0, 3, 4, 3, 2, 0};
static const int KS_WEIGHT[7] = {0, 0, 2, 2, 3, 5, 0};
static int KS_TABLE[64];
static void initEvalTables() {
  for (int i = 0; i < 64; i++) KS_TABLE[i] = min(250, (i * i * 3) >> 2);
}

static int evaluate(const Position& pos) {
  int mg = 0, eg = 0, phase = 0;
  const U64 all = pos.occ();
  int unitsOn[2] = {0, 0}; // attack units against [color]'s king
  const int ks[2] = {pos.kingSq(WHITE), pos.kingSq(BLACK)};
  const U64 kzone[2] = {kingAtt[ks[0]] | (1ULL << ks[0]), kingAtt[ks[1]] | (1ULL << ks[1])};

  for (int c = 0; c < 2; c++) {
    const int sgn = c == WHITE ? 1 : -1;
    const U64 own = pos.bb[c][0];
    for (int t = PAWN; t <= KING; t++) {
      U64 b = pos.bb[c][t];
      phase += PHASE_W[t] * popcnt(b);
      while (b) {
        int sq = popLsb(b);
        int idx = c == WHITE ? (sq ^ 56) : sq;
        mg += sgn * (MG_VAL[t] + MG_PST[t][idx]);
        eg += sgn * (EG_VAL[t] + EG_PST[t][idx]);

        if (t >= KNIGHT && t <= QUEEN) {
          U64 att = t == KNIGHT ? knightAtt[sq]
                  : t == BISHOP ? bishopAtt(sq, all)
                  : t == ROOK   ? rookAtt(sq, all)
                  : queenAtt(sq, all);
          int mob = popcnt(att & ~own);
          mg += sgn * MOB_MG[t] * mob;
          eg += sgn * MOB_EG[t] * mob;
          unitsOn[c ^ 1] += KS_WEIGHT[t] * popcnt(att & kzone[c ^ 1]);
        }

        if (t == ROOK) {
          int f = sq & 7;
          bool ownP = fileMask[f] & pos.bb[c][PAWN];
          bool oppP = fileMask[f] & pos.bb[c ^ 1][PAWN];
          if (!ownP) {
            if (!oppP) { mg += sgn * 28; eg += sgn * 8; }
            else { mg += sgn * 12; eg += sgn * 6; }
          }
        }
        if (t == PAWN) {
          int f = sq & 7;
          if (popcnt(fileMask[f] & pos.bb[c][PAWN]) > 1) { mg += sgn * -4; eg += sgn * -8; }
          if (!(adjFileMask[f] & pos.bb[c][PAWN])) { mg += sgn * -12; eg += sgn * -8; }
          if (!(passedMask[c][sq] & pos.bb[c ^ 1][PAWN])) {
            int adv = c == WHITE ? (sq >> 3) : 7 - (sq >> 3);
            int pm = PASSED_MG[adv], pe = PASSED_EG[adv];
            int front = c == WHITE ? sq + 8 : sq - 8;
            if (front >= 0 && front < 64 && pos.sqPiece[front]) { pm = pm * 2 / 3; pe = pe * 2 / 3; }
            mg += sgn * pm; eg += sgn * pe;
          }
        }
      }
    }
    if (popcnt(pos.bb[c][BISHOP]) >= 2) { mg += sgn * 25; eg += sgn * 45; }
  }

  // king safety (attacker's queen halves the units if absent) + pawn shield
  for (int c = 0; c < 2; c++) {
    int u = unitsOn[c];
    if (!pos.bb[c ^ 1][QUEEN]) u >>= 1;
    int pen = KS_TABLE[min(u, 63)];
    mg += c == WHITE ? -pen : pen;

    int r = ks[c] >> 3;
    bool home = c == WHITE ? (r <= 1) : (r >= 6);
    if (home) {
      int shield = 0;
      U64 p = pos.bb[c][PAWN];
      U64 s1 = shield1[c][ks[c]] & p;
      U64 s2 = shield2[c][ks[c]] & p & ~((c == WHITE ? s1 << 8 : s1 >> 8));
      shield += 12 * popcnt(s1) + 6 * popcnt(s2);
      shield -= 10 * (3 - popcnt(s1) - popcnt(s2) < 0 ? 0 : 3 - popcnt(s1) - popcnt(s2));
      mg += c == WHITE ? shield : -shield;
    }
  }

  if (phase > 24) phase = 24;
  int score = (mg * phase + eg * (24 - phase)) / 24;
  return (pos.side == WHITE ? score : -score) + 14; // tempo
}

// ----------------------------------------------------------------- search
static const int INF = 32000, MATE = 31000, MATE_BOUND = 30000;
static const int MAX_PLY = 96;
enum { TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3 };
struct TTEntry { U64 key; int32_t move; int16_t score; int8_t depth; uint8_t flag; uint8_t age; };

// shared across search threads (benign races on entries, standard for Lazy SMP)
static vector<TTEntry> g_tt(size_t(1) << 22);
static size_t g_ttMask = (size_t(1) << 22) - 1;
static atomic<bool> g_stop{false};
static atomic<uint64_t> g_nodes{0};
static int g_threads = 1;
static atomic<long long> g_deadlineMs{0}; // epoch ms; 0 = no deadline

static int LMR_TABLE[64][64];
static void initLMR() {
  for (int d = 0; d < 64; d++)
    for (int m = 0; m < 64; m++)
      LMR_TABLE[d][m] = (d && m) ? max(0, (int)lround(0.5 + log(d) * log(m) / 2.4)) : 0;
}

struct Engine {
  Position pos;
  vector<TTEntry>& tt = g_tt;
  size_t& ttMask = g_ttMask;
  uint8_t age = 0;
  bool isHelper = false;
  int killer1[MAX_PLY] = {0}, killer2[MAX_PLY] = {0};
  int history[2 * 7 * 64] = {0};
  int counter[2 * 7 * 64] = {0};
  int evalStack[MAX_PLY] = {0};
  int pvTable[MAX_PLY][MAX_PLY];
  int pvLen[MAX_PLY] = {0};
  U64 nodes = 0;
  int lastScore = 0; // root score of the last completed think()
  Clock::time_point deadline, softDeadline;
  bool useDeadline = false;
  bool aborted = false;

  Engine() {}

  void resizeTT(long mb) {
    size_t entries = 1 << 16;
    while ((entries << 1) * sizeof(TTEntry) <= size_t(mb) * 1024 * 1024 && entries < (size_t(1) << 26))
      entries <<= 1;
    g_tt.assign(entries, TTEntry{});
    g_ttMask = entries - 1;
  }

  void clearTables() {
    fill(tt.begin(), tt.end(), TTEntry{});
    memset(history, 0, sizeof(history));
    memset(counter, 0, sizeof(counter));
    memset(killer1, 0, sizeof(killer1));
    memset(killer2, 0, sizeof(killer2));
  }

  void checkTime() {
    if ((nodes & 1023) == 0) {
      if (g_stop.load(memory_order_relaxed)) { aborted = true; return; }
      long long dl = g_deadlineMs.load(memory_order_relaxed);
      if (dl) {
        long long now = chrono::duration_cast<chrono::milliseconds>(
            Clock::now().time_since_epoch()).count();
        if (now > dl) { aborted = true; g_stop.store(true, memory_order_relaxed); }
      }
    }
  }

  int histIdx(int c, int piece, int to) const { return c * 7 * 64 + piece * 64 + to; }
  int cmIdx(int prevM, int stm) const { return stm * 7 * 64 + mPiece(prevM) * 64 + mTo(prevM); }

  // SEE with x-ray updates
  int see(int m) {
    if (m & F_EP) return 0;
    const int to = mTo(m), from = mFrom(m);
    int gain[34];
    int d = 0;
    gain[0] = SEE_VAL[mCapt(m)];
    int attackerVal = SEE_VAL[mPiece(m)];
    U64 occ = pos.occ() ^ (1ULL << from);
    int stm = pos.side ^ 1;
    U64 attadef =
        (pawnAtt[WHITE][to] & pos.bb[BLACK][PAWN]) | (pawnAtt[BLACK][to] & pos.bb[WHITE][PAWN]) |
        (knightAtt[to] & (pos.bb[WHITE][KNIGHT] | pos.bb[BLACK][KNIGHT])) |
        (kingAtt[to] & (pos.bb[WHITE][KING] | pos.bb[BLACK][KING])) |
        (bishopAtt(to, occ) & (pos.bb[WHITE][BISHOP] | pos.bb[BLACK][BISHOP] | pos.bb[WHITE][QUEEN] | pos.bb[BLACK][QUEEN])) |
        (rookAtt(to, occ) & (pos.bb[WHITE][ROOK] | pos.bb[BLACK][ROOK] | pos.bb[WHITE][QUEEN] | pos.bb[BLACK][QUEEN]));
    attadef &= occ;

    for (;;) {
      U64 side = attadef & pos.bb[stm][0];
      if (!side || d >= 30) break;
      int t;
      U64 chosen = 0;
      for (t = PAWN; t <= KING; t++) {
        chosen = side & pos.bb[stm][t];
        if (chosen) break;
      }
      d++;
      gain[d] = attackerVal - gain[d - 1];
      if (max(-gain[d - 1], gain[d]) < 0) break;
      attackerVal = SEE_VAL[t];
      int asq = lsb(chosen);
      occ ^= 1ULL << asq;
      // reveal x-rays through the removed attacker
      attadef |= bishopAtt(to, occ) & (pos.bb[WHITE][BISHOP] | pos.bb[BLACK][BISHOP] | pos.bb[WHITE][QUEEN] | pos.bb[BLACK][QUEEN]);
      attadef |= rookAtt(to, occ) & (pos.bb[WHITE][ROOK] | pos.bb[BLACK][ROOK] | pos.bb[WHITE][QUEEN] | pos.bb[BLACK][QUEEN]);
      attadef &= occ;
      stm ^= 1;
    }
    while (d > 0) { gain[d - 1] = -max(-gain[d - 1], gain[d]); d--; }
    return gain[0];
  }

  void scoreMoves(const int* moves, int* scores, int n, int ttMove, int ply) {
    int prevM = pos.lastMove();
    int cm = prevM ? counter[cmIdx(prevM, pos.side)] : 0;
    for (int i = 0; i < n; i++) {
      int m = moves[i];
      if (m == ttMove) { scores[i] = 2000000000; continue; }
      int capt = mCapt(m), promo = mPromo(m);
      if (capt) {
        if (!promo && SEE_VAL[capt] < SEE_VAL[mPiece(m)] && see(m) < 0)
          scores[i] = -1000000000 + capt * 100 - mPiece(m);
        else
          scores[i] = 1000000000 + capt * 100 - mPiece(m) + (promo == QUEEN ? 500 : 0);
      }
      else if (promo == QUEEN) scores[i] = 999000000;
      else if (promo) scores[i] = 500000;
      else if (m == killer1[ply]) scores[i] = 900000000;
      else if (m == cm) scores[i] = 850000000;
      else if (m == killer2[ply]) scores[i] = 800000000;
      else scores[i] = history[histIdx(pos.side, mPiece(m), mTo(m))];
    }
  }

  int pickMove(int* moves, int* scores, int n, int start) {
    int bi = start;
    for (int i = start + 1; i < n; i++) if (scores[i] > scores[bi]) bi = i;
    swap(moves[bi], moves[start]);
    swap(scores[bi], scores[start]);
    return moves[start];
  }

  int qsearch(int alpha, int beta, int ply) {
    nodes++;
    checkTime();
    if (aborted) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    size_t qidx = pos.hash & ttMask;
    TTEntry& qe = tt[qidx];
    int ttMove = 0;
    if (qe.key == pos.hash && qe.flag != 0) {
      ttMove = qe.move;
      int ts = qe.score;
      if (ts > MATE_BOUND) ts -= ply; else if (ts < -MATE_BOUND) ts += ply;
      if (qe.flag == TT_EXACT) return ts;
      if (qe.flag == TT_LOWER && ts >= beta) return ts;
      if (qe.flag == TT_UPPER && ts <= alpha) return ts;
    }

    const int origAlpha = alpha;
    bool chk = pos.inCheck();
    int best, bestMove = 0;
    if (chk) best = -MATE + ply;
    else {
      best = evaluate(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }

    int moves[256], scores[256];
    int n = pos.genMoves(moves, !chk);
    scoreMoves(moves, scores, n, ttMove, ply);
    int legal = 0;
    for (int i = 0; i < n; i++) {
      int m = pickMove(moves, scores, n, i);
      if (!chk && !mPromo(m)) {
        if (scores[i] < -900000000) continue;
        if (best + SEE_VAL[mCapt(m)] + 200 <= alpha) continue;
      }
      pos.make(m);
      if (pos.illegalAfterMove()) { pos.unmake(); continue; }
      legal++;
      int score = -qsearch(-beta, -alpha, ply + 1);
      pos.unmake();
      if (aborted) return 0;
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }
    if (chk && legal == 0) return -MATE + ply;

    if (qe.flag == 0 || qe.age != age || qe.depth <= 0) {
      int ss = best;
      if (ss > MATE_BOUND) ss += ply; else if (ss < -MATE_BOUND) ss -= ply;
      qe = {pos.hash, bestMove, int16_t(ss), int8_t(0), uint8_t(best >= beta ? TT_LOWER : best > origAlpha ? TT_EXACT : TT_UPPER), age};
    }
    return best;
  }

  int search(int depth, int alpha, int beta, int ply, bool nullOk) {
    pvLen[ply] = 0;
    if (ply > 0) {
      if (pos.halfmove >= 100 || pos.isRepetition()) { nodes++; return 0; }
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;
    }

    bool chk = pos.inCheck();
    if (chk) depth++;
    if (depth <= 0) return qsearch(alpha, beta, ply);

    nodes++;
    checkTime();
    if (aborted) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    bool isPv = beta - alpha > 1;
    size_t idx = pos.hash & ttMask;
    TTEntry& e = tt[idx];
    int ttMove = 0;
    if (e.key == pos.hash && e.flag != 0) {
      ttMove = e.move;
      if (!isPv && ply > 0 && e.depth >= depth) {
        int s = e.score;
        if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
        if (e.flag == TT_EXACT) return s;
        if (e.flag == TT_LOWER && s >= beta) return s;
        if (e.flag == TT_UPPER && s <= alpha) return s;
      }
    }

    int staticEval = chk ? -INF : evaluate(pos);
    evalStack[ply] = staticEval;
    bool improving = !chk && ply >= 2 && staticEval > evalStack[ply - 2];

    if (!isPv && !chk && abs(beta) < MATE_BOUND) {
      if (depth <= 6 && staticEval - (improving ? 70 : 90) * depth >= beta)
        return staticEval;
      if (depth <= 2 && staticEval + 200 + 150 * depth < alpha) {
        int v = qsearch(alpha, beta, ply);
        if (aborted) return 0;
        if (v < alpha) return v;
      }
      if (nullOk && depth >= 3 && staticEval >= beta && pos.hasNonPawnMaterial(pos.side)) {
        int R = 3 + (depth >> 3) + (staticEval - beta > 200 ? 1 : 0);
        pos.makeNull();
        int score = -search(max(0, depth - 1 - R), -beta, -beta + 1, ply + 1, false);
        pos.unmakeNull();
        if (aborted) return 0;
        if (score >= beta && score < MATE_BOUND) return beta;
      }
    }

    if (isPv && !ttMove && depth >= 5) {
      search(depth - 2, alpha, beta, ply, false);
      if (aborted) return 0;
      if (e.key == pos.hash) ttMove = e.move;
    }

    bool futile = !isPv && !chk && depth <= 3 && staticEval + 100 + 120 * depth <= alpha;
    int lmpMax = improving ? 4 + depth * depth : 2 + (depth * depth) / 2;

    int moves[256], scores[256];
    int n = pos.genMoves(moves, false);
    scoreMoves(moves, scores, n, ttMove, ply);
    int prevM = pos.lastMove();

    int legal = 0, bestScore = -INF, bestMove = 0, ttFlag = TT_UPPER;
    for (int i = 0; i < n; i++) {
      int m = pickMove(moves, scores, n, i);
      int capt = mCapt(m), promo = mPromo(m);
      bool quiet = !isCapture(m) && !promo;

      if (!isPv && !chk && bestScore > -MATE_BOUND && legal > 0) {
        if (quiet && depth <= 5 && legal >= lmpMax) continue;
        if (capt && !promo && depth <= 4 &&
            SEE_VAL[capt] < SEE_VAL[mPiece(m)] && see(m) < -80 * depth) continue;
      }

      pos.make(m);
      if (pos.illegalAfterMove()) { pos.unmake(); continue; }
      legal++;
      bool givesCheck = pos.inCheck();
      if (futile && quiet && legal > 1 && !givesCheck) { pos.unmake(); continue; }

      int score;
      if (legal == 1) {
        score = -search(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        int R = 0;
        if (quiet && depth >= 3 && !chk && !givesCheck && legal > 2) {
          R = LMR_TABLE[min(depth, 63)][min(legal, 63)];
          if (isPv) R--;
          if (!improving) R++;
          if (m == killer1[ply] || m == killer2[ply]) R--;
          if (R < 0) R = 0;
          int maxR = depth - 2;
          if (R > maxR) R = max(maxR, 0);
        }
        score = -search(depth - 1 - R, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && R > 0 && !aborted)
          score = -search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && score < beta && !aborted)
          score = -search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (aborted) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          ttFlag = TT_EXACT;
          pvTable[ply][0] = m;
          for (int j = 0; j < pvLen[ply + 1]; j++) pvTable[ply][j + 1] = pvTable[ply + 1][j];
          pvLen[ply] = pvLen[ply + 1] + 1;
          if (alpha >= beta) {
            ttFlag = TT_LOWER;
            if (quiet) {
              if (killer1[ply] != m) { killer2[ply] = killer1[ply]; killer1[ply] = m; }
              if (prevM) counter[cmIdx(prevM, pos.side)] = m;
              int& h = history[histIdx(pos.side, mPiece(m), mTo(m))];
              h += depth * depth;
              if (h > 400000) for (auto& v : history) v >>= 1;
            }
            break;
          }
        }
      }
    }

    if (legal == 0) return chk ? -MATE + ply : 0;

    if (e.flag == 0 || e.age != age || depth >= e.depth || ttFlag == TT_EXACT) {
      int st2 = bestScore;
      if (st2 > MATE_BOUND) st2 += ply; else if (st2 < -MATE_BOUND) st2 -= ply;
      e = {pos.hash, bestMove, int16_t(st2), int8_t(depth), uint8_t(ttFlag), age};
    }
    return bestScore;
  }

  // helper thread body: iterative deepening, no output, fills the shared TT
  void helperLoop(const Position& root, int maxDepth, int offset) {
    isHelper = true;
    pos = root;
    aborted = false;
    nodes = 0;
    age++;
    memset(killer1, 0, sizeof(killer1));
    memset(killer2, 0, sizeof(killer2));
    for (int depth = 1 + (offset & 1); depth <= maxDepth && !g_stop.load(memory_order_relaxed); depth++) {
      search(depth, -INF, INF, 0, true);
      if (aborted) break;
    }
    g_nodes.fetch_add(nodes, memory_order_relaxed);
  }

  int think(int maxDepth, long movetimeMs, bool infoOut) {
    nodes = 0;
    aborted = false;
    g_stop.store(false, memory_order_relaxed);
    g_nodes.store(0, memory_order_relaxed);

    // Lazy SMP: spawn helper searchers on the same root
    vector<thread> helpers;
    vector<Engine>* helperEngines = nullptr;
    if (g_threads > 1) {
      helperEngines = new vector<Engine>(g_threads - 1);
      for (int i = 0; i < g_threads - 1; i++) {
        Engine& h = (*helperEngines)[i];
        thread t(&Engine::helperLoop, &h, cref(pos), maxDepth, i);
        helpers.push_back(move(t));
      }
    }
    useDeadline = movetimeMs > 0;
    auto t0 = Clock::now();
    if (useDeadline) {
      deadline = t0 + chrono::milliseconds(movetimeMs);
      softDeadline = t0 + chrono::milliseconds(movetimeMs * 6 / 10);
      long long nowMs = chrono::duration_cast<chrono::milliseconds>(t0.time_since_epoch()).count();
      g_deadlineMs.store(nowMs + movetimeMs, memory_order_relaxed);
    } else {
      g_deadlineMs.store(0, memory_order_relaxed);
    }
    age++;
    memset(killer1, 0, sizeof(killer1));
    memset(killer2, 0, sizeof(killer2));
    for (auto& h : history) h /= 8;

    int rootMoves[256], rootScores[256];
    int n = 0;
    {
      int all[256];
      int an = pos.genMoves(all, false);
      for (int i = 0; i < an; i++) {
        pos.make(all[i]);
        if (!pos.illegalAfterMove()) rootMoves[n++] = all[i];
        pos.unmake();
      }
    }
    if (n == 0) return 0;

    int bestMove = rootMoves[0], bestScore = -INF;
    int prevScore = 0;
    vector<pair<int, U64>> rootCnt;

    for (int depth = 1; depth <= maxDepth; depth++) {
      int alpha = depth >= 5 ? prevScore - 35 : -INF;
      int beta  = depth >= 5 ? prevScore + 35 : INF;

      for (;;) {
        int a = alpha;
        int iterBest = 0, iterScore = -INF;
        scoreMoves(rootMoves, rootScores, n, bestMove, 0);
        for (auto& pr : rootCnt) {
          for (int i = 0; i < n; i++) {
            if (rootMoves[i] == pr.first && rootScores[i] < 2000000000) {
              U64 c = pr.second > 1899000000ULL ? 1899000000ULL : pr.second;
              rootScores[i] = int(1000000 + c);
              break;
            }
          }
        }
        vector<pair<int, U64>> cnt;

        for (int i = 0; i < n; i++) {
          int m = pickMove(rootMoves, rootScores, n, i);
          U64 n0 = nodes;
          pos.make(m);
          int score;
          if (i == 0) score = -search(depth - 1, -beta, -a, 1, true);
          else {
            score = -search(depth - 1, -a - 1, -a, 1, true);
            if (score > a && score < beta && !aborted) score = -search(depth - 1, -beta, -a, 1, true);
          }
          pos.unmake();
          cnt.push_back({m, nodes - n0});
          if (aborted) break;
          if (score > iterScore || i == 0) {
            iterScore = score;
            if (score > a || i == 0) {
              a = max(a, score);
              iterBest = m;
              pvTable[0][0] = m;
              for (int j = 0; j < pvLen[1]; j++) pvTable[0][j + 1] = pvTable[1][j];
              pvLen[0] = pvLen[1] + 1;
            }
          }
          if (a >= beta) break;
        }

        if (aborted) break;
        if (iterScore <= alpha && alpha > -INF) { alpha = max(-INF, alpha - 150); continue; }
        if (iterScore >= beta && beta < INF)   { beta = min(INF, beta + 150); continue; }
        rootCnt = cnt;

        bestMove = iterBest ? iterBest : bestMove;
        bestScore = iterScore;
        prevScore = iterScore;
        lastScore = iterScore;

        if (infoOut) {
          auto ms = chrono::duration_cast<chrono::milliseconds>(Clock::now() - t0).count();
          long nps = ms > 0 ? (long)(nodes * 1000 / ms) : 0;
          printf("info depth %d score ", depth);
          if (abs(bestScore) > MATE_BOUND) {
            int mate = (MATE - abs(bestScore) + 1) / 2;
            printf("mate %d", bestScore > 0 ? mate : -mate);
          } else printf("cp %d", bestScore);
          printf(" nodes %llu nps %ld time %lld pv", (unsigned long long)nodes, nps, (long long)ms);
          for (int j = 0; j < pvLen[0]; j++) {
            int m = pvTable[0][j];
            printf(" %s%s", sqName(mFrom(m)).c_str(), sqName(mTo(m)).c_str());
            if (mPromo(m)) printf("%c", PIECE_CH[mPromo(m)]);
          }
          printf("\n");
          fflush(stdout);
        }
        break;
      }

      if (aborted) break;
      if (abs(bestScore) > MATE_BOUND && depth >= 6) break;
      if (useDeadline && Clock::now() > softDeadline) break;
    }
    if (!helpers.empty()) {
      g_stop.store(true, memory_order_relaxed);
      for (auto& t : helpers) t.join();
      nodes += g_nodes.load(memory_order_relaxed);
      delete helperEngines;
    }
    return bestMove;
  }
};

// ----------------------------------------------------------------- FEN out
static string posToFen(const Position& pos) {
  string out;
  for (int r = 7; r >= 0; r--) {
    int empty = 0;
    for (int f = 0; f < 8; f++) {
      int sq = r * 8 + f;
      if (!pos.sqPiece[sq]) { empty++; continue; }
      if (empty) { out += char('0' + empty); empty = 0; }
      char ch = PIECE_CH[pos.sqPiece[sq]];
      out += pos.sqColor[sq] == WHITE ? char(toupper(ch)) : ch;
    }
    if (empty) out += char('0' + empty);
    if (r) out += '/';
  }
  out += pos.side == WHITE ? " w " : " b ";
  string cr;
  if (pos.castling & CR_WK) cr += 'K';
  if (pos.castling & CR_WQ) cr += 'Q';
  if (pos.castling & CR_BK) cr += 'k';
  if (pos.castling & CR_BQ) cr += 'q';
  out += (cr.empty() ? "-" : cr);
  out += ' ';
  out += pos.ep >= 0 ? sqName(pos.ep) : "-";
  out += " " + to_string(pos.halfmove) + " " + to_string(pos.fullmove);
  return out;
}

// ----------------------------------------------------------------- selfplay data generation
// selfplay <games> <movetimeMs> <seed> → stdout: FEN;cpWhite;result  (result: 1/0.5/0 white)
static void runSelfplay(Engine& eng, int games, long mt, U64 seed) {
  U64 rs = seed ? seed : 0xABCDEF12345ULL;
  auto rnd = [&]() { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; };
  U64 total = 0;
  for (int g = 0; g < games; g++) {
    eng.clearTables();
    eng.pos.load(START_FEN);
    int randPlies = 6 + int(rnd() % 6);
    bool dead = false;
    for (int i = 0; i < randPlies; i++) {
      int mv[256], sc[256];
      int nn = eng.pos.genMoves(mv, false);
      int legal[256], ln = 0;
      for (int j = 0; j < nn; j++) {
        eng.pos.make(mv[j]);
        if (!eng.pos.illegalAfterMove()) legal[ln++] = mv[j];
        eng.pos.unmake();
      }
      (void)sc;
      if (!ln) { dead = true; break; }
      eng.pos.make(legal[rnd() % ln]);
    }
    if (dead) continue;

    vector<string> lines;   // buffered "fen;cpWhite" — result appended at end
    double result = 0.5;
    int decisiveStreak = 0;
    for (int ply = randPlies; ply < 200; ply++) {
      int mv[256];
      int nn = eng.pos.genMoves(mv, false);
      int ln = 0;
      for (int j = 0; j < nn; j++) {
        eng.pos.make(mv[j]);
        if (!eng.pos.illegalAfterMove()) ln++;
        eng.pos.unmake();
        if (ln) break;
      }
      if (!ln) { // mate or stalemate
        result = eng.pos.inCheck() ? (eng.pos.side == WHITE ? 0.0 : 1.0) : 0.5;
        break;
      }
      if (eng.pos.halfmove >= 100 || (ply > 40 && eng.pos.isRepetition())) { result = 0.5; break; }

      int best = eng.think(64, mt, false);
      if (!best) { result = 0.5; break; }
      int cpStm = eng.lastScore;
      int cpWhite = eng.pos.side == WHITE ? cpStm : -cpStm;

      // adjudicate hopeless games early
      if (abs(cpWhite) > 1200) {
        if (++decisiveStreak >= 4) { result = cpWhite > 0 ? 1.0 : 0.0; break; }
      } else decisiveStreak = 0;

      if (ply >= 8 && !eng.pos.inCheck() && abs(cpStm) < 30000 - 1000)
        lines.push_back(posToFen(eng.pos) + ";" + to_string(cpWhite));

      eng.pos.make(best);
    }
    for (auto& l : lines) printf("%s;%.1f\n", l.c_str(), result);
    total += lines.size();
    if ((g + 1) % 20 == 0) {
      fprintf(stderr, "game %d/%d positions %llu\n", g + 1, games, (unsigned long long)total);
      fflush(stderr);
    }
    fflush(stdout);
  }
  fprintf(stderr, "DONE games %d positions %llu\n", games, (unsigned long long)total);
}

// ----------------------------------------------------------------- UCI
static string moveToUci(int m) {
  string s = sqName(mFrom(m)) + sqName(mTo(m));
  if (mPromo(m)) s += PIECE_CH[mPromo(m)];
  return s;
}

static int uciToMove(Position& pos, const string& u) {
  int moves[256];
  int n = pos.genMoves(moves, false);
  for (int i = 0; i < n; i++) {
    pos.make(moves[i]);
    bool ok = !pos.illegalAfterMove();
    pos.unmake();
    if (ok && moveToUci(moves[i]) == u) return moves[i];
  }
  return 0;
}

static void runBench(Engine& eng) {
  struct { const char* fen; int depth; U64 want; } tests[] = {
    {START_FEN, 5, 4865609ULL},
    {"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 4, 4085603ULL},
    {"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624ULL},
    {"r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333ULL},
    {"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 4, 2103487ULL},
  };
  bool ok = true;
  auto t0 = Clock::now();
  for (auto& t : tests) {
    eng.pos.load(t.fen);
    U64 got = perft(eng.pos, t.depth);
    bool pass = got == t.want;
    if (!pass) ok = false;
    printf("perft d%d: %llu (beklenen %llu) %s\n", t.depth, (unsigned long long)got,
           (unsigned long long)t.want, pass ? "OK" : "FAIL");
  }
  auto ms = chrono::duration_cast<chrono::milliseconds>(Clock::now() - t0).count();
  printf("bench: %s, %lld ms\n", ok ? "ALL PASS" : "FAILURES", (long long)ms);
  fflush(stdout);
}

int main() {
  initTables();
  initZobrist();
  initEvalTables();
  initLMR();

  Engine eng;
  eng.resizeTT(64);
  eng.pos.load(START_FEN);

  string line;
  while (getline(cin, line)) {
    istringstream ss(line);
    string cmd;
    ss >> cmd;

    if (cmd == "uci") {
      printf("id name VEGA 2.0 bitboard\n");
      printf("id author SigmaBoy project\n");
      printf("option name Hash type spin default 64 min 16 max 1024\n");
      printf("option name Threads type spin default 1 min 1 max 8\n");
      printf("uciok\n");
      fflush(stdout);
    } else if (cmd == "isready") {
      printf("readyok\n");
      fflush(stdout);
    } else if (cmd == "setoption") {
      string tok, name, value;
      while (ss >> tok) {
        if (tok == "name") ss >> name;
        else if (tok == "value") ss >> value;
      }
      if (name == "Hash" && !value.empty()) eng.resizeTT(atol(value.c_str()));
      if (name == "Threads" && !value.empty()) g_threads = max(1, min(8, atoi(value.c_str())));
    } else if (cmd == "ucinewgame") {
      eng.clearTables();
    } else if (cmd == "position") {
      string sub;
      ss >> sub;
      if (sub == "startpos") {
        eng.pos.load(START_FEN);
        string tok;
        if (ss >> tok && tok == "moves")
          while (ss >> tok) { int m = uciToMove(eng.pos, tok); if (m) eng.pos.make(m); }
      } else if (sub == "fen") {
        string fen, tok;
        int fields = 0;
        while (fields < 6 && ss >> tok) {
          if (tok == "moves") { fields = 99; break; }
          fen += (fen.empty() ? "" : " ") + tok;
          fields++;
        }
        eng.pos.load(fen);
        if (fields == 99 || (ss >> tok && tok == "moves"))
          while (ss >> tok) { int m = uciToMove(eng.pos, tok); if (m) eng.pos.make(m); }
      }
    } else if (cmd == "go") {
      long movetime = 0, wtime = 0, btime = 0, winc = 0, binc = 0;
      int depth = 64;
      string tok;
      while (ss >> tok) {
        if (tok == "movetime") ss >> movetime;
        else if (tok == "depth") ss >> depth;
        else if (tok == "wtime") ss >> wtime;
        else if (tok == "btime") ss >> btime;
        else if (tok == "winc") ss >> winc;
        else if (tok == "binc") ss >> binc;
        else if (tok == "infinite") movetime = 0;
      }
      if (!movetime && (wtime || btime)) {
        long t = eng.pos.side == WHITE ? wtime : btime;
        long inc = eng.pos.side == WHITE ? winc : binc;
        movetime = max(30L, t / 30 + inc / 2);
      }
      int best = eng.think(depth, movetime, true);
      printf("bestmove %s\n", best ? moveToUci(best).c_str() : "0000");
      fflush(stdout);
    } else if (cmd == "perft") {
      int d = 5;
      ss >> d;
      auto t0 = Clock::now();
      U64 nn = perft(eng.pos, d);
      auto ms = chrono::duration_cast<chrono::milliseconds>(Clock::now() - t0).count();
      printf("perft %d: %llu dugum, %lld ms (%.1fM/s)\n", d, (unsigned long long)nn,
             (long long)ms, ms ? nn / 1000.0 / ms : 0);
      fflush(stdout);
    } else if (cmd == "bench") {
      runBench(eng);
    } else if (cmd == "selfplay") {
      int games = 100; long mt = 30; unsigned long long seed = 1;
      ss >> games >> mt >> seed;
      runSelfplay(eng, games, mt, seed);
    } else if (cmd == "quit") {
      break;
    }
  }
  return 0;
}

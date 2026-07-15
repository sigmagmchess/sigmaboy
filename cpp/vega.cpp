/*
 * VEGA — C++ UCI chess engine (port of the SigmaBoy/VEGA JavaScript engine)
 *
 * Board: 0x88. Search: iterative deepening, aspiration windows, PVS,
 * transposition table, null-move pruning, reverse futility, razoring,
 * late move reductions/pruning, futility, SEE pruning, killer moves,
 * countermove + history heuristics, IID, quiescence with check evasions.
 * Eval: tapered PeSTO tables + mobility, pawn structure, king safety.
 *
 * Build:  g++ -O2 -std=c++17 -o vega vega.cpp
 * Usage:  UCI (Arena, CuteChess, BanksiaGUI, lichess-bot...)
 *         extra commands: "perft N", "bench"
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

using namespace std;
using Clock = chrono::steady_clock;

// ----------------------------------------------------------------- basics
enum { EMPTY = 0, PAWN = 1, KNIGHT, BISHOP, ROOK, QUEEN, KING };
enum { WHITE = 1, BLACK = -1 };
enum { CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8 };

static const int F_EP = 1 << 23, F_CASTLE = 1 << 24, F_DOUBLE = 1 << 25;

static const int KNIGHT_D[8] = {-33, -31, -18, -14, 14, 18, 31, 33};
static const int BISHOP_D[4] = {-17, -15, 15, 17};
static const int ROOK_D[4]   = {-16, -1, 1, 16};
static const int KING_D[8]   = {-17, -16, -15, -1, 1, 15, 16, 17};

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static const char PIECE_CH[7] = {' ', 'p', 'n', 'b', 'r', 'q', 'k'};

static inline int mFrom(int m)  { return m & 127; }
static inline int mTo(int m)    { return (m >> 7) & 127; }
static inline int mPiece(int m) { return (m >> 14) & 7; }
static inline int mCapt(int m)  { return (m >> 17) & 7; }
static inline int mPromo(int m) { return (m >> 20) & 7; }
static inline int encodeMove(int f, int t, int p, int c, int pr, int fl) {
  return f | (t << 7) | (p << 14) | (c << 17) | (pr << 20) | fl;
}
static inline bool isCapture(int m) { return mCapt(m) != 0 || (m & F_EP); }

static string sqName(int sq) {
  string s;
  s += char('a' + (sq & 7));
  s += char('0' + (8 - (sq >> 4)));
  return s;
}
static int nameSq(const string& s) {
  return (8 - (s[1] - '0')) * 16 + (s[0] - 'a');
}

// castling-rights masks
static uint8_t CAST_MASK[128];
static void initCastMask() {
  for (int i = 0; i < 128; i++) CAST_MASK[i] = 15;
  CAST_MASK[116] = 15 & ~(CR_WK | CR_WQ);
  CAST_MASK[112] = 15 & ~CR_WQ;
  CAST_MASK[119] = 15 & ~CR_WK;
  CAST_MASK[4]   = 15 & ~(CR_BK | CR_BQ);
  CAST_MASK[0]   = 15 & ~CR_BQ;
  CAST_MASK[7]   = 15 & ~CR_BK;
}

// ----------------------------------------------------------------- zobrist
static uint64_t Z_PIECE[12][128], Z_SIDE, Z_CAST[16], Z_EP[8];
static uint64_t rng64() {
  static uint64_t s = 0x9E3779B97F4A7C15ULL;
  s ^= s << 13; s ^= s >> 7; s ^= s << 17;
  return s;
}
static void initZobrist() {
  for (auto& row : Z_PIECE) for (auto& v : row) v = rng64();
  Z_SIDE = rng64();
  for (auto& v : Z_CAST) v = rng64();
  for (auto& v : Z_EP) v = rng64();
}
static inline int zIdx(int p) { return p > 0 ? p - 1 : 5 - p; } // -1→6 … -6→11

// ----------------------------------------------------------------- position
struct Undo { uint8_t cast; int8_t ep; int16_t half; uint64_t hash; int move; };

struct Position {
  int8_t board[128];
  int side;
  int castling;
  int ep; // -1 or square
  int halfmove, fullmove;
  int kings[2]; // [white, black]
  uint64_t hash;
  vector<Undo> st;

  void computeHash() {
    hash = 0;
    for (int sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (board[sq]) hash ^= Z_PIECE[zIdx(board[sq])][sq];
    }
    if (side == BLACK) hash ^= Z_SIDE;
    hash ^= Z_CAST[castling];
    if (ep >= 0) hash ^= Z_EP[ep & 7];
  }

  void load(const string& fen) {
    memset(board, 0, sizeof(board));
    st.clear();
    st.reserve(1024);
    istringstream ss(fen);
    string b, stm, cr, eps;
    ss >> b >> stm >> cr >> eps;
    halfmove = 0; fullmove = 1;
    ss >> halfmove >> fullmove;
    int sq = 0;
    for (char c : b) {
      if (c == '/') { sq = (sq & ~15) + 16; continue; }
      if (c >= '1' && c <= '8') { sq += c - '0'; continue; }
      int type = 0;
      switch (tolower(c)) {
        case 'p': type = PAWN; break; case 'n': type = KNIGHT; break;
        case 'b': type = BISHOP; break; case 'r': type = ROOK; break;
        case 'q': type = QUEEN; break; case 'k': type = KING; break;
      }
      int color = isupper(c) ? WHITE : BLACK;
      board[sq] = int8_t(type * color);
      if (type == KING) kings[color == WHITE ? 0 : 1] = sq;
      sq++;
    }
    side = (stm == "w") ? WHITE : BLACK;
    castling = 0;
    if (cr.find('K') != string::npos) castling |= CR_WK;
    if (cr.find('Q') != string::npos) castling |= CR_WQ;
    if (cr.find('k') != string::npos) castling |= CR_BK;
    if (cr.find('q') != string::npos) castling |= CR_BQ;
    ep = (eps.size() == 2) ? nameSq(eps) : -1;
    computeHash();
  }

  bool isAttacked(int sq, int by) const {
    if (by == WHITE) {
      if (!((sq + 15) & 0x88) && board[sq + 15] == PAWN) return true;
      if (!((sq + 17) & 0x88) && board[sq + 17] == PAWN) return true;
    } else {
      if (!((sq - 15) & 0x88) && board[sq - 15] == -PAWN) return true;
      if (!((sq - 17) & 0x88) && board[sq - 17] == -PAWN) return true;
    }
    const int kn = KNIGHT * by, kg = KING * by;
    for (int d : KNIGHT_D) { int t = sq + d; if (!(t & 0x88) && board[t] == kn) return true; }
    for (int d : KING_D)   { int t = sq + d; if (!(t & 0x88) && board[t] == kg) return true; }
    const int bi = BISHOP * by, qu = QUEEN * by, ro = ROOK * by;
    for (int d : BISHOP_D)
      for (int t = sq + d; !(t & 0x88); t += d) {
        int p = board[t];
        if (p) { if (p == bi || p == qu) return true; break; }
      }
    for (int d : ROOK_D)
      for (int t = sq + d; !(t & 0x88); t += d) {
        int p = board[t];
        if (p) { if (p == ro || p == qu) return true; break; }
      }
    return false;
  }

  bool inCheck() const { return isAttacked(kings[side == WHITE ? 0 : 1], -side); }
  bool illegalAfterMove() const {
    int mover = -side;
    return isAttacked(kings[mover == WHITE ? 0 : 1], side);
  }

  int genMoves(int* out, bool capsOnly) const {
    int n = 0;
    const int us = side, them = -side;
    const int dir = us == WHITE ? -16 : 16;
    const int startRank = us == WHITE ? 6 : 1;
    const int promoRank = us == WHITE ? 0 : 7;

    for (int sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      int p = board[sq];
      if (p == 0 || (p > 0) != (us > 0)) continue;
      int type = p * us;

      if (type == PAWN) {
        int fwd = sq + dir;
        if (!board[fwd]) {
          if ((fwd >> 4) == promoRank) {
            out[n++] = encodeMove(sq, fwd, PAWN, 0, QUEEN, 0);
            if (!capsOnly) {
              out[n++] = encodeMove(sq, fwd, PAWN, 0, ROOK, 0);
              out[n++] = encodeMove(sq, fwd, PAWN, 0, BISHOP, 0);
              out[n++] = encodeMove(sq, fwd, PAWN, 0, KNIGHT, 0);
            }
          } else if (!capsOnly) {
            out[n++] = encodeMove(sq, fwd, PAWN, 0, 0, 0);
            if ((sq >> 4) == startRank && !board[fwd + dir])
              out[n++] = encodeMove(sq, fwd + dir, PAWN, 0, 0, F_DOUBLE);
          }
        }
        for (int s2 = -1; s2 <= 1; s2 += 2) {
          int to = sq + dir + s2;
          if (to & 0x88) continue;
          int tp = board[to];
          if (tp && (tp > 0) == (them > 0)) {
            int capt = tp * them;
            if ((to >> 4) == promoRank) {
              out[n++] = encodeMove(sq, to, PAWN, capt, QUEEN, 0);
              out[n++] = encodeMove(sq, to, PAWN, capt, ROOK, 0);
              out[n++] = encodeMove(sq, to, PAWN, capt, BISHOP, 0);
              out[n++] = encodeMove(sq, to, PAWN, capt, KNIGHT, 0);
            } else out[n++] = encodeMove(sq, to, PAWN, capt, 0, 0);
          } else if (to == ep) {
            out[n++] = encodeMove(sq, to, PAWN, PAWN, 0, F_EP);
          }
        }
        continue;
      }

      if (type == KNIGHT || type == KING) {
        const int* deltas = type == KNIGHT ? KNIGHT_D : KING_D;
        for (int i = 0; i < 8; i++) {
          int to = sq + deltas[i];
          if (to & 0x88) continue;
          int tp = board[to];
          if (tp == 0) { if (!capsOnly) out[n++] = encodeMove(sq, to, type, 0, 0, 0); }
          else if ((tp > 0) == (them > 0)) out[n++] = encodeMove(sq, to, type, tp * them, 0, 0);
        }
        continue;
      }

      const int* dirs = type == BISHOP ? BISHOP_D : type == ROOK ? ROOK_D : KING_D;
      int nd = type == QUEEN ? 8 : 4;
      for (int i = 0; i < nd; i++) {
        int d = dirs[i];
        for (int to = sq + d; !(to & 0x88); to += d) {
          int tp = board[to];
          if (tp == 0) { if (!capsOnly) out[n++] = encodeMove(sq, to, type, 0, 0, 0); continue; }
          if ((tp > 0) == (them > 0)) out[n++] = encodeMove(sq, to, type, tp * them, 0, 0);
          break;
        }
      }
    }

    if (!capsOnly) {
      if (us == WHITE) {
        if ((castling & CR_WK) && !board[117] && !board[118] &&
            !isAttacked(116, BLACK) && !isAttacked(117, BLACK) && !isAttacked(118, BLACK))
          out[n++] = encodeMove(116, 118, KING, 0, 0, F_CASTLE);
        if ((castling & CR_WQ) && !board[115] && !board[114] && !board[113] &&
            !isAttacked(116, BLACK) && !isAttacked(115, BLACK) && !isAttacked(114, BLACK))
          out[n++] = encodeMove(116, 114, KING, 0, 0, F_CASTLE);
      } else {
        if ((castling & CR_BK) && !board[5] && !board[6] &&
            !isAttacked(4, WHITE) && !isAttacked(5, WHITE) && !isAttacked(6, WHITE))
          out[n++] = encodeMove(4, 6, KING, 0, 0, F_CASTLE);
        if ((castling & CR_BQ) && !board[3] && !board[2] && !board[1] &&
            !isAttacked(4, WHITE) && !isAttacked(3, WHITE) && !isAttacked(2, WHITE))
          out[n++] = encodeMove(4, 2, KING, 0, 0, F_CASTLE);
      }
    }
    return n;
  }

  void make(int m) {
    const int us = side, them = -side;
    const int from = m & 127, to = (m >> 7) & 127;
    const int piece = (m >> 14) & 7, capt = (m >> 17) & 7, promo = (m >> 20) & 7;

    st.push_back({uint8_t(castling), int8_t(ep), int16_t(halfmove), hash, m});

    if (ep >= 0) hash ^= Z_EP[ep & 7];
    board[from] = 0;
    hash ^= Z_PIECE[zIdx(piece * us)][from];

    if (m & F_EP) {
      int capSq = to + (us == WHITE ? 16 : -16);
      board[capSq] = 0;
      hash ^= Z_PIECE[zIdx(PAWN * them)][capSq];
    } else if (capt) {
      hash ^= Z_PIECE[zIdx(capt * them)][to];
    }

    int placed = (promo ? promo : piece) * us;
    board[to] = int8_t(placed);
    hash ^= Z_PIECE[zIdx(placed)][to];

    if (piece == KING) {
      kings[us == WHITE ? 0 : 1] = to;
      if (m & F_CASTLE) {
        int rf, rt;
        if ((to & 7) == 6) { rf = to + 1; rt = to - 1; } else { rf = to - 2; rt = to + 1; }
        board[rt] = int8_t(ROOK * us);
        board[rf] = 0;
        hash ^= Z_PIECE[zIdx(ROOK * us)][rf] ^ Z_PIECE[zIdx(ROOK * us)][rt];
      }
    }

    hash ^= Z_CAST[castling];
    castling &= CAST_MASK[from] & CAST_MASK[to];
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
    const int them = side, us = -side;
    const int from = m & 127, to = (m >> 7) & 127;
    const int piece = (m >> 14) & 7, capt = (m >> 17) & 7;

    board[from] = int8_t(piece * us);
    if (m & F_EP) {
      board[to] = 0;
      board[to + (us == WHITE ? 16 : -16)] = int8_t(PAWN * them);
    } else {
      board[to] = int8_t(capt ? capt * them : 0);
    }
    if (piece == KING) {
      kings[us == WHITE ? 0 : 1] = from;
      if (m & F_CASTLE) {
        if ((to & 7) == 6) { board[to + 1] = int8_t(ROOK * us); board[to - 1] = 0; }
        else { board[to - 2] = int8_t(ROOK * us); board[to + 1] = 0; }
      }
    }
    castling = u.cast; ep = u.ep; halfmove = u.half; hash = u.hash;
    if (us == BLACK) fullmove--;
    side = us;
    st.pop_back();
  }

  void makeNull() {
    st.push_back({uint8_t(castling), int8_t(ep), int16_t(halfmove), hash, 0});
    if (ep >= 0) hash ^= Z_EP[ep & 7];
    ep = -1;
    halfmove++;
    side = -side;
    hash ^= Z_SIDE;
  }
  void unmakeNull() {
    const Undo& u = st.back();
    castling = u.cast; ep = u.ep; halfmove = u.half; hash = u.hash;
    side = -side;
    st.pop_back();
  }

  int lastMove() const { return st.empty() ? 0 : st.back().move; }

  bool isRepetition() const {
    int n = (int)st.size();
    int limit = min(halfmove, n);
    for (int i = 2; i <= limit; i += 2)
      if (st[n - i].hash == hash) return true;
    return false;
  }

  bool hasNonPawnMaterial(int s) const {
    for (int sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      int p = board[sq] * s;
      if (p >= KNIGHT && p <= QUEEN) return true;
    }
    return false;
  }
};

// ----------------------------------------------------------------- perft
static uint64_t perft(Position& pos, int depth) {
  if (depth == 0) return 1;
  int moves[256];
  int n = pos.genMoves(moves, false);
  uint64_t nodes = 0;
  for (int i = 0; i < n; i++) {
    pos.make(moves[i]);
    if (!pos.illegalAfterMove()) nodes += depth == 1 ? 1 : perft(pos, depth - 1);
    pos.unmake();
  }
  return nodes;
}

// ----------------------------------------------------------------- eval
static const int MG_VAL[7] = {0, 82, 337, 365, 477, 1025, 0};
static const int EG_VAL[7] = {0, 94, 281, 297, 512, 936, 0};
static const int SEE_VAL[7] = {0, 100, 320, 330, 500, 950, 20000};

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

static bool hasEnemyPawnAhead(const int8_t* b, int sq, bool white) {
  int dir = white ? -16 : 16;
  int enemy = white ? -PAWN : PAWN;
  for (int t = sq + dir; !(t & 0x88); t += dir) {
    if (b[t] == enemy) return true;
    if (!((t - 1) & 0x88) && b[t - 1] == enemy) return true;
    if (!((t + 1) & 0x88) && b[t + 1] == enemy) return true;
  }
  return false;
}

static int kingShield(const int8_t* b, int ksq, bool white) {
  int r = ksq >> 4;
  if (white && r < 6) return 0;
  if (!white && r > 1) return 0;
  int dir = white ? -16 : 16;
  int own = white ? PAWN : -PAWN;
  int score = 0;
  for (int df = -1; df <= 1; df++) {
    int s1 = ksq + dir + df, s2 = ksq + 2 * dir + df;
    if (!(s1 & 0x88) && b[s1] == own) score += 12;
    else if (!(s2 & 0x88) && b[s2] == own) score += 6;
    else score -= 10;
  }
  return score;
}

static int evaluate(const Position& pos) {
  const int8_t* b = pos.board;
  int mg = 0, eg = 0, phase = 0;
  int wB = 0, bB = 0, wQ = 0, bQ = 0;

  int wFile[10] = {0}, bFile[10] = {0};
  int wPawns[64], bPawns[64];
  int wpc = 0, bpc = 0;
  for (int sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    if (b[sq] == PAWN)       { wFile[(sq & 7) + 1]++; wPawns[wpc++] = sq; }
    else if (b[sq] == -PAWN) { bFile[(sq & 7) + 1]++; bPawns[bpc++] = sq; }
  }

  bool zoneW[136] = {false}, zoneB[136] = {false};
  int wk = pos.kings[0], bk = pos.kings[1];
  zoneW[wk] = zoneB[bk] = true;
  for (int d : KING_D) {
    int t = wk + d; if (!(t & 0x88)) zoneW[t] = true;
    t = bk + d;     if (!(t & 0x88)) zoneB[t] = true;
  }
  int unitsOnW = 0, unitsOnB = 0;

  for (int sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    int p = b[sq];
    if (!p) continue;
    int t = p > 0 ? p : -p;
    bool white = p > 0;
    int idx = white ? (((sq >> 4) << 3) | (sq & 7)) : ((((sq >> 4) << 3) | (sq & 7)) ^ 56);
    int sgn = white ? 1 : -1;

    mg += sgn * (MG_VAL[t] + MG_PST[t][idx]);
    eg += sgn * (EG_VAL[t] + EG_PST[t][idx]);
    phase += PHASE_W[t];

    if (t == BISHOP) { if (white) wB++; else bB++; }
    else if (t == QUEEN) { if (white) wQ++; else bQ++; }

    if (t >= KNIGHT && t <= QUEEN) {
      int mob = 0;
      int kw = KS_WEIGHT[t];
      if (t == KNIGHT) {
        for (int d : KNIGHT_D) {
          int to = sq + d;
          if (to & 0x88) continue;
          if (b[to] == 0 || (b[to] > 0) != white) mob++;
          if (white) { if (zoneB[to]) unitsOnB += kw; }
          else if (zoneW[to]) unitsOnW += kw;
        }
      } else {
        const int* dirs = t == BISHOP ? BISHOP_D : t == ROOK ? ROOK_D : KING_D;
        int nd = t == QUEEN ? 8 : 4;
        for (int i = 0; i < nd; i++) {
          int d = dirs[i];
          for (int to = sq + d; !(to & 0x88); to += d) {
            if (white) { if (zoneB[to]) unitsOnB += kw; }
            else if (zoneW[to]) unitsOnW += kw;
            if (b[to] == 0) { mob++; continue; }
            if ((b[to] > 0) != white) mob++;
            break;
          }
        }
      }
      mg += sgn * MOB_MG[t] * mob;
      eg += sgn * MOB_EG[t] * mob;
    }

    if (t == ROOK) {
      int f = (sq & 7) + 1;
      int own = white ? wFile[f] : bFile[f];
      int opp = white ? bFile[f] : wFile[f];
      if (own == 0) {
        if (opp == 0) { mg += sgn * 28; eg += sgn * 8; }
        else { mg += sgn * 12; eg += sgn * 6; }
      }
    }
  }

  if (wB >= 2) { mg += 25; eg += 45; }
  if (bB >= 2) { mg -= 25; eg -= 45; }

  if (!wQ) unitsOnB >>= 1;
  if (!bQ) unitsOnW >>= 1;
  mg += KS_TABLE[min(unitsOnB, 63)];
  mg -= KS_TABLE[min(unitsOnW, 63)];

  for (int i = 0; i < wpc; i++) {
    int sq = wPawns[i], f = (sq & 7) + 1, r = sq >> 4;
    if (wFile[f] > 1) { mg += -4; eg += -8; }
    if (wFile[f - 1] == 0 && wFile[f + 1] == 0) { mg += -12; eg += -8; }
    if (!hasEnemyPawnAhead(b, sq, true)) {
      int adv = 7 - r;
      int pm = PASSED_MG[adv], pe = PASSED_EG[adv];
      if (b[sq - 16]) { pm = pm * 2 / 3; pe = pe * 2 / 3; }
      mg += pm; eg += pe;
    }
  }
  for (int i = 0; i < bpc; i++) {
    int sq = bPawns[i], f = (sq & 7) + 1, r = sq >> 4;
    if (bFile[f] > 1) { mg -= -4; eg -= -8; }
    if (bFile[f - 1] == 0 && bFile[f + 1] == 0) { mg -= -12; eg -= -8; }
    if (!hasEnemyPawnAhead(b, sq, false)) {
      int adv = r;
      int pm = PASSED_MG[adv], pe = PASSED_EG[adv];
      if (b[sq + 16]) { pm = pm * 2 / 3; pe = pe * 2 / 3; }
      mg -= pm; eg -= pe;
    }
  }

  mg += kingShield(b, pos.kings[0], true);
  mg -= kingShield(b, pos.kings[1], false);

  if (phase > 24) phase = 24;
  int score = (mg * phase + eg * (24 - phase)) / 24;
  return (pos.side == WHITE ? score : -score) + 14; // tempo
}

// ----------------------------------------------------------------- search
static const int INF = 32000, MATE = 31000, MATE_BOUND = 30000;
static const int MAX_PLY = 96;
static const size_t TT_SIZE = 1 << 22, TT_MASK = TT_SIZE - 1;
enum { TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3 };

struct TTEntry { uint64_t key; int32_t move; int16_t score; int8_t depth; uint8_t flag; uint8_t age; };

static int LMR_TABLE[64][64];
static void initLMR() {
  for (int d = 0; d < 64; d++)
    for (int m = 0; m < 64; m++)
      LMR_TABLE[d][m] = (d && m) ? max(0, (int)lround(0.5 + log(d) * log(m) / 2.4)) : 0;
}

struct Engine {
  Position pos;
  vector<TTEntry> tt;
  uint8_t age = 0;
  int killer1[MAX_PLY] = {0}, killer2[MAX_PLY] = {0};
  int history[2 * 7 * 128] = {0};
  int counter[2 * 7 * 128] = {0};
  int evalStack[MAX_PLY] = {0};
  int pvTable[MAX_PLY][MAX_PLY];
  int pvLen[MAX_PLY] = {0};
  uint64_t nodes = 0;
  Clock::time_point deadline, softDeadline;
  bool useDeadline = false;
  bool aborted = false;

  Engine() { tt.resize(TT_SIZE); }

  void clearTables() {
    fill(tt.begin(), tt.end(), TTEntry{});
    memset(history, 0, sizeof(history));
    memset(counter, 0, sizeof(counter));
    memset(killer1, 0, sizeof(killer1));
    memset(killer2, 0, sizeof(killer2));
  }

  void checkTime() {
    if ((nodes & 2047) == 0 && useDeadline && Clock::now() > deadline) aborted = true;
  }

  int histIdx(int s, int piece, int to) const { return (s == WHITE ? 0 : 7 * 128) + piece * 128 + (to & 127); }
  int cmIdx(int prevM, int stm) const { return (stm == WHITE ? 0 : 7 * 128) + mPiece(prevM) * 128 + (mTo(prevM) & 127); }

  int smallestAttacker(int to, int s) const {
    const int8_t* b = pos.board;
    int t;
    if (s == WHITE) {
      t = to + 15; if (!(t & 0x88) && b[t] == PAWN) return t;
      t = to + 17; if (!(t & 0x88) && b[t] == PAWN) return t;
    } else {
      t = to - 15; if (!(t & 0x88) && b[t] == -PAWN) return t;
      t = to - 17; if (!(t & 0x88) && b[t] == -PAWN) return t;
    }
    for (int d : KNIGHT_D) { t = to + d; if (!(t & 0x88) && b[t] == KNIGHT * s) return t; }
    for (int d : BISHOP_D)
      for (t = to + d; !(t & 0x88); t += d) { int p = b[t]; if (p) { if (p == BISHOP * s) return t; break; } }
    for (int d : ROOK_D)
      for (t = to + d; !(t & 0x88); t += d) { int p = b[t]; if (p) { if (p == ROOK * s) return t; break; } }
    for (int d : KING_D)
      for (t = to + d; !(t & 0x88); t += d) { int p = b[t]; if (p) { if (p == QUEEN * s) return t; break; } }
    for (int d : KING_D) { t = to + d; if (!(t & 0x88) && b[t] == KING * s) return t; }
    return -1;
  }

  int see(int m) {
    if (m & F_EP) return 0;
    int8_t* b = pos.board;
    int to = mTo(m), from = mFrom(m);
    int gain[34];
    int rsq[34]; int8_t rp[34];
    int d = 0, nr = 0;
    gain[0] = SEE_VAL[mCapt(m)];
    int occVal = SEE_VAL[mPiece(m)];
    rsq[nr] = from; rp[nr++] = b[from]; b[from] = 0;
    int s = -pos.side;
    for (;;) {
      int a = smallestAttacker(to, s);
      if (a < 0 || d >= 30) break;
      d++;
      gain[d] = occVal - gain[d - 1];
      if (max(-gain[d - 1], gain[d]) < 0) break;
      occVal = SEE_VAL[abs(b[a])];
      rsq[nr] = a; rp[nr++] = b[a]; b[a] = 0;
      s = -s;
    }
    while (nr > 0) { nr--; b[rsq[nr]] = rp[nr]; }
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

    bool chk = pos.inCheck();
    int best;
    if (chk) best = -MATE + ply;
    else {
      best = evaluate(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }

    int moves[256], scores[256];
    int n = pos.genMoves(moves, !chk);
    scoreMoves(moves, scores, n, 0, ply);
    int legal = 0;
    for (int i = 0; i < n; i++) {
      int m = pickMove(moves, scores, n, i);
      if (!chk && !mPromo(m)) {
        if (scores[i] < -900000000) continue;                    // losing capture
        if (best + SEE_VAL[mCapt(m)] + 200 <= alpha) continue;   // delta
      }
      pos.make(m);
      if (pos.illegalAfterMove()) { pos.unmake(); continue; }
      legal++;
      int score = -qsearch(-beta, -alpha, ply + 1);
      pos.unmake();
      if (aborted) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }
    if (chk && legal == 0) return -MATE + ply;
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

    size_t idx = pos.hash & TT_MASK;
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

  // returns best move (0 if none). infoOut: print UCI info lines.
  int think(int maxDepth, long movetimeMs, bool infoOut) {
    nodes = 0;
    aborted = false;
    useDeadline = movetimeMs > 0;
    auto t0 = Clock::now();
    if (useDeadline) {
      deadline = t0 + chrono::milliseconds(movetimeMs);
      softDeadline = t0 + chrono::milliseconds(movetimeMs * 6 / 10);
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

    for (int depth = 1; depth <= maxDepth; depth++) {
      int alpha = depth >= 5 ? prevScore - 35 : -INF;
      int beta  = depth >= 5 ? prevScore + 35 : INF;

      for (;;) {
        int a = alpha;
        int iterBest = 0, iterScore = -INF;
        scoreMoves(rootMoves, rootScores, n, bestMove, 0);

        for (int i = 0; i < n; i++) {
          int m = pickMove(rootMoves, rootScores, n, i);
          pos.make(m);
          int score;
          if (i == 0) score = -search(depth - 1, -beta, -a, 1, true);
          else {
            score = -search(depth - 1, -a - 1, -a, 1, true);
            if (score > a && score < beta && !aborted) score = -search(depth - 1, -beta, -a, 1, true);
          }
          pos.unmake();
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

        bestMove = iterBest ? iterBest : bestMove;
        bestScore = iterScore;
        prevScore = iterScore;

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
    return bestMove;
  }
};

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
  struct { const char* fen; int depth; uint64_t want; } tests[] = {
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
    uint64_t got = perft(eng.pos, t.depth);
    bool pass = got == t.want;
    if (!pass) ok = false;
    printf("perft d%d %s: %llu (beklenen %llu) %s\n", t.depth, t.fen, (unsigned long long)got,
           (unsigned long long)t.want, pass ? "OK" : "FAIL");
  }
  auto ms = chrono::duration_cast<chrono::milliseconds>(Clock::now() - t0).count();
  printf("bench: %s, %lld ms\n", ok ? "ALL PASS" : "FAILURES", (long long)ms);
  fflush(stdout);
}

int main() {
  initCastMask();
  initZobrist();
  initEvalTables();
  initLMR();

  Engine eng;
  eng.pos.load(START_FEN);

  string line;
  while (getline(cin, line)) {
    istringstream ss(line);
    string cmd;
    ss >> cmd;

    if (cmd == "uci") {
      printf("id name VEGA 1.0\n");
      printf("id author SigmaBoy project\n");
      printf("uciok\n");
      fflush(stdout);
    } else if (cmd == "isready") {
      printf("readyok\n");
      fflush(stdout);
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
      uint64_t nodes = perft(eng.pos, d);
      auto ms = chrono::duration_cast<chrono::milliseconds>(Clock::now() - t0).count();
      printf("perft %d: %llu dugum, %lld ms (%.1fM/s)\n", d, (unsigned long long)nodes,
             (long long)ms, ms ? nodes / 1000.0 / ms : 0);
      fflush(stdout);
    } else if (cmd == "bench") {
      runBench(eng);
    } else if (cmd == "quit") {
      break;
    }
  }
  return 0;
}

// Распознавание доски со скриншота.
// 1) detectBoard  — ищет квадрат 8x8 с шахматным узором.
// 2) extractFeatures — для каждой клетки: маска "не фон" + яркость.
// 3) recognize — перебирает позиции на 0..2 полухода вперёд от известной
//    и выбирает ту, что лучше всего совпадает с картинкой по образцам фигур.

const SQ = 32;      // размер клетки при нарезке, px
const INNER0 = 4;   // внутренняя область клетки [4..28)
const INNER = 24;
const FG_T = 60;    // порог отличия пикселя от фона (сумма |dR|+|dG|+|dB|)

// ---------- Загрузка ----------
export async function loadImage(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch (_) { /* fallback */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(blob);
  });
}

function rasterize(img, maxDim) {
  const k = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, k };
}

// ---------- Поиск доски ----------
function integral(r) {
  const { data, w, h } = r;
  const W = w + 1;
  const I = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  for (let y = 0; y < h; y++) {
    const s = [0, 0, 0];
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        s[c] += data[p + c];
        I[c][(y + 1) * W + x + 1] = I[c][y * W + x + 1] + s[c];
      }
    }
  }
  return { I, W };
}

function patch(ii, c, x0, y0, x1, y1) {
  const { I, W } = ii, A = I[c];
  return (A[y1 * W + x1] - A[y0 * W + x1] - A[y1 * W + x0] + A[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
}

// Оценка: насколько сетка (x,y,s) похожа на шахматную доску.
const _cols = new Float64Array(64 * 3);
function med4(a, b, c, d) {
  // медиана 4 чисел = среднее двух средних
  const lo1 = a < b ? a : b, hi1 = a < b ? b : a;
  const lo2 = c < d ? c : d, hi2 = c < d ? d : c;
  const midLo = lo1 > lo2 ? lo1 : lo2;
  const midHi = hi1 < hi2 ? hi1 : hi2;
  return (midLo + midHi) / 2;
}
function gridScore(ii, x, y, s, inset, psize) {
  const q = s / 8;
  const a = Math.max(0, Math.floor(q * inset));
  const p = Math.max(1, Math.round(q * psize));
  const { I, W } = ii;
  const area = p * p;
  let s0r = 0, s0g = 0, s0b = 0, s1r = 0, s1g = 0, s1b = 0;
  for (let r = 0; r < 8; r++) {
    const sy = Math.floor(y + r * q), ey = Math.floor(y + (r + 1) * q);
    const ya = sy + a, yb = ey - a - p;
    for (let f = 0; f < 8; f++) {
      const sx = Math.floor(x + f * q), ex = Math.floor(x + (f + 1) * q);
      const xa = sx + a, xb = ex - a - p;
      const i = (r * 8 + f) * 3;
      for (let c = 0; c < 3; c++) {
        const A = I[c];
        const pm = (x0, y0) => (A[(y0 + p) * W + x0 + p] - A[y0 * W + x0 + p] - A[(y0 + p) * W + x0] + A[y0 * W + x0]) / area;
        _cols[i + c] = med4(pm(xa, ya), pm(xb, ya), pm(xa, yb), pm(xb, yb));
      }
      if ((r + f) & 1) { s1r += _cols[i]; s1g += _cols[i + 1]; s1b += _cols[i + 2]; }
      else { s0r += _cols[i]; s0g += _cols[i + 1]; s0b += _cols[i + 2]; }
    }
  }
  const m0 = [s0r / 32, s0g / 32, s0b / 32], m1 = [s1r / 32, s1g / 32, s1b / 32];
  let within = 0;
  for (let k = 0; k < 64; k++) {
    const m = (((k >> 3) + (k & 7)) & 1) ? m1 : m0;
    const d0 = _cols[k * 3] - m[0], d1 = _cols[k * 3 + 1] - m[1], d2 = _cols[k * 3 + 2] - m[2];
    within += d0 * d0 + d1 * d1 + d2 * d2;
  }
  within /= 64;
  const b0 = m0[0] - m1[0], b1 = m0[1] - m1[1], b2 = m0[2] - m1[2];
  const between = b0 * b0 + b1 * b1 + b2 * b2;
  if (between < 150) return 0; // слишком слабый контраст — не доска
  return between / (within + 30);
}

// hint — рамка с прошлого скрина того же размера: если она всё ещё хороша, ищем только рядом
export function detectBoard(img, hint) {
  if (hint) {
    const big = rasterize(img, 900);
    const iiB = integral(big);
    const k = big.k;
    const r = refine(iiB, big, hint.x * k, hint.y * k, hint.size * k, 2);
    if (r.score >= hint.score * 0.75) return { x: r.x / k, y: r.y / k, size: r.s / k, score: r.score };
  }
  // Грубый поиск на маленькой копии
  const small = rasterize(img, 220);
  const iiS = integral(small);
  const minD = Math.min(small.w, small.h);
  let best = { score: -1 };
  for (let s = Math.round(minD * 0.3); s <= minD; s += 2) {
    for (let y = 0; y + s <= small.h; y += 3) {
      for (let x = 0; x + s <= small.w; x += 3) {
        const sc = gridScore(iiS, x, y, s, 0.12, 0.2);
        if (sc > best.score) best = { score: sc, x, y, s };
      }
    }
  }
  if (best.score <= 0) return null;

  // Уточнение на крупной копии
  const big = rasterize(img, 900);
  const iiB = integral(big);
  const ratio = big.w / small.w;
  let fine = refine(iiB, big, best.x * ratio, best.y * ratio, best.s * ratio, Math.ceil(2 * ratio));
  if (fine.score <= 0) fine = { x: best.x * ratio, y: best.y * ratio, s: best.s * ratio, score: best.score };
  const k = big.k;
  return { x: fine.x / k, y: fine.y / k, size: fine.s / k, score: fine.score };
}

function refine(iiB, big, cx, cy, cs, span) {
  // сначала шаг 2px, потом 1px вокруг лучшего
  let fine = { score: -1 };
  const minDB = Math.min(big.w, big.h);
  const scan = (x0, y0, s0, sp, ss, step) => {
    for (let s = Math.round(s0 - ss); s <= Math.round(s0 + ss); s += step) {
      if (s < 16 || s > minDB) continue;
      for (let y = Math.round(y0 - sp); y <= Math.round(y0 + sp); y += step) {
        if (y < 0 || y + s > big.h) continue;
        for (let x = Math.round(x0 - sp); x <= Math.round(x0 + sp); x += step) {
          if (x < 0 || x + s > big.w) continue;
          const sc = gridScore(iiB, x, y, s, 0.04, 0.12);
          if (sc > fine.score) fine = { score: sc, x, y, s };
        }
      }
    }
  };
  scan(cx, cy, cs, span, span, 2);
  if (fine.score > 0) scan(fine.x, fine.y, fine.s, 2, 2, 1);
  return fine;
}

// ---------- Признаки клеток ----------
// Индекс клетки: rank*8 + file (a1 = 0, h8 = 63)
export function squareIndexAt(row, col, flipped) {
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row : 7 - row;
  return rank * 8 + file;
}

export function extractFeatures(img, box, flipped) {
  const N = SQ * 8;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.x, box.y, box.size, box.size, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const feats = new Array(64);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const ox = col * SQ, oy = row * SQ;
      // фон = медиана по кольцу у края клетки
      const ring = [[], [], []];
      for (let t = 1; t <= 2; t++) {
        for (let i = 2; i < SQ - 2; i++) {
          for (const [px, py] of [[i, t], [i, SQ - 1 - t], [t, i], [SQ - 1 - t, i]]) {
            const p = ((oy + py) * N + ox + px) * 4;
            ring[0].push(d[p]); ring[1].push(d[p + 1]); ring[2].push(d[p + 2]);
          }
        }
      }
      const bg = ring.map(a => { a.sort((m, n) => m - n); return a[a.length >> 1]; });
      const fg = new Uint8Array(INNER * INNER);
      const lum = new Uint8Array(INNER * INNER);
      let cnt = 0;
      for (let y = 0; y < INNER; y++) {
        for (let x = 0; x < INNER; x++) {
          const p = ((oy + INNER0 + y) * N + ox + INNER0 + x) * 4;
          const diff = Math.abs(d[p] - bg[0]) + Math.abs(d[p + 1] - bg[1]) + Math.abs(d[p + 2] - bg[2]);
          const i = y * INNER + x;
          lum[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
          if (diff > FG_T) { fg[i] = 1; cnt++; }
        }
      }
      feats[squareIndexAt(row, col, flipped)] = { fg, lum, cnt };
    }
  }
  return feats;
}

// Расстояние между клетками (0 = одинаковые, 1 = совсем разные), с допуском сдвига ±1px
function dist(A, B) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let s = 0, n = 0;
      for (let y = 1; y < INNER - 1; y++) {
        const yb = y + dy;
        for (let x = 1; x < INNER - 1; x++) {
          const i = y * INNER + x, j = yb * INNER + x + dx;
          const a = A.fg[i], b = B.fg[j];
          if (a !== b) s += 1;
          else if (a) s += Math.min(1, Math.abs(A.lum[i] - B.lum[j]) / 110);
          n++;
        }
      }
      if (s < best) best = s / n;
    }
  }
  return best;
}

// ---------- Сопоставление с позицией ----------
const CODES = ['e', 'wp', 'wn', 'wb', 'wr', 'wq', 'wk', 'bp', 'bn', 'bb', 'br', 'bq', 'bk'];

export function boardCodes(chess) {
  // chess.board(): [0] = 8-я горизонталь
  const b = chess.board();
  const out = new Array(64);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      out[(7 - r) * 8 + f] = p ? p.color + p.type : 'e';
    }
  }
  return out;
}

function makeExemplars(feats, codes, tag) {
  return feats.map((ft, sq) => ({ code: codes[sq], ft, sq, tag }));
}

function costTable(feats, pool, selfTag) {
  // cost[sq][code] = мин. расстояние до образцов этого типа
  return feats.map((ft, sq) => {
    const row = {};
    for (const c of CODES) row[c] = 1;
    for (const ex of pool) {
      if (ex.tag === selfTag && ex.sq === sq) continue; // leave-one-out
      const cur = row[ex.code];
      if (cur < 0.02) continue;
      const v = dist(ft, ex.ft);
      if (v < cur) row[ex.code] = v;
    }
    return row;
  });
}

function scoreCodes(cost, codes) {
  let s = 0;
  for (let i = 0; i < 64; i++) s += cost[i][codes[i]];
  return s;
}

// Все позиции на 0..2 полухода вперёд
function candidates(chess) {
  const out = [{ moves: [], codes: boardCodes(chess) }];
  for (const m1 of chess.moves({ verbose: true })) {
    chess.move(m1);
    out.push({ moves: [m1], codes: boardCodes(chess) });
    for (const m2 of chess.moves({ verbose: true })) {
      chess.move(m2);
      out.push({ moves: [m1, m2], codes: boardCodes(chess) });
      chess.undo();
    }
    chess.undo();
  }
  return out;
}

const PLY_PENALTY = 0.04;

function rank(cands, cost) {
  for (const c of cands) c.score = scoreCodes(cost, c.codes) + c.moves.length * PLY_PENALTY;
  cands.sort((a, b) => a.score - b.score);
  return cands;
}

/**
 * pool — массив образцов из прошлых скриншотов (мутируется: добавляются новые).
 * Возвращает { moves, score, margin, uncertain }.
 */
export function recognize(feats, chess, pool, shotId) {
  const cands = candidates(chess);
  let ranked;
  if (pool.length === 0) {
    // Первый скриншот: калибруемся на нём же (leave-one-out)
    let codes = boardCodes(chess);
    for (let iter = 0; iter < 2; iter++) {
      const tmp = makeExemplars(feats, codes, shotId);
      ranked = rank(cands, costTable(feats, tmp, shotId));
      codes = ranked[0].codes;
    }
  } else {
    ranked = rank(cands, costTable(feats, pool, null));
  }
  const best = ranked[0];
  const second = ranked[1];
  const margin = second ? second.score - best.score : 1;

  // Обновляем пул образцов: держим данные последних 3 скриншотов
  pool.push(...makeExemplars(feats, best.codes, shotId));
  const tags = [...new Set(pool.map(e => e.tag))];
  if (tags.length > 3) {
    const drop = tags[0];
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i].tag === drop) pool.splice(i, 1);
  }

  return {
    moves: best.moves,
    score: best.score,
    margin,
    uncertain: margin < 0.1 || best.score > 16,
  };
}

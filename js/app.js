import { Chess } from '../vendor/chess.js';
import { Engine, pickBuild } from './engine.js';
import { BoardView } from './board.js';
import { PIECE_IMG } from './pieces.js';
import { loadImage, detectBoard, extractFeatures, recognize } from './vision.js';

const $ = (id) => document.getElementById(id);
const PIECE_RU = { p: 'Пешка', n: 'Конь', b: 'Слон', r: 'Ладья', q: 'Ферзь', k: 'Король' };
const PIECE_ACC = { p: 'пешку', n: 'коня', b: 'слона', r: 'ладью', q: 'ферзя', k: 'короля' };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const store = {
  get(k, d) { try { const v = localStorage.getItem('cb.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('cb.' + k, JSON.stringify(v)); } catch (_) { /* нет хранилища */ } },
};

const S = {
  color: store.get('color', 'w'),     // за кого играет пользователь
  think: store.get('think', 5000),    // мс на ход, 0 = без ограничения
  multipv: store.get('multipv', 3),
  flip: false,                        // ручной переворот доски
  mode: 'play',                       // 'play' | 'edit'
  chess: new Chess(),
  startFen: START,
  redo: [],
  selected: null,
  an: { fen: null, lines: [], done: false },
  token: 0,
  engineReady: false,
  build: null,
  edit: { pieces: {}, turn: 'w', tool: null, selected: null },
  // распознавание скриншотов
  vis: { pool: [], shot: 0, img: null, box: null, manualBox: null, autoBox: null, lastRecog: null },
};

// ---------- Утилиты ----------
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function piecesFromChess(chess) {
  const out = {};
  const b = chess.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = b[r][f];
    if (p) out['abcdefgh'[f] + (8 - r)] = p.color + p.type;
  }
  return out;
}

function uciToMove(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch (_) { return null; }
}

function pvToSan(fen, pv, max = 8) {
  const c = new Chess(fen);
  const out = [];
  for (const uci of pv.slice(0, max)) {
    try { out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san); } catch (_) { break; }
  }
  return out;
}

function moveText(m) {
  if (m.san.startsWith('O-O-O')) return 'Длинная рокировка';
  if (m.san.startsWith('O-O')) return 'Короткая рокировка';
  let t = `${PIECE_RU[m.piece]} ${m.from} → ${m.to}`;
  if (m.captured) t += ` (бьёт ${PIECE_ACC[m.captured]})`;
  if (m.promotion) t += `, превращение в ${PIECE_ACC[m.promotion]}`;
  return t;
}

// оценка с точки зрения пользователя
function evalFor(line, fen) {
  const stm = fen.split(' ')[1];
  const sign = stm === S.color ? 1 : -1;
  if (line.mate !== null && line.mate !== undefined) {
    const m = line.mate * sign;
    return { text: m > 0 ? `#${m}` : `#-${-m}`, frac: m > 0 ? 1 : 0, cp: m > 0 ? 10000 : -10000 };
  }
  const cp = line.cp * sign;
  return { text: (cp > 0 ? '+' : cp < 0 ? '−' : '') + Math.abs(cp / 100).toFixed(2), frac: 1 / (1 + Math.exp(-cp / 300)), cp };
}

function verdict(cp) {
  if (cp >= 10000) return 'ставишь мат';
  if (cp <= -10000) return 'тебе грозит мат';
  if (cp > 300) return 'выигрываешь';
  if (cp > 100) return 'большой перевес';
  if (cp > 40) return 'небольшой перевес';
  if (cp >= -40) return 'равно';
  if (cp >= -100) return 'чуть хуже';
  if (cp >= -300) return 'хуже';
  return 'проигрываешь';
}

// ---------- Доска ----------
const view = new BoardView($('board'), {
  onTap: (sq, info) => (S.mode === 'edit' ? editTap(sq) : playTap(sq, info)),
  onDrop: (from, to) => (S.mode === 'edit' ? editDrop(from, to) : playDrop(from, to)),
});

function orientation() { return (S.color === 'b') !== S.flip; }

function renderBoard() {
  view.setFlipped(orientation());
  if (S.mode === 'edit') {
    const marks = {};
    if (S.edit.selected) marks[S.edit.selected] = ['sel'];
    view.set(S.edit.pieces, marks, []);
    return;
  }
  const c = S.chess;
  const marks = {};
  const add = (sq, cls) => { (marks[sq] ||= []).push(cls); };
  const h = c.history({ verbose: true });
  if (h.length) { add(h.at(-1).from, 'last'); add(h.at(-1).to, 'last'); }
  if (S.selected) {
    add(S.selected, 'sel');
    for (const m of c.moves({ square: S.selected, verbose: true })) add(m.to, c.get(m.to) ? 'capture' : 'target');
  }
  if (c.inCheck()) {
    const k = Object.entries(piecesFromChess(c)).find(([, v]) => v === c.turn() + 'k');
    if (k) add(k[0], 'check');
  }
  view.set(piecesFromChess(c), marks, arrowsFromAnalysis());
}

function arrowsFromAnalysis() {
  if (S.mode !== 'play' || S.an.fen !== S.chess.fen()) return [];
  const mine = S.chess.turn() === S.color;
  const out = [];
  S.an.lines.forEach((l, i) => {
    if (!l.pv[0]) return;
    if (!mine && i > 0) return;
    const kind = !mine ? 'opp' : i === 0 ? 'best' : 'alt';
    out.push({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), kind });
  });
  // не рисуем вторую стрелку поверх главной
  return out.filter((a, i) => i === 0 || !(a.from === out[0].from && a.to === out[0].to));
}

// ---------- Режим партии: ввод ходов ----------
function playTap(sq) {
  const c = S.chess;
  if (c.isGameOver()) return;
  if (S.selected) {
    if (sq === S.selected) { S.selected = null; renderBoard(); return; }
    const legal = c.moves({ square: S.selected, verbose: true }).filter(m => m.to === sq);
    if (legal.length) { tryMove(S.selected, sq, legal); return; }
  }
  const p = c.get(sq);
  if (p && p.color === c.turn()) {
    S.selected = sq;
  } else {
    S.selected = null;
    if (p) wrongSideHint();
  }
  renderBoard();
}

function playDrop(from, to) {
  const c = S.chess;
  const p = c.get(from);
  S.selected = null;
  if (!p || c.isGameOver()) { renderBoard(); return; }
  if (p.color !== c.turn()) { wrongSideHint(); renderBoard(); return; }
  const legal = c.moves({ square: from, verbose: true }).filter(m => m.to === to);
  if (!legal.length) { toast('Так ходить нельзя'); renderBoard(); return; }
  tryMove(from, to, legal);
}

function wrongSideHint() {
  if (S.chess.turn() === S.color) toast('Сейчас твой ход. Нажми «Сделал ход» или сходи своей фигурой.');
  else toast('Сейчас ход соперника — передвинь его фигуру так, как он сходил.');
}

async function tryMove(from, to, legal) {
  let promotion;
  if (legal.some(m => m.promotion)) {
    promotion = await askPromotion(S.chess.turn());
    if (!promotion) { S.selected = null; renderBoard(); return; }
  }
  applyMove({ from, to, promotion });
}

function applyMove(mv) {
  try { S.chess.move(mv); } catch (_) { toast('Так ходить нельзя'); return; }
  S.redo = [];
  S.selected = null;
  S.vis.lastRecog = null;
  positionChanged();
}

function askPromotion(color) {
  return new Promise((res) => {
    const box = $('promo');
    const row = $('promo-row');
    row.replaceChildren();
    for (const t of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.backgroundImage = `url("${PIECE_IMG[color + t]}")`;
      b.setAttribute('aria-label', PIECE_RU[t]);
      b.onclick = () => { box.hidden = true; res(t); };
      row.append(b);
    }
    $('promo-cancel').onclick = () => { box.hidden = true; res(null); };
    box.hidden = false;
  });
}

// ---------- Анализ ----------
function positionChanged() {
  renderAll();
  analyze();
}

function gameOverText() {
  const c = S.chess;
  if (c.isCheckmate()) return c.turn() === S.color ? 'Мат. Партия проиграна.' : 'Мат! Ты победил.';
  if (c.isStalemate()) return 'Пат — ничья.';
  if (c.isThreefoldRepetition()) return 'Троекратное повторение — ничья.';
  if (c.isInsufficientMaterial()) return 'Мало материала — ничья.';
  if (c.isDraw()) return 'Ничья по правилу 50 ходов.';
  return null;
}

async function analyze() {
  const token = ++S.token;
  const fen = S.chess.fen();
  S.an = { fen, lines: [], done: false };
  renderHint();
  if (S.mode !== 'play' || gameOverText()) { if (engine) engine.stop(); return; }
  if (!S.engineReady) return;
  const opts = S.think ? { movetime: S.think, multipv: S.multipv } : { infinite: true, multipv: S.multipv };
  let last = 0;
  try {
    const res = await engine.analyze(fen, opts, (lines) => {
      if (token !== S.token) return;
      S.an.lines = lines;
      const now = performance.now();
      if (now - last > 120) { last = now; renderAnalysis(); }
    });
    if (token !== S.token) return;
    if (res.lines.length) S.an.lines = res.lines;
    S.an.done = true;
    renderAnalysis();
    if (S.chess.turn() === S.color && navigator.vibrate) navigator.vibrate(25);
  } catch (e) {
    console.error(e);
    if (token === S.token) setEngineStatus('Движок не ответил — обнови страницу', true);
  }
}

function renderAnalysis() {
  view.setArrows(arrowsFromAnalysis());
  renderHint();
  renderLines();
}

function bestMove() {
  const l = S.an.lines[0];
  if (!l || S.an.fen !== S.chess.fen()) return null;
  return uciToMove(S.an.fen, l.pv[0]);
}

function renderHint() {
  const over = gameOverText();
  const hint = $('hint');
  const best = bestMove();
  const mine = S.chess.turn() === S.color;
  const l0 = S.an.fen === S.chess.fen() ? S.an.lines[0] : null;
  const ev = l0 ? evalFor(l0, S.an.fen) : null;
  $('eval-fill').style.height = ev ? (ev.frac * 100).toFixed(1) + '%' : '50%';
  $('eval-text').textContent = ev ? `${ev.text} · ${verdict(ev.cp)}` : '';
  $('depth').textContent = l0 ? `глубина ${l0.depth}${l0.nps ? ` · ${(l0.nps / 1e6).toFixed(1)} млн поз/с` : ''}` : '';
  $('btn-played').hidden = true;
  $('btn-opp').hidden = true;

  if (S.mode === 'edit') {
    hint.dataset.kind = 'wait';
    $('hint-label').textContent = 'Расстановка';
    $('hint-title').textContent = 'Расставь фигуры как в игре';
    $('hint-sub').textContent = 'Выбери фигуру снизу и тапай по клеткам. Перетаскивай, чтобы переставить. Потом «Готово».';
    return;
  }
  if (over) {
    hint.dataset.kind = 'over';
    $('hint-label').textContent = 'Партия окончена';
    $('hint-title').textContent = over;
    $('hint-sub').textContent = 'Нажми «Новая», чтобы сыграть ещё.';
    return;
  }
  if (!S.engineReady) {
    hint.dataset.kind = 'wait';
    $('hint-label').textContent = mine ? 'Твой ход' : 'Ход соперника';
    $('hint-title').textContent = 'Движок загружается…';
    $('hint-sub').textContent = 'Первый запуск качает ~7 МБ, потом работает офлайн.';
    return;
  }
  if (mine) {
    hint.dataset.kind = best ? (S.an.done ? 'move' : 'think') : 'think';
    $('hint-label').textContent = S.an.done || !S.think ? 'Твой ход — лучший' : 'Твой ход — считаю…';
    $('hint-title').textContent = best ? moveText(best) : 'Считаю…';
    $('hint-sub').textContent = best ? `${best.san} · сходи так в игре и нажми кнопку` : '';
    if (best) { $('btn-played').hidden = false; $('btn-played').textContent = `✓ Сделал ход ${best.san}`; }
  } else {
    hint.dataset.kind = 'opp';
    $('hint-label').textContent = 'Ход соперника';
    $('hint-title').textContent = 'Введи ход соперника';
    $('hint-sub').textContent = best
      ? `Скорее всего он сыграет ${best.san} (синяя стрелка). Если сходил иначе — передвинь его фигуру на доске.`
      : 'Тапни его фигуру и клетку, куда она пошла, или перетащи. Можно скинуть скриншот.';
    if (best) { $('btn-opp').hidden = false; $('btn-opp').textContent = `Соперник сыграл ${best.san}`; }
  }
}

function renderLines() {
  const list = $('lines');
  list.replaceChildren();
  if (S.an.fen !== S.chess.fen()) return;
  S.an.lines.forEach((l, i) => {
    const ev = evalFor(l, S.an.fen);
    const san = pvToSan(S.an.fen, l.pv);
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="line${i === 0 ? ' top' : ''}"><span class="ev">${ev.text}</span><span class="pv"><b>${san[0] || ''}</b> ${san.slice(1).join(' ')}</span></button>`;
    li.firstChild.onclick = () => {
      const m = uciToMove(S.an.fen, l.pv[0]);
      if (m) applyMove({ from: m.from, to: m.to, promotion: m.promotion });
    };
    list.append(li);
  });
}

// ---------- Общая отрисовка ----------
function renderAll() {
  document.body.dataset.mode = S.mode;
  renderBoard();
  renderHint();
  renderLines();
  const h = S.chess.history();
  const list = $('moves');
  list.replaceChildren();
  const sf = (S.startFen || START).split(' ');
  const blackFirst = sf[1] === 'b';
  let i = 0, n = +sf[5] || 1;
  if (blackFirst && h.length) {
    list.insertAdjacentHTML('beforeend', `<li><b>${n}.</b><span>…</span><span>${h[0]}</span></li>`);
    i = 1; n++;
  }
  for (; i < h.length; i += 2, n++) {
    list.insertAdjacentHTML('beforeend', `<li><b>${n}.</b><span>${h[i]}</span><span>${h[i + 1] || ''}</span></li>`);
  }
  list.scrollTop = list.scrollHeight;
  document.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', b.dataset.color === S.color));
  document.querySelectorAll('[data-think]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.think === S.think));
  document.querySelectorAll('[data-multipv]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.multipv === S.multipv));
  $('undo').disabled = h.length === 0;
  $('redo').disabled = S.redo.length === 0;
  renderEditor();
}

// ---------- Редактор позиции ----------
function enterEdit() {
  S.mode = 'edit';
  S.selected = null;
  S.edit = { pieces: piecesFromChess(S.chess), turn: S.chess.turn(), tool: null, selected: null };
  if (engine) engine.stop();
  S.token++;
  renderAll();
}

function renderEditor() {
  const pal = $('palette');
  if (!pal.childElementCount) {
    for (const code of ['wk', 'wq', 'wr', 'wb', 'wn', 'wp', 'bk', 'bq', 'br', 'bb', 'bn', 'bp']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tool = code;
      b.style.backgroundImage = `url("${PIECE_IMG[code]}")`;
      b.setAttribute('aria-label', (code[0] === 'w' ? 'Белый ' : 'Чёрный ') + PIECE_RU[code[1]].toLowerCase());
      pal.append(b);
    }
    const x = document.createElement('button');
    x.type = 'button'; x.dataset.tool = 'x'; x.className = 'eraser'; x.textContent = '✕';
    x.setAttribute('aria-label', 'Ластик');
    pal.append(x);
    pal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      S.edit.tool = S.edit.tool === b.dataset.tool ? null : b.dataset.tool;
      S.edit.selected = null;
      renderAll();
    });
  }
  pal.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.edit.tool));
  document.querySelectorAll('[data-turn]').forEach(b => b.setAttribute('aria-pressed', b.dataset.turn === S.edit.turn));
}

function editTap(sq) {
  const E = S.edit;
  if (E.tool === 'x') delete E.pieces[sq];
  else if (E.tool) {
    if (E.pieces[sq] === E.tool) delete E.pieces[sq];
    else E.pieces[sq] = E.tool;
  } else if (E.selected) {
    if (E.selected !== sq) { E.pieces[sq] = E.pieces[E.selected]; delete E.pieces[E.selected]; }
    E.selected = null;
  } else if (E.pieces[sq]) {
    E.selected = sq;
  }
  renderBoard();
}

function editDrop(from, to) {
  const E = S.edit;
  if (E.pieces[from]) { E.pieces[to] = E.pieces[from]; delete E.pieces[from]; }
  E.selected = null;
  renderBoard();
}

function editorFen() {
  const P = S.edit.pieces;
  let rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = '', empty = 0;
    for (const f of 'abcdefgh') {
      const p = P[f + r];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p[0] === 'w' ? p[1].toUpperCase() : p[1];
    }
    rows.push(row + (empty || ''));
  }
  let castle = '';
  if (P.e1 === 'wk') { if (P.h1 === 'wr') castle += 'K'; if (P.a1 === 'wr') castle += 'Q'; }
  if (P.e8 === 'bk') { if (P.h8 === 'br') castle += 'k'; if (P.a8 === 'br') castle += 'q'; }
  return `${rows.join('/')} ${S.edit.turn} ${castle || '-'} - 0 1`;
}

function finishEdit() {
  const P = S.edit.pieces;
  const vals = Object.values(P);
  if (vals.filter(v => v === 'wk').length !== 1 || vals.filter(v => v === 'bk').length !== 1) {
    toast('Нужно ровно по одному королю каждого цвета'); return;
  }
  if (Object.entries(P).some(([sq, v]) => v[1] === 'p' && (sq[1] === '1' || sq[1] === '8'))) {
    toast('Пешка не может стоять на 1-й или 8-й горизонтали'); return;
  }
  const fen = editorFen();
  let c;
  try { c = new Chess(fen); } catch (e) { toast('Позиция невозможна: ' + e.message); return; }
  const other = S.edit.turn === 'w' ? 'b' : 'w';
  const kOther = Object.keys(P).find(sq => P[sq] === other + 'k');
  if (c.isAttacked(kOther, S.edit.turn)) { toast('Король стороны, которая не ходит, под шахом — проверь, чей ход'); return; }
  S.chess = c;
  S.startFen = fen;
  S.redo = [];
  S.mode = 'play';
  S.vis.lastRecog = null;
  if (engine) engine.newGame();
  positionChanged();
}

function cancelEdit() { S.mode = 'play'; positionChanged(); }

// ---------- Кнопки ----------
function newGame() {
  S.mode = 'play';
  S.chess = new Chess();
  S.startFen = START;
  S.redo = [];
  S.selected = null;
  S.vis.pool = []; S.vis.lastRecog = null; S.vis.img = null;
  if (engine) engine.newGame();
  positionChanged();
}

$('btn-played').onclick = () => {
  const m = bestMove();
  if (m) applyMove({ from: m.from, to: m.to, promotion: m.promotion });
};
$('btn-opp').onclick = $('btn-played').onclick;
$('new').onclick = newGame;
$('undo').onclick = () => {
  const m = S.chess.undo();
  if (!m) return;
  S.redo.push(m);
  if (S.vis.lastRecog) dropShot(S.vis.lastRecog.tag);
  S.vis.lastRecog = null;
  S.selected = null;
  positionChanged();
};
$('redo').onclick = () => {
  const m = S.redo.pop();
  if (!m) return;
  S.chess.move(m);
  S.selected = null;
  positionChanged();
};
$('flip').onclick = () => { S.flip = !S.flip; renderBoard(); };
$('edit').onclick = enterEdit;
$('edit-done').onclick = finishEdit;
$('edit-cancel').onclick = cancelEdit;
$('edit-start').onclick = () => { S.edit.pieces = piecesFromChess(new Chess(START)); S.edit.turn = 'w'; renderAll(); };
$('edit-clear').onclick = () => { S.edit.pieces = { e1: 'wk', e8: 'bk' }; renderAll(); };
document.querySelectorAll('[data-turn]').forEach(b => b.onclick = () => { S.edit.turn = b.dataset.turn; renderEditor(); });

document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
  if (S.color === b.dataset.color) return;
  S.color = b.dataset.color;
  S.flip = false;
  store.set('color', S.color);
  positionChanged();
});
document.querySelectorAll('[data-think]').forEach(b => b.onclick = () => {
  S.think = +b.dataset.think;
  store.set('think', S.think);
  positionChanged();
});
document.querySelectorAll('[data-multipv]').forEach(b => b.onclick = () => {
  S.multipv = +b.dataset.multipv;
  store.set('multipv', S.multipv);
  positionChanged();
});
$('copy-fen').onclick = async () => {
  const fen = S.chess.fen();
  try { await navigator.clipboard.writeText(fen); toast('FEN скопирован'); }
  catch (_) { $('fen-in').value = fen; $('fen-in').select(); }
};
$('load-fen').onclick = () => {
  const v = $('fen-in').value.trim();
  if (!v) return;
  try {
    const c = new Chess(v);
    S.chess = c; S.startFen = c.fen(); S.redo = []; S.mode = 'play';
    if (engine) engine.newGame();
    positionChanged();
    toast('Позиция загружена');
  } catch (e) {
    try {
      const c = new Chess(); c.loadPgn(v);
      S.chess = c; S.startFen = c.getHeaders?.().FEN || START; S.redo = []; S.mode = 'play';
      positionChanged();
      toast('Партия загружена');
    } catch (_) { toast('Не понял: вставь FEN или PGN'); }
  }
};

// клавиши на ПК
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft') $('undo').click();
  else if (e.key === 'ArrowRight') $('redo').click();
  else if (e.key === 'Enter' || e.key === ' ') {
    const b = !$('btn-played').hidden ? $('btn-played') : !$('btn-opp').hidden ? $('btn-opp') : null;
    if (b) { e.preventDefault(); b.click(); }
  } else if (e.key === 'f') $('flip').click();
});

// ---------- Скриншоты ----------
function sameSize(a, img) { return a && a.w === img.width && a.h === img.height; }
function dropShot(tag) {
  const pool = S.vis.pool;
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].tag === tag) pool.splice(i, 1);
}

async function handleImage(blob) {
  if (S.mode === 'edit') cancelEdit();
  try {
    $('recog-note').textContent = 'Распознаю доску…';
    const img = await loadImage(blob);
    S.vis.img = img;
    S.vis.lastRecog = null;
    await new Promise(r => setTimeout(r, 20));
    runRecognition();
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть картинку');
  }
}

function runRecognition() {
  const V = S.vis, img = V.img;
  let box;
  if (sameSize(V.manualBox, img)) box = V.manualBox.box;
  else {
    box = detectBoard(img, sameSize(V.autoBox, img) ? V.autoBox.box : null);
    if (box) V.autoBox = { w: img.width, h: img.height, box };
  }
  V.box = box;
  $('shot').open = true;
  drawPreview();
  if (!box) {
    $('recog-note').textContent = 'Не нашёл доску. Обведи её пальцем на картинке ниже.';
    $('recog-note').dataset.warn = '1';
    return;
  }
  const feats = extractFeatures(img, box, orientation());
  const tag = ++V.shot;
  const res = recognize(feats, S.chess, V.pool, tag);
  for (const m of res.moves) S.chess.move(m);
  if (res.moves.length) S.redo = [];
  V.lastRecog = { plies: res.moves.length, tag };
  let note = res.moves.length ? `Распознал: ${res.moves.map(m => m.san).join(', ')}` : 'Новых ходов не вижу — позиция та же.';
  if (res.uncertain) note += ' ⚠ Не уверен — сверь доску. Если не так, «Назад» и введи ход вручную.';
  $('recog-note').textContent = note;
  $('recog-note').dataset.warn = res.uncertain ? '1' : '0';
  if (res.moves.length) toast(note);
  positionChanged();
}

const pv = $('preview');
let pdrag = null;
function drawPreview(tmp) {
  const img = S.vis.img;
  if (!img) return;
  const maxW = pv.parentElement.clientWidth || 360;
  const k = Math.min(1, maxW / img.width, 480 / img.height);
  pv.width = Math.round(img.width * k);
  pv.height = Math.round(img.height * k);
  const ctx = pv.getContext('2d');
  ctx.drawImage(img, 0, 0, pv.width, pv.height);
  const b = tmp || S.vis.box;
  if (b) {
    ctx.strokeStyle = '#ff3b6b';
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x * k, b.y * k, b.size * k, b.size * k);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    for (let i = 1; i < 8; i++) {
      const o = b.size * k * i / 8;
      ctx.beginPath(); ctx.moveTo(b.x * k + o, b.y * k); ctx.lineTo(b.x * k + o, (b.y + b.size) * k); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(b.x * k, b.y * k + o); ctx.lineTo((b.x + b.size) * k, b.y * k + o); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  pv._k = k;
}
function pvPoint(e) {
  const r = pv.getBoundingClientRect();
  const k = pv._k * (r.width / pv.width);
  return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
}
pv.addEventListener('pointerdown', (e) => {
  if (!S.vis.img) return;
  pv.setPointerCapture(e.pointerId);
  pdrag = { a: pvPoint(e) };
  e.preventDefault();
});
pv.addEventListener('pointermove', (e) => {
  if (!pdrag) return;
  const b = pvPoint(e);
  const size = Math.max(Math.abs(b.x - pdrag.a.x), Math.abs(b.y - pdrag.a.y));
  pdrag.box = { x: b.x < pdrag.a.x ? pdrag.a.x - size : pdrag.a.x, y: b.y < pdrag.a.y ? pdrag.a.y - size : pdrag.a.y, size };
  drawPreview(pdrag.box);
});
pv.addEventListener('pointerup', () => {
  if (!pdrag) return;
  const box = pdrag.box;
  pdrag = null;
  if (!box || box.size < 40) { drawPreview(); return; }
  const V = S.vis;
  V.manualBox = { w: V.img.width, h: V.img.height, box };
  if (V.lastRecog) {
    for (let i = 0; i < V.lastRecog.plies; i++) S.chess.undo();
    dropShot(V.lastRecog.tag);
    V.lastRecog = null;
  }
  runRecognition();
});

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) handleImage(f);
  e.target.value = '';
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); handleImage(item.getAsFile()); }
});
document.body.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
document.body.addEventListener('dragleave', () => document.body.classList.remove('dropping'));
document.body.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  document.body.classList.remove('dropping');
  if (f) { e.preventDefault(); handleImage(f); }
});

// ---------- Движок ----------
let engine = null;
function setEngineStatus(t, bad) {
  const el = $('engine-status');
  el.textContent = t;
  el.dataset.bad = bad ? '1' : '0';
}

async function startEngine() {
  const build = pickBuild();
  S.build = build;
  setEngineStatus('Загружаю Stockfish…');
  const attempt = async (b) => {
    const e = new Engine(b.url);
    await e.init({ threads: b.threads, hash: b.hash });
    return e;
  };
  try {
    engine = await attempt(build);
  } catch (e) {
    console.warn('multi-thread engine failed, falling back', e);
    if (build.multi) {
      S.build = { ...build, url: 'engine/stockfish-18-lite-single.js', threads: 1, multi: false };
      try { engine = await attempt(S.build); } catch (e2) { console.error(e2); }
    }
  }
  if (!engine) { setEngineStatus('Движок не загрузился — обнови страницу', true); return; }
  S.engineReady = true;
  setEngineStatus(`Stockfish 18 · ${S.build.threads} ${S.build.threads === 1 ? 'поток' : S.build.threads < 5 ? 'потока' : 'потоков'}`);
  analyze();
}

// не даём экрану гаснуть во время партии
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } } catch (_) { /* не поддерживается */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, { once: true });

window.addEventListener('resize', () => drawPreview());
window.__chessbot = { S, handleImage, newGame, applyMove };

renderAll();
startEngine();

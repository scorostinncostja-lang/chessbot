// Доска: отрисовка, стрелки, тапы и перетаскивание.
// Доска ничего не решает сама — сообщает о тапах/перетаскиваниях наружу (onTap, onDrop).
import { PIECE_IMG } from './pieces.js';

const FILES = 'abcdefgh';
const NS = 'http://www.w3.org/2000/svg';

export class BoardView {
  constructor(root, { onTap, onDrop }) {
    this.root = root;
    this.onTap = onTap;
    this.onDrop = onDrop;
    this.flipped = false;
    this.pieces = {};       // sq -> 'wp' и т.п.
    this.marks = {};        // sq -> массив классов ('last','sel','target','capture','check')
    this.arrows = [];       // [{from,to,kind}]
    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.classList.add('arrow-layer');
    root.append(this.grid, this.svg);
    this.cells = {};
    this.build();
    this.bindPointer();
  }

  build() {
    this.grid.replaceChildren();
    this.cells = {};
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const f = this.flipped ? 7 - col : col;
        const r = this.flipped ? row : 7 - row;
        const sq = FILES[f] + (r + 1);
        const cell = document.createElement('div');
        cell.dataset.sq = sq;
        cell.className = 'sq ' + ((f + r) % 2 ? 'light' : 'dark');
        const img = document.createElement('div');
        img.className = 'pc';
        cell.append(img);
        if (col === 0) cell.insertAdjacentHTML('beforeend', `<i class="rk">${r + 1}</i>`);
        if (row === 7) cell.insertAdjacentHTML('beforeend', `<i class="fl">${FILES[f]}</i>`);
        this.grid.append(cell);
        this.cells[sq] = cell;
      }
    }
  }

  setFlipped(v) {
    if (v === this.flipped) return;
    this.flipped = v;
    this.build();
    this.paint();
  }

  // pieces: {sq: code}, marks: {sq: [classes]}
  set(pieces, marks = {}, arrows = []) {
    this.pieces = pieces;
    this.marks = marks;
    this.arrows = arrows;
    this.paint();
  }

  setArrows(arrows) { this.arrows = arrows; this.drawArrows(); }

  paint() {
    for (const [sq, cell] of Object.entries(this.cells)) {
      const code = this.pieces[sq];
      const pc = cell.firstChild;
      pc.style.backgroundImage = code ? `url("${PIECE_IMG[code]}")` : '';
      pc.dataset.code = code || '';
      cell.className = 'sq ' + (cell.classList.contains('light') ? 'light' : 'dark') +
        (this.marks[sq] ? ' ' + this.marks[sq].join(' ') : '');
    }
    this.drawArrows();
  }

  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return this.flipped ? { x: 7 - f, y: r } : { x: f, y: 7 - r };
  }

  drawArrows() {
    this.svg.replaceChildren();
    // рисуем от слабых к сильным, чтобы главная стрелка была сверху
    for (const a of [...this.arrows].reverse()) {
      const p = this.xy(a.from), q = this.xy(a.to);
      const x1 = p.x + 0.5, y1 = p.y + 0.5, x2 = q.x + 0.5, y2 = q.y + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const main = a.kind === 'best' || a.kind === 'opp';
      const head = main ? 0.42 : 0.32, w = main ? 0.18 : 0.1, hw = main ? 0.27 : 0.18;
      const sx = x1 + ux * 0.2, sy = y1 + uy * 0.2;
      const ex = x2 - ux * head, ey = y2 - uy * head;
      const nx = -uy, ny = ux;
      const pts = [
        [sx + nx * w / 2, sy + ny * w / 2], [ex + nx * w / 2, ey + ny * w / 2],
        [ex + nx * hw, ey + ny * hw], [x2, y2], [ex - nx * hw, ey - ny * hw],
        [ex - nx * w / 2, ey - ny * w / 2], [sx - nx * w / 2, sy - ny * w / 2],
      ];
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pts.map(v => v.map(n => n.toFixed(3)).join(',')).join(' '));
      poly.setAttribute('class', 'arrow arrow-' + a.kind);
      this.svg.append(poly);
    }
  }

  sqAt(clientX, clientY) {
    const r = this.grid.getBoundingClientRect();
    const col = Math.floor((clientX - r.left) / (r.width / 8));
    const row = Math.floor((clientY - r.top) / (r.height / 8));
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const f = this.flipped ? 7 - col : col;
    const rk = this.flipped ? row : 7 - row;
    return FILES[f] + (rk + 1);
  }

  bindPointer() {
    let drag = null;
    const el = this.grid;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const sq = this.sqAt(e.clientX, e.clientY);
      if (!sq) return;
      e.preventDefault();
      drag = { sq, x: e.clientX, y: e.clientY, moved: false, ghost: null, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (!drag.moved && dist > 8 && this.pieces[drag.sq]) {
        drag.moved = true;
        const size = el.getBoundingClientRect().width / 8;
        const g = document.createElement('div');
        g.className = 'ghost';
        g.style.width = g.style.height = size * 1.15 + 'px';
        g.style.backgroundImage = `url("${PIECE_IMG[this.pieces[drag.sq]]}")`;
        document.body.append(g);
        drag.ghost = g;
        drag.size = size * 1.15;
        this.cells[drag.sq].classList.add('dragging');
      }
      if (drag.ghost) {
        drag.ghost.style.transform = `translate(${e.clientX - drag.size / 2}px, ${e.clientY - drag.size * 0.6}px)`;
        const over = this.sqAt(e.clientX, e.clientY);
        for (const c of Object.values(this.cells)) c.classList.toggle('hover', c.dataset.sq === over);
      }
    });
    const end = (e, cancel) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (d.ghost) {
        d.ghost.remove();
        for (const c of Object.values(this.cells)) c.classList.remove('hover', 'dragging');
        const to = this.sqAt(e.clientX, e.clientY);
        if (!cancel && to && to !== d.sq) this.onDrop(d.sq, to);
        else if (!cancel && to === d.sq) this.onTap(d.sq, { fromDrag: true });
        else this.paint();
      } else if (!cancel) {
        this.onTap(d.sq, {});
      }
    };
    el.addEventListener('pointerup', (e) => end(e, false));
    el.addEventListener('pointercancel', (e) => end(e, true));
  }
}

// Shared measurement cursors + a uPlot plugin that renders and manipulates them
// across every graph in the stack. One cursor is "active": click a cursor's line
// or flag to make it active, click empty plot space to jump the active cursor
// there, or drag any cursor directly. Moving a cursor on one plot moves it on all
// of them (the model is shared).

const CURSOR_COLORS = ['#ffb86b', '#6be0ff', '#c58bff', '#8bffb0'];
const HIT_PX = 10; // grab tolerance (canvas px)
const CLICK_PX = 4; // max CSS-px movement still counted as a click, not a drag

export class CursorModel {
  constructor() {
    this.times = []; // seconds
    this.active = 0; // index of the active cursor
    this.playback = null; // playback marker time, or null
    this.listeners = new Set();
  }

  get maxCursors() {
    return CURSOR_COLORS.length;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }

  add(t) {
    if (this.times.length >= CURSOR_COLORS.length) return;
    this.times.push(t);
    this.active = this.times.length - 1;
    this.#emit();
  }

  clear() {
    this.times = [];
    this.active = 0;
    this.#emit();
  }

  move(i, t) {
    this.times[i] = t;
    this.#emit();
  }

  setActive(i) {
    if (i < 0 || i >= this.times.length || i === this.active) return;
    this.active = i;
    this.#emit();
  }

  setPlayback(t) {
    this.playback = t;
    this.#emit();
  }

  colorFor(i) {
    return CURSOR_COLORS[i % CURSOR_COLORS.length];
  }
}

/**
 * uPlot plugin: draw cursor lines + playback marker, with select / click-place /
 * drag interaction.
 * @param {CursorModel} model
 * @param {() => void} onMoved called after a drag so the manager can redraw peers + readout
 */
export function cursorPlugin(model, onMoved) {
  let u = null;
  let dragging = -1;
  let downX = null;
  let downOnCursor = false;

  function draw(self) {
    const { ctx } = self;
    const { left, top, width, height } = self.bbox;
    const dpr = self.pxRatio || devicePixelRatio || 1;
    ctx.save();

    // playback marker
    if (model.playback != null) {
      const x = self.valToPos(model.playback, 'x', true);
      if (x >= left && x <= left + width) {
        ctx.strokeStyle = 'rgba(120,200,120,0.9)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        vline(ctx, x, top, height);
      }
    }
    ctx.setLineDash([]);

    // cursors
    model.times.forEach((t, i) => {
      const x = self.valToPos(t, 'x', true);
      if (x < left || x > left + width) return;
      const active = i === model.active;
      const col = model.colorFor(i);
      ctx.globalAlpha = active ? 1 : 0.6;
      ctx.strokeStyle = col;
      ctx.lineWidth = (active ? 2 : 1) * dpr;
      vline(ctx, x, top, height);

      // flag with the cursor number at the top
      ctx.globalAlpha = 1;
      const w = 15 * dpr, h = 15 * dpr;
      ctx.beginPath();
      ctx.rect(x + 1, top, w, h);
      ctx.fillStyle = active ? col : '#0b0e14';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.fillStyle = active ? '#06121f' : col;
      ctx.font = `${active ? 'bold ' : ''}${Math.round(10 * dpr)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + 1 + w / 2, top + h / 2 + 0.5 * dpr);
    });
    ctx.restore();
  }

  function vline(ctx, x, top, height) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, top + height);
    ctx.stroke();
  }

  // Hit-test in CSS pixels (matches pointer offsetX) — uPlot's canvas pixel
  // ratio does not always equal window.devicePixelRatio, so never mix the two.
  function nearestCursor(offsetX) {
    let best = -1, bestDist = HIT_PX;
    model.times.forEach((t, i) => {
      const d = Math.abs(u.valToPos(t, 'x') - offsetX);
      if (d <= bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  return {
    hooks: {
      ready(self) {
        u = self;
        const over = self.over;
        over.addEventListener('pointerdown', (e) => {
          const hit = nearestCursor(e.offsetX);
          downX = e.offsetX;
          downOnCursor = hit >= 0;
          if (hit >= 0) {
            model.setActive(hit);
            dragging = hit;
            over.setPointerCapture(e.pointerId);
            e.stopPropagation();
            e.preventDefault();
          }
        });
        over.addEventListener('pointermove', (e) => {
          if (dragging < 0) return;
          model.times[dragging] = clampToScale(u, u.posToVal(e.offsetX, 'x'));
          u.redraw(false, false);
          onMoved();
          e.stopPropagation();
        });
        const end = (e) => {
          if (dragging >= 0) {
            dragging = -1;
            try { over.releasePointerCapture(e.pointerId); } catch {}
            downX = null;
            return;
          }
          // plain click on empty space → jump the active cursor there
          if (downX != null && !downOnCursor && model.times.length) {
            if (Math.abs(e.offsetX - downX) < CLICK_PX) {
              model.move(model.active, clampToScale(u, u.posToVal(e.offsetX, 'x')));
            }
          }
          downX = null;
          downOnCursor = false;
        };
        over.addEventListener('pointerup', end);
        over.addEventListener('pointercancel', () => { dragging = -1; downX = null; });
      },
      draw,
    },
  };
}

function clampToScale(u, val) {
  const sc = u.scales.x;
  if (sc.min != null && val < sc.min) return sc.min;
  if (sc.max != null && val > sc.max) return sc.max;
  return val;
}

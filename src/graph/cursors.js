// Shared, draggable cursor model + a uPlot plugin that renders and drags
// cursors on every graph in a stack. Moving a cursor on one plot moves it on
// all of them (the model is shared); a readout table shows each signal's value
// at each cursor plus the two-cursor delta.

const CURSOR_COLORS = ['#ffb86b', '#6be0ff', '#c58bff', '#8bffb0'];
const HIT_PX = 6;

export class CursorModel {
  constructor() {
    this.times = []; // seconds
    this.playback = null; // playback marker time, or null
    this.listeners = new Set();
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
    this.#emit();
  }

  clear() {
    this.times = [];
    this.#emit();
  }

  move(i, t) {
    this.times[i] = t;
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
 * uPlot plugin drawing cursor lines + the playback marker, with drag support.
 * @param {CursorModel} model
 * @param {() => void} onMoved called after a drag so the manager can redraw peers + readout
 */
export function cursorPlugin(model, onMoved) {
  let u = null;
  let dragging = -1;

  function draw(self) {
    const { ctx } = self;
    const { left, top, width, height } = self.bbox;
    ctx.save();
    ctx.lineWidth = 1;
    // playback marker
    if (model.playback != null) {
      const x = self.valToPos(model.playback, 'x', true);
      if (x >= left && x <= left + width) {
        ctx.strokeStyle = 'rgba(120,200,120,0.9)';
        ctx.setLineDash([4, 3]);
        line(ctx, x, top, height);
      }
    }
    // cursors
    ctx.setLineDash([]);
    model.times.forEach((t, i) => {
      const x = self.valToPos(t, 'x', true);
      if (x < left || x > left + width) return;
      ctx.strokeStyle = model.colorFor(i);
      line(ctx, x, top, height);
      ctx.fillStyle = model.colorFor(i);
      ctx.font = '10px monospace';
      ctx.fillText(String(i + 1), x + 3, top + 10);
    });
    ctx.restore();
  }

  function line(ctx, x, top, height) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, top + height);
    ctx.stroke();
  }

  function nearestCursor(px) {
    let best = -1;
    let bestDist = HIT_PX;
    model.times.forEach((t, i) => {
      const x = u.valToPos(t, 'x', true);
      const d = Math.abs(x - px);
      if (d <= bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  return {
    hooks: {
      ready(self) {
        u = self;
        const over = self.over;
        over.addEventListener('pointerdown', (e) => {
          // canvas pixels = CSS px * dpr; valToPos with canvasPixels=true
          const px = e.offsetX * devicePixelRatio;
          const hit = nearestCursor(px);
          if (hit >= 0) {
            dragging = hit;
            over.setPointerCapture(e.pointerId);
            e.stopPropagation();
            e.preventDefault();
          }
        });
        over.addEventListener('pointermove', (e) => {
          if (dragging < 0) return;
          const val = u.posToVal(e.offsetX, 'x');
          model.times[dragging] = clampToScale(u, val);
          u.redraw(false, false);
          onMoved();
          e.stopPropagation();
        });
        const end = (e) => {
          if (dragging >= 0) {
            dragging = -1;
            try { over.releasePointerCapture(e.pointerId); } catch {}
          }
        };
        over.addEventListener('pointerup', end);
        over.addEventListener('pointercancel', end);
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

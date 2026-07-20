/** Seconds -> "1:23.456" / "12.345 s" style display. */
export function formatDuration(sec) {
  if (!isFinite(sec)) return '—';
  if (sec < 60) return sec.toFixed(3) + ' s';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (m < 60) return `${m}:${s.toFixed(3).padStart(6, '0')} min`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')} h`;
}

/** Seconds -> fixed-width timestamp for trace columns: "  12.345678". */
export function formatTimestamp(sec) {
  return sec.toFixed(6);
}

/** Unix seconds -> local date-time string, or '—' if unknown. */
export function formatEpoch(epochSec) {
  if (epochSec == null) return '—';
  return new Date(epochSec * 1000).toLocaleString();
}

/** Binary search: greatest index i in sorted arr with arr[i] <= v, or -1. */
export function lowerBound(arr, len, v) {
  let lo = 0, hi = len - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

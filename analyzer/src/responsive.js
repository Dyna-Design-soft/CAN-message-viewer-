// Responsive / mobile layer for the reference UI (CSS overrides + mobile app bar and nav drawer).
// The reference markup and scripts are not modified; everything here is additive.
const css = `
html{-webkit-text-size-adjust:100%}
body{overflow-x:hidden}
canvas{max-width:100%}
img,svg{max-width:100%}
.ia-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
.ia-scroll>table{display:table!important;min-width:100%}
#iaBar,#iaScrim{display:none}
@media (max-width:1100px) and (min-width:861px){
  .sidebar{width:200px;padding:18px 10px}
  .main{padding:20px 22px 40px}
}
@media (max-width:860px){
  .app{display:block!important}
  #iaBar{display:flex;position:sticky;top:0;z-index:900;align-items:center;gap:10px;padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top));background:rgba(10,20,32,.94);backdrop-filter:blur(10px);border-bottom:1px solid #1f3850}
  #iaBar .ia-menu{width:42px;height:42px;border-radius:11px;border:1px solid #27435c;background:#10233a;color:#d9e7f2;font-size:20px;display:grid;place-items:center;cursor:pointer;flex-shrink:0}
  #iaBar .ia-title{flex:1;min-width:0}
  #iaBar .ia-title b{display:block;font-size:15px;color:#e9f3fb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #iaBar .ia-title span{display:block;font-size:10px;letter-spacing:.12em;color:#58e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #iaBar .ia-open{height:42px;padding:0 14px;border-radius:11px;border:0;background:linear-gradient(135deg,#3fd0e0,#3f86f0);color:#04121a;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
  .sidebar{position:fixed!important;top:0;left:0;bottom:0;height:100vh!important;height:100dvh!important;width:min(82vw,300px)!important;z-index:9500;transform:translateX(-105%);transition:transform .25s ease;overflow-y:auto;padding:max(18px,env(safe-area-inset-top)) 12px 18px!important;box-shadow:0 0 40px rgba(0,0,0,.6)}
  body.ia-nav .sidebar{transform:none}
  .sidebar .navs{display:block!important;overflow:visible!important}
  .sidebar .nav{min-width:0!important;white-space:normal!important;min-height:46px;font-size:15px}
  .sidebar .sidefoot{display:block!important;position:static!important;margin-top:16px}
  #iaScrim{display:block;position:fixed;inset:0;z-index:9400;background:rgba(2,6,12,.6);opacity:0;pointer-events:none;transition:opacity .25s}
  body.ia-nav #iaScrim{opacity:1;pointer-events:auto}
  body.ia-nav{overflow:hidden}
  .main{padding:14px 14px 40px!important;max-width:100vw}
  .top{flex-direction:column;align-items:stretch!important;gap:10px;padding-bottom:12px;margin-bottom:16px}
  .top h1{font-size:24px;line-height:1.15}
  .topright{gap:8px;width:100%}
  .topright{flex-wrap:wrap}
  .topright>*{flex:0 1 auto;justify-content:center;text-align:center;font-size:12px!important;min-height:34px!important;padding:6px 12px!important;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .topright>button{margin-left:auto}
  .main button,.main .btn,.main select,.main input:not([type=checkbox]):not([type=radio]):not([type=range]){min-height:40px;font-size:14px}
  .main input,.main select,.main textarea{font-size:16px!important} /* stop iOS zoom on focus */
  .card,.panel{border-radius:14px}
  .plot{height:240px!important}
  .hero h2,.hero h1{font-size:30px!important;line-height:1.1}
  [class*=kpis],[class*=metrics],.four,.studio-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}
  .two,.three,.split,.adv-two,.v11-grid,.lab-charts,.overview-main{grid-template-columns:minmax(0,1fr)!important}
  .top>div:first-child{display:none}
  .topright>label.btn{display:none}
  .sectionhead{flex-wrap:wrap;gap:10px}
  .sectionhead>*{min-width:0}
  #bdBar{left:8px;right:8px;width:auto;transform:none;bottom:max(8px,env(safe-area-inset-bottom));border-radius:14px}
  #bdBar .row{padding:8px 10px;gap:6px}
  #bdBar .sum{font-size:11px;min-width:0;flex:1 1 60%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  #bdBar input{width:84px;font-size:16px}
  #bdBar button,#bdBar select{min-height:38px}
  #bdBar .track{height:26px}
  #bdStats td,#bdStats th{padding:6px 8px}
}
@media (max-width:480px){
  .top h1{font-size:21px}
  .main{padding:12px 10px 40px!important}
  .hero h2,.hero h1{font-size:26px!important}
}
@media (hover:none){ .nav,.btn,button{-webkit-tap-highlight-color:transparent} }
`;
export function installResponsive() {
  if (!document.querySelector('meta[name=viewport]')) {
    const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1,viewport-fit=cover'; document.head.appendChild(m);
  }
  const st = document.createElement('style'); st.id = 'iaResponsive'; st.textContent = css; document.head.appendChild(st);
  const app = document.querySelector('.app'), main = document.querySelector('.main');
  if (!app || !main) return;
  const bar = document.createElement('div'); bar.id = 'iaBar';
  bar.innerHTML = `<button class="ia-menu" aria-label="Open menu" aria-expanded="false">☰</button><div class="ia-title"><span data-eb>INDUSTRIAL DATA ANALYZER</span><b data-tt>Analysis Overview</b></div><button class="ia-open" aria-label="Open data file">＋ Open</button>`;
  main.prepend(bar);
  const scrim = document.createElement('div'); scrim.id = 'iaScrim'; document.body.appendChild(scrim);
  const menu = bar.querySelector('.ia-menu');
  const setNav = (on) => { document.body.classList.toggle('ia-nav', on); menu.setAttribute('aria-expanded', on); };
  menu.onclick = () => setNav(!document.body.classList.contains('ia-nav'));
  scrim.onclick = () => setNav(false);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });
  document.querySelector('.sidebar')?.addEventListener('click', (e) => { if (e.target.closest('.nav,[data-page],button')) setNav(false); });
  bar.querySelector('.ia-open').onclick = () => { const i = document.getElementById('fileInput'); if (i && !i.disabled) i.click(); };
  // swipe from left edge opens, swipe left closes
  let sx = null;
  addEventListener('touchstart', (e) => { const x = e.touches[0].clientX; sx = x < 24 || document.body.classList.contains('ia-nav') ? x : null; }, { passive: true });
  addEventListener('touchend', (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (dx > 60) setNav(true); else if (dx < -60) setNav(false); sx = null; }, { passive: true });
  // mirror the page title into the app bar
  const sync = () => {
    const t = document.getElementById('pageTitle'), e = document.getElementById('eyebrow');
    if (t) bar.querySelector('[data-tt]').textContent = t.textContent;
    if (e) bar.querySelector('[data-eb]').textContent = e.textContent;
  };
  sync();
  const tt = document.getElementById('pageTitle'); if (tt) new MutationObserver(sync).observe(tt, { childList: true, characterData: true, subtree: true });
  // wrap tables so they scroll inside cards (re-run when the reference re-renders)
  const wrap = () => {
    main.querySelectorAll('table').forEach((t) => {
      if (t.parentElement.classList.contains('ia-scroll')) return;
      const p = getComputedStyle(t.parentElement);
      if (/auto|scroll/.test(p.overflowX)) return;
      const w = document.createElement('div'); w.className = 'ia-scroll'; t.before(w); w.appendChild(t);
    });
  };
  wrap();
  let q = 0; new MutationObserver(() => { if (!q) q = requestAnimationFrame(() => { q = 0; wrap(); }); }).observe(main, { childList: true, subtree: true });
  // redraw canvases after orientation / size changes (reference draws on its own resize handlers too)
  [100, 600, 1500].forEach((ms) => setTimeout(() => dispatchEvent(new Event('resize')), ms));
  matchMedia('(max-width:860px)').addEventListener('change', () => setTimeout(() => dispatchEvent(new Event('resize')), 50));
  let rz; addEventListener('orientationchange', () => { clearTimeout(rz); rz = setTimeout(() => dispatchEvent(new Event('resize')), 300); });
}

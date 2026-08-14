/*
 * 집품 성과 대시보드 (Picking Performance Dashboard)
 * -------------------------------------------------
 * inbound.coupang.com 반품 토트 데이터를 수집해 집품 작업자별 성과를
 * 다크 프로 스타일 모달 + Chart.js 로 시각화하는 북마크릿 앱.
 *
 * 자체포함(single self-contained) 설계: 이 파일 전체가 북마크릿 본문이 되며
 * Chart.js 는 빌드 시 함께 인라인되어 외부 CDN 요청이 전혀 없다.
 *
 * 실행 컨텍스트: inbound.coupang.com 페이지 위에서 실행되어야 한다
 * (같은 출처여야 세션 쿠키로 조회가 되고 CORS 문제가 없다).
 *
 * 로컬 검증(index.html 모의 테스트)에서는 window.__PP_MOCK__ 로
 * 조회 URL / 상세 URL 을 fixture 로 대체할 수 있다.
 */
(function () {
  'use strict';

  // 이전 버전 인스턴스가 남아있으면 철거하고 이 버전으로 새로 구성한다.
  // (재사용하면 예전 북마크릿 실행 후 새 북마크릿을 눌러도 옛 UI 가 그대로 열리는 문제가 생김)
  try {
    if (window.__PP_DASHBOARD__ && typeof window.__PP_DASHBOARD__.destroy === 'function') {
      window.__PP_DASHBOARD__.destroy();
    }
    document.querySelectorAll('.' + 'pp-overlay').forEach((n) => n.remove());
    const oldStyle = document.getElementById('pp-style');
    if (oldStyle) oldStyle.remove();
  } catch (e) { /* 무시 */ }
  try { delete window.__PP_DASHBOARD__; } catch (e) { window.__PP_DASHBOARD__ = undefined; }

  /* ============================ 설정 상수 ============================ */
  const PREFIX = 'pp';
  const LS_MAP = 'pp_worker_map';       // { picker: name }
  const LS_WEIGHTS = 'pp_weights';      // { qty: 0.6, tote: 0.4 }
  const LS_REFRESH = 'pp_refresh';      // { on: true, intervalMs: 60000 }
  const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
  const CONCURRENCY = 6;                // 상세 페이지 동시 요청 수

  // 색상 (미니멀 라이트)
  const COLOR_QTY = '#4F46E5';   // 수량 = 인디고
  const COLOR_TOTE = '#F59E0B';  // 토트 = 앰버
  const COLOR_ACCENT = '#4F46E5';

  // 상세 페이지 첫 table 의 데이터 셀 인덱스 (사용자 명세)
  const IDX_TOTE = 0;
  const IDX_DONE = 5;    // 6번째 td = 집품완료시간
  const IDX_PICKER = 6;
  const IDX_QTY = 7;

  // 조회 목록 URL (날짜만 서버로 전달, 시간은 클라이언트 필터)
  const LIST_URL = (start, end) =>
    'https://inbound.coupang.com/vendor-return/tote/paging' +
    '?page=0&vendorReturnOrderItemId=&vendorName=&skuBarcode=&skuExternalId=' +
    '&vendorReturnWorkId=&containerBarcode=&status=&vendorReturnOrderExternalId=' +
    '&vendorReturnOrderId=&toteBarcode=&dateType=PICKING_CREATED' +
    '&end=' + end + '&start=' + start + '&size=10000';

  // 행에서 날짜/시간 문자열 자동 탐지 (컬럼 위치를 몰라도 견고)
  const DT_RE = /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

  // 모의 테스트 훅
  const MOCK = window.__PP_MOCK__ || null;

  /* ============================ 상태 ============================ */
  const state = {
    rows: [],          // [{ tote, picker, qty }]
    agg: [],           // [{ picker, name, qty, totes, eff, score }]
    weights: loadWeights(),
    map: loadMap(),
    charts: {},        // Chart 인스턴스 참조
    view: 'config',
    rangeLabel: '',
    form: null,        // 마지막 입력 기간 { sd, st, ed, et } — 결과에서 돌아와도 유지(북마크 재실행 시 초기화)
    excluded: new Set(), // 이번 결과에서 제외한 작업자 코드(세션 한정, localStorage 미저장)
    meta: null,        // 마지막 결과 메타 { undated, total0 } — 삭제 후 재렌더 시 재사용
    detailCache: new Map(), // href → { tote, picker, qty } — 새로고침 시 새 토트만 재요청
    refresh: loadRefresh(), // { on, intervalMs, timer, busy, lastAt }
  };

  /* ============================ 유틸 ============================ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const c = (name) => PREFIX + '-' + name; // class helper
  // 로컬(브라우저 시간대) 오늘 날짜를 YYYY-MM-DD 로. toISOString 은 UTC 라 KST 새벽에 어제가 잡혀 사용하지 않음.
  const todayLocal = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // ms → "1시간 05분" / "12분 30초" / "45초" / "—"
  const fmtDuration = (ms) => {
    if (!ms || ms <= 0) return '—';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}시간 ${String(m).padStart(2, '0')}분`;
    if (m) return `${m}분 ${String(sec).padStart(2, '0')}초`;
    return `${sec}초`;
  };
  const hhmm = (ms) => (ms == null ? '' : new Date(ms).toTimeString().slice(0, 5)); // ms → HH:MM
  // 간단 토스트(모달 위 하단 중앙, ~2s 후 사라짐)
  function showToast(msg) {
    if (!overlay) return;
    const t = el('div', c('toast'), esc(msg));
    overlay.appendChild(t);
    requestAnimationFrame(() => t.classList.add(c('toast-on')));
    setTimeout(() => {
      t.classList.remove(c('toast-on'));
      setTimeout(() => t.remove(), 250);
    }, 2000);
  }

  function loadMap() {
    try { return JSON.parse(localStorage.getItem(LS_MAP)) || {}; }
    catch (e) { return {}; }
  }
  function saveMap(m) { localStorage.setItem(LS_MAP, JSON.stringify(m)); }
  function loadWeights() {
    try {
      const w = JSON.parse(localStorage.getItem(LS_WEIGHTS));
      if (w && typeof w.qty === 'number') return w;
    } catch (e) {}
    return { qty: 0.6, tote: 0.4 };
  }
  function saveWeights(w) { localStorage.setItem(LS_WEIGHTS, JSON.stringify(w)); }
  function loadRefresh() {
    let on = true, intervalMs = 60000;
    try {
      const r = JSON.parse(localStorage.getItem(LS_REFRESH));
      if (r) { if (typeof r.on === 'boolean') on = r.on; if (r.intervalMs) intervalMs = r.intervalMs; }
    } catch (e) {}
    return { on, intervalMs, timer: null, busy: false, lastAt: null };
  }
  function saveRefresh() {
    localStorage.setItem(LS_REFRESH, JSON.stringify({ on: state.refresh.on, intervalMs: state.refresh.intervalMs }));
  }
  const displayName = (picker) => state.map[picker] || picker;
  // 매핑된 작업자는 코드도 함께 노출 (미매핑이면 코드만)
  const codeOf = (a) => (a.name && a.name !== a.picker) ? a.picker : '';
  const labelOf = (a) => codeOf(a) ? `${a.name} (${a.picker})` : a.picker;

  /* ============================ 스타일 주입 (다크 프로) ============================ */
  function injectStyle() {
    const existing = document.getElementById('pp-style');
    if (existing) existing.remove(); // 항상 최신 CSS 로 교체
    const FONT = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    const css = `
    .${c('overlay')}{position:fixed;inset:0;z-index:2147483000;
      background:rgba(17,18,22,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
      display:flex;align-items:center;justify-content:center;font-family:${FONT};
      color:#18181b;-webkit-font-smoothing:antialiased;}
    .${c('win')}{width:96vw;height:94vh;max-width:none;display:flex;flex-direction:column;
      background:#ffffff;border:1px solid #e7e7ea;border-radius:16px;overflow:hidden;
      box-shadow:0 24px 60px rgba(20,20,50,.22);}
    .${c('titlebar')}{display:flex;align-items:center;gap:12px;padding:16px 20px;
      border-bottom:1px solid #ececef;user-select:none;cursor:default;
      background:linear-gradient(180deg, rgba(79,70,229,.05), transparent);}
    .${c('brand')}{display:flex;align-items:center;gap:11px;min-width:0;}
    .${c('logo')}{width:30px;height:30px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;
      justify-content:center;color:#fff;font-size:14px;background:linear-gradient(135deg,#6366f1,#4f46e5);
      box-shadow:0 4px 14px rgba(79,70,229,.4);}
    .${c('title')}{font-size:16px;font-weight:800;letter-spacing:-.3px;color:#18181b;}
    .${c('subtitle')}{font-size:12px;color:#71717a;margin-top:1px;}
    .${c('chip')}{margin-left:auto;font-size:12px;font-weight:600;color:#71717a;background:#f4f4f5;
      border:1px solid #e4e4e7;padding:6px 11px;border-radius:999px;white-space:nowrap;}
    .${c('x')}{width:31px;height:31px;flex:0 0 auto;border-radius:9px;border:1px solid #e4e4e7;background:#f4f4f5;
      color:#18181b;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:.15s;}
    .${c('x')}:hover{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#dc2626;}
    .${c('body')}{flex:1 1 auto;overflow:auto;padding:20px 22px 22px;}

    .${c('h')}{display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:14.5px;font-weight:700;
      letter-spacing:-.2px;color:#18181b;}
    .${c('dot')}{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${COLOR_ACCENT};}
    .${c('dot-a')}{background:${COLOR_TOTE};} .${c('dot-v')}{background:#8b5cf6;} .${c('dot-r')}{background:#ef4444;}
    .${c('muted')}{color:#71717a;font-size:12px;line-height:1.6;}

    .${c('row')}{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;}
    .${c('field')}{display:flex;flex-direction:column;gap:6px;}
    .${c('field')} label{font-size:12px;font-weight:600;color:#3f3f46;}
    .${c('field')} input{font:inherit;font-size:13px;padding:8px 10px;border:1px solid #d4d4d8;border-radius:8px;
      background:#fff;color:#18181b;color-scheme:light;}
    .${c('field')} input:focus{outline:none;border-color:${COLOR_ACCENT};box-shadow:0 0 0 3px rgba(79,70,229,.2);}

    .${c('btn')}{font:inherit;font-size:13px;font-weight:700;padding:9px 17px;border-radius:11px;cursor:pointer;
      border:1px solid #e4e4e7;background:#f4f4f5;color:#18181b;transition:filter .12s,transform .12s;}
    .${c('btn')}:hover{transform:translateY(-1px);} .${c('btn')}:active{filter:brightness(.96);}
    .${c('btn-primary')}{border:none;color:#fff;background:linear-gradient(135deg,#6366f1,#4f46e5);
      box-shadow:0 6px 18px rgba(79,70,229,.35);}
    .${c('btn-default')}{background:#f4f4f5;color:#18181b;} .${c('btn-ghost')}{background:transparent;border-color:transparent;color:#4f46e5;}
    /* 작업자별 삭제(✕) 버튼 — 닫기 버튼과 동일한 hover 톤 */
    .${c('del')}{flex:0 0 auto;width:22px;height:22px;border-radius:7px;border:1px solid #e4e4e7;background:#f4f4f5;
      color:#a1a1aa;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;
      padding:0;transition:.15s;}
    .${c('del')}:hover{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#dc2626;}

    .${c('card')}{background:#fafafb;border:1px solid #ececef;border-radius:14px;padding:18px;
      box-shadow:0 1px 2px rgba(0,0,0,.04);}
    .${c('tiles')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px;}
    .${c('tile')}{background:#fafafb;border:1px solid #ececef;border-radius:14px;padding:14px 16px;}
    .${c('tile')} .${c('tval')}{font-size:26px;font-weight:800;letter-spacing:-.6px;color:#18181b;}
    .${c('tile')} .${c('tlbl')}{font-size:12px;color:#71717a;margin-top:3px;font-weight:600;}
    .${c('cards')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:16px;}
    .${c('idlecan')}{position:relative;width:100%;height:280px;}
    .${c('idlerank')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:16px;}

    /* 수치 순위 리스트 (leaderboard) */
    .${c('lb')}{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;}
    .${c('lb')} li{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:12px;border:1px solid transparent;
      background:linear-gradient(90deg, rgba(79,70,229,.08) var(--p,0%), transparent 0);}
    .${c('rk')}{width:26px;height:26px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:800;border-radius:8px;background:#f0f0f2;color:#71717a;}
    .${c('nm')}{font-size:14px;font-weight:700;color:#18181b;}
    .${c('code')}{font-size:11px;font-weight:600;color:#71717a;margin-left:6px;}
    .${c('sub')}{font-size:11px;color:#71717a;font-weight:600;margin-top:2px;}
    .${c('vl')}{margin-left:auto;font-size:16px;font-weight:800;color:#18181b;letter-spacing:-.3px;white-space:nowrap;}
    .${c('vl')} small{font-size:11px;font-weight:600;color:#71717a;margin-left:3px;}
    .${c('lb')} li.${c('t1')}{background:linear-gradient(90deg, rgba(245,158,11,.16), rgba(245,158,11,.04));border-color:rgba(245,158,11,.45);}
    .${c('lb')} li.${c('t2')}{background:linear-gradient(90deg, rgba(148,163,184,.16), rgba(148,163,184,.03));border-color:rgba(148,163,184,.4);}
    .${c('lb')} li.${c('t3')}{background:linear-gradient(90deg, rgba(205,127,50,.15), rgba(205,127,50,.03));border-color:rgba(205,127,50,.4);}
    .${c('lb')} li.${c('t1')} .${c('rk')},.${c('lb')} li.${c('t2')} .${c('rk')},.${c('lb')} li.${c('t3')} .${c('rk')}{color:#fff;font-size:15px;}
    .${c('lb')} li.${c('t1')} .${c('rk')}{background:linear-gradient(135deg,#fcd34d,#f59e0b);box-shadow:0 3px 10px rgba(245,158,11,.45);}
    .${c('lb')} li.${c('t2')} .${c('rk')}{background:linear-gradient(135deg,#e5e7eb,#9ca3af);box-shadow:0 3px 10px rgba(148,163,184,.4);}
    .${c('lb')} li.${c('t3')} .${c('rk')}{background:linear-gradient(135deg,#e0a878,#b45309);box-shadow:0 3px 10px rgba(180,83,9,.35);}
    .${c('lb')} li.${c('t1')} .${c('vl')}{color:#4f46e5;}

    .${c('can-wrap')}{position:relative;width:100%;}
    .${c('loading')}{max-width:640px;margin:14vh auto 0;text-align:center;}
    .${c('loading')} .${c('h')}{justify-content:center;font-size:20px;margin-bottom:20px;}
    .${c('loading')} .${c('muted')}{font-size:14px;margin-top:12px;}
    .${c('progress')}{height:8px;background:#ececef;border-radius:5px;overflow:hidden;margin:14px 0 6px;}
    .${c('loading')} .${c('progress')}{height:12px;border-radius:7px;}
    .${c('progress')} div{height:100%;width:0;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width .2s;}
    .${c('spin-lg')}{display:inline-block;width:34px;height:34px;border:4px solid #e4e4e7;
      border-top-color:${COLOR_ACCENT};border-radius:50%;animation:pp-spin .7s linear infinite;vertical-align:-8px;margin-right:10px;}
    .${c('sliders')}{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:14px;
      background:#fafafb;border:1px solid #ececef;border-radius:14px;padding:12px 16px;}
    .${c('sliders')} label{font-size:12.5px;font-weight:600;color:#3f3f46;}
    .${c('sliders')} input[type=range]{accent-color:${COLOR_ACCENT};width:260px;max-width:60vw;}

    .${c('ta')}{width:100%;min-height:96px;font:inherit;font-size:13px;padding:10px 12px;border:1px solid #d4d4d8;
      border-radius:10px;background:#fff;color:#18181b;resize:vertical;color-scheme:light;}
    .${c('ta')}:focus{outline:none;border-color:${COLOR_ACCENT};box-shadow:0 0 0 3px rgba(79,70,229,.2);}
    /* 매핑 표: 스크롤 시 머리글 고정. border-collapse:separate + box-shadow 로 경계선이 함께 고정되게 함 */
    .${c('table')}{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;}
    .${c('table')} th,.${c('table')} td{padding:8px 10px;border-bottom:1px solid #ececef;text-align:left;}
    .${c('table')} th{font-weight:700;color:#3f3f46;background:#f4f4f5;position:sticky;top:0;z-index:2;
      box-shadow:inset 0 -1px 0 #e4e4e7;border-bottom:none;}
    .${c('table')} input{width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid #d4d4d8;border-radius:6px;
      background:#fff;color:#18181b;color-scheme:light;}

    .${c('footer')}{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}
    .${c('spin')}{display:inline-block;width:16px;height:16px;border:2px solid #e4e4e7;
      border-top-color:${COLOR_ACCENT};border-radius:50%;animation:pp-spin .7s linear infinite;vertical-align:-3px;}
    @keyframes pp-spin{to{transform:rotate(360deg)}}
    .${c('note')}{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);color:#b45309;
      padding:8px 12px;border-radius:8px;font-size:12px;margin-top:12px;}
    /* 실시간 자동 새로고침 바 */
    .${c('rbar')}{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px;
      background:#f4f4f5;border:1px solid #e4e4e7;border-radius:14px;padding:10px 16px;}
    .${c('rlbl')}{font-size:13px;font-weight:700;color:#18181b;display:flex;align-items:center;gap:8px;}
    .${c('sel')}{font:inherit;font-size:12.5px;font-weight:600;padding:6px 9px;border:1px solid #d4d4d8;
      border-radius:8px;background:#fff;color:#18181b;color-scheme:light;cursor:pointer;}
    .${c('rlast')}{margin-left:auto;font-size:12px;font-weight:600;color:#71717a;display:flex;align-items:center;gap:7px;}
    .${c('sw')}{position:relative;width:42px;height:24px;flex:0 0 auto;cursor:pointer;}
    .${c('sw')} input{opacity:0;width:0;height:0;position:absolute;}
    .${c('sw')} span{position:absolute;inset:0;background:#d4d4d8;border-radius:999px;transition:.18s;}
    .${c('sw')} span::before{content:'';position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;
      background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:.18s;}
    .${c('sw')} input:checked + span{background:${COLOR_ACCENT};}
    .${c('sw')} input:checked + span::before{transform:translateX(18px);}
    /* 토스트 */
    .${c('toast')}{position:fixed;left:50%;bottom:34px;transform:translate(-50%,16px);
      background:#18181b;color:#fff;font-size:13px;font-weight:600;padding:11px 18px;border-radius:12px;
      box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transition:opacity .2s,transform .2s;z-index:2147483001;pointer-events:none;}
    .${c('toast-on')}{opacity:1;transform:translate(-50%,0);}`;
    const s = el('style');
    s.id = 'pp-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ============================ 모달 프레임 ============================ */
  let overlay, winEl, bodyEl;

  function buildWindow() {
    overlay = el('div', c('overlay'));
    winEl = el('div', c('win'));

    const bar = el('div', c('titlebar'));
    const brand = el('div', c('brand'));
    const logo = el('div', c('logo'), '◆');
    const titles = el('div');
    titles.append(el('div', c('title'), '집품 성과 대시보드'),
      el('div', c('subtitle'), '작업자별 집품 성과'));
    brand.append(logo, titles);
    const chip = el('div', c('chip'), '조회 전');
    chip.id = 'pp-chip';
    const closeBtn = el('button', c('x'), '✕');
    closeBtn.title = '닫기';
    bar.append(brand, chip, closeBtn);

    bodyEl = el('div', c('body'));
    winEl.append(bar, bodyEl);
    overlay.append(winEl);
    document.body.appendChild(overlay);

    closeBtn.addEventListener('click', destroy);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) destroy(); });
    makeDraggable(bar);
  }

  function setChip(text) {
    const chip = $('#pp-chip');
    if (chip) chip.textContent = text || '조회 전';
  }

  function makeDraggable(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.' + c('x'))) return; // 닫기 버튼은 드래그 제외
      dragging = true;
      const r = winEl.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      winEl.style.position = 'fixed';
      winEl.style.margin = '0';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      winEl.style.left = (ox + e.clientX - sx) + 'px';
      winEl.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  }

  function destroy() {
    stopRefresh();
    Object.values(state.charts).forEach((ch) => { try { ch.destroy(); } catch (e) {} });
    state.charts = {};
    if (overlay) overlay.remove();
    overlay = winEl = bodyEl = null;
  }

  function headline(text, dotClass) {
    const h = el('div', c('h'));
    h.append(el('span', c('dot') + (dotClass ? ' ' + dotClass : '')), document.createTextNode(text));
    return h;
  }

  /* ============================ 뷰: 설정 ============================ */
  function renderConfig() {
    state.view = 'config';
    stopRefresh();
    setChip('조회 전');
    const today = todayLocal();
    bodyEl.innerHTML = '';

    bodyEl.append(headline('조회 조건'));
    bodyEl.append(el('div', c('muted'),
      'PICKING_CREATED 기준으로 조회합니다. 서버는 날짜 단위로 조회하고, 시간은 결과에서 추가로 필터링합니다.'));

    // 결과에서 돌아오면 방금 입력한 기간을 유지(북마크 처음 실행 시에만 오늘로 초기화)
    const f = state.form || {};
    const rowDates = el('div', c('row'));
    rowDates.style.marginTop = '14px';
    rowDates.append(
      field('시작 날짜', 'pp-start-date', 'date', f.sd || today),
      field('시작 시간', 'pp-start-time', 'time', f.st || '00:00'),
      field('종료 날짜', 'pp-end-date', 'date', f.ed || today),
      field('종료 시간', 'pp-end-time', 'time', f.et || '23:59'),
    );

    const rowBtns = el('div', c('row'));
    rowBtns.style.marginTop = '20px';
    const runBtn = el('button', c('btn') + ' ' + c('btn-primary'), '조회');
    const mapBtn = el('button', c('btn') + ' ' + c('btn-default'), '작업자 매핑');
    rowBtns.append(runBtn, mapBtn);

    // 가중치 설명 + 슬라이더
    const wCard = el('div', c('card'));
    wCard.style.marginTop = '20px';
    wCard.append(headline('종합 순위 가중치'));
    wCard.append(el('div', c('muted'),
      '수량과 토트 수를 각각 0~100으로 정규화한 뒤 가중합으로 종합 점수를 냅니다. ' +
      '토트 가중치를 높이면, 할당이 넓게 퍼져 토트는 많지만 수량이 적은 작업자가 덜 불이익을 받습니다.'));
    const sliders = el('div', c('sliders'));
    const wq = Math.round(state.weights.qty * 100);
    sliders.innerHTML =
      `<label>수량 <b id="pp-wq-lbl">${wq}%</b> / 토트 <b id="pp-wt-lbl">${100 - wq}%</b>` +
      `<br><input type="range" id="pp-wq" min="0" max="100" value="${wq}"></label>`;
    wCard.append(sliders);

    bodyEl.append(rowDates, rowBtns, wCard);

    $('#pp-wq', bodyEl).addEventListener('input', (e) => {
      const q = +e.target.value;
      $('#pp-wq-lbl', bodyEl).textContent = q + '%';
      $('#pp-wt-lbl', bodyEl).textContent = (100 - q) + '%';
      state.weights = { qty: q / 100, tote: (100 - q) / 100 };
      saveWeights(state.weights);
    });

    runBtn.addEventListener('click', onRun);
    mapBtn.addEventListener('click', () => renderMapping('config'));
  }

  function field(label, id, type, value) {
    const f = el('div', c('field'));
    const l = el('label', null, label);
    l.setAttribute('for', id);
    const i = el('input');
    i.id = id; i.type = type; i.value = value;
    f.append(l, i);
    return f;
  }

  /* ============================ 조회 실행 ============================ */
  // 수동 조회(버튼): 입력값을 form 으로 저장하고, 제외/캐시 초기화 후 큰 로딩과 함께 조회
  function onRun() {
    const sd = $('#pp-start-date', bodyEl).value;
    const st = $('#pp-start-time', bodyEl).value || '00:00';
    const ed = $('#pp-end-date', bodyEl).value;
    const et = $('#pp-end-time', bodyEl).value || '23:59';
    if (!sd || !ed) { alert('시작/종료 날짜를 입력하세요.'); return; }

    stopRefresh();
    state.form = { sd, st, ed, et }; // 결과에서 돌아와도 유지
    state.excluded.clear();          // 새 조회 = 새 결과이므로 제외 목록 초기화
    state.detailCache.clear();       // 새 조회 = 상세 캐시 초기화
    runQuery({ silent: false });
  }

  // 조회 파이프라인(수동/자동 공통). silent=true 면 큰 로딩 없이 제자리 갱신.
  async function runQuery(opts) {
    const silent = !!(opts && opts.silent);
    const f = state.form;
    if (!f) return;
    if (state.refresh.busy) return; // 중복 실행 방지
    state.refresh.busy = true;

    const { sd, st, ed, et } = f;
    const startDT = new Date(sd + 'T' + st + ':00');
    const endDT = new Date(ed + 'T' + et + ':59');
    state.rangeLabel = (sd === ed) ? `${sd} · ${st}~${et}` : `${sd} ${st} ~ ${ed} ${et}`;

    let p, status;
    if (!silent) {
      renderProgress();
      p = $('#pp-progress-bar', bodyEl);
      status = $('#pp-progress-status', bodyEl);
    } else {
      setUpdating(true);
    }

    try {
      // 1) 목록 조회
      if (status) status.textContent = '목록 조회 중…';
      const listUrl = MOCK ? new URL(MOCK.listUrl, location.href).href : LIST_URL(sd, ed);
      const listHtml = await fetchText(listUrl);
      const listDoc = new DOMParser().parseFromString(listHtml, 'text/html');
      let entries = parseList(listDoc, listUrl);

      // 2) 시간 필터
      const total0 = entries.length;
      let undated = 0;
      entries = entries.filter((e) => {
        if (!e.dt) { undated++; return true; } // 시각 미탐지는 보존
        return e.dt >= startDT && e.dt <= endDT;
      });
      if (status) status.textContent = `대상 ${entries.length}건 (전체 ${total0}건) 상세 수집 중…`;

      // 3) 상세 수집 — 캐시에 없는 href 만 요청(자동 새로고침 부담 최소화)
      const rows = [];
      let done = 0;
      await pool(entries, CONCURRENCY, async (entry) => {
        const key = entry.href;
        let rec = state.detailCache.get(key);
        if (!rec) {
          try {
            const url = (MOCK && MOCK.detailUrl) ? MOCK.detailUrl : entry.href;
            const html = await fetchText(url);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            rec = parseDetail(doc);
            if (rec) state.detailCache.set(key, rec);
          } catch (e) { /* 개별 실패는 건너뜀 */ }
        }
        if (rec) rows.push(rec);
        done++;
        if (p) p.style.width = (entries.length ? (done / entries.length * 100) : 100) + '%';
        if (status) status.textContent = `상세 수집 ${done}/${entries.length}`;
      });

      state.rows = rows;
      aggregate();
      state.refresh.lastAt = new Date();
      await ensureChart();

      if (silent && state.view === 'results' && state.agg.length) {
        updateResultsInPlace();
      } else {
        renderResults({ undated, total0 });
      }
    } catch (err) {
      if (status) {
        status.innerHTML = '오류: ' + (err && err.message ? err.message : err) +
          '<br><span class="' + c('muted') + '">쿠팡에 로그인된 상태에서 실행해야 합니다.</span>';
      } else {
        setUpdating(false, '업데이트 실패 · 다음 주기 재시도');
      }
    } finally {
      state.refresh.busy = false;
      if (silent) setUpdating(false);
    }
  }

  function renderProgress() {
    state.view = 'progress';
    stopRefresh();
    bodyEl.innerHTML = '';
    const wrap = el('div', c('loading'));
    wrap.append(el('div', c('h'), '<span class="' + c('spin-lg') + '"></span>데이터 수집 중'));
    const bar = el('div', c('progress'));
    bar.append(el('div'));
    wrap.append(bar);
    const st = el('div', c('muted'), '준비 중…');
    st.id = 'pp-progress-status';
    wrap.append(st);
    bodyEl.append(wrap);
    $('.' + c('progress') + ' div', bodyEl).id = 'pp-progress-bar';
  }

  /* ============================ 실시간 자동 새로고침 ============================ */
  function startRefresh() {
    stopRefresh();
    if (!state.refresh.on) return;
    state.refresh.timer = setInterval(() => {
      if (state.view === 'results' && !state.refresh.busy) runQuery({ silent: true });
    }, state.refresh.intervalMs);
  }
  function stopRefresh() {
    if (state.refresh.timer) { clearInterval(state.refresh.timer); state.refresh.timer = null; }
  }
  // 자동 새로고침 상태 표시(스피너 + 마지막 업데이트 시각)
  function setUpdating(on, failMsg) {
    const box = $('#pp-rlast', bodyEl);
    if (!box) return;
    const t = state.refresh.lastAt;
    const hhmmss = t ? t.toTimeString().slice(0, 8) : '—';
    box.innerHTML = on
      ? `<span class="${c('spin')}"></span> 업데이트 중…`
      : (failMsg ? esc(failMsg) : `마지막 업데이트 ${hhmmss}`);
  }

  /* ============================ 파싱 ============================ */
  function parseList(doc, baseUrl) {
    const base = baseUrl || 'https://inbound.coupang.com/';
    const out = [];
    const rows = doc.querySelectorAll('table tbody tr, table tr');
    const seen = new Set();
    rows.forEach((tr) => {
      const firstTd = tr.querySelector('td');
      if (!firstTd) return;
      const a = firstTd.querySelector('a[href]');
      if (!a) return;
      const href = new URL(a.getAttribute('href'), base).href;
      if (seen.has(href)) return;
      seen.add(href);
      const m = tr.textContent.match(DT_RE);
      let dt = null;
      if (m) {
        dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (isNaN(dt)) dt = null;
      }
      out.push({ href, dt });
    });
    return out;
  }

  function parseDetail(doc) {
    const table = doc.querySelector('table');
    if (!table) return null;
    // 첫 데이터 행: td 를 가진 첫 tr
    let cells = null;
    const trs = table.querySelectorAll('tr');
    for (const tr of trs) {
      const tds = tr.querySelectorAll('td');
      if (tds.length) { cells = tds; break; }
    }
    if (!cells) return null;
    const txt = (i) => (cells[i] ? cells[i].textContent.trim() : '');
    const tote = txt(IDX_TOTE);
    const picker = txt(IDX_PICKER);
    const qty = parseInt((txt(IDX_QTY) || '').replace(/[^\d.-]/g, ''), 10) || 0;
    // 집품완료시간 → 타임스탬프(ms) | null
    let done = null;
    const dm = (txt(IDX_DONE) || '').match(DT_RE);
    if (dm) {
      const d = new Date(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], +(dm[6] || 0));
      if (!isNaN(d)) done = d.getTime();
    }
    if (!picker && !tote) return null;
    return { tote, picker, qty, done };
  }

  /* ============================ 집계 & 점수 ============================ */
  function aggregate() {
    const byPicker = new Map();
    state.rows.forEach((r) => {
      const key = r.picker || '(미상)';
      if (state.excluded.has(key)) return; // 이번 결과에서 삭제된 작업자는 집계에서 제외
      let g = byPicker.get(key);
      if (!g) { g = { picker: key, qty: 0, totes: new Set(), dones: [] }; byPicker.set(key, g); }
      g.qty += r.qty;
      if (r.tote) g.totes.add(r.tote);
      if (r.done != null) g.dones.push(r.done);
    });
    state.agg = Array.from(byPicker.values()).map((g) => {
      const idle = computeIdle(g.dones);
      return {
        picker: g.picker,
        name: displayName(g.picker),
        qty: g.qty,
        totes: g.totes.size || 0,
        eff: g.totes.size ? +(g.qty / g.totes.size).toFixed(1) : 0,
        idleLast: idle.last, // 마지막 − 직전 완료 간격(ms)
        idleMax: idle.max,   // 기간 내 연속 완료 최대 간격(ms)
        idleMaxStart: idle.maxStart, // 최대 간격 시작 완료 시각
        idleMaxEnd: idle.maxEnd,     // 최대 간격 끝 완료 시각
        idleLastStart: idle.lastStart, // 유휴시간(마지막−직전) 시작 완료 시각
        idleLastEnd: idle.lastEnd,     // 유휴시간(마지막−직전) 끝 완료 시각
        doneCount: g.dones.length,     // 완료 건수(평균 유휴 계산용)
        firstDone: idle.first,       // 첫 완료 시각
        lastDone: idle.lastDone,     // 마지막 완료 시각
      };
    });
    computeScores();
  }

  // 완료 타임스탬프 배열 → 유휴 지표(ms). last=마지막−직전, max=연속 최대 간격.
  function computeIdle(dones) {
    if (!dones || !dones.length) return { last: 0, max: 0, maxStart: null, maxEnd: null, lastStart: null, lastEnd: null, first: null, lastDone: null };
    const s = dones.slice().sort((a, b) => a - b);
    if (s.length < 2) return { last: 0, max: 0, maxStart: null, maxEnd: null, lastStart: null, lastEnd: null, first: s[0], lastDone: s[0] };
    let max = 0, ms = null, me = null;
    for (let i = 1; i < s.length; i++) {
      const g = s[i] - s[i - 1];
      if (g > max) { max = g; ms = s[i - 1]; me = s[i]; }
    }
    return {
      last: s[s.length - 1] - s[s.length - 2], max: max,
      maxStart: ms, maxEnd: me,
      lastStart: s[s.length - 2], lastEnd: s[s.length - 1], // 유휴시간(마지막−직전) 구간
      first: s[0], lastDone: s[s.length - 1],
    };
  }

  // 평균 유휴 시간(ms): 전체 완료 간격 평균 = Σ(마지막−첫 완료) ÷ Σ(완료건수−1)
  function avgIdleGap() {
    let span = 0, gaps = 0;
    state.agg.forEach((a) => {
      if (a.doneCount >= 2 && a.firstDone != null && a.lastDone != null) {
        span += (a.lastDone - a.firstDone);
        gaps += (a.doneCount - 1);
      }
    });
    return gaps ? span / gaps : 0;
  }

  function computeScores() {
    const maxQ = Math.max(1, ...state.agg.map((a) => a.qty));
    const minQ = Math.min(...state.agg.map((a) => a.qty), 0);
    const maxT = Math.max(1, ...state.agg.map((a) => a.totes));
    const minT = Math.min(...state.agg.map((a) => a.totes), 0);
    const norm = (v, mn, mx) => (mx === mn ? 100 : ((v - mn) / (mx - mn)) * 100);
    const w = state.weights;
    state.agg.forEach((a) => {
      a.qtyN = norm(a.qty, minQ, maxQ);
      a.toteN = norm(a.totes, minT, maxT);
      a.score = +(w.qty * a.qtyN + w.tote * a.toteN).toFixed(1);
    });
  }

  /* ============================ Chart.js 로더 ============================ */
  function ensureChart() {
    if (window.Chart) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = el('script');
      s.src = CHART_CDN;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Chart.js 로드 실패. 빌드된 북마크릿(dist/bookmarklet.txt)에는 Chart.js 가 내장되어 있습니다.'));
      document.head.appendChild(s);
    });
  }

  /* ============================ 뷰: 결과 ============================ */
  function renderResults(meta) {
    state.view = 'results';
    state.meta = meta || {}; // 삭제 후 재렌더 때 undated 안내 유지
    setChip(state.rangeLabel || '조회 완료');
    bodyEl.innerHTML = '';

    if (!state.agg.length) {
      bodyEl.append(headline('결과 없음'));
      bodyEl.append(el('div', c('muted'), '조회된 데이터가 없습니다. 날짜/시간 범위를 확인하세요.'));
      const back = el('button', c('btn') + ' ' + c('btn-default'), '← 조회 조건');
      back.style.marginTop = '16px';
      back.addEventListener('click', renderConfig);
      bodyEl.append(back);
      return;
    }

    // 실시간 자동 새로고침 바
    bodyEl.append(buildRefreshBar());

    // 요약 타일 (값 span 에 id 부여 → 자동 새로고침 시 제자리 갱신)
    const totQ = state.agg.reduce((s, a) => s + a.qty, 0);
    const totT = state.agg.reduce((s, a) => s + a.totes, 0);
    const tiles = el('div', c('tiles'));
    tiles.append(
      tile(totQ.toLocaleString(), '총 집품 수량', 'pp-t-qty'),
      tile(totT.toLocaleString(), '총 토트 수', 'pp-t-tote'),
      tile(String(state.agg.length), '작업자 수', 'pp-t-workers'),
      tile(totT ? (totQ / totT).toFixed(1) : '0', '토트당 평균 수량', 'pp-t-avg'),
      tile(fmtDuration(avgIdleGap()), '평균 유휴 시간', 'pp-t-idleavg'),
    );
    bodyEl.append(tiles);

    if (meta && meta.undated) {
      bodyEl.append(el('div', c('note'),
        `시각을 인식하지 못한 ${meta.undated}건은 시간 필터 없이 포함되었습니다.`));
    }

    // 섹션 1: 종합 대시보드 (막대그래프)
    const sec1 = el('div', c('card'));
    sec1.style.marginTop = '18px';
    sec1.append(headline('종합 대시보드 — 작업자별 수량 · 토트 수'));
    const wrap1 = el('div', c('can-wrap'));
    wrap1.style.height = 'clamp(340px, 44vh, 620px)';
    const cv1 = el('canvas'); cv1.id = 'pp-chart-main';
    wrap1.append(cv1); sec1.append(wrap1);
    bodyEl.append(sec1);

    // 섹션 2: 수치 순위 리더보드 (수량 / 토트 / 종합)
    const cards = el('div', c('cards'));
    cards.append(
      lbCard('집품 수량 순위', c('dot'), 'pp-lb-qty'),
      lbCard('토트 수 순위', c('dot-a'), 'pp-lb-tote'),
      lbCard('종합 순위', c('dot-v'), 'pp-lb-score'),
    );
    bodyEl.append(cards);

    // 섹션 3: 유휴 타임라인(간트) — 단독, 전체 폭
    const sec3 = el('div', c('card'));
    sec3.style.marginTop = '16px';
    sec3.append(headline('유휴 타임라인 — 작업 구간 · 최대 유휴 시간대', c('dot-r')));
    const canBox = el('div', c('can-wrap') + ' ' + c('idlecan'));
    const cvi = el('canvas'); cvi.id = 'pp-chart-idle';
    canBox.append(cvi);
    sec3.append(canBox);
    bodyEl.append(sec3);

    // 섹션 4: 유휴 순위 2열 (좌: 유휴시간 / 우: 최대유휴시간)
    const idleRank = el('div', c('idlerank'));
    idleRank.append(
      lbCard('유휴시간 순위', c('dot-r'), 'pp-lb-idle-last'),
      lbCard('최대유휴시간 순위', c('dot-v'), 'pp-lb-idle-max'),
    );
    bodyEl.append(idleRank);

    // 종합 순위 가중치 재조정 슬라이더
    const wRow = el('div', c('sliders'));
    const wq = Math.round(state.weights.qty * 100);
    wRow.innerHTML =
      `<label>종합 순위 가중치 · 수량 <b id="pp-r-wq-lbl">${wq}%</b> / 토트 <b id="pp-r-wt-lbl">${100 - wq}%</b>` +
      `<br><input type="range" id="pp-r-wq" min="0" max="100" value="${wq}"></label>`;
    bodyEl.append(wRow);
    $('#pp-r-wq', bodyEl).addEventListener('input', (e) => {
      const q = +e.target.value;
      $('#pp-r-wq-lbl', bodyEl).textContent = q + '%';
      $('#pp-r-wt-lbl', bodyEl).textContent = (100 - q) + '%';
      state.weights = { qty: q / 100, tote: (100 - q) / 100 };
      saveWeights(state.weights);
      computeScores();
      renderScoreBoard();
    });

    // 하단 버튼
    const footer = el('div', c('footer'));
    const backBtn = el('button', c('btn') + ' ' + c('btn-default'), '← 조회 조건');
    const mapBtn = el('button', c('btn') + ' ' + c('btn-default'), '작업자 매핑');
    footer.append(backBtn, mapBtn);
    bodyEl.append(footer);
    mapBtn.addEventListener('click', () => renderMapping('results'));
    backBtn.addEventListener('click', renderConfig);

    // 렌더
    renderLeaderboard('pp-lb-qty', (a) => a.qty, '개');
    renderLeaderboard('pp-lb-tote', (a) => a.totes, '토트');
    renderScoreBoard();
    renderIdleLastBoard();
    renderIdleMaxBoard();
    drawMainChart();
    drawIdleTimeline();
    setUpdating(false);   // 마지막 업데이트 시각 표시
    startRefresh();       // 자동 새로고침 재개(설정이 on 이면)
  }

  function tile(val, lbl, valId) {
    const t = el('div', c('tile'));
    const v = el('div', c('tval'), val);
    if (valId) v.id = valId;
    t.append(v, el('div', c('tlbl'), lbl));
    return t;
  }

  // 실시간 자동 새로고침 바 (토글 + 주기 + 마지막 업데이트)
  function buildRefreshBar() {
    const bar = el('div', c('rbar'));
    const lbl = el('label', c('rlbl'));
    const sw = el('span', c('sw'));
    sw.innerHTML = `<input type="checkbox" ${state.refresh.on ? 'checked' : ''}><span></span>`;
    lbl.append(sw, document.createTextNode('실시간 자동 새로고침'));
    const sel = el('select', c('sel'));
    [['30초', 30000], ['1분', 60000], ['5분', 300000]].forEach(([t, v]) => {
      const o = el('option', null, t); o.value = String(v);
      if (v === state.refresh.intervalMs) o.selected = true;
      sel.append(o);
    });
    const last = el('div', c('rlast'));
    last.id = 'pp-rlast';
    bar.append(lbl, sel, last);

    sw.querySelector('input').addEventListener('change', (e) => {
      state.refresh.on = e.target.checked;
      saveRefresh();
      if (state.refresh.on) { startRefresh(); runQuery({ silent: true }); }
      else { stopRefresh(); setUpdating(false); }
    });
    sel.addEventListener('change', (e) => {
      state.refresh.intervalMs = +e.target.value;
      saveRefresh();
      if (state.refresh.on) startRefresh();
    });
    return bar;
  }

  // 자동 새로고침 시 화면을 다시 그리지 않고 데이터만 제자리 갱신
  function updateResultsInPlace() {
    const totQ = state.agg.reduce((s, a) => s + a.qty, 0);
    const totT = state.agg.reduce((s, a) => s + a.totes, 0);
    const set = (id, v) => { const n = $('#' + id, bodyEl); if (n) n.textContent = v; };
    set('pp-t-qty', totQ.toLocaleString());
    set('pp-t-tote', totT.toLocaleString());
    set('pp-t-workers', String(state.agg.length));
    set('pp-t-avg', totT ? (totQ / totT).toFixed(1) : '0');
    set('pp-t-idleavg', fmtDuration(avgIdleGap()));
    renderLeaderboard('pp-lb-qty', (a) => a.qty, '개');
    renderLeaderboard('pp-lb-tote', (a) => a.totes, '토트');
    renderScoreBoard();
    renderIdleLastBoard();
    renderIdleMaxBoard();
    drawMainChart();
    drawIdleTimeline();
    setUpdating(false);
  }

  function lbCard(title, dotClass, olId) {
    const card = el('div', c('card'));
    card.append(headline(title, dotClass === c('dot') ? '' : dotClass));
    const ol = el('ol', c('lb'));
    ol.id = olId;
    card.append(ol);
    return card;
  }

  const MEDALS = ['🥇', '🥈', '🥉'];

  function renderLeaderboard(olId, valFn, unit, subFn, opts) {
    const ol = $('#' + olId, bodyEl);
    if (!ol) return;
    const useMedal = !opts || opts.medal !== false;
    const showDel = !!(opts && opts.del);
    const fmt = (opts && opts.fmt) || ((v) => v.toLocaleString() + `<small>${unit}</small>`);
    const arr = [...state.agg].sort((a, b) => valFn(b) - valFn(a));
    const max = arr.length ? (Math.max(...arr.map(valFn)) || 1) : 1;
    ol.innerHTML = '';
    arr.forEach((a, i) => {
      const li = el('li');
      if (useMedal && i < 3) li.classList.add(c('t' + (i + 1)));
      li.style.setProperty('--p', Math.max(6, valFn(a) / max * 100) + '%');
      const rk = (useMedal && i < 3) ? MEDALS[i] : (i + 1);
      li.innerHTML =
        `<span class="${c('rk')}">${rk}</span>` +
        `<span><span class="${c('nm')}">${esc(a.name)}</span>` +
        (codeOf(a) ? `<span class="${c('code')}">${esc(a.picker)}</span>` : '') +
        (subFn ? `<div class="${c('sub')}">${subFn(a)}</div>` : '') + `</span>` +
        `<span class="${c('vl')}">${fmt(valFn(a))}</span>` +
        (showDel ? `<button class="${c('del')}" type="button" title="이 작업자를 이번 결과에서 삭제">✕</button>` : '');
      if (showDel) li.querySelector('.' + c('del')).addEventListener('click', () => removeWorker(a.picker));
      ol.append(li);
    });
  }

  function renderScoreBoard() {
    // 삭제(✕) 버튼은 종합 순위에서만
    renderLeaderboard('pp-lb-score', (a) => a.score, '점',
      (a) => `수량 ${a.qty.toLocaleString()} · 토트 ${a.totes} · 효율 ${a.eff}`,
      { del: true });
  }

  // 유휴시간 순위: 마지막−직전 완료 간격 내림차순. 유휴는 보상이 아니므로 메달 대신 순위 숫자.
  // 최대 유휴는 발생 시간대(HH:MM→HH:MM)도 함께 표시.
  // 유휴시간 순위: 마지막−직전 완료 간격 기준
  function renderIdleLastBoard() {
    renderLeaderboard('pp-lb-idle-last', (a) => a.idleLast, '',
      (a) => a.idleLast ? `${hhmm(a.idleLastStart)}→${hhmm(a.idleLastEnd)}` : '—',
      { fmt: (v) => fmtDuration(v), medal: false });
  }
  // 최대유휴시간 순위: 기간 내 연속 완료 최대 간격 기준
  function renderIdleMaxBoard() {
    renderLeaderboard('pp-lb-idle-max', (a) => a.idleMax, '',
      (a) => a.idleMax ? `${hhmm(a.idleMaxStart)}→${hhmm(a.idleMaxEnd)}` : '—',
      { fmt: (v) => fmtDuration(v), medal: false });
  }

  // 작업자를 이번 결과에서 삭제 → 재집계 후 결과 화면 전체 재렌더(차트·순위·요약 타일 반영)
  function removeWorker(picker) {
    state.excluded.add(picker);
    aggregate();
    renderResults(state.meta || {});
  }

  /* ============================ 섹션1 차트 ============================ */
  function drawMainChart() {
    Chart.defaults.font.family = "'Pretendard','Apple SD Gothic Neo',-apple-system,sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = '#3f3f46';   // 축·라벨 기본 글씨(진한 회색으로 대비 강화)
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(24,24,27,.92)';
    Chart.defaults.plugins.tooltip.cornerRadius = 10;
    Chart.defaults.plugins.tooltip.padding = 10;

    const grid = 'rgba(0,0,0,.06)';
    const tickFont = { weight: '600' };
    const axisTitle = (text) => ({ display: true, text, color: '#27272a', font: { weight: '700', size: 12 } });
    const byQty = [...state.agg].sort((a, b) => b.qty - a.qty);
    destroyChart('main');
    state.charts.main = new Chart($('#pp-chart-main', bodyEl), {
      type: 'bar',
      data: {
        // 매핑 시 위=이름 / 아래=코드 2줄(배열 라벨)로 → 한 줄로 길어져 대각선으로 기우는 문제 방지
        labels: byQty.map((a) => codeOf(a) ? [a.name, a.picker] : [a.picker]),
        datasets: [
          { label: '수량', data: byQty.map((a) => a.qty), backgroundColor: COLOR_QTY, yAxisID: 'y', borderRadius: 7 },
          { label: '토트 수', data: byQty.map((a) => a.totes), backgroundColor: COLOR_TOTE, yAxisID: 'y1', borderRadius: 7 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        // 캔버스를 최소 2x 해상도로 렌더 → 1x 화면에서도 글씨/막대가 흐릿하지 않게(이미지처럼 뭉개짐 방지)
        devicePixelRatio: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, color: '#27272a', font: { weight: '700', size: 12.5 } } } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: '#3f3f46', font: tickFont } },
          y: { beginAtZero: true, position: 'left', grid: { color: grid }, border: { display: false }, ticks: { color: '#3f3f46', font: tickFont }, title: axisTitle('수량') },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, border: { display: false }, ticks: { color: '#3f3f46', font: tickFont }, title: axisTitle('토트 수') },
        },
      },
    });
  }

  function destroyChart(key) {
    if (state.charts[key]) { try { state.charts[key].destroy(); } catch (e) {} delete state.charts[key]; }
  }

  /* ============================ 섹션3 유휴 타임라인(간트) ============================ */
  function drawIdleTimeline() {
    const canvas = $('#pp-chart-idle', bodyEl);
    if (!canvas) return;
    destroyChart('idle');

    // 유휴시간(마지막−직전) 내림차순으로 작업자 정렬
    const arr = [...state.agg].sort((a, b) => b.idleMax - a.idleMax);
    const withTime = arr.filter((a) => a.firstDone != null);
    const box = canvas.parentElement;
    let note = box.querySelector('.' + c('idlenote'));

    if (!withTime.length) { // 완료시간 데이터가 전혀 없을 때 (캔버스는 보존, 안내만 표시)
      canvas.style.display = 'none';
      if (!note) { note = el('div', c('idlenote') + ' ' + c('muted'), '완료시간 데이터가 없습니다. (상세 6번째 칸 확인)'); note.style.padding = '24px 4px'; box.append(note); }
      box.style.height = 'auto';
      return;
    }
    if (note) note.remove();
    canvas.style.display = '';
    box.style.height = Math.max(200, withTime.length * 46 + 44) + 'px';

    const labels = withTime.map((a) => labelOf(a));
    const spanData = withTime.map((a) => [a.firstDone, a.lastDone]);           // 작업 구간
    const gapData = withTime.map((a) => (a.idleMax ? [a.idleMaxStart, a.idleMaxEnd] : null)); // 최대 유휴 구간
    const times = withTime.flatMap((a) => [a.firstDone, a.lastDone]);
    const minT = Math.min(...times), maxT = Math.max(...times);
    const pad = Math.max(60000, (maxT - minT) * 0.04); // 최소 1분 패딩

    state.charts.idle = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '작업 구간', data: spanData, backgroundColor: '#e4e4e7', borderRadius: 5,
            grouped: false, order: 2, barPercentage: 0.55, categoryPercentage: 0.8 },
          { label: '최대 유휴', data: gapData, backgroundColor: 'rgba(239,68,68,.85)', borderRadius: 5,
            grouped: false, order: 1, barPercentage: 0.55, categoryPercentage: 0.8 },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        devicePixelRatio: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, color: '#27272a', font: { weight: '700', size: 12 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const a = withTime[ctx.dataIndex];
                if (ctx.datasetIndex === 1) {
                  return a.idleMax ? `최대 유휴 ${fmtDuration(a.idleMax)} (${hhmm(a.idleMaxStart)}→${hhmm(a.idleMaxEnd)})` : '최대 유휴 없음';
                }
                return `작업 ${hhmm(a.firstDone)}→${hhmm(a.lastDone)}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: minT - pad, max: maxT + pad,
            grid: { color: 'rgba(0,0,0,.06)' }, border: { display: false },
            ticks: { color: '#3f3f46', font: { weight: '600' }, maxTicksLimit: 8, callback: (v) => hhmm(v) },
          },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: '#3f3f46', font: { weight: '700' } } },
        },
      },
    });
  }

  /* ============================ 뷰: 작업자 매핑 (엑셀 붙여넣기) ============================ */
  function renderMapping(returnTo) {
    state.view = 'mapping';
    bodyEl.innerHTML = '';
    bodyEl.append(headline('작업자 매핑'));
    bodyEl.append(el('div', c('muted'),
      '엑셀에서 두 열(왼쪽=집품작업자 코드, 오른쪽=이름)을 그대로 복사해 아래 칸에 붙여넣으세요. ' +
      '표에 자동 반영됩니다. 개별 수정도 가능하며, 저장하면 차트·순위 라벨이 이름으로 표시됩니다.'));

    // 붙여넣기 영역
    const ta = el('textarea', c('ta'));
    ta.id = 'pp-paste';
    ta.placeholder = '예)\nW001\t이진희\nW002\t박영진\n… (엑셀 2열 복사 → 붙여넣기)';
    ta.style.marginTop = '12px';
    bodyEl.append(ta);
    const applyRow = el('div', c('row'));
    applyRow.style.marginTop = '10px';
    const applyBtn = el('button', c('btn') + ' ' + c('btn-default'), '붙여넣기 → 표 반영');
    applyRow.append(applyBtn);
    bodyEl.append(applyRow);

    // 편집 표
    const codes = new Set(Object.keys(state.map));
    state.agg.forEach((a) => codes.add(a.picker));
    state.rows.forEach((r) => { if (r.picker) codes.add(r.picker); });

    const tblWrap = el('div', c('card'));
    tblWrap.style.marginTop = '14px';
    tblWrap.style.padding = '0';       // 카드 패딩 제거 → sticky 머리글이 위쪽 여백 없이 딱 붙게(스크롤 버그 방지)
    tblWrap.style.maxHeight = '38vh';
    tblWrap.style.overflow = 'auto';
    const tbl = el('table', c('table'));
    tbl.innerHTML = '<thead><tr><th style="width:44%">집품작업자 (코드)</th><th>집품작업자 이름</th>' +
      '<th style="width:44px;text-align:center">삭제</th></tr></thead>';
    const tbody = el('tbody');
    tbl.append(tbody);
    tblWrap.append(tbl);
    bodyEl.append(tblWrap);

    function fillTable(map) {
      const list = Array.from(new Set([...codes, ...Object.keys(map)])).filter(Boolean).sort();
      tbody.innerHTML = '';
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="' + c('muted') +
          '">먼저 조회를 실행하거나, 위 칸에 엑셀 데이터를 붙여넣으세요.</td></tr>';
        return;
      }
      list.forEach((code) => tbody.append(mapRow(code, map[code] || '')));
    }
    fillTable(state.map);

    // 현재 표를 map 으로 수집
    function collectTable() {
      const m = {};
      tbody.querySelectorAll('tr').forEach((tr) => {
        const inps = tr.querySelectorAll('input');
        if (inps.length < 2) return;
        const code = inps[0].value.trim();
        const name = inps[1].value.trim();
        if (code && name) m[code] = name;
      });
      return m;
    }

    // 엑셀 붙여넣기 파싱: 줄 → (탭 | 콤마 | 2+ 공백) 2열
    function parsePasted(text) {
      const map = {};
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        const cols = line.split(/\t|,|\s{2,}/).map((s) => s.trim()).filter((s) => s !== '');
        if (cols.length >= 2) map[cols[0]] = cols.slice(1).join(' ');
      });
      return map;
    }
    function applyPaste() {
      const pasted = parsePasted(ta.value);
      const n = Object.keys(pasted).length;
      if (!n) { showToast('코드·이름 2열을 찾지 못했습니다'); return; }
      Object.keys(pasted).forEach((k) => codes.add(k));
      // 기존 표 입력값 + 붙여넣기 병합(붙여넣기 우선)
      fillTable(Object.assign({}, collectTable(), pasted));
      ta.value = '';                      // 입력창 초기화
      showToast(`${n}명 반영됨`);           // 피드백 토스트
    }
    applyBtn.addEventListener('click', applyPaste);
    ta.addEventListener('paste', () => setTimeout(applyPaste, 0)); // 붙여넣는 즉시 반영

    // 하단 버튼
    const footer = el('div', c('footer'));
    const addBtn = el('button', c('btn') + ' ' + c('btn-ghost'), '+ 행 추가');
    const cancelBtn = el('button', c('btn') + ' ' + c('btn-default'), '취소');
    const saveBtn = el('button', c('btn') + ' ' + c('btn-primary'), '저장');
    footer.append(addBtn, cancelBtn, saveBtn);
    bodyEl.append(footer);

    addBtn.addEventListener('click', () => tbody.append(mapRow('', '')));
    cancelBtn.addEventListener('click', back);
    saveBtn.addEventListener('click', () => {
      state.map = collectTable();
      saveMap(state.map);
      if (state.agg.length) aggregate();
      showToast('매핑 저장됨');
      back();
    });

    function back() {
      if (returnTo === 'results' && state.agg.length) renderResults({});
      else renderConfig();
    }
  }

  function mapRow(code, name) {
    const tr = el('tr');
    const td1 = el('td'), td2 = el('td'), td3 = el('td');
    td3.style.textAlign = 'center';
    const i1 = el('input'); i1.value = code; i1.placeholder = '코드';
    const i2 = el('input'); i2.value = name; i2.placeholder = '이름';
    const del = el('button', c('del'), '✕');
    del.type = 'button';
    del.title = '이 작업자를 표와 이번 결과에서 삭제';
    // 행 삭제 + (코드가 있으면) 이번 결과에서 제외. 저장 시 aggregate() 가 반영.
    del.addEventListener('click', () => {
      const cd = i1.value.trim();
      if (cd) state.excluded.add(cd);
      tr.remove();
    });
    td1.append(i1); td2.append(i2); td3.append(del);
    tr.append(td1, td2, td3);
    return tr;
  }

  /* ============================ 네트워크 유틸 ============================ */
  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  // 동시성 제한 풀
  async function pool(items, limit, worker) {
    const queue = items.slice();
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      runners.push((async () => {
        while (queue.length) {
          const item = queue.shift();
          await worker(item);
        }
      })());
    }
    await Promise.all(runners);
  }

  /* ============================ 진입점 ============================ */
  const api = {
    open() {
      injectStyle();
      if (!overlay) { buildWindow(); }
      renderConfig();
    },
    destroy,  // 다음 버전 북마크릿이 깔끔히 철거할 수 있게 노출
    // 테스트 편의를 위해 내부 함수 노출
    _parseList: parseList,
    _parseDetail: parseDetail,
    _state: state,
  };
  window.__PP_DASHBOARD__ = api;
  api.open();
})();

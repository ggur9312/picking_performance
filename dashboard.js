/*
 * 집품 성과 대시보드 (Picking Performance Dashboard)
 * -------------------------------------------------
 * inbound.coupang.com 반품 토트 데이터를 수집해 집품 작업자별 성과를
 * macOS 스타일 모달 + Chart.js 로 시각화하는 북마크릿 앱.
 *
 * 자체포함(single self-contained) 설계: 이 파일 전체가 북마크릿 본문이 되며
 * 외부 의존성은 Chart.js CDN 하나뿐이다.
 *
 * 실행 컨텍스트: inbound.coupang.com 페이지 위에서 실행되어야 한다
 * (같은 출처여야 세션 쿠키로 조회가 되고 CORS 문제가 없다).
 *
 * 로컬 검증(index.html 모의 테스트)에서는 window.__PP_MOCK__ 로
 * 조회 URL / 상세 URL 을 fixture 로 대체할 수 있다.
 */
(function () {
  'use strict';

  // 이미 열려 있으면 다시 열기만 한다.
  if (window.__PP_DASHBOARD__) {
    window.__PP_DASHBOARD__.open();
    return;
  }

  /* ============================ 설정 상수 ============================ */
  const PREFIX = 'pp';
  const LS_MAP = 'pp_worker_map';       // { picker: name }
  const LS_WEIGHTS = 'pp_weights';      // { qty: 0.6, tote: 0.4 }
  const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
  const CONCURRENCY = 6;                // 상세 페이지 동시 요청 수

  // 상세 페이지 첫 table 의 데이터 셀 인덱스 (사용자 명세)
  const IDX_TOTE = 0;
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
  };

  const PALETTE = ['#0A84FF', '#30D158', '#FF9F0A', '#FF375F', '#BF5AF2',
    '#64D2FF', '#FFD60A', '#5E5CE6', '#FF453A', '#66D4CF'];

  /* ============================ 유틸 ============================ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const c = (name) => PREFIX + '-' + name; // class helper

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
  const displayName = (picker) => state.map[picker] || picker;

  /* ============================ 스타일 주입 ============================ */
  function injectStyle() {
    if (document.getElementById('pp-style')) return;
    const css = `
    .${c('overlay')}{position:fixed;inset:0;z-index:2147483000;
      background:rgba(0,0,0,.28);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
      display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
      color:#1d1d1f;-webkit-font-smoothing:antialiased;}
    .${c('win')}{width:min(1080px,94vw);max-height:92vh;display:flex;flex-direction:column;
      background:rgba(246,246,248,.96);border-radius:12px;overflow:hidden;
      box-shadow:0 24px 70px rgba(0,0,0,.42),0 0 0 .5px rgba(0,0,0,.18);}
    .${c('titlebar')}{height:44px;flex:0 0 auto;display:flex;align-items:center;padding:0 14px;
      background:linear-gradient(#ececee,#dededf);border-bottom:.5px solid #c6c6c9;
      cursor:default;user-select:none;position:relative;}
    .${c('lights')}{display:flex;gap:8px;}
    .${c('light')}{width:12px;height:12px;border-radius:50%;border:.5px solid rgba(0,0,0,.18);}
    .${c('close')}{background:#ff5f57;}.${c('min')}{background:#febc2e;}.${c('max')}{background:#28c840;}
    .${c('light')}:hover{filter:brightness(.92);cursor:pointer;}
    .${c('title')}{position:absolute;left:0;right:0;text-align:center;font-size:13px;font-weight:600;color:#3a3a3c;pointer-events:none;}
    .${c('body')}{flex:1 1 auto;overflow:auto;padding:22px 24px;}
    .${c('h2')}{font-size:15px;font-weight:700;margin:0 0 12px;color:#1d1d1f;}
    .${c('muted')}{color:#8a8a8e;font-size:12px;}
    .${c('row')}{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;}
    .${c('field')}{display:flex;flex-direction:column;gap:6px;}
    .${c('field')} label{font-size:12px;font-weight:600;color:#48484a;}
    .${c('field')} input{font:inherit;font-size:13px;padding:7px 9px;border:1px solid #c6c6c9;
      border-radius:7px;background:#fff;color:#1d1d1f;}
    .${c('field')} input:focus{outline:none;border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.25);}
    .${c('btn')}{font:inherit;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;
      border:1px solid transparent;cursor:pointer;transition:filter .12s;}
    .${c('btn')}:active{filter:brightness(.93);}
    .${c('btn-primary')}{background:linear-gradient(#3aa0ff,#0a84ff);color:#fff;
      box-shadow:0 1px 2px rgba(10,132,255,.4);}
    .${c('btn-default')}{background:#fff;color:#1d1d1f;border-color:#c6c6c9;}
    .${c('btn-ghost')}{background:transparent;color:#0a84ff;}
    .${c('card')}{background:#fff;border-radius:12px;padding:16px;
      box-shadow:0 1px 3px rgba(0,0,0,.08),0 0 0 .5px rgba(0,0,0,.05);}
    .${c('tiles')}{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px;}
    .${c('tile')}{background:#fff;border-radius:12px;padding:14px 16px;
      box-shadow:0 1px 3px rgba(0,0,0,.08),0 0 0 .5px rgba(0,0,0,.05);}
    .${c('tile')} .${c('tval')}{font-size:24px;font-weight:800;letter-spacing:-.5px;}
    .${c('tile')} .${c('tlbl')}{font-size:12px;color:#8a8a8e;margin-top:2px;font-weight:600;}
    .${c('cards')}{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:18px;}
    .${c('cardhead')}{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;}
    .${c('cardhead')} h3{font-size:14px;font-weight:700;margin:0;}
    .${c('can-wrap')}{position:relative;width:100%;}
    .${c('progress')}{height:8px;background:#e5e5ea;border-radius:5px;overflow:hidden;margin:14px 0 6px;}
    .${c('progress')} div{height:100%;width:0;background:linear-gradient(90deg,#0a84ff,#30d158);transition:width .2s;}
    .${c('sliders')}{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-top:6px;}
    .${c('sliders')} input[type=range]{accent-color:#0a84ff;width:180px;}
    .${c('table')}{width:100%;border-collapse:collapse;font-size:13px;}
    .${c('table')} th,.${c('table')} td{padding:7px 10px;border-bottom:1px solid #ececee;text-align:left;}
    .${c('table')} th{font-weight:700;color:#48484a;background:#f7f7f9;position:sticky;top:0;}
    .${c('table')} input{width:100%;font:inherit;font-size:13px;padding:5px 7px;border:1px solid #d6d6d9;border-radius:6px;}
    .${c('footer')}{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}
    .${c('spin')}{display:inline-block;width:16px;height:16px;border:2px solid #c6c6c9;
      border-top-color:#0a84ff;border-radius:50%;animation:pp-spin .7s linear infinite;vertical-align:-3px;}
    @keyframes pp-spin{to{transform:rotate(360deg)}}
    .${c('note')}{background:#fff8e1;border:1px solid #ffe08a;color:#8a6d00;
      padding:8px 12px;border-radius:8px;font-size:12px;margin-top:12px;}
    @media (prefers-color-scheme: dark){
      .${c('win')}{background:rgba(38,38,40,.97);color:#f5f5f7;}
      .${c('titlebar')}{background:linear-gradient(#3a3a3c,#2c2c2e);border-bottom-color:#1c1c1e;}
      .${c('title')}{color:#d1d1d6;}
      .${c('body')}{color:#f5f5f7;}
      .${c('h2')},.${c('field')} label{color:#f5f5f7;}
      .${c('field')} input,.${c('table')} input{background:#1c1c1e;color:#f5f5f7;border-color:#48484a;}
      .${c('card')},.${c('tile')}{background:#2c2c2e;box-shadow:0 1px 3px rgba(0,0,0,.4),0 0 0 .5px rgba(255,255,255,.06);}
      .${c('btn-default')}{background:#3a3a3c;color:#f5f5f7;border-color:#48484a;}
      .${c('table')} th{background:#3a3a3c;color:#d1d1d6;}
      .${c('table')} th,.${c('table')} td{border-bottom-color:#3a3a3c;}
      .${c('cardhead')} h3,.${c('tile')} .${c('tval')}{color:#f5f5f7;}
    }`;
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
    const lights = el('div', c('lights'));
    const close = el('div', c('light') + ' ' + c('close'));
    const min = el('div', c('light') + ' ' + c('min'));
    const max = el('div', c('light') + ' ' + c('max'));
    lights.append(close, min, max);
    const title = el('div', c('title'), '집품 성과 대시보드');
    bar.append(lights, title);

    bodyEl = el('div', c('body'));
    winEl.append(bar, bodyEl);
    overlay.append(winEl);
    document.body.appendChild(overlay);

    close.addEventListener('click', destroy);
    min.addEventListener('click', () => { bodyEl.style.display = bodyEl.style.display === 'none' ? '' : 'none'; });
    max.addEventListener('click', () => {
      const full = winEl.dataset.full === '1';
      winEl.style.width = full ? 'min(1080px,94vw)' : '98vw';
      winEl.style.maxHeight = full ? '92vh' : '96vh';
      winEl.dataset.full = full ? '' : '1';
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) destroy(); });
    makeDraggable(bar);
  }

  function makeDraggable(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains(c('light'))) return;
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
    Object.values(state.charts).forEach((ch) => { try { ch.destroy(); } catch (e) {} });
    state.charts = {};
    if (overlay) overlay.remove();
    overlay = winEl = bodyEl = null;
  }

  /* ============================ 뷰: 설정 ============================ */
  function renderConfig() {
    state.view = 'config';
    const today = new Date().toISOString().slice(0, 10);
    bodyEl.innerHTML = '';

    const h = el('div', c('h2'), '조회 조건');
    const desc = el('div', c('muted'),
      'PICKING_CREATED 기준으로 조회합니다. 서버는 날짜 단위로 조회하고, 시간은 결과에서 추가로 필터링합니다.');

    const rowDates = el('div', c('row'));
    rowDates.style.marginTop = '14px';
    rowDates.append(
      field('시작 날짜', 'pp-start-date', 'date', today),
      field('시작 시간', 'pp-start-time', 'time', '00:00'),
      field('종료 날짜', 'pp-end-date', 'date', today),
      field('종료 시간', 'pp-end-time', 'time', '23:59'),
    );

    const rowBtns = el('div', c('row'));
    rowBtns.style.marginTop = '20px';
    const runBtn = el('button', c('btn') + ' ' + c('btn-primary'), '조회');
    const mapBtn = el('button', c('btn') + ' ' + c('btn-default'), '작업자 매핑');
    rowBtns.append(runBtn, mapBtn);

    // 가중치 슬라이더
    const wCard = el('div', c('card'));
    wCard.style.marginTop = '20px';
    wCard.append(el('div', c('h2'), '종합 순위 가중치'));
    wCard.append(el('div', c('muted'),
      '수량과 토트 수를 각각 0~100으로 정규화한 뒤 가중합으로 종합 점수를 냅니다. ' +
      '토트 가중치를 높이면, 할당이 넓게 퍼져 토트는 많지만 수량이 적은 작업자가 덜 불이익을 받습니다.'));
    const sliders = el('div', c('sliders'));
    const wq = state.weights.qty;
    sliders.innerHTML =
      `<label style="font-size:12px;font-weight:600">수량 <b id="pp-wq-lbl">${Math.round(wq * 100)}%</b>` +
      `<br><input type="range" id="pp-wq" min="0" max="100" value="${Math.round(wq * 100)}"></label>` +
      `<label style="font-size:12px;font-weight:600">토트 <b id="pp-wt-lbl">${Math.round((1 - wq) * 100)}%</b>` +
      `<br><input type="range" id="pp-wt" min="0" max="100" value="${Math.round((1 - wq) * 100)}" disabled></label>`;
    wCard.append(sliders);

    bodyEl.append(h, desc, rowDates, rowBtns, wCard);

    // 가중치 상호 연동 (합=100)
    const wqEl = $('#pp-wq', bodyEl);
    wqEl.addEventListener('input', () => {
      const q = +wqEl.value;
      $('#pp-wq-lbl', bodyEl).textContent = q + '%';
      $('#pp-wt-lbl', bodyEl).textContent = (100 - q) + '%';
      $('#pp-wt', bodyEl).value = 100 - q;
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
  async function onRun() {
    const sd = $('#pp-start-date', bodyEl).value;
    const st = $('#pp-start-time', bodyEl).value || '00:00';
    const ed = $('#pp-end-date', bodyEl).value;
    const et = $('#pp-end-time', bodyEl).value || '23:59';
    if (!sd || !ed) { alert('시작/종료 날짜를 입력하세요.'); return; }

    const startDT = new Date(sd + 'T' + st + ':00');
    const endDT = new Date(ed + 'T' + et + ':59');

    renderProgress();
    const p = $('#pp-progress-bar', bodyEl);
    const status = $('#pp-progress-status', bodyEl);

    try {
      // 1) 목록 조회
      status.textContent = '목록 조회 중…';
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
      status.textContent = `대상 ${entries.length}건 (전체 ${total0}건) 상세 수집 중…`;

      // 3) 상세 병렬 수집
      const rows = [];
      let done = 0;
      await pool(entries, CONCURRENCY, async (entry) => {
        try {
          const url = (MOCK && MOCK.detailUrl) ? MOCK.detailUrl : entry.href;
          const html = await fetchText(url);
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const rec = parseDetail(doc);
          if (rec) rows.push(rec);
        } catch (e) { /* 개별 실패는 건너뜀 */ }
        done++;
        p.style.width = (entries.length ? (done / entries.length * 100) : 100) + '%';
        status.textContent = `상세 수집 ${done}/${entries.length}`;
      });

      state.rows = rows;
      aggregate();
      await ensureChart();
      renderResults({ undated, total0 });
    } catch (err) {
      status.innerHTML = '오류: ' + (err && err.message ? err.message : err) +
        '<br><span class="' + c('muted') + '">쿠팡에 로그인된 상태에서 실행해야 합니다.</span>';
    }
  }

  function renderProgress() {
    state.view = 'progress';
    bodyEl.innerHTML = '';
    bodyEl.append(el('div', c('h2'), '<span class="' + c('spin') + '"></span> 데이터 수집 중'));
    const bar = el('div', c('progress'));
    bar.append(el('div'));
    bodyEl.append(bar);
    const st = el('div', c('muted'), '준비 중…');
    st.id = 'pp-progress-status';
    bodyEl.append(st);
    $('.' + c('progress') + ' div', bodyEl).id = 'pp-progress-bar';
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
    if (!picker && !tote) return null;
    return { tote, picker, qty };
  }

  /* ============================ 집계 & 점수 ============================ */
  function aggregate() {
    const byPicker = new Map();
    state.rows.forEach((r) => {
      const key = r.picker || '(미상)';
      let g = byPicker.get(key);
      if (!g) { g = { picker: key, qty: 0, totes: new Set() }; byPicker.set(key, g); }
      g.qty += r.qty;
      if (r.tote) g.totes.add(r.tote);
    });
    state.agg = Array.from(byPicker.values()).map((g) => ({
      picker: g.picker,
      name: displayName(g.picker),
      qty: g.qty,
      totes: g.totes.size || 0,
      eff: g.totes.size ? +(g.qty / g.totes.size).toFixed(1) : 0,
    }));
    computeScores();
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
      s.onerror = () => reject(new Error('Chart.js 로드 실패 (CSP 차단 가능). README의 콘솔 대체안을 참고하세요.'));
      document.head.appendChild(s);
    });
  }

  /* ============================ 뷰: 결과 ============================ */
  function renderResults(meta) {
    state.view = 'results';
    bodyEl.innerHTML = '';

    if (!state.agg.length) {
      bodyEl.append(el('div', c('h2'), '결과 없음'));
      bodyEl.append(el('div', c('muted'), '조회된 데이터가 없습니다. 날짜/시간 범위를 확인하세요.'));
      const back = el('button', c('btn') + ' ' + c('btn-default'), '← 조회 조건');
      back.style.marginTop = '16px';
      back.addEventListener('click', renderConfig);
      bodyEl.append(back);
      return;
    }

    // 요약 타일
    const totQ = state.agg.reduce((s, a) => s + a.qty, 0);
    const totT = state.agg.reduce((s, a) => s + a.totes, 0);
    const tiles = el('div', c('tiles'));
    tiles.append(
      tile(totQ.toLocaleString(), '총 집품 수량'),
      tile(totT.toLocaleString(), '총 토트 수'),
      tile(String(state.agg.length), '작업자 수'),
      tile(totT ? (totQ / totT).toFixed(1) : '0', '토트당 평균 수량'),
    );
    bodyEl.append(tiles);

    if (meta && meta.undated) {
      bodyEl.append(el('div', c('note'),
        `시각을 인식하지 못한 ${meta.undated}건은 시간 필터 없이 포함되었습니다.`));
    }

    // 섹션 1: 종합 대시보드
    const sec1 = el('div', c('card'));
    sec1.style.marginTop = '18px';
    sec1.append(el('div', c('h2'), '① 종합 대시보드 — 작업자별 수량 · 토트 수'));
    const wrap1 = el('div', c('can-wrap'));
    wrap1.style.height = '320px';
    const cv1 = el('canvas'); cv1.id = 'pp-chart-main';
    wrap1.append(cv1); sec1.append(wrap1);
    bodyEl.append(sec1);

    // 섹션 2: 3 카드
    const cards = el('div', c('cards'));
    cards.append(
      rankCard('② 집품 수량 순위', 'pp-chart-qty'),
      rankCard('③ 토트 수 순위', 'pp-chart-tote'),
      rankCard('④ 종합 순위', 'pp-chart-score'),
    );
    bodyEl.append(cards);

    // 하단 버튼
    const footer = el('div', c('footer'));
    const mapBtn = el('button', c('btn') + ' ' + c('btn-default'), '작업자 매핑');
    const backBtn = el('button', c('btn') + ' ' + c('btn-ghost'), '← 조회 조건');
    footer.append(backBtn, mapBtn);
    bodyEl.append(footer);
    mapBtn.addEventListener('click', () => renderMapping('results'));
    backBtn.addEventListener('click', renderConfig);

    // 종합 순위 가중치 재조정 슬라이더 (결과 화면에서도)
    const wRow = el('div', c('sliders'));
    wRow.style.marginTop = '14px';
    const wq = Math.round(state.weights.qty * 100);
    wRow.innerHTML =
      `<label style="font-size:12px;font-weight:600">종합 순위 가중치 · 수량 <b id="pp-r-wq-lbl">${wq}%</b> / 토트 <b id="pp-r-wt-lbl">${100 - wq}%</b>` +
      `<br><input type="range" id="pp-r-wq" min="0" max="100" value="${wq}" style="width:260px"></label>`;
    cards.after(wRow);
    $('#pp-r-wq', bodyEl).addEventListener('input', (e) => {
      const q = +e.target.value;
      $('#pp-r-wq-lbl', bodyEl).textContent = q + '%';
      $('#pp-r-wt-lbl', bodyEl).textContent = (100 - q) + '%';
      state.weights = { qty: q / 100, tote: (100 - q) / 100 };
      saveWeights(state.weights);
      computeScores();
      updateScoreChart();
    });

    drawCharts();
  }

  function tile(val, lbl) {
    const t = el('div', c('tile'));
    t.append(el('div', c('tval'), val), el('div', c('tlbl'), lbl));
    return t;
  }
  function rankCard(title, canvasId) {
    const card = el('div', c('card'));
    const head = el('div', c('cardhead'));
    head.append(el('h3', null, title));
    card.append(head);
    const wrap = el('div', c('can-wrap'));
    wrap.style.height = '300px';
    const cv = el('canvas'); cv.id = canvasId;
    wrap.append(cv); card.append(wrap);
    return card;
  }

  /* ============================ 차트 그리기 ============================ */
  function drawCharts() {
    const font = { family: "-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif" };
    Chart.defaults.font.family = font.family;

    // 섹션 1: 수량 + 토트 그룹 막대 (이중 축)
    const byQty = [...state.agg].sort((a, b) => b.qty - a.qty);
    destroyChart('main');
    state.charts.main = new Chart($('#pp-chart-main', bodyEl), {
      type: 'bar',
      data: {
        labels: byQty.map((a) => a.name),
        datasets: [
          { label: '수량', data: byQty.map((a) => a.qty), backgroundColor: '#0A84FF', yAxisID: 'y', borderRadius: 5 },
          { label: '토트 수', data: byQty.map((a) => a.totes), backgroundColor: '#30D158', yAxisID: 'y1', borderRadius: 5 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { beginAtZero: true, position: 'left', title: { display: true, text: '수량' } },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '토트 수' } },
        },
      },
    });

    drawRank('qty', 'pp-chart-qty', (a) => a.qty, '#0A84FF', (a) => `${a.qty.toLocaleString()} 개`);
    drawRank('tote', 'pp-chart-tote', (a) => a.totes, '#30D158', (a) => `${a.totes.toLocaleString()} 토트`);
    updateScoreChart();
  }

  function drawRank(key, canvasId, valFn, color, labelFn) {
    const sorted = [...state.agg].sort((a, b) => valFn(b) - valFn(a));
    destroyChart(key);
    state.charts[key] = new Chart($('#' + canvasId, bodyEl), {
      type: 'bar',
      data: {
        labels: sorted.map((a) => a.name),
        datasets: [{
          data: sorted.map(valFn),
          backgroundColor: sorted.map((_, i) => color + (i === 0 ? '' : 'cc')),
          borderRadius: 5,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => labelFn(sorted[ctx.dataIndex]) } },
        },
        scales: { x: { beginAtZero: true } },
      },
    });
  }

  function updateScoreChart() {
    const sorted = [...state.agg].sort((a, b) => b.score - a.score);
    destroyChart('score');
    state.charts.score = new Chart($('#pp-chart-score', bodyEl), {
      type: 'bar',
      data: {
        labels: sorted.map((a) => a.name),
        datasets: [{
          data: sorted.map((a) => a.score),
          backgroundColor: sorted.map((_, i) => PALETTE[i % PALETTE.length]),
          borderRadius: 5,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const a = sorted[ctx.dataIndex];
                return [`종합 ${a.score}점`, `수량 ${a.qty.toLocaleString()} / 토트 ${a.totes} / 효율 ${a.eff}`];
              },
            },
          },
        },
        scales: { x: { beginAtZero: true, max: 100 } },
      },
    });
  }

  function destroyChart(key) {
    if (state.charts[key]) { try { state.charts[key].destroy(); } catch (e) {} delete state.charts[key]; }
  }

  /* ============================ 뷰: 작업자 매핑 ============================ */
  function renderMapping(returnTo) {
    state.view = 'mapping';
    bodyEl.innerHTML = '';
    bodyEl.append(el('div', c('h2'), '작업자 매핑'));
    bodyEl.append(el('div', c('muted'),
      '왼쪽 열은 수집된 집품작업자 코드, 오른쪽 열에 이름을 입력하세요. 저장하면 차트 라벨이 이름으로 표시됩니다.'));

    // 수집된 코드 + 저장된 매핑 병합
    const codes = new Set(Object.keys(state.map));
    state.agg.forEach((a) => codes.add(a.picker));
    state.rows.forEach((r) => { if (r.picker) codes.add(r.picker); });
    const list = Array.from(codes).filter(Boolean).sort();

    const tblWrap = el('div', c('card'));
    tblWrap.style.marginTop = '14px';
    tblWrap.style.maxHeight = '46vh';
    tblWrap.style.overflow = 'auto';
    const tbl = el('table', c('table'));
    tbl.innerHTML = '<thead><tr><th style="width:45%">집품작업자 (코드)</th><th>집품작업자 이름</th></tr></thead>';
    const tbody = el('tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="' + c('muted') + '">먼저 조회를 실행하면 작업자 코드가 채워집니다. 지금 직접 추가할 수도 있습니다.</td></tr>';
    }
    list.forEach((code) => tbody.append(mapRow(code, state.map[code] || '')));
    tbl.append(tbody);
    tblWrap.append(tbl);
    bodyEl.append(tblWrap);

    const footer = el('div', c('footer'));
    const addBtn = el('button', c('btn') + ' ' + c('btn-ghost'), '+ 행 추가');
    const saveBtn = el('button', c('btn') + ' ' + c('btn-primary'), '저장');
    const cancelBtn = el('button', c('btn') + ' ' + c('btn-default'), '취소');
    footer.append(addBtn, cancelBtn, saveBtn);
    bodyEl.append(footer);

    addBtn.addEventListener('click', () => tbody.append(mapRow('', '')));
    cancelBtn.addEventListener('click', () => back());
    saveBtn.addEventListener('click', () => {
      const m = {};
      tbody.querySelectorAll('tr').forEach((tr) => {
        const inps = tr.querySelectorAll('input');
        if (inps.length < 2) return;
        const code = inps[0].value.trim();
        const name = inps[1].value.trim();
        if (code && name) m[code] = name;
      });
      state.map = m;
      saveMap(m);
      if (state.agg.length) { aggregate(); }
      back();
    });

    function back() {
      if (returnTo === 'results' && state.agg.length) renderResults({});
      else renderConfig();
    }
  }

  function mapRow(code, name) {
    const tr = el('tr');
    const td1 = el('td'), td2 = el('td');
    const i1 = el('input'); i1.value = code; i1.placeholder = '코드';
    const i2 = el('input'); i2.value = name; i2.placeholder = '이름';
    td1.append(i1); td2.append(i2);
    tr.append(td1, td2);
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
    // 테스트 편의를 위해 내부 함수 노출
    _parseList: parseList,
    _parseDetail: parseDetail,
    _state: state,
  };
  window.__PP_DASHBOARD__ = api;
  api.open();
})();

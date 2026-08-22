/**
 * CKD 컨테이너 수량 산출 자동화 — UI 애플리케이션
 *
 * 역할: 엑셀 업로드/파싱(SheetJS), 설정 변경, 계산 엔진(js/engine.js) 호출,
 *       차트(Chart.js)·표 렌더링, 물류팀 전달용 엑셀 내보내기.
 * 계산 로직은 전부 engine.js에 있으며 이 파일은 입출력만 담당한다.
 */
(function () {
  'use strict';

  var engine = window.CKDEngine;

  /* ------------------------------------------------------------------ */
  /* 설정 (config/container.json과 동일한 기본값 — file:// 실행 대비)      */
  /* ------------------------------------------------------------------ */

  var DEFAULT_CONFIG = {
    defaultType: '40ft',
    targetLoadRate: 0.7,
    scenarioRates: [0.65, 0.7, 0.75],
    carryOver: false,
    carryOverThreshold: 0.5,
    types: {
      '40ft': {
        name: '40ft 일반(Dry)',
        innerLengthMm: 12032, innerWidthMm: 2352, innerHeightMm: 2395,
        maxCbm: 67.7, maxWeightKg: 26780
      },
      '40HC': {
        name: '40ft 하이큐브(HC)',
        innerLengthMm: 12032, innerWidthMm: 2352, innerHeightMm: 2698,
        maxCbm: 76.4, maxWeightKg: 26460
      }
    }
  };

  /* 차트 색상 (색각이상 검증을 통과한 팔레트, 고정 순서) */
  var COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
  var INK_MUTED = '#898781';
  var GRID = '#e1e0d9';

  var state = {
    config: DEFAULT_CONFIG,
    type: DEFAULT_CONFIG.defaultType,
    loadRatePct: 70,
    carryOver: false,
    plan: [],
    modelBox: null,
    boxMaster: null,
    result: null,
    scenarios: null,
    activeCorp: null
  };

  var charts = {}; // canvas id -> Chart 인스턴스

  /* ------------------------------------------------------------------ */
  /* 유틸리티                                                            */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function fmt(n) { return Number(n).toLocaleString('ko-KR'); }

  function pct(x, digits) {
    return (x * 100).toFixed(digits == null ? 1 : digits) + '%';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function monthLabel(mo) {
    var p = mo.split('-');
    return p[0].slice(2) + "'" + parseInt(p[1], 10) + '월';
  }

  function boxesToText(boxes) {
    return Object.keys(boxes).sort().map(function (code) {
      return code + '×' + boxes[code];
    }).join(', ');
  }

  function showErrors(list) {
    var el = $('errorNotice');
    if (!list || list.length === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '<b>데이터 검증 오류</b><ul>' +
      list.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    el.classList.remove('hidden');
  }

  /** 비차단 경고 배너 표시(html이 비어 있으면 숨김). */
  function showWarn(id, html) {
    var el = $(id);
    if (!html) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* 엑셀 파싱 (SheetJS)                                                  */
  /* ------------------------------------------------------------------ */

  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function readWorkbook(file) {
    return file.arrayBuffer().then(function (buf) {
      return XLSX.read(buf, { type: 'array' });
    });
  }

  function firstSheetRows(wb) {
    var ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: null });
  }

  /** 생산계획 행 파싱: 법인 / 모델명 / YYYY-MM 컬럼들 */
  function parsePlanRows(rows, fileName) {
    var out = [];
    rows.forEach(function (r) {
      var corp = r['법인'];
      var model = r['모델명'];
      if (corp == null || model == null) return;
      var qty = {};
      Object.keys(r).forEach(function (k) {
        var key = String(k).trim();
        if (MONTH_RE.test(key)) {
          var v = Number(r[k]);
          if (!isNaN(v) && v > 0) qty[key] = v;
        }
      });
      out.push({ corp: String(corp).trim(), model: String(model).trim(), qty: qty });
    });
    if (out.length === 0) {
      throw new Error(fileName + ': "법인/모델명/YYYY-MM" 형식의 행을 찾지 못했습니다.');
    }
    return out;
  }

  /** 모델-박스 구성 파싱: 모델명 / 박스코드 / 대당 박스 수량 */
  function parseModelBoxRows(rows, fileName) {
    var out = [];
    rows.forEach(function (r) {
      if (r['모델명'] == null || r['박스코드'] == null) return;
      out.push({
        model: String(r['모델명']).trim(),
        boxCode: String(r['박스코드']).trim(),
        perUnit: Number(r['대당 박스 수량']) || 0
      });
    });
    if (out.length === 0) {
      throw new Error(fileName + ': "모델명/박스코드/대당 박스 수량" 컬럼을 찾지 못했습니다.');
    }
    return out;
  }

  /** 박스 마스터 파싱 */
  function parseBoxMasterRows(rows, fileName) {
    var out = {};
    rows.forEach(function (r) {
      var code = r['박스코드'];
      if (code == null) return;
      var l = Number(r['길이(mm)']) || 0;
      var w = Number(r['폭(mm)']) || 0;
      var h = Number(r['높이(mm)']) || 0;
      var cbm = Number(r['부피(CBM)']);
      if (!cbm || isNaN(cbm)) cbm = Math.round(l * w * h / 1e6) / 1000; // 치수로 자동 계산
      out[String(code).trim()] = {
        lengthMm: l, widthMm: w, heightMm: h,
        cbm: cbm,
        weightKg: Number(r['중량(kg)']) || 0,
        maxStack: Number(r['적층 가능 단수']) || 1,
        group: r['혼적 그룹'] != null ? String(r['혼적 그룹']).trim() : 'G1',
        note: r['비고'] != null ? String(r['비고']) : ''
      };
    });
    if (Object.keys(out).length === 0) {
      throw new Error(fileName + ': "박스코드/치수/중량/혼적 그룹" 컬럼을 찾지 못했습니다.');
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 업로드 핸들러                                                        */
  /* ------------------------------------------------------------------ */

  function setStatus(id, text, loaded) {
    var el = $(id);
    el.textContent = text;
    el.classList.toggle('loaded', !!loaded);
  }

  function handlePlanFiles(files) {
    var jobs = Array.prototype.map.call(files, function (file) {
      return readWorkbook(file).then(function (wb) {
        return parsePlanRows(firstSheetRows(wb), file.name);
      });
    });
    Promise.all(jobs).then(function (parsedList) {
      var newRows = [];
      parsedList.forEach(function (rows) { newRows = newRows.concat(rows); });
      // 새로 올라온 법인의 기존 계획은 교체한다
      var corps = {};
      newRows.forEach(function (r) { corps[r.corp] = true; });
      state.plan = state.plan.filter(function (r) { return !corps[r.corp]; }).concat(newRows);
      var corpNames = Object.keys(corps).join(', ');
      setStatus('statusPlan', '불러옴: ' + corpNames + ' (' + fmt(newRows.length) + '개 모델 행)', true);
      recompute();
    }).catch(function (err) {
      setStatus('statusPlan', '오류: ' + err.message, false);
    });
  }

  function handleSingleFile(file, parser, statusId, assign) {
    readWorkbook(file).then(function (wb) {
      var parsed = parser(firstSheetRows(wb), file.name);
      assign(parsed);
      var count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
      setStatus(statusId, '불러옴: ' + file.name + ' (' + fmt(count) + '건)', true);
      recompute();
    }).catch(function (err) {
      setStatus(statusId, '오류: ' + err.message, false);
    });
  }

  function loadSampleData() {
    var sample = window.CKD_SAMPLE_DATA;
    state.plan = sample.plan.map(function (r) {
      return { corp: r.corp, model: r.model, qty: r.qty };
    });
    state.modelBox = sample.modelBox.slice();
    state.boxMaster = sample.boxMaster;
    setStatus('statusPlan', '샘플 불러옴: 브라질, 인도 (' + fmt(state.plan.length) + '개 모델 행)', true);
    setStatus('statusModelBox', '샘플 불러옴 (' + fmt(state.modelBox.length) + '건)', true);
    setStatus('statusBoxMaster', '샘플 불러옴 (' + fmt(Object.keys(state.boxMaster).length) + '종)', true);
    recompute();
  }

  /* ------------------------------------------------------------------ */
  /* 계산 실행                                                            */
  /* ------------------------------------------------------------------ */

  function currentContainer() {
    return state.config.types[state.type];
  }

  function recompute() {
    if (state.plan.length === 0 || !state.modelBox || !state.boxMaster) return;

    var input = {
      plan: state.plan,
      modelBox: state.modelBox,
      boxMaster: state.boxMaster,
      container: currentContainer()
    };

    var errors = engine.validateInput(input);
    showErrors(errors);
    if (errors.length > 0) return;

    var opts = {
      loadRate: state.loadRatePct / 100,
      carryOver: state.carryOver,
      carryOverThreshold: state.config.carryOverThreshold
    };
    state.result = engine.calculate(input, opts);

    // 생산계획에는 있으나 구성 마스터에 없는 모델 → 산출 제외 경고(비차단)
    var unmatched = state.result.unmatchedModels || [];
    showWarn('warnNotice', unmatched.length === 0 ? '' :
      '<b>주의</b> 생산계획에 있으나 박스 구성 마스터에 없는 모델 ' + unmatched.length + '건: ' +
      esc(unmatched.join(', ')) +
      ' — 해당 모델의 물량은 아래 산출 결과에서 <b>제외</b>되어 있습니다.');

    state.scenarios = engine.runScenarios(input, state.config.scenarioRates, {
      carryOver: state.carryOver,
      carryOverThreshold: state.config.carryOverThreshold
    });
    if (!state.activeCorp || state.result.corps.indexOf(state.activeCorp) < 0) {
      state.activeCorp = state.result.corps[0];
    }

    $('emptyState').classList.add('hidden');
    $('resultArea').classList.remove('hidden');
    renderAll();
  }

  function renderAll() {
    renderKpis();
    renderMonthlyChart();
    renderMonthlyTable();
    renderBoxChart();
    renderScenario();
    renderManifest();
  }

  /* ------------------------------------------------------------------ */
  /* KPI 카드                                                             */
  /* ------------------------------------------------------------------ */

  function renderKpis() {
    var res = state.result;
    var total = 0, totalCbm = 0, containerMonths = 0;
    res.corps.forEach(function (corp) {
      total += res.byCorp[corp].totalContainers;
      res.byCorp[corp].monthly.forEach(function (m) {
        totalCbm += m.totalCbm;
        containerMonths += m.containerCount;
      });
    });
    var maxCbm = currentContainer().maxCbm;
    var avgRate = containerMonths > 0 ? totalCbm / (containerMonths * maxCbm) : 0;
    var monthlyAvg = res.months.length > 0 ? total / res.months.length : 0;

    var cards = [
      { label: '총 컨테이너 소요 (18개월)', value: fmt(total), unit: '대',
        sub: state.type + ' · 목표 적재율 ' + state.loadRatePct + '%', cls: '' },
      { label: '월 평균 소요', value: fmt(Math.round(monthlyAvg * 10) / 10), unit: '대/월',
        sub: res.months[0] + ' ~ ' + res.months[res.months.length - 1], cls: '' }
    ];
    res.corps.forEach(function (corp, i) {
      cards.push({
        label: corp + '법인 컨테이너', value: fmt(res.byCorp[corp].totalContainers), unit: '대',
        sub: '박스 ' + fmt(Object.keys(res.boxTotals[corp]).reduce(function (s, c) {
          return s + res.boxTotals[corp][c];
        }, 0)) + '개', cls: i === 0 ? 'accent' : 'accent-2'
      });
    });
    cards.push({
      label: '평균 실적재율 (부피)', value: pct(avgRate), unit: '',
      sub: '컨테이너 CBM ' + maxCbm + ' 기준', cls: ''
    });

    $('kpiGrid').innerHTML = cards.map(function (c) {
      return '<div class="kpi ' + c.cls + '">' +
        '<div class="label">' + esc(c.label) + '</div>' +
        '<div class="value">' + c.value + (c.unit ? '<small>' + c.unit + '</small>' : '') + '</div>' +
        '<div class="sub">' + esc(c.sub) + '</div></div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* 차트 공통                                                            */
  /* ------------------------------------------------------------------ */

  function baseOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, color: '#52514e' }
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) + '대';
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: INK_MUTED, maxRotation: 45 } },
        y: {
          beginAtZero: true,
          title: { display: !!yTitle, text: yTitle || '', color: INK_MUTED, font: { size: 12 } },
          grid: { color: GRID },
          ticks: { color: INK_MUTED, callback: function (v) { return fmt(v); } }
        }
      }
    };
  }

  function drawChart(canvasId, cfg) {
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart($(canvasId).getContext('2d'), cfg);
  }

  /* ------------------------------------------------------------------ */
  /* 차트 1: 법인별 × 월별 컨테이너                                        */
  /* ------------------------------------------------------------------ */

  function renderMonthlyChart() {
    var res = state.result;
    $('mainChartDesc').textContent =
      '적재율 ' + state.loadRatePct + '% · ' + currentContainer().name +
      (state.carryOver ? ' · 덜 찬 컨테이너 다음 달 이월 적용' : ' · 남는 박스 없이 당월 확보');

    var datasets = res.corps.map(function (corp, i) {
      return {
        label: corp + '법인',
        data: res.byCorp[corp].monthly.map(function (m) { return m.containerCount; }),
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 4,
        maxBarThickness: 26
      };
    });

    drawChart('chartMonthly', {
      type: 'bar',
      data: { labels: res.months.map(monthLabel), datasets: datasets },
      options: baseOptions('컨테이너 (대)')
    });
  }

  /* ------------------------------------------------------------------ */
  /* 표: 월별 컨테이너 소요                                                */
  /* ------------------------------------------------------------------ */

  function renderMonthlyTable() {
    var res = state.result;
    var months = res.months;
    var html = '<table class="data"><thead><tr><th class="text">법인 / 구분</th>';
    months.forEach(function (mo) { html += '<th>' + monthLabel(mo) + '</th>'; });
    html += '<th>합계</th></tr></thead><tbody>';

    res.corps.forEach(function (corp) {
      var monthly = res.byCorp[corp].monthly;
      html += '<tr><td class="text"><b>' + esc(corp) + '법인</b> · 2차(조합)</td>';
      monthly.forEach(function (m) { html += '<td>' + fmt(m.containerCount) + '</td>'; });
      html += '<td><b>' + fmt(res.byCorp[corp].totalContainers) + '</b></td></tr>';

      var simpleSum = 0;
      html += '<tr><td class="text sub-metric">' + esc(corp) + '법인 · 1차(단순 부피)</td>';
      monthly.forEach(function (m) {
        simpleSum += m.simple.byVolume;
        html += '<td class="sub-metric">' + fmt(m.simple.byVolume) + '</td>';
      });
      html += '<td class="sub-metric">' + fmt(simpleSum) + '</td></tr>';

      html += '<tr><td class="text sub-metric">' + esc(corp) + '법인 · 평균 실적재율(부피)</td>';
      monthly.forEach(function (m) {
        html += '<td class="sub-metric">' + (m.containerCount > 0 ? pct(m.avgCbmRate, 0) : '-') + '</td>';
      });
      html += '<td class="sub-metric">-</td></tr>';
    });

    // 합계(2차 기준)
    var grand = 0;
    html += '<tr class="total-row"><td class="text">합계 (2차 확보 기준)</td>';
    months.forEach(function (mo, mi) {
      var s = res.corps.reduce(function (acc, corp) {
        return acc + res.byCorp[corp].monthly[mi].containerCount;
      }, 0);
      grand += s;
      html += '<td>' + fmt(s) + '</td>';
    });
    html += '<td>' + fmt(grand) + '</td></tr>';
    html += '</tbody></table>';
    $('monthlyTableWrap').innerHTML = html;
  }

  /* ------------------------------------------------------------------ */
  /* 차트 2: 박스 종류별 물량                                              */
  /* ------------------------------------------------------------------ */

  function renderBoxChart() {
    var res = state.result;
    var codes = {};
    res.corps.forEach(function (corp) {
      Object.keys(res.boxTotals[corp]).forEach(function (c) { codes[c] = true; });
    });
    var labels = Object.keys(codes).sort();

    var datasets = res.corps.map(function (corp, i) {
      return {
        label: corp + '법인',
        data: labels.map(function (c) { return res.boxTotals[corp][c] || 0; }),
        backgroundColor: COLORS[i % COLORS.length],
        borderRadius: 4,
        maxBarThickness: 40
      };
    });

    var opts = baseOptions('박스 수량 (개)');
    opts.plugins.tooltip.callbacks.label = function (ctx) {
      var code = labels[ctx.dataIndex];
      var spec = state.boxMaster[code] || {};
      return ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) + '개' +
        (spec.group ? ' (혼적 ' + spec.group + ', ' + spec.cbm + ' CBM)' : '');
    };

    drawChart('chartBoxes', {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: opts
    });
  }

  /* ------------------------------------------------------------------ */
  /* 차트 3 + 표: 적재율 시나리오 비교                                      */
  /* ------------------------------------------------------------------ */

  function renderScenario() {
    var res = state.result;
    var scen = state.scenarios;
    $('scenarioDesc').textContent =
      '적재율을 ' + scen.map(function (s) { return Math.round(s.rate * 100) + '%'; }).join(' / ') +
      '로 바꿨을 때 월별 총(브라질+인도) 컨테이너 소요 비교입니다.';

    var datasets = scen.map(function (s, i) {
      return {
        label: '적재율 ' + Math.round(s.rate * 100) + '%',
        data: s.monthlyTotal,
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: COLORS[i % COLORS.length],
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.25,
        fill: false
      };
    });

    drawChart('chartScenario', {
      type: 'line',
      data: { labels: res.months.map(monthLabel), datasets: datasets },
      options: baseOptions('컨테이너 (대)')
    });

    // 시나리오 요약 표
    var html = '<table class="data"><thead><tr><th class="text">적재율 시나리오</th>';
    res.corps.forEach(function (corp) { html += '<th>' + esc(corp) + '법인 합계</th>'; });
    html += '<th>총 합계 (18개월)</th><th>기준(70%) 대비</th></tr></thead><tbody>';
    var baseTotal = null;
    scen.forEach(function (s) {
      if (Math.round(s.rate * 100) === 70) baseTotal = s.totalContainers;
    });
    scen.forEach(function (s) {
      html += '<tr><td class="text">적재율 ' + Math.round(s.rate * 100) + '%</td>';
      res.corps.forEach(function (corp) {
        html += '<td>' + fmt(s.byCorp[corp] ? s.byCorp[corp].total : 0) + '</td>';
      });
      var diff = baseTotal != null ? s.totalContainers - baseTotal : 0;
      html += '<td><b>' + fmt(s.totalContainers) + '</b></td>';
      html += '<td>' + (diff === 0 ? '기준' : (diff > 0 ? '+' : '') + fmt(diff) + '대') + '</td></tr>';
    });
    html += '</tbody></table>';
    $('scenarioTableWrap').innerHTML = html;
  }

  /* ------------------------------------------------------------------ */
  /* 컨테이너별 적재 구성 내역 (검증용)                                     */
  /* ------------------------------------------------------------------ */

  function renderManifest() {
    var res = state.result;

    $('corpTabs').innerHTML = res.corps.map(function (corp) {
      return '<button type="button" class="corp-tab' +
        (corp === state.activeCorp ? ' active' : '') +
        '" data-corp="' + esc(corp) + '">' + esc(corp) + '법인</button>';
    }).join('');

    Array.prototype.forEach.call($('corpTabs').querySelectorAll('.corp-tab'), function (btn) {
      btn.addEventListener('click', function () {
        state.activeCorp = btn.getAttribute('data-corp');
        renderManifest();
      });
    });

    var corp = state.activeCorp;
    var html = res.byCorp[corp].monthly.map(function (m) {
      var head = '<summary>' + m.month +
        '<span class="badge">컨테이너 ' + fmt(m.containerCount) + '대</span>' +
        '<span class="badge">박스 ' + fmt(m.totalBoxes) + '개</span>' +
        '<span class="badge">' + fmt(m.totalCbm) + ' CBM · ' + fmt(m.totalWeightKg) + ' kg</span>' +
        (Object.keys(m.carriedIn).length ? '<span class="badge">이월 유입: ' + esc(boxesToText(m.carriedIn)) + '</span>' : '') +
        (Object.keys(m.carriedOut).length ? '<span class="badge">다음 달 이월: ' + esc(boxesToText(m.carriedOut)) + '</span>' : '') +
        '</summary>';

      var body;
      if (m.containerCount === 0) {
        body = '<div class="inner"><p style="color:#898781;margin:4px 0;">이번 달 확보 컨테이너 없음' +
          (Object.keys(m.carriedOut).length ? ' (전량 다음 달 이월)' : '') + '</p></div>';
      } else {
        body = '<div class="inner"><div class="table-scroll"><table class="data"><thead><tr>' +
          '<th>No</th><th>혼적 그룹</th><th class="text">박스 구성</th>' +
          '<th>부피(CBM)</th><th>부피 적재율</th><th>중량(kg)</th><th>중량 적재율</th>' +
          '</tr></thead><tbody>' +
          m.containers.map(function (c) {
            return '<tr' + (c.overCapacity ? ' class="over-cap"' : '') + '>' +
              '<td>' + c.no + '</td>' +
              '<td>' + esc(c.group) + '</td>' +
              '<td class="text">' + esc(boxesToText(c.boxes)) + '</td>' +
              '<td>' + fmt(c.cbm) + '</td>' +
              '<td>' + pct(c.cbmRate) + '</td>' +
              '<td>' + fmt(c.weightKg) + '</td>' +
              '<td>' + pct(c.weightRate) + '</td></tr>';
          }).join('') +
          '</tbody></table></div></div>';
      }
      return '<details class="month-detail">' + head + body + '</details>';
    }).join('');

    $('manifestArea').innerHTML = html;
  }

  /* ------------------------------------------------------------------ */
  /* 엑셀 내보내기 (요약 + 월별 상세)                                       */
  /* ------------------------------------------------------------------ */

  function exportExcel() {
    var res = state.result;
    if (!res) return;
    var wb = XLSX.utils.book_new();
    var type = currentContainer();

    // --- 요약 시트 ---
    var aoa = [];
    aoa.push(['CKD 컨테이너 수량 산출 결과 (물류팀 전달용)']);
    aoa.push(['산출 조건', type.name + ' · 목표 적재율 ' + state.loadRatePct + '%' +
      (state.carryOver ? ' · 이월 옵션 적용' : ' · 남는 박스 당월 확보'),
      '', '컨테이너 CBM', type.maxCbm, '최대 중량(kg)', type.maxWeightKg]);
    aoa.push([]);

    var header = ['월'];
    res.corps.forEach(function (corp) {
      header.push(corp + ' 컨테이너(대)', corp + ' 박스(개)', corp + ' 실적재율(부피)');
    });
    header.push('합계 컨테이너(대)');
    aoa.push(header);

    res.months.forEach(function (mo, mi) {
      var row = [mo];
      var sum = 0;
      res.corps.forEach(function (corp) {
        var m = res.byCorp[corp].monthly[mi];
        sum += m.containerCount;
        row.push(m.containerCount, m.totalBoxes,
          m.containerCount > 0 ? Math.round(m.avgCbmRate * 1000) / 10 + '%' : '-');
      });
      row.push(sum);
      aoa.push(row);
    });

    var totalRow = ['합계'];
    var grand = 0;
    res.corps.forEach(function (corp) {
      var t = res.byCorp[corp].totalContainers;
      grand += t;
      var boxes = res.byCorp[corp].monthly.reduce(function (s, m) { return s + m.totalBoxes; }, 0);
      totalRow.push(t, boxes, '');
    });
    totalRow.push(grand);
    aoa.push(totalRow);

    aoa.push([]);
    aoa.push(['적재율 시나리오 비교 (18개월 총 컨테이너)']);
    var scHeader = ['적재율'];
    res.corps.forEach(function (corp) { scHeader.push(corp + '법인'); });
    scHeader.push('총 합계');
    aoa.push(scHeader);
    state.scenarios.forEach(function (s) {
      var row = [Math.round(s.rate * 100) + '%'];
      res.corps.forEach(function (corp) { row.push(s.byCorp[corp] ? s.byCorp[corp].total : 0); });
      row.push(s.totalContainers);
      aoa.push(row);
    });

    var wsSummary = XLSX.utils.aoa_to_sheet(aoa);
    wsSummary['!cols'] = header.map(function () { return { wch: 16 }; });
    XLSX.utils.book_append_sheet(wb, wsSummary, '요약');

    // --- 월별 상세 시트 ---
    res.months.forEach(function (mo, mi) {
      var rows = [['법인', '컨테이너 No', '혼적 그룹', '박스 구성',
        '부피(CBM)', '부피 적재율', '중량(kg)', '중량 적재율']];
      res.corps.forEach(function (corp) {
        var m = res.byCorp[corp].monthly[mi];
        m.containers.forEach(function (c) {
          rows.push([corp, c.no, c.group, boxesToText(c.boxes),
            c.cbm, Math.round(c.cbmRate * 1000) / 10 + '%',
            c.weightKg, Math.round(c.weightRate * 1000) / 10 + '%']);
        });
      });
      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 8 }, { wch: 11 }, { wch: 9 }, { wch: 40 },
        { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 11 }];
      XLSX.utils.book_append_sheet(wb, ws, mo);
    });

    var today = new Date();
    var stamp = today.getFullYear() +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');
    XLSX.writeFile(wb, 'CKD_컨테이너산출_' + stamp + '.xlsx');
  }

  /* ------------------------------------------------------------------ */
  /* 설정 UI 초기화 및 이벤트                                              */
  /* ------------------------------------------------------------------ */

  function refreshTypeUi() {
    var sel = $('typeSelect');
    sel.innerHTML = Object.keys(state.config.types).map(function (key) {
      var t = state.config.types[key];
      return '<option value="' + esc(key) + '"' + (key === state.type ? ' selected' : '') + '>' +
        esc(t.name) + '</option>';
    }).join('');
    var t = currentContainer();
    $('typeSpec').textContent = '내부 ' + fmt(t.innerLengthMm) + '×' + fmt(t.innerWidthMm) +
      '×' + fmt(t.innerHeightMm) + 'mm · ' + t.maxCbm + ' CBM · 최대 ' + fmt(t.maxWeightKg) + 'kg';
  }

  function setRate(pctValue) {
    var v = Math.min(95, Math.max(50, Math.round(Number(pctValue) || 70)));
    state.loadRatePct = v;
    $('rateSlider').value = v;
    $('rateInput').value = v;
    recompute();
  }

  function applyConfig(cfg) {
    state.config = cfg;
    state.type = cfg.defaultType;
    state.loadRatePct = Math.round(cfg.targetLoadRate * 100);
    state.carryOver = !!cfg.carryOver;
    $('rateSlider').value = state.loadRatePct;
    $('rateInput').value = state.loadRatePct;
    $('carryOverCheck').checked = state.carryOver;
    refreshTypeUi();
  }

  function init() {
    Chart.defaults.font.family =
      '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';
    Chart.defaults.font.size = 12;

    applyConfig(DEFAULT_CONFIG);

    // GitHub Pages 등 HTTP 환경에서는 설정 파일을 우선 적용 (file://에서는 기본값 사용)
    fetch('config/container.json').then(function (r) {
      if (!r.ok) throw new Error('config load failed');
      return r.json();
    }).then(function (cfg) {
      applyConfig(cfg);
      showWarn('configNotice', '');
      recompute();
    }).catch(function () {
      // 기본값(DEFAULT_CONFIG)으로 계속 동작하되, 사용자에게 보이도록 경고한다.
      var isFile = location.protocol === 'file:';
      showWarn('configNotice',
        '<b>config/container.json 로드 실패 — 기본값 사용 중</b><br>' +
        (isFile
          ? 'file:// 프로토콜로 열면 브라우저 보안 정책상 설정 파일을 읽을 수 없는 것이 정상입니다. ' +
            '코드에 내장된 동일한 기본값으로 동작하며, 설정 파일을 적용하려면 ' +
            '<code>python3 -m http.server 8000</code> 등 로컬 서버로 실행하세요.'
          : '설정 파일을 읽지 못해 코드에 내장된 기본값(40ft/40HC, 적재율 70%)으로 동작합니다. ' +
            '파일 경로와 JSON 형식을 확인하세요.'));
    });

    $('filePlan').addEventListener('change', function (e) {
      if (e.target.files.length) handlePlanFiles(e.target.files);
    });
    $('fileModelBox').addEventListener('change', function (e) {
      if (e.target.files.length) {
        handleSingleFile(e.target.files[0], parseModelBoxRows, 'statusModelBox',
          function (v) { state.modelBox = v; });
      }
    });
    $('fileBoxMaster').addEventListener('change', function (e) {
      if (e.target.files.length) {
        handleSingleFile(e.target.files[0], parseBoxMasterRows, 'statusBoxMaster',
          function (v) { state.boxMaster = v; });
      }
    });

    $('btnSample').addEventListener('click', loadSampleData);
    $('btnExport').addEventListener('click', exportExcel);

    $('rateSlider').addEventListener('input', function (e) { setRate(e.target.value); });
    $('rateInput').addEventListener('change', function (e) { setRate(e.target.value); });

    $('typeSelect').addEventListener('change', function (e) {
      state.type = e.target.value;
      refreshTypeUi();
      recompute();
    });

    $('carryOverCheck').addEventListener('change', function (e) {
      state.carryOver = e.target.checked;
      recompute();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/**
 * CKD 컨테이너 수량 산출 엔진 (순수 계산 모듈)
 *
 * - 브라우저(window.CKDEngine)와 Node(require)에서 동일하게 동작한다.
 * - UI/엑셀 파싱과 완전히 분리된 순수 함수들만 포함한다.
 * - 모든 규칙(컨테이너 규격, 적재율, 이월 등)은 config/container.json 값을
 *   인자로 받아 동작하므로 규칙 변경 시 코드 수정이 필요 없다.
 *
 * 입력 데이터 구조(정규화된 형태):
 *   plan      : [{ corp: '브라질', model: 'R210-BR', qty: { '2026-09': 30, ... } }, ...]
 *   modelBox  : [{ model: 'R210-BR', boxCode: 'BX-A', perUnit: 1 }, ...]
 *   boxMaster : { 'BX-A': { lengthMm, widthMm, heightMm, cbm, weightKg, maxStack, group }, ... }
 *   container : { maxCbm: 67.7, maxWeightKg: 26780 }  (선택한 타입의 규격)
 *
 * 산출 규칙(기획서 5번 가정):
 *   1) 월별·법인별 필요 박스 수량 = Σ(모델 생산 대수 × 대당 박스 수량)
 *   2) 1차(단순): 총 부피 ÷ (컨테이너 CBM × 적재율)를 올림
 *   3) 2차(조합): First-Fit Decreasing 근사 bin-packing
 *      - 같은 혼적 그룹 박스끼리만 한 컨테이너에 적재
 *      - 컨테이너당 부피 한도 = maxCbm × 적재율, 중량 한도 = maxWeightKg × 적재율
 *   4) 남는 박스는 기본적으로 해당 월에 컨테이너를 추가 확보하여 전량 선적.
 *      이월 옵션(carryOver=true) 사용 시, 그룹별 마지막 컨테이너의 부피 사용률이
 *      임계값(carryOverThreshold, 기본 50%) 미만이면 그 박스들을 다음 달로 이월.
 *      (마지막 달은 전량 선적)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CKDEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  /* ------------------------------------------------------------------ */
  /* 유틸리티                                                            */
  /* ------------------------------------------------------------------ */

  /** '2026-09'부터 count개월의 'YYYY-MM' 배열을 만든다. */
  function monthRange(startMonth, count) {
    var parts = String(startMonth).split('-');
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(y + '-' + (m < 10 ? '0' + m : String(m)));
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /** plan 배열에서 등장하는 모든 월을 정렬해 반환한다. */
  function collectMonths(plan) {
    var set = {};
    plan.forEach(function (row) {
      Object.keys(row.qty || {}).forEach(function (mo) { set[mo] = true; });
    });
    return Object.keys(set).sort();
  }

  /** plan 배열에서 등장하는 법인 목록(입력 순서 유지). */
  function collectCorps(plan) {
    var seen = {};
    var out = [];
    plan.forEach(function (row) {
      if (!seen[row.corp]) { seen[row.corp] = true; out.push(row.corp); }
    });
    return out;
  }

  /** {boxCode: qty} 두 개를 합산한 새 객체를 반환한다. */
  function mergeBoxCounts(a, b) {
    var out = {};
    [a, b].forEach(function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (code) {
        if (src[code] > 0) out[code] = (out[code] || 0) + src[code];
      });
    });
    return out;
  }

  function sumBoxCounts(counts) {
    return Object.keys(counts).reduce(function (s, c) { return s + counts[c]; }, 0);
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* ------------------------------------------------------------------ */
  /* 1) 박스 수량 집계                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 월별·법인별 박스 종류별 필요 수량을 집계한다.
   * 구성 마스터에 없는 모델은 집계에서 제외되며 unmatchedModels로 보고한다.
   * @returns { corps, months, demand, unmatchedModels }
   *   — demand[corp][month][boxCode] = 수량, unmatchedModels = 제외된 모델명 배열
   */
  function aggregateBoxes(plan, modelBox) {
    var corps = collectCorps(plan);
    var months = collectMonths(plan);

    // 모델별 박스 구성 인덱스: model -> [{boxCode, perUnit}]
    var comp = {};
    modelBox.forEach(function (row) {
      if (!comp[row.model]) comp[row.model] = [];
      comp[row.model].push({ boxCode: row.boxCode, perUnit: row.perUnit });
    });

    var demand = {};
    corps.forEach(function (corp) {
      demand[corp] = {};
      months.forEach(function (mo) { demand[corp][mo] = {}; });
    });

    var unmatchedSeen = {};
    var unmatchedModels = [];
    plan.forEach(function (row) {
      var boxes = comp[row.model];
      if (!boxes) {
        // 구성 마스터에 없는 모델은 산출에서 제외하고 목록으로 보고한다(UI 경고용)
        if (!unmatchedSeen[row.model]) {
          unmatchedSeen[row.model] = true;
          unmatchedModels.push(row.model);
        }
        return;
      }
      Object.keys(row.qty || {}).forEach(function (mo) {
        var units = Number(row.qty[mo]) || 0;
        if (units <= 0) return;
        boxes.forEach(function (b) {
          var d = demand[row.corp][mo];
          d[b.boxCode] = (d[b.boxCode] || 0) + units * b.perUnit;
        });
      });
    });

    return { corps: corps, months: months, demand: demand, unmatchedModels: unmatchedModels };
  }

  /* ------------------------------------------------------------------ */
  /* 2) 1차 단순 산출                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 총 부피 ÷ (컨테이너 CBM × 적재율)을 올림한 1차 산출.
   * 중량 기준 소요도 참고용으로 함께 계산한다.
   * @param boxCounts {boxCode: qty}
   */
  function simpleEstimate(boxCounts, boxMaster, container, loadRate) {
    var totalCbm = 0;
    var totalWeightKg = 0;
    Object.keys(boxCounts).forEach(function (code) {
      var spec = boxMaster[code];
      if (!spec) throw new Error('박스 마스터에 없는 박스코드: ' + code);
      totalCbm += boxCounts[code] * spec.cbm;
      totalWeightKg += boxCounts[code] * spec.weightKg;
    });
    var volCap = container.maxCbm * loadRate;
    var wtCap = container.maxWeightKg * loadRate;
    var byVolume = totalCbm > 0 ? Math.ceil(totalCbm / volCap - EPS) : 0;
    var byWeight = totalWeightKg > 0 ? Math.ceil(totalWeightKg / wtCap - EPS) : 0;
    return {
      totalCbm: round3(totalCbm),
      totalWeightKg: Math.round(totalWeightKg),
      byVolume: byVolume,
      byWeight: byWeight,
      containers: byVolume // 1차 산출은 부피 기준(기획서 3.2)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3) 2차 bin-packing (First-Fit Decreasing)                           */
  /* ------------------------------------------------------------------ */

  /**
   * 혼적 그룹/부피/중량 제약을 반영한 FFD 근사 bin-packing.
   * @param boxCounts {boxCode: qty} — 한 달·한 법인의 박스 수요
   * @returns { containers: [...], containerCount, totalCbm, totalWeightKg }
   *   각 컨테이너: { no, group, boxes:{code:qty}, cbm, weightKg,
   *                 cbmRate(컨테이너 CBM 대비), weightRate, overCapacity }
   */
  function packContainers(boxCounts, boxMaster, container, loadRate) {
    var volCap = container.maxCbm * loadRate;
    var wtCap = container.maxWeightKg * loadRate;

    // 혼적 그룹별로 박스를 나눈다.
    var byGroup = {};
    Object.keys(boxCounts).forEach(function (code) {
      var qty = boxCounts[code];
      if (qty <= 0) return;
      var spec = boxMaster[code];
      if (!spec) throw new Error('박스 마스터에 없는 박스코드: ' + code);
      if (!byGroup[spec.group]) byGroup[spec.group] = [];
      byGroup[spec.group].push({ code: code, qty: qty, cbm: spec.cbm, weightKg: spec.weightKg });
    });

    var containers = [];
    Object.keys(byGroup).sort().forEach(function (group) {
      // FFD: 부피 내림차순(동률이면 중량 내림차순) 정렬
      var items = byGroup[group].slice().sort(function (a, b) {
        return (b.cbm - a.cbm) || (b.weightKg - a.weightKg) || (a.code < b.code ? -1 : 1);
      });
      var bins = [];
      items.forEach(function (item) {
        for (var n = 0; n < item.qty; n++) {
          var placed = false;
          for (var i = 0; i < bins.length; i++) {
            var bin = bins[i];
            if (bin.cbm + item.cbm <= volCap + EPS && bin.weightKg + item.weightKg <= wtCap + EPS) {
              bin.cbm += item.cbm;
              bin.weightKg += item.weightKg;
              bin.boxes[item.code] = (bin.boxes[item.code] || 0) + 1;
              placed = true;
              break;
            }
          }
          if (!placed) {
            // 새 컨테이너 개설. 단일 박스가 한도를 초과하면 단독 적재 후 표시.
            bins.push({
              group: group,
              boxes: (function () { var o = {}; o[item.code] = 1; return o; })(),
              cbm: item.cbm,
              weightKg: item.weightKg,
              overCapacity: item.cbm > volCap + EPS || item.weightKg > wtCap + EPS
            });
          }
        }
      });
      bins.forEach(function (b) { containers.push(b); });
    });

    var totalCbm = 0;
    var totalWeightKg = 0;
    containers.forEach(function (c, idx) {
      c.no = idx + 1;
      c.cbm = round3(c.cbm);
      c.weightKg = Math.round(c.weightKg * 100) / 100;
      c.cbmRate = round3(c.cbm / container.maxCbm);
      c.weightRate = round3(c.weightKg / container.maxWeightKg);
      c.overCapacity = !!c.overCapacity;
      totalCbm += c.cbm;
      totalWeightKg += c.weightKg;
    });

    return {
      containers: containers,
      containerCount: containers.length,
      totalCbm: round3(totalCbm),
      totalWeightKg: Math.round(totalWeightKg)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4) 월별 계산(이월 옵션 포함)                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 전체 계산: 집계 → 월별 1차/2차 산출 → (옵션) 이월 처리.
   * @param input   { plan, modelBox, boxMaster, container }
   * @param options { loadRate, carryOver, carryOverThreshold }
   */
  function calculate(input, options) {
    var opts = options || {};
    var loadRate = opts.loadRate != null ? opts.loadRate : 0.7;
    var carryOver = !!opts.carryOver;
    var threshold = opts.carryOverThreshold != null ? opts.carryOverThreshold : 0.5;
    var container = input.container;
    var boxMaster = input.boxMaster;

    var agg = aggregateBoxes(input.plan, input.modelBox);
    var months = agg.months;
    var byCorp = {};

    agg.corps.forEach(function (corp) {
      var carried = {}; // 다음 달로 이월된 박스
      var monthly = [];
      var totalContainers = 0;

      months.forEach(function (mo, mi) {
        var isLast = mi === months.length - 1;
        var carriedIn = carried;
        var demand = mergeBoxCounts(agg.demand[corp][mo], carriedIn);
        carried = {};

        var carriedOut = {};
        var packed = packContainers(demand, boxMaster, container, loadRate);

        if (carryOver && !isLast) {
          // 그룹별 마지막(가장 덜 찬) 컨테이너가 임계값 미만이면 이월
          var keep = [];
          var lastByGroup = {};
          packed.containers.forEach(function (c) { lastByGroup[c.group] = c; });
          packed.containers.forEach(function (c) {
            var isCandidate = lastByGroup[c.group] === c &&
              c.cbm / (container.maxCbm * loadRate) < threshold - EPS;
            if (isCandidate) {
              carriedOut = mergeBoxCounts(carriedOut, c.boxes);
            } else {
              keep.push(c);
            }
          });
          if (Object.keys(carriedOut).length > 0) {
            keep.forEach(function (c, idx) { c.no = idx + 1; });
            var totCbm = 0, totWt = 0;
            keep.forEach(function (c) { totCbm += c.cbm; totWt += c.weightKg; });
            packed = {
              containers: keep,
              containerCount: keep.length,
              totalCbm: round3(totCbm),
              totalWeightKg: Math.round(totWt)
            };
            carried = carriedOut;
          }
        }

        // 실제로 이번 달에 실린 물량 기준 합계
        var shipped = {};
        packed.containers.forEach(function (c) {
          shipped = mergeBoxCounts(shipped, c.boxes);
        });

        var simple = simpleEstimate(demand, boxMaster, container, loadRate);
        var avgCbmRate = packed.containerCount > 0
          ? round3(packed.totalCbm / (packed.containerCount * container.maxCbm)) : 0;
        var avgWeightRate = packed.containerCount > 0
          ? round3(packed.totalWeightKg / (packed.containerCount * container.maxWeightKg)) : 0;

        totalContainers += packed.containerCount;
        monthly.push({
          month: mo,
          demand: demand,
          carriedIn: carriedIn,
          carriedOut: carriedOut,
          shipped: shipped,
          totalBoxes: sumBoxCounts(shipped),
          simple: simple,
          containers: packed.containers,
          containerCount: packed.containerCount,
          totalCbm: packed.totalCbm,
          totalWeightKg: packed.totalWeightKg,
          avgCbmRate: avgCbmRate,
          avgWeightRate: avgWeightRate
        });
      });

      byCorp[corp] = { monthly: monthly, totalContainers: totalContainers };
    });

    // 박스 종류별 총 물량(법인별)
    var boxTotals = {};
    agg.corps.forEach(function (corp) {
      boxTotals[corp] = {};
      months.forEach(function (mo) {
        boxTotals[corp] = mergeBoxCounts(boxTotals[corp], agg.demand[corp][mo]);
      });
    });

    return {
      loadRate: loadRate,
      carryOver: carryOver,
      months: months,
      corps: agg.corps,
      demand: agg.demand,
      byCorp: byCorp,
      boxTotals: boxTotals,
      unmatchedModels: agg.unmatchedModels // 구성 마스터에 없어 산출에서 제외된 모델
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5) 시나리오 비교 (적재율 65/70/75%)                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 적재율 시나리오별 월별/총 컨테이너 수를 비교한다.
   * @param rates 예: [0.65, 0.70, 0.75]
   */
  function runScenarios(input, rates, options) {
    var opts = options || {};
    return rates.map(function (rate) {
      var res = calculate(input, {
        loadRate: rate,
        carryOver: opts.carryOver,
        carryOverThreshold: opts.carryOverThreshold
      });
      var monthlyTotal = res.months.map(function (mo, mi) {
        return res.corps.reduce(function (s, corp) {
          return s + res.byCorp[corp].monthly[mi].containerCount;
        }, 0);
      });
      var byCorp = {};
      res.corps.forEach(function (corp) {
        byCorp[corp] = {
          monthlyCounts: res.byCorp[corp].monthly.map(function (m) { return m.containerCount; }),
          total: res.byCorp[corp].totalContainers
        };
      });
      return {
        rate: rate,
        monthlyTotal: monthlyTotal,
        byCorp: byCorp,
        totalContainers: monthlyTotal.reduce(function (s, x) { return s + x; }, 0)
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* 6) 입력 검증                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 구성의 박스코드가 박스 마스터에 있는지 검증(계산 불가능한 치명 오류만).
   * 생산계획에만 있고 구성 마스터에 없는 모델은 오류가 아니라
   * calculate() 결과의 unmatchedModels로 보고한다(산출에서 제외됨을 경고).
   */
  function validateInput(input) {
    var errors = [];
    input.modelBox.forEach(function (r) {
      if (!input.boxMaster[r.boxCode]) {
        errors.push('모델 "' + r.model + '"의 박스코드 "' + r.boxCode + '"이(가) 박스 마스터에 없습니다.');
      }
    });
    return errors;
  }

  return {
    monthRange: monthRange,
    mergeBoxCounts: mergeBoxCounts,
    aggregateBoxes: aggregateBoxes,
    simpleEstimate: simpleEstimate,
    packContainers: packContainers,
    calculate: calculate,
    runScenarios: runScenarios,
    validateInput: validateInput
  };
});

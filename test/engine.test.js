/**
 * 계산 엔진 단위 테스트 (node test/engine.test.js 로 실행)
 * 외부 라이브러리 없이 node 기본 assert만 사용한다.
 * 핵심: 손으로 계산한 소규모 사례와 FFD/단순 산출 결과를 대조한다.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const engine = require('../js/engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

/* ------------------------------------------------------------------ */
/* 수작업 검산용 소규모 데이터                                            */
/* 컨테이너: CBM 10, 최대 중량 1,000kg, 적재율 70% → 한도 7CBM / 700kg    */
/* ------------------------------------------------------------------ */
const container = { maxCbm: 10, maxWeightKg: 1000 };
const boxMaster = {
  P: { cbm: 3, weightKg: 100, group: 'G1' },
  Q: { cbm: 2, weightKg: 300, group: 'G1' },
  R: { cbm: 1, weightKg: 50, group: 'G2' },
  W: { cbm: 1, weightKg: 400, group: 'G1' } // 중량 제약 검증용
};

console.log('\n[1] aggregateBoxes — 박스 수량 집계');

test('모델 생산대수 × 대당 박스 수량이 정확히 집계된다', () => {
  const plan = [
    { corp: '브라질', model: 'M1', qty: { '2026-09': 10, '2026-10': 5 } },
    { corp: '브라질', model: 'M2', qty: { '2026-09': 4 } },
    { corp: '인도', model: 'M1', qty: { '2026-09': 7 } }
  ];
  const modelBox = [
    { model: 'M1', boxCode: 'P', perUnit: 2 },
    { model: 'M1', boxCode: 'R', perUnit: 1 },
    { model: 'M2', boxCode: 'Q', perUnit: 3 }
  ];
  const agg = engine.aggregateBoxes(plan, modelBox);
  assert.deepStrictEqual(agg.corps, ['브라질', '인도']);
  assert.deepStrictEqual(agg.months, ['2026-09', '2026-10']);
  // 브라질 2026-09: P = 10×2 = 20, R = 10×1 = 10, Q = 4×3 = 12
  assert.deepStrictEqual(agg.demand['브라질']['2026-09'], { P: 20, R: 10, Q: 12 });
  // 브라질 2026-10: P = 5×2 = 10, R = 5
  assert.deepStrictEqual(agg.demand['브라질']['2026-10'], { P: 10, R: 5 });
  // 인도 2026-09: P = 14, R = 7
  assert.deepStrictEqual(agg.demand['인도']['2026-09'], { P: 14, R: 7 });
});

console.log('\n[2] simpleEstimate — 1차 단순 산출');

test('총 부피 ÷ (컨테이너 CBM × 적재율) 올림 = 손계산과 일치', () => {
  // P×2 + Q×2 + R×3 = 6 + 4 + 3 = 13 CBM → ceil(13 / 7) = 2
  const est = engine.simpleEstimate({ P: 2, Q: 2, R: 3 }, boxMaster, container, 0.7);
  assert.strictEqual(est.totalCbm, 13);
  assert.strictEqual(est.containers, 2);
  assert.strictEqual(est.byVolume, 2);
  // 중량 = 200 + 600 + 150 = 950kg → ceil(950 / 700) = 2
  assert.strictEqual(est.totalWeightKg, 950);
  assert.strictEqual(est.byWeight, 2);
});

test('수요가 없으면 0 컨테이너', () => {
  const est = engine.simpleEstimate({}, boxMaster, container, 0.7);
  assert.strictEqual(est.containers, 0);
});

console.log('\n[3] packContainers — FFD bin-packing (손계산 사례)');

test('혼적 그룹 + 부피 한도를 지키는 FFD 결과가 손계산과 일치', () => {
  // 수요: P×2(G1, 3CBM), Q×2(G1, 2CBM), R×3(G2, 1CBM), 한도 7CBM/700kg
  // G1 FFD(부피 내림차순 3,3,2,2):
  //   C1: 3+3=6 (+2는 8>7 불가) → P×2
  //   C2: 2+2=4              → Q×2
  // G2: 1+1+1=3               → R×3
  // → 총 3대 (단순 산출 2대보다 많음: 혼적 제약 때문)
  const res = engine.packContainers({ P: 2, Q: 2, R: 3 }, boxMaster, container, 0.7);
  assert.strictEqual(res.containerCount, 3);
  const g1 = res.containers.filter((c) => c.group === 'G1');
  const g2 = res.containers.filter((c) => c.group === 'G2');
  assert.strictEqual(g1.length, 2);
  assert.strictEqual(g2.length, 1);
  assert.deepStrictEqual(g1[0].boxes, { P: 2 });
  assert.strictEqual(g1[0].cbm, 6);
  assert.strictEqual(g1[0].cbmRate, 0.6); // 6 / 10 CBM
  assert.deepStrictEqual(g1[1].boxes, { Q: 2 });
  assert.deepStrictEqual(g2[0].boxes, { R: 3 });
  // 혼적 그룹이 섞인 컨테이너가 없어야 한다
  res.containers.forEach((c) => {
    const groups = new Set(Object.keys(c.boxes).map((code) => boxMaster[code].group));
    assert.strictEqual(groups.size, 1);
  });
});

test('중량 한도가 부피보다 먼저 걸리는 경우', () => {
  // W: 1CBM, 400kg. 부피로는 7개까지 들어가지만 중량 한도 700kg → 컨테이너당 1개
  const res = engine.packContainers({ W: 3 }, boxMaster, container, 0.7);
  assert.strictEqual(res.containerCount, 3);
  res.containers.forEach((c) => {
    assert.deepStrictEqual(c.boxes, { W: 1 });
    assert.ok(c.weightKg <= 700);
  });
});

test('모든 박스가 남김없이 적재된다', () => {
  const demand = { P: 5, Q: 7, R: 11, W: 2 };
  const res = engine.packContainers(demand, boxMaster, container, 0.7);
  const shipped = {};
  res.containers.forEach((c) => {
    Object.keys(c.boxes).forEach((code) => {
      shipped[code] = (shipped[code] || 0) + c.boxes[code];
    });
    assert.ok(c.cbm <= 7 + 1e-9, '부피 한도 초과');
    assert.ok(c.weightKg <= 700 + 1e-9, '중량 한도 초과');
  });
  assert.deepStrictEqual(shipped, demand);
});

console.log('\n[4] calculate — 월별 통합 산출과 이월 옵션');

const smallInput = {
  plan: [
    { corp: '브라질', model: 'M1', qty: { '2026-09': 2, '2026-10': 2, '2026-11': 2 } }
  ],
  modelBox: [{ model: 'M1', boxCode: 'Q', perUnit: 1 }], // 월별 Q×2 = 4CBM
  boxMaster,
  container
};

test('기본(이월 없음): 매월 남는 박스 없이 컨테이너 추가 확보', () => {
  const res = engine.calculate(smallInput, { loadRate: 0.7, carryOver: false });
  const monthly = res.byCorp['브라질'].monthly;
  // 매월 Q×2 = 4CBM ≤ 7 → 매월 1대
  assert.deepStrictEqual(monthly.map((m) => m.containerCount), [1, 1, 1]);
  monthly.forEach((m) => assert.deepStrictEqual(m.carriedOut, {}));
  assert.strictEqual(res.byCorp['브라질'].totalContainers, 3);
});

test('이월 옵션: 덜 찬 컨테이너(임계값 미만)는 다음 달로 이월, 마지막 달은 전량 선적', () => {
  // 4CBM / 한도 7CBM = 57% ≥ 기본 임계값 50% → 이월 안 됨. 임계값 60%로 테스트.
  const res = engine.calculate(smallInput, {
    loadRate: 0.7, carryOver: true, carryOverThreshold: 0.6
  });
  const monthly = res.byCorp['브라질'].monthly;
  // Q는 2CBM/300kg — 중량 한도 700kg 때문에 컨테이너당 최대 2개(600kg).
  // 9월: Q×2(4CBM, 4/7=57%<60%) 이월 → 0대
  // 10월: Q×4 → C1 Q×2(4CBM), C2 Q×2(4CBM, 57%<60%) 이월 → 1대
  // 11월(마지막): Q×2+이월2 = Q×4 전량 선적 → 2대
  assert.deepStrictEqual(monthly.map((m) => m.containerCount), [0, 1, 2]);
  assert.deepStrictEqual(monthly[0].carriedOut, { Q: 2 });
  assert.deepStrictEqual(monthly[1].carriedIn, { Q: 2 });
  assert.deepStrictEqual(monthly[1].carriedOut, { Q: 2 });
  assert.deepStrictEqual(monthly[2].carriedIn, { Q: 2 });
  assert.deepStrictEqual(monthly[2].carriedOut, {});
  // 3개월 합산 선적 박스 수 = 총 수요(Q×6)와 동일해야 한다
  const shippedTotal = monthly.reduce((s, m) => s + (m.shipped.Q || 0), 0);
  assert.strictEqual(shippedTotal, 6);
});

console.log('\n[5] runScenarios — 적재율 65/70/75% 비교');

test('적재율이 높을수록 컨테이너 수가 같거나 줄어든다', () => {
  const plan = [
    { corp: '브라질', model: 'M1', qty: { '2026-09': 20 } },
    { corp: '인도', model: 'M2', qty: { '2026-09': 15 } }
  ];
  const modelBox = [
    { model: 'M1', boxCode: 'P', perUnit: 1 },
    { model: 'M1', boxCode: 'R', perUnit: 2 },
    { model: 'M2', boxCode: 'Q', perUnit: 2 }
  ];
  const input = { plan, modelBox, boxMaster, container };
  const scen = engine.runScenarios(input, [0.65, 0.7, 0.75]);
  assert.strictEqual(scen.length, 3);
  assert.ok(scen[0].totalContainers >= scen[1].totalContainers);
  assert.ok(scen[1].totalContainers >= scen[2].totalContainers);
  scen.forEach((s) => assert.ok(s.totalContainers > 0));
});

console.log('\n[6] 미매칭 모델 보고 — unmatchedModels');

test('구성 마스터에 없는 모델은 unmatchedModels로 보고되고 산출에서 제외된다', () => {
  const plan = [
    { corp: '브라질', model: 'M1', qty: { '2026-09': 2 } },
    { corp: '브라질', model: 'MX', qty: { '2026-09': 5 } }, // 마스터에 없음
    { corp: '인도', model: 'MX', qty: { '2026-10': 3 } },   // 중복 — 1건으로 집계
    { corp: '인도', model: 'MY', qty: { '2026-10': 1 } }    // 마스터에 없음
  ];
  const modelBox = [{ model: 'M1', boxCode: 'Q', perUnit: 1 }];
  const res = engine.calculate({ plan, modelBox, boxMaster, container }, { loadRate: 0.7 });
  // 중복 없이 등장 순서대로 보고된다
  assert.deepStrictEqual(res.unmatchedModels, ['MX', 'MY']);
  // 미매칭 모델의 물량은 집계(demand)에 포함되지 않는다
  assert.deepStrictEqual(res.demand['브라질']['2026-09'], { Q: 2 });
  assert.deepStrictEqual(res.demand['인도']['2026-10'], {});
  // 모든 모델이 매칭되면 빈 배열
  const ok = engine.calculate(
    { plan: [plan[0]], modelBox, boxMaster, container }, { loadRate: 0.7 });
  assert.deepStrictEqual(ok.unmatchedModels, []);
  // validateInput은 미매칭 모델을 차단 오류로 보지 않는다(박스코드 누락만 오류)
  assert.deepStrictEqual(engine.validateInput({ plan, modelBox, boxMaster }), []);
  const badBox = engine.validateInput({
    plan, modelBox: [{ model: 'M1', boxCode: 'ZZ', perUnit: 1 }], boxMaster
  });
  assert.strictEqual(badBox.length, 1);
});

console.log('\n[7] 실제 샘플 데이터 스모크 테스트');

test('config/container.json 규격으로 샘플 데이터 전체 계산이 무결하다', () => {
  const configPath = path.join(__dirname, '..', 'config', 'container.json');
  const samplePath = path.join(__dirname, '..', 'js', 'sample-data.js');
  if (!fs.existsSync(samplePath)) {
    console.log('    (js/sample-data.js 없음 — 샘플 생성 전이므로 건너뜀)');
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const sample = require(samplePath);
  const type = config.types[config.defaultType];
  const input = {
    plan: sample.plan,
    modelBox: sample.modelBox,
    boxMaster: sample.boxMaster,
    container: type
  };
  assert.deepStrictEqual(engine.validateInput(input), []);
  const res = engine.calculate(input, { loadRate: config.targetLoadRate });
  assert.strictEqual(res.months.length, 18);
  assert.deepStrictEqual(res.corps, ['브라질', '인도']);
  res.corps.forEach((corp) => {
    res.byCorp[corp].monthly.forEach((m) => {
      // 모든 박스가 선적되었는지(이월 없음 기준)
      assert.deepStrictEqual(m.shipped, m.demand);
      // 2차(조합) 결과는 1차 부피 기준 산출보다 항상 크거나 같다
      assert.ok(m.containerCount >= m.simple.byVolume);
      // 한도 준수
      m.containers.forEach((c) => {
        assert.ok(c.cbm <= type.maxCbm * config.targetLoadRate + 1e-9);
        assert.ok(c.weightKg <= type.maxWeightKg * config.targetLoadRate + 1e-9);
      });
    });
    assert.ok(res.byCorp[corp].totalContainers > 0);
  });
});

console.log('\n총 ' + passed + '개 테스트 통과\n');

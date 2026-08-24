-- 로컬 검증 전용 — hd-project04 (운영 실행 금지)
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin','authenticator'))
     or exists (select 1 from pg_namespace where nspname='graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] 부피 계산 · 컨테이너 올림 · 미매핑 모델'; end $t$;

do $t$ begin
  -- 올림이 핵심이다. 내림하면 과소 예측이 되어 선적이 막힌다.
  perform public._assert_eq(public.containers(47.39, 67.7, 0.70), 1, '딱 한 대 분량이면 1개');
  perform public._assert_eq(public.containers(47.40, 67.7, 0.70), 2,
    '용량을 조금이라도 넘으면 컨테이너를 하나 더 쓴다 (내림하면 선적 불가)');
  perform public._assert_eq(public.containers(0,     67.7, 0.70), 0, '부피 0 이면 0개');
  perform public._assert(public.containers(10, 0, 0.70) is null,   '내부 부피가 0 이면 판정 불가');
  perform public._assert(public.containers(10, null, 0.70) is null,'규격이 없으면 판정 불가');
  -- 적재율을 올리면 컨테이너가 줄어야 한다
  perform public._assert(public.containers(100, 67.7, 0.70) >= public.containers(100, 67.7, 0.95),
    '적재율을 올리면 필요 컨테이너가 줄거나 같다');
end $t$;

do $t$
declare v_vol numeric;
begin
  -- 1m x 1m x 1m = 1㎥
  insert into public.box (code, name, length_mm, width_mm, height_mm)
  values ('B1','테스트박스', 1000, 1000, 1000) on conflict (code) do nothing;
  perform public._assert_eq(
    (select volume_m3 from public.box where code='B1'), 1::numeric,
    '1000x1000x1000mm = 1㎥ (부피는 저장이 아니라 계산)');

  -- 치수를 고치면 부피가 따라온다 — 따로 저장했다면 여기서 어긋난다
  update public.box set length_mm = 2000 where code='B1';
  perform public._assert_eq(
    (select volume_m3 from public.box where code='B1'), 2::numeric,
    '치수를 고치면 부피가 자동으로 따라온다');
  update public.box set length_mm = 1000 where code='B1';

  insert into public.model_box (model, box_code, qty_per_unit)
  values ('MDL-A','B1', 3) on conflict (model, box_code) do nothing;
  perform public._assert_eq(
    (select volume_per_unit_m3 from public.model_volume where model='MDL-A'), 3::numeric,
    '모델 1대 = 박스 3개 = 3㎥');

  insert into public.plan (plant_code, period, model, qty)
  values ('BRA','2026-09','MDL-A', 20), ('BRA','2026-09','MDL-Z', 5)
  on conflict (plant_code, period, model) do update set qty = excluded.qty;

  -- 20대 x 3㎥ = 60㎥ / (67.7 x 0.7 = 47.39) → 2개
  perform public._assert_eq(
    (select containers from public.monthly_container
      where plant_code='BRA' and period='2026-09'), 2,
    '20대(60㎥) → 40ft 2개');

  -- 박스 구성이 없는 모델은 부피 0 으로 잡혀 과소 산출이 된다. 조용히 넘어가지 않아야 한다.
  perform public._assert_eq(
    (select unmapped_models from public.monthly_container
      where plant_code='BRA' and period='2026-09'), 1::bigint,
    '박스 구성이 없는 모델 건수를 함께 알려 준다');
  perform public._assert_eq(
    (select count(*) from public.unmapped_models where model='MDL-Z'), 1::bigint,
    '미매핑 모델이 별도 뷰로 드러난다');

  -- 중복 방지는 DB 제약으로
  declare v_r boolean := false;
  begin
    begin
      insert into public.plan (plant_code, period, model, qty)
      values ('BRA','2026-09','MDL-A', 99);
    exception when unique_violation then v_r := true;
    end;
    perform public._assert(v_r, '같은 법인·달·모델 중복은 UNIQUE 가 막는다');
  end;

  declare v_r2 boolean := false;
  begin
    begin
      insert into public.container_spec (code, name, inner_volume_m3, target_fill)
      values ('BAD','잘못된 적재율', 67.7, 1.5);
    exception when check_violation then v_r2 := true;
    end;
    perform public._assert(v_r2, '적재율 100% 초과는 check 제약이 막는다');
  end;

  declare v_r3 boolean := false;
  begin
    begin
      insert into public.box (code, length_mm, width_mm, height_mm)
      values ('BAD2', -1, 100, 100);
    exception when check_violation then v_r3 := true;
    end;
    perform public._assert(v_r3, '음수 치수는 check 제약이 막는다');
  end;
end $t$;

do $t$ begin
  perform public._assert_eq((select count(*) from public.plant), 2::bigint, '법인 2곳 시드');
  perform public._assert_eq(
    (select target_fill from public.container_spec where code='40FT'), 0.70::numeric,
    '40ft 목표 적재율 70% 시드');
end $t$;

delete from public.plan where model in ('MDL-A','MDL-Z');
delete from public.model_box where model = 'MDL-A';
delete from public.box where code = 'B1';

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;

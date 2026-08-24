-- ============================================================================
-- hd-project04 — 브라질/인도 CKD 컨테이너 수량 산출
-- Supabase(Postgres) 운영 스키마 + RLS
--
--  실행 위치 : Supabase Dashboard → SQL Editor · 재실행 안전
--  이 스키마는 **수강생 본인의 Supabase 프로젝트**에 올리는 것을 전제로 합니다.
--  프로젝트가 본인 것이라 테이블 이름에 접두사를 붙이지 않았습니다.
--  (여러 앱을 한 프로젝트에 몰아 쓸 계획이면 이름 충돌을 먼저 확인하세요.)
--
--  이 도구의 값어치는 "규칙을 눈이 아니라 코드가 지키는 것"에 있습니다.
--  과다 예측 → 미사용 컨테이너 페널티, 과소 예측 → 선적 불가.
--  그래서 박스 부피·적재율·산출식을 전부 DB 에 고정해 두었습니다.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.plant (
  code       text primary key,                   -- 'BRA', 'IND'
  name       text not null,
  currency   text,
  active     boolean not null default true
);

-- 컨테이너 규격 — 40ft 기준. 적재율은 규칙이라 데이터로 둔다(코드에 박지 않는다).
create table if not exists public.container_spec (
  code            text primary key,              -- '40FT'
  name            text not null,
  inner_volume_m3 numeric not null check (inner_volume_m3 > 0),
  max_weight_kg   numeric,
  target_fill     numeric not null default 0.70
                  check (target_fill > 0 and target_fill <= 1),
  updated_at      timestamptz not null default now()
);

-- 박스 규격 마스터
create table if not exists public.box (
  code       text primary key,
  name       text,
  length_mm  numeric not null check (length_mm > 0),
  width_mm   numeric not null check (width_mm  > 0),
  height_mm  numeric not null check (height_mm > 0),
  -- 부피는 저장하지 않고 계산한다. 따로 저장하면 치수를 고치는 순간 어긋나는데,
  -- 그 어긋남이 산출 결과에만 조용히 나타난다.
  volume_m3  numeric generated always as
             (length_mm * width_mm * height_mm / 1000000000.0) stored,
  weight_kg  numeric,
  updated_at timestamptz not null default now()
);

-- 모델별 CKD 박스 구성 — 장비 1대를 보내려면 어떤 박스가 몇 개 필요한가
create table if not exists public.model_box (
  id            bigint generated always as identity primary key,
  model         text not null,
  box_code      text not null references public.box(code) on delete restrict,
  qty_per_unit  numeric not null check (qty_per_unit > 0),
  constraint model_box_uniq unique (model, box_code)
);
create index if not exists model_box_model_idx on public.model_box (model);

-- 18개월 생산계획
create table if not exists public.plan (
  id         bigint generated always as identity primary key,
  plant_code text not null references public.plant(code) on delete cascade,
  period     text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  model      text not null,
  qty        numeric not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  -- 같은 법인·같은 달·같은 모델이 두 번 들어오면 컨테이너 수가 두 배가 된다.
  -- ⚠ 프런트 upsert 는 onConflict 를 이 조합으로 지정할 것.
  constraint plan_uniq unique (plant_code, period, model)
);
create index if not exists plan_period_idx on public.plan (plant_code, period);

-- 산출 결과 스냅샷 — 물류팀에 넘긴 값이 무엇이었는지 남긴다
create table if not exists public.result (
  id             bigint generated always as identity primary key,
  plant_code     text not null,
  period         text not null,
  total_volume_m3 numeric not null,
  container_code text not null,
  target_fill    numeric not null,
  containers     int not null,
  calculated_at  timestamptz not null default now(),
  calculated_by  uuid default auth.uid(),
  note           text
);
create index if not exists result_idx on public.result (plant_code, period, calculated_at desc);

create table if not exists public.log (
  id        bigint generated always as identity primary key,
  ran_at    timestamptz not null default now(),
  kind      text not null,
  detail    text,
  processed int not null default 0,
  failed    int not null default 0,
  actor     uuid default auth.uid()
);
create index if not exists log_ran_at_idx on public.log (ran_at desc);

create table if not exists public.admin (
  user_id uuid primary key, email text, created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. 함수
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.admin a where a.user_id = auth.uid());
$fn$;

/**
 * 필요 컨테이너 수.
 *
 * 실을 수 있는 부피 = 컨테이너 내부 부피 × 목표 적재율.
 * 나머지가 남으면 컨테이너 하나를 더 써야 하므로 **올림**한다.
 * 내림하면 과소 예측이 되어 선적이 통째로 막힌다 — 이 도구를 만든 이유가 그것이다.
 */
create or replace function public.containers(
  p_volume_m3 numeric, p_inner_volume_m3 numeric, p_target_fill numeric
) returns int language plpgsql immutable set search_path = public as $fn$
declare v_cap numeric;
begin
  if p_volume_m3 is null or p_volume_m3 <= 0 then return 0; end if;
  if p_inner_volume_m3 is null or p_inner_volume_m3 <= 0 then return null; end if;
  v_cap := p_inner_volume_m3 * coalesce(p_target_fill, 1);
  if v_cap <= 0 then return null; end if;
  return ceil(p_volume_m3 / v_cap)::int;
end;
$fn$;

-- 박스 치수를 고치면 갱신일시를 따라 올린다
create or replace function public.touch()
returns trigger language plpgsql set search_path = public as $fn$
begin new.updated_at := now(); return new; end;
$fn$;

drop trigger if exists box_touch on public.box;
create trigger box_touch before update on public.box
  for each row execute function public.touch();

-- ----------------------------------------------------------------------------
-- 3. 뷰 — 계획 → 부피 → 컨테이너
-- ----------------------------------------------------------------------------

-- 모델 1대당 부피
create or replace view public.model_volume as
select mb.model,
       sum(mb.qty_per_unit * b.volume_m3) as volume_per_unit_m3,
       count(*)                            as box_kinds
from public.model_box mb
join public.box b on b.code = mb.box_code
group by mb.model;

-- 월별 필요 컨테이너
create or replace view public.monthly_container as
select
  p.plant_code,
  p.period,
  sum(p.qty)                              as unit_qty,
  sum(p.qty * coalesce(v.volume_per_unit_m3, 0)) as total_volume_m3,
  cs.code                                 as container_code,
  cs.target_fill,
  public.containers(
    sum(p.qty * coalesce(v.volume_per_unit_m3, 0)),
    cs.inner_volume_m3, cs.target_fill)   as containers,
  -- 박스 구성이 없는 모델이 섞이면 부피가 0 으로 잡혀 과소 산출이 된다.
  -- 조용히 넘어가지 않도록 건수를 함께 보여 준다.
  count(*) filter (where v.model is null) as unmapped_models
from public.plan p
left join public.model_volume v on v.model = p.model
cross join public.container_spec cs
group by p.plant_code, p.period, cs.code, cs.target_fill, cs.inner_volume_m3;

-- 박스 구성이 없는 모델 — 산출에서 빠진 것을 드러낸다
create or replace view public.unmapped_models as
select distinct p.plant_code, p.period, p.model, p.qty
from public.plan p
where not exists (select 1 from public.model_box mb where mb.model = p.model);

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------

alter table public.plant          enable row level security;
alter table public.container_spec enable row level security;
alter table public.box            enable row level security;
alter table public.model_box      enable row level security;
alter table public.plan           enable row level security;
alter table public.result         enable row level security;
alter table public.log            enable row level security;
alter table public.admin          enable row level security;

do $rls$
declare t text;
begin
  foreach t in array array['plant','container_spec','box',
                           'model_box','plan','result']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_write',  t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())', t || '_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_delete', t);
  end loop;
end;
$rls$;

drop policy if exists log_read  on public.log;
drop policy if exists log_write on public.log;
create policy log_read  on public.log for select to authenticated using (true);
create policy log_write on public.log for insert to authenticated with check (true);

drop policy if exists admin_read on public.admin;
create policy admin_read on public.admin for select to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. 함수 실행 권한 (§3.7)
-- ----------------------------------------------------------------------------

revoke all on function public.is_admin()                          from public, anon;
revoke all on function public.containers(numeric, numeric, numeric) from public, anon;
revoke all on function public.touch()                             from public, anon;

grant execute on function public.is_admin()                          to authenticated;
grant execute on function public.containers(numeric, numeric, numeric) to authenticated;
grant execute on function public.touch()                             to authenticated;

-- ----------------------------------------------------------------------------
-- 6. 시드 — 40ft 규격과 법인 2곳
-- ----------------------------------------------------------------------------

insert into public.plant (code, name) values
  ('BRA', '브라질법인'), ('IND', '인도법인')
on conflict (code) do nothing;

-- 40ft 드라이 컨테이너 내부 용적은 통상 67~68㎥. 목표 적재율 70%.
insert into public.container_spec (code, name, inner_volume_m3, max_weight_kg, target_fill)
values ('40FT', '40ft 드라이 컨테이너', 67.7, 26500, 0.70)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 끝. 관리자 등록:
--   insert into public.admin (user_id, email)
--   select id, email from auth.users where email = '<관리자 이메일>'
--   on conflict (user_id) do nothing;
-- ----------------------------------------------------------------------------

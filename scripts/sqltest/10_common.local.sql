-- ============================================================================
-- 로컬 검증 전용 — 전 프로젝트 공통 불변식
--
-- ⚠ 운영에서 실행할 수 없습니다(가드 내장).
-- ============================================================================

do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

create or replace function public._assert(p_ok boolean, p_label text)
returns void language plpgsql set search_path = public as $fn$
begin
  if p_ok then raise notice '  OK   %', p_label;
  else raise exception 'FAIL  %', p_label;
  end if;
end;
$fn$;

create or replace function public._assert_eq(p_actual anyelement, p_expected anyelement, p_label text)
returns void language plpgsql set search_path = public as $fn$
begin
  if p_actual is not distinct from p_expected then raise notice '  OK   %', p_label;
  else raise exception 'FAIL  %  (기대 %, 실제 %)', p_label, p_expected, p_actual;
  end if;
end;
$fn$;

do $t$ begin raise notice '[공통] 예약어 · RLS · 함수 권한'; end $t$;

-- ① 이름이 PostgreSQL 예약어와 겹치지 않는가.
--    접두사를 쓰지 않으므로(본인 프로젝트 전제) 이 검사가 접두사 검사를 대신한다.
--    `user`·`order`·`group` 같은 이름은 만들 수는 있어도 쓸 때마다 따옴표가 필요해
--    쿼리가 조용히 깨진다.
do $t$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v')
     and c.relname in ('user','order','group','session','table','column','check',
                       'default','array','all','any','select','from','where');
  perform public._assert(v_bad is null,
    '예약어와 겹치는 표 이름이 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;

-- ② RLS — 켜져 있고 정책이 붙어 있는가
do $t$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname not like 'pg\_%' and not c.relrowsecurity;
  perform public._assert(v_bad is null,
    'RLS 가 꺼진 테이블이 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;

do $t$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname not like 'pg\_%'
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  perform public._assert(v_bad is null,
    '정책이 하나도 없는 테이블이 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;

-- ③ 함수 권한 — GRANT 만으로는 제한되지 않는다.
--    Supabase 가 ALTER DEFAULT PRIVILEGES 로 신규 함수마다 anon 에 EXECUTE 를 붙이므로
--    PUBLIC 만 지우면 anon=X 가 남아 비로그인 호출이 그대로 뚫린다. (§3.7)
--    단, RLS 정책 식에서 쓰는 판정 함수는 anon 을 남겨야 공개 조회가 죽지 않는다.
--    그런 함수는 이름에 _pub_ 를 넣어 예외로 둔다.
do $t$
declare v_bad text;
begin
  select string_agg(proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and proname not like '\_assert%'
     and proname not like '%\_pub\_%'
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  perform public._assert(v_bad is null,
    'anon 에 EXECUTE 가 남은 함수가 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;

do $t$
declare v_bad text;
begin
  select string_agg(proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and proname not like '\_assert%'
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  perform public._assert(v_bad is null,
    'authenticated 는 전 함수를 실행할 수 있다' || coalesce(' (막힌 함수: ' || v_bad || ')', ''));
end $t$;

-- ④ 기록성 테이블(_log)은 사후 조작을 막기 위해 UPDATE/DELETE 정책을 두지 않는다
do $t$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname like '%log' and p.polcmd in ('w', 'd');
  perform public._assert(v_bad is null,
    '기록성 테이블에 UPDATE/DELETE 정책이 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;

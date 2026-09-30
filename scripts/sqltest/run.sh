#!/usr/bin/env bash
# ============================================================================
# supabase/schema.sql 을 임시 로컬 PostgreSQL 에 실제로 적용해 검증한다.
#
#   ./scripts/sqltest/run.sh
#
# 운영에서 처음 돌리지 않기 위한 장치다. 브라우저도 빌드도 SQL 은 잡아 주지 않는다.
# 임시 클러스터를 만들어 쓰고 끝나면 지우므로 기존 PostgreSQL 설치에 영향이 없다.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for c in /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@17/bin \
           /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin; do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
# 데비안·우분투(그리고 GitHub Actions 러너) — 여기서는 initdb 가 PATH 에 없다
if [ -z "$PGBIN" ]; then
  for c in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V -r); do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
if [ -z "$PGBIN" ] && command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then
  echo "PostgreSQL 을 찾지 못했습니다." >&2
  echo "  macOS  : brew install postgresql@17" >&2
  echo "  우분투 : sudo apt-get install -y postgresql" >&2
  exit 1
fi

TMP="$(mktemp -d)"; PGDATA="$TMP/data"; PGSOCK="$TMP/sock"; mkdir -p "$PGSOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "임시 PostgreSQL 준비 중…"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -h '' -c listen_addresses=''" -w start >/dev/null
"$PGBIN/createdb" -h "$PGSOCK" -U postgres sqltest

PSQL=("$PGBIN/psql" -h "$PGSOCK" -U postgres -d sqltest -v ON_ERROR_STOP=1 -q)

echo "① Supabase 환경 스텁"
"${PSQL[@]}" -f "$ROOT/scripts/sqltest/00_supabase_stub.local.sql"

echo "② schema.sql 적용"
"${PSQL[@]}" -f "$ROOT/supabase/schema.sql"

echo "③ 재적용 (재실행 안전한가)"
"${PSQL[@]}" -f "$ROOT/supabase/schema.sql"

echo "③-1 실행 위치 가드 — 공용 프로젝트 흔적(www_profiles·user_profiles)이 있으면 schema.sql 이 멈추는가"
for t in www_profiles user_profiles; do
  "${PSQL[@]}" -c "create table public.$t (id uuid)"
  if out="$("${PSQL[@]}" -f "$ROOT/supabase/schema.sql" 2>&1)"; then
    echo "FAIL  public.$t 가 있는데 schema.sql 이 멈추지 않았습니다" >&2; exit 1
  fi
  case "$out" in
    *"공용 프로젝트입니다"*) ;;
    *) echo "FAIL  schema.sql 이 가드가 아닌 다른 이유로 실패했습니다: $out" >&2; exit 1 ;;
  esac
  "${PSQL[@]}" -c "drop table public.$t"
  echo "  OK   public.$t → schema.sql 실행 거부"
done

echo "④ 공통 불변식 검증"
"${PSQL[@]}" -f "$ROOT/scripts/sqltest/10_common.local.sql" 2>&1 | sed 's/^psql:.*NOTICE:  //'

if [ -f "$ROOT/scripts/sqltest/20_project.local.sql" ]; then
  echo "⑤ 프로젝트별 검증"
  "${PSQL[@]}" -f "$ROOT/scripts/sqltest/20_project.local.sql" 2>&1 | sed 's/^psql:.*NOTICE:  //'
fi

echo ""
echo "SQL 검증 통과."

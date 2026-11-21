-- ============================================================================
--  독도국제무역.com 국제상품 3D 전시관 — 전시관 입장 자동 집계(관리자 전용 통계)
--  파일: supabase_upgrade_visitors.sql   (Supabase SQL Editor 에서 한 번 실행)
-- ============================================================================
--  무엇을 하나
--   · 전시관에 들어온 방문을 gallery_visits 표에 한 세션당 한 줄로 남긴다.
--   · 그 수치(오늘·누적·고유 방문자·최근 기록)는 **관리자 PIN 을 아는 사람만**
--     읽을 수 있다. 일반 방문자는 표를 직접 읽을 수도 없고, 입장 기록을 남기는
--     RPC 도 숫자를 하나도 돌려주지 않는다(오직 {"ok":true}).
--
--  필요한 것
--   · 이미 gallery_config / gallery_pin_ok 가 있는 DB (supabase_setup.sql 적용됨)
--   · 이 파일은 여러 번 실행해도 안전하다(if not exists / create or replace).
--
--  적용 뒤 확인 (SQL Editor 에 그대로 붙여 실행)
--   1) 표:     select count(*) from public.gallery_visits;
--   2) 함수:   select proname from pg_proc where proname in
--              ('record_gallery_visit','update_gallery_visit_name','admin_get_visit_stats');
--   3) 권한:   select has_table_privilege('anon','public.gallery_visits','select');  -- false 여야 정상
--   4) 통계:   select public.admin_get_visit_stats('관리자PIN');                    -- 관리자 PIN 을 넣어 확인
--   5) 웹:     전시관 상단 바 🔐 관리자 → PIN 입력 → 실시간·오늘·누적·7일 추이·최근 기록
-- ============================================================================

-- ── 1. 입장 기록 표 ────────────────────────────────────────────────────────
--  · session_id  : 탭(방문 세션)마다 하나 — 새로고침·방 이동으로 같은 방문이
--                  여러 번 세어지지 않게 unique 로 막는다.
--  · visitor_id  : 브라우저(localStorage)마다 하나 — '몇 명이 왔나'(고유 인원) 집계용.
--  · visitor_name: 그때의 닉네임(나중에 바꾸면 update_gallery_visit_name 이 고친다).
--  · device_kind : mobile / desktop · entry_zone: 처음 들어온 구역(hall 등)
create table if not exists public.gallery_visits (
  id           bigserial primary key,
  session_id   text not null unique,
  visitor_id   text not null,
  visitor_name text not null default '방문자',
  device_kind  text not null default 'mobile',
  entry_zone   text not null default 'hall',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists gallery_visits_created_idx
  on public.gallery_visits (created_at desc);
create index if not exists gallery_visits_visitor_idx
  on public.gallery_visits (visitor_id);

-- ── 2. 직접 접근 전면 차단 ─────────────────────────────────────────────────
--  RLS 를 켜고 정책을 하나도 만들지 않는다 + 권한 자체를 회수한다.
--  (통계는 아래 admin_get_visit_stats SECURITY DEFINER 함수로만 나간다.)
alter table public.gallery_visits enable row level security;
revoke all on public.gallery_visits from anon, authenticated;
revoke all on sequence public.gallery_visits_id_seq from anon, authenticated;

-- ── 3. RPC — 입장 기록 (일반 방문자가 부른다) ──────────────────────────────
--  돌려주는 값은 언제나 {"ok":true} 뿐이다. 몇 번째 방문인지·전체 인원 같은
--  숫자는 절대 돌려주지 않는다(방문자가 통계를 역산할 수 없게).
create or replace function public.record_gallery_visit(
  p_session_id text,
  p_visitor_id text,
  p_name       text default '방문자',
  p_device     text default 'mobile',
  p_zone       text default 'hall'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_session_id is null or length(btrim(p_session_id)) = 0 then
    return jsonb_build_object('ok', true);          -- 조용히 넘어간다(오류도 알리지 않음)
  end if;

  insert into public.gallery_visits (session_id, visitor_id, visitor_name, device_kind, entry_zone)
  values (
    left(btrim(p_session_id), 80),
    left(coalesce(nullif(btrim(p_visitor_id), ''), 'unknown'), 80),
    left(coalesce(nullif(btrim(p_name), ''), '방문자'), 12),
    case when lower(coalesce(btrim(p_device), '')) = 'desktop' then 'desktop' else 'mobile' end,
    left(coalesce(nullif(btrim(p_zone), ''), 'hall'), 40)
  )
  on conflict (session_id) do nothing;               -- 같은 세션은 한 번만

  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', true);             -- 실패해도 방문자에게는 아무 것도 알리지 않는다
end;
$$;

-- ── 4. RPC — 닉네임 변경 반영 ──────────────────────────────────────────────
create or replace function public.update_gallery_visit_name(
  p_session_id text,
  p_name       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_session_id is null or length(btrim(p_session_id)) = 0 then
    return jsonb_build_object('ok', true);
  end if;

  update public.gallery_visits
     set visitor_name = left(coalesce(nullif(btrim(p_name), ''), '방문자'), 12),
         updated_at   = now()
   where session_id = left(btrim(p_session_id), 80);

  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', true);
end;
$$;

-- ── 5. RPC — 관리자 전용 통계 (PIN 필요) ───────────────────────────────────
--  PIN 이 틀리면 {"ok":false,"error":"pin"} 만 돌려준다. 통계는 한 톨도 안 나간다.
--  '오늘' 은 한국시간(Asia/Seoul) 자정 기준, 'daily' 는 최근 7일(오늘 포함) 일별.
create or replace function public.admin_get_visit_stats(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_today timestamptz;      -- 한국시간 오늘 자정(절대시각)
  v_day0  date;             -- 한국시간 오늘 날짜
  v_out   jsonb;
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;

  v_today := date_trunc('day', (now() at time zone 'Asia/Seoul')) at time zone 'Asia/Seoul';
  v_day0  := (now() at time zone 'Asia/Seoul')::date;

  select jsonb_build_object(
    'ok', true,
    'total_visits', (select count(*) from public.gallery_visits),
    'total_unique', (select count(distinct visitor_id) from public.gallery_visits),
    'today_visits', (select count(*) from public.gallery_visits where created_at >= v_today),
    'today_unique', (select count(distinct visitor_id) from public.gallery_visits where created_at >= v_today),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date',   to_char(d.day, 'YYYY-MM-DD'),
               'visits', coalesce(x.visits, 0),
               'unique', coalesce(x.uniq, 0)) order by d.day)
        from (select v_day0 - off as day from generate_series(0, 6) as off) d
        left join (
          select (created_at at time zone 'Asia/Seoul')::date as day,
                 count(*)                    as visits,
                 count(distinct visitor_id)  as uniq
            from public.gallery_visits
           where created_at >= v_today - interval '6 days'
           group by 1
        ) x on x.day = d.day
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',         r.id,
               'name',       r.visitor_name,
               'device',     r.device_kind,
               'zone',       r.entry_zone,
               'created_at', r.created_at) order by r.created_at desc)
        from (select id, visitor_name, device_kind, entry_zone, created_at
                from public.gallery_visits
               order by created_at desc
               limit 30) r
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ── 6. 실행 권한 ───────────────────────────────────────────────────────────
--  표는 아무 권한도 주지 않고, 위 3개 RPC 에만 실행 권한을 준다.
revoke all on function public.record_gallery_visit(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_gallery_visit_name(text, text) from public, anon, authenticated;
revoke all on function public.admin_get_visit_stats(text) from public, anon, authenticated;

grant execute on function public.record_gallery_visit(text, text, text, text, text) to anon, authenticated;
grant execute on function public.update_gallery_visit_name(text, text) to anon, authenticated;
grant execute on function public.admin_get_visit_stats(text) to anon, authenticated;

-- ============================================================================
--  [선택] 시험용으로 한 줄 넣어 보고 지우기 (통계 창이 비어 있을 때)
--    insert into public.gallery_visits (session_id, visitor_id, visitor_name, device_kind, entry_zone)
--    values ('test-' || gen_random_uuid(), 'test-visitor', '시험', 'desktop', 'hall');
--    delete from public.gallery_visits where visitor_id = 'test-visitor';
-- ============================================================================

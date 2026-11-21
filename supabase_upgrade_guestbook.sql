-- ============================================================================
--  재롱둥이 머니 쇼츠 · 3D 전시관 — [업그레이드] 모두 함께 쓰는 공유 방명록
-- ============================================================================
--  무엇이 바뀌나
--   지금 방명록은 브라우저(localStorage)에만 저장되어, 그 기기에서만 보입니다.
--   → 서버(Supabase) 표에 저장해, 방문한 모든 사람이 같은 방명록을 보고 남기게 합니다.
--
--  이 파일이 하는 일 (기존 판넬·설정·PIN 은 절대 건드리지 않습니다)
--   1) public.gallery_guestbook 표를 만든다
--      (id bigserial · name text · message text · created_at timestamptz default now())
--   2) RLS 를 켜고, 방문자(anon·authenticated)는 '읽기(SELECT)'만 허용한다.
--      직접 INSERT/UPDATE/DELETE 는 막는다(아래 RPC 로만 쓸 수 있다).
--   3) public.add_guestbook_entry(p_name, p_message) — 누구나 글을 남긴다
--      · 빈 내용은 거부, 이름 20자·내용 300자로 자르고 앞뒤 공백 제거
--      · 반환: {"ok": true, "entry": {"id": …, "name": …, "message": …, "created_at": …}}
--   4) public.delete_guestbook_entry(pin_input, p_id) — 관리자 PIN 을 맞히면 그 글을 지운다
--      (PIN 은 gallery_config 에 해시로 저장된 기존 값을 그대로 씁니다 — 새 PIN 을 만들지 않습니다)
--   5) supabase_realtime 발행(publication)에 gallery_guestbook 을 더한다(이미 있으면 그대로).
--
--  안전한 이유
--   · 여러 번 실행해도 안전합니다(if not exists / create or replace).
--   · gallery_panels · gallery_config · 관리자 PIN 행은 읽기만 하고 바꾸지 않습니다.
--   · 실시간 발행 추가는 실패해도 예외를 삼켜서 스크립트가 멈추지 않습니다.
--
--  실행 방법
--   Supabase 대시보드 → SQL Editor → New query → 아래 전체를 붙여 넣고 Run
--   (SQL Editor 에서는 크롬 자동번역을 꺼 두세요 — 화면이 깨지는 경우가 있습니다)
--
--  실행 뒤 확인
--   select public.add_guestbook_entry('테스트', '공유 방명록 연결 확인');
--   select id, name, message, created_at from public.gallery_guestbook order by created_at desc limit 5;
--   → 글이 보이면 완료. 지우려면: select public.delete_guestbook_entry('본인PIN', <id>);
-- ============================================================================

-- ── 1. 방명록 표 ─────────────────────────────────────────────────────────────
create table if not exists public.gallery_guestbook (
  id         bigserial primary key,
  name       text not null,
  message    text not null,
  created_at timestamptz not null default now()
);

-- 목록은 항상 최신순으로 읽으므로 인덱스를 하나 둔다.
create index if not exists gallery_guestbook_created_idx
  on public.gallery_guestbook (created_at desc);

-- ── 2. RLS — 방문자는 읽기만 ────────────────────────────────────────────────
alter table public.gallery_guestbook enable row level security;

drop policy if exists gallery_guestbook_anon_read on public.gallery_guestbook;
create policy gallery_guestbook_anon_read
  on public.gallery_guestbook
  for select
  to anon, authenticated
  using (true);

-- 쓰기(insert/update/delete) 정책은 만들지 않는다 → 아래 security definer 함수로만 가능.
revoke all on public.gallery_guestbook from anon, authenticated;
grant select on public.gallery_guestbook to anon, authenticated;
grant usage, select on sequence public.gallery_guestbook_id_seq to anon, authenticated;

-- ── 3. 글 남기기 RPC ────────────────────────────────────────────────────────
create or replace function public.add_guestbook_entry(
  p_name    text,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name    text;
  v_message text;
  row_out   public.gallery_guestbook;
begin
  v_name    := left(btrim(coalesce(p_name, '')), 20);
  v_message := left(btrim(coalesce(p_message, '')), 300);

  if v_name = '' then
    v_name := '방문자';
  end if;
  if v_message = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  insert into public.gallery_guestbook (name, message)
  values (v_name, v_message)
  returning * into row_out;

  return jsonb_build_object(
    'ok', true,
    'entry', jsonb_build_object(
      'id',         row_out.id,
      'name',       row_out.name,
      'message',    row_out.message,
      'created_at', row_out.created_at
    )
  );
end;
$$;

revoke all on function public.add_guestbook_entry(text, text) from public;
grant execute on function public.add_guestbook_entry(text, text) to anon, authenticated;

-- ── 4. 관리자 PIN 으로 글 지우기 RPC ────────────────────────────────────────
create or replace function public.delete_guestbook_entry(
  pin_input text,
  p_id      bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  if p_id is null then
    return jsonb_build_object('ok', false, 'error', 'id');
  end if;

  delete from public.gallery_guestbook where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'missing', 'id', p_id);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.delete_guestbook_entry(text, bigint) from public;
grant execute on function public.delete_guestbook_entry(text, bigint) to anon, authenticated;

-- ── 5. Realtime 발행 — 이미 켜져 있으면 그대로, 아니면 켠다 ──────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'gallery_guestbook'
  ) then
    execute 'alter publication supabase_realtime add table public.gallery_guestbook';
  end if;
exception when others then
  raise notice 'supabase_realtime publication 에 gallery_guestbook 을 더하지 못했습니다: %', sqlerrm;
end;
$$;

-- ============================================================================
--  확인용 (선택)
--   1) 표가 만들어졌는지:  select count(*) from public.gallery_guestbook;
--   2) 함수가 있는지:      select proname from pg_proc where proname in
--                          ('add_guestbook_entry','delete_guestbook_entry');
--   3) 웹에서: 안내데스크 방명록에 글을 남기고 → 다른 휴대폰/PC에서 새로고침해도
--              같은 글이 보이면 완료.
-- ============================================================================

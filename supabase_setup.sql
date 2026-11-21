-- ============================================================================
--  재롱둥이 머니 쇼츠 · 3D 전시관 — 2단계 판넬 저장/실시간 구조 (Supabase)
-- ============================================================================
--  하는 일
--   · gallery_panels : 종목별 2~5번 판넬(사용자가 직접 고른 쇼츠·이미지)만 저장한다.
--                      1번 판넬(최신 자동)은 exhibits.json / GitHub Actions 가 맡으므로 DB에 넣지 않는다.
--   · gallery_config : 관리자 PIN 의 해시만 보관한다(평문 저장 안 함).
--   · anon 키를 가진 방문자는 SELECT 만 가능하고, 쓰기는 PIN 을 받는 RPC 함수로만 통과한다.
--
--  판넬 종류(kind)
--   · 'shorts' / 'video' : 유튜브 영상 — video_id 11자리, image_url 은 비운다.
--   · 'image'            : 사진·이미지 — video_id 는 비우고 image_url 에 https 주소나
--                          data:image/...;base64 데이터(폰에서 고른 사진을 줄인 것)를 담는다.
--   · 'empty'            : 지운 칸 — 행을 DELETE 하지 않고 '비었다'는 표식으로 남긴다.
--                          (행을 지우면 새로고침할 때 exhibits.json 의 기본 #2~#5 쇼츠가 다시 나타난다.)
--
--  적용 순서 (Supabase 대시보드 → SQL Editor 에 이 파일을 붙여 실행)
--   1) 이 파일 전체 실행
--   2) 아래 [초기 PIN 설정] 의 예시에서 PIN 값만 바꿔 실행
--   3) 전시관 exhibits.json 의 meta.realtime.supabaseUrl / supabaseAnonKey 채우기
--      (anon 공개 키만 넣습니다. service_role 키는 절대 브라우저에 넣지 마세요.)
--
--  다시 실행해도 안전합니다(if not exists / drop … if exists / create or replace).
--  이미 쓰던 DB 에도 그대로 붙여 실행하면 이미지·빈 슬롯 지원만 더해집니다(기존 판넬·PIN 유지).
--  이미지 지원만 빠르게 더하려면 supabase_upgrade_image.sql,
--  판넬 삭제(빈 슬롯)만 빠르게 더하려면 supabase_upgrade_delete.sql 을 실행해도 됩니다.
-- ============================================================================

-- ── 0. 확장 ─────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ── 1. 테이블 ───────────────────────────────────────────────────────────────
--  pin_input 은 RPC 로만 쓰고 이 테이블에는 해시만 남긴다.
create table if not exists public.gallery_config (
  key         text primary key,
  value_hash  text,
  updated_at  timestamptz not null default now()
);

--  slot_no 는 반드시 2..5 (1번 판넬은 자동 최신이므로 DB 로 편집할 수 없다)
--  image_url 은 '이미지' 판넬에서만 쓴다(영상 판넬은 null).
create table if not exists public.gallery_panels (
  ticker_id   text        not null,
  slot_no     int         not null check (slot_no between 2 and 5),
  video_id    text,
  title       text        not null default '',
  kind        text        not null default 'shorts'
                          check (kind in ('shorts', 'video', 'image', 'empty')),
  image_url   text,
  updated_at  timestamptz not null default now(),
  primary key (ticker_id, slot_no)
);

-- ── 1-1. 기존 DB 업그레이드 (이미 쓰던 gallery_panels 에 이미지·빈 슬롯 지원만 더한다) ──
--  · kind 제약을 'image' · 'empty' 까지 넓힌다(제약 이름은 Postgres 가 붙인 gallery_panels_kind_check).
--  · image_url 컬럼을 더한다. 이미 있으면 아무 일도 하지 않는다.
--  · 기존 행(영상 판넬)은 kind 가 'shorts'/'video' 라 그대로 통과하고, image_url 은 null 로 남는다.
alter table public.gallery_panels drop constraint if exists gallery_panels_kind_check;
alter table public.gallery_panels
  add constraint gallery_panels_kind_check check (kind in ('shorts', 'video', 'image', 'empty'));
alter table public.gallery_panels add column if not exists image_url text;

create index if not exists gallery_panels_ticker_idx
  on public.gallery_panels (ticker_id);

-- ── 2. 관리자 PIN 확인 도우미 ───────────────────────────────────────────────
--  gallery_config('admin_pin') 에 crypt(pin, gen_salt('bf')) 형태로 저장한다.
create or replace function public.gallery_pin_ok(pin_input text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored text;
begin
  if pin_input is null or length(btrim(pin_input)) < 4 then
    return false;
  end if;
  select value_hash into stored
    from public.gallery_config
   where key = 'admin_pin';
  if stored is null or stored = '' then
    -- PIN 을 아직 설정하지 않았으면 아무도 통과하지 못한다(설정 전 잠금).
    return false;
  end if;
  return stored = crypt(btrim(pin_input), stored);
end;
$$;

-- ── 3. RPC 1 — PIN 확인 ─────────────────────────────────────────────────────
create or replace function public.verify_gallery_pin(pin_input text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return public.gallery_pin_ok(pin_input);
end;
$$;

-- ── 4. RPC 2 — 판넬 저장(2~5번 칸만) ────────────────────────────────────────
--  이전 6인자 버전은 지우고 7인자(p_image_url 추가) 하나만 남긴다.
--  (인자 개수가 다른 함수를 그대로 두면 PostgREST 가 어느 쪽을 부를지 헷갈릴 수 있다.)
drop function if exists public.save_gallery_panel(text, text, int, text, text, text);

--  반환 예: {"ok": true, "ticker_id": "gold", "slot_no": 3, "kind": "image"}
--          {"ok": false, "error": "pin"}    ← PIN 불일치
--          {"ok": false, "error": "slot"}   ← 2..5 이외의 칸 요청
--          {"ok": false, "error": "video"}  ← 영상 ID가 비었거나 형식이 틀림
--          {"ok": false, "error": "image"}  ← 이미지 주소가 비었거나 형식·용량 초과
create or replace function public.save_gallery_panel(
  pin_input   text,
  p_ticker_id text,
  p_slot_no   int,
  p_video_id  text,
  p_title     text,
  p_kind      text,
  p_image_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_video text := btrim(coalesce(p_video_id, ''));
  v_title text := btrim(coalesce(p_title, ''));
  v_kind  text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'shorts');
  v_image text := btrim(coalesce(p_image_url, ''));
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;

  -- 1번 판넬은 자동(최신) 전용이라 DB 로는 절대 바꾸지 못한다.
  if p_slot_no is null or p_slot_no < 2 or p_slot_no > 5 then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  if v_kind not in ('shorts', 'video', 'image') then
    v_kind := 'shorts';
  end if;

  if v_kind = 'image' then
    -- 이미지 판넬: 영상 ID 는 비우고, 이미지 주소만 검사한다.
    --   · https?:// 주소, 또는 브라우저에서 줄여 만든 data:image/...;base64 데이터
    --   · 350,000자(=약 350KB) 이하만 허용 — 폰에서 보낸 사진은 앱이 220KB 이하로 줄여 보낸다.
    v_video := null;
    if v_image = '' then
      return jsonb_build_object('ok', false, 'error', 'image');
    end if;
    if length(v_image) > 350000 then
      return jsonb_build_object('ok', false, 'error', 'image');
    end if;
    if v_image !~ '^https?://'
       and v_image !~ '^data:image/(png|jpeg|jpg|webp|gif);base64,' then
      return jsonb_build_object('ok', false, 'error', 'image');
    end if;
  else
    -- 영상 판넬: 유튜브 영상 ID 11자리만 허용(직접 링크는 클라이언트에서 ID 로 바꿔 보낸다).
    v_image := null;
    if v_video !~ '^[A-Za-z0-9_-]{11}$' then
      return jsonb_build_object('ok', false, 'error', 'video');
    end if;
  end if;

  insert into public.gallery_panels
    (ticker_id, slot_no, video_id, title, kind, image_url, updated_at)
  values
    (p_ticker_id, p_slot_no, v_video, left(v_title, 120), v_kind, v_image, now())
  on conflict (ticker_id, slot_no) do update
    set video_id   = excluded.video_id,
        title      = excluded.title,
        kind       = excluded.kind,
        image_url  = excluded.image_url,
        updated_at = now();

  return jsonb_build_object('ok', true, 'ticker_id', p_ticker_id, 'slot_no', p_slot_no,
                            'video_id', v_video, 'title', left(v_title, 120),
                            'kind', v_kind,
                            'image_url', case when v_kind = 'image' then v_image else null end);
end;
$$;

-- ── 5. RPC 3 — 판넬 삭제(대기 슬롯으로) ─────────────────────────────────────
--  행을 DELETE 하지 않고 kind='empty' 로 덮어쓴다(UPSERT).
--  DELETE 하면 새로고침할 때 exhibits.json 의 기본 #2~#5 쇼츠가 다시 나타나므로,
--  '이 칸은 지웠다'는 사실을 DB 에 남겨 새로고침·다른 기기에서도 빈 슬롯으로 보이게 한다.
--  반환 예: {"ok": true, "ticker_id": "gold", "slot_no": 3, "kind": "empty", "video_id": null}
create or replace function public.clear_gallery_panel(
  pin_input   text,
  p_ticker_id text,
  p_slot_no   int
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
  if p_slot_no is null or p_slot_no < 2 or p_slot_no > 5 then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  insert into public.gallery_panels
    (ticker_id, slot_no, video_id, title, kind, image_url, updated_at)
  values
    (p_ticker_id, p_slot_no, null, '', 'empty', null, now())
  on conflict (ticker_id, slot_no) do update
    set video_id   = null,
        title      = '',
        kind       = 'empty',
        image_url  = null,
        updated_at = now();

  return jsonb_build_object('ok', true, 'ticker_id', p_ticker_id, 'slot_no', p_slot_no,
                            'kind', 'empty', 'video_id', null);
end;
$$;

-- ── 6. RLS — 읽기만 공개, 쓰기는 RPC(security definer)로만 ───────────────────
alter table public.gallery_panels enable row level security;
alter table public.gallery_config enable row level security;

-- 이전 정책이 있으면 지우고 다시 만든다(다시 실행해도 안전).
drop policy if exists gallery_panels_anon_read on public.gallery_panels;
create policy gallery_panels_anon_read
  on public.gallery_panels
  for select
  to anon, authenticated
  using (true);

-- anon/authenticated 의 직접 쓰기 정책은 만들지 않는다 → INSERT/UPDATE/DELETE 차단.
revoke insert, update, delete, truncate on public.gallery_panels from anon, authenticated;
grant select on public.gallery_panels to anon, authenticated;

-- gallery_config 는 anon 접근 전면 차단(정책 없음 + 권한 회수).
revoke all on public.gallery_config from anon, authenticated;

-- 함수 실행 권한: 확인용/저장용 RPC 만 anon 에게 연다.
revoke all on function public.gallery_pin_ok(text) from public, anon, authenticated;
revoke all on function public.verify_gallery_pin(text) from public;
revoke all on function public.save_gallery_panel(text, text, int, text, text, text, text) from public;
revoke all on function public.clear_gallery_panel(text, text, int) from public;

grant execute on function public.verify_gallery_pin(text) to anon, authenticated;
grant execute on function public.save_gallery_panel(text, text, int, text, text, text, text) to anon, authenticated;
grant execute on function public.clear_gallery_panel(text, text, int) to anon, authenticated;

-- ── 7. Realtime — gallery_panels 변경을 접속자에게 즉시 알린다 ───────────────
--  (이미 publication 에 나와 있으면 아래 insert 는 건너뜁니다.)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'gallery_panels'
  ) then
    execute 'alter publication supabase_realtime add table public.gallery_panels';
  end if;
exception when others then
  raise notice 'supabase_realtime publication 을 건드리지 못했습니다: %', sqlerrm;
end;
$$;

-- 변경 전/후 행을 함께 보내려면(권장)
alter table public.gallery_panels replica identity full;


-- ============================================================================
--  [공유 방명록] — 방문한 모든 사람이 함께 보고 남기는 방명록
--  (supabase_upgrade_guestbook.sql 과 같은 내용입니다. 이미 적용한 DB 에서 다시 실행해도 안전합니다.)
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

-- ============================================================================
--  [초기 PIN 설정] — 아래 PIN 값만 원하는 숫자/문자로 바꿔 한 번 실행하세요.
--  (예: '2487' 처럼 본인만 아는 4~12자리. 실행 뒤 이 파일에 PIN 을 적어 두지 마세요.)
-- ============================================================================
-- insert into public.gallery_config (key, value_hash, updated_at)
-- values ('admin_pin', crypt('PIN을여기에입력', gen_salt('bf')), now())
-- on conflict (key) do update
--   set value_hash = excluded.value_hash, updated_at = now();
--
-- PIN 바꾸기: 같은 insert 문을 새 PIN 으로 다시 실행하면 됩니다(해시만 남습니다).
-- PIN 확인:   select public.verify_gallery_pin('PIN을여기에입력');
-- 설정 확인:  select key, length(value_hash), updated_at from public.gallery_config;
-- ============================================================================

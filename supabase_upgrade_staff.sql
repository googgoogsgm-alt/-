-- ============================================================================
--  독도국제무역.com 국제상품 3D 전시관 — 2층 회의실 직원 등급(A·B·C) 명단
--  파일: supabase_upgrade_staff.sql   (Supabase SQL Editor 에서 한 번 실행)
-- ============================================================================
--  이 파일은 공개 저장소에 함께 올라갑니다. 그래서 실제 입장 코드(비밀번호)는
--  이 파일에 적지 않습니다. 코드는 아래 [코드 등록] 칸의 SQL 로 한 번 넣으면
--  bcrypt 해시로만 gallery_config 에 남습니다.
--
--  필요한 것
--   · 이미 gallery_config / verify_gallery_pin 이 있는 DB (supabase_setup.sql 적용됨)
--   · pgcrypto 확장 (crypt, gen_salt)
--
--  적용 뒤 확인
--   1) 표:    select count(*) from public.gallery_staff;
--   2) 함수:  select proname from pg_proc where proname in
--             ('verify_meeting_access','admin_list_staff','admin_upsert_staff',
--              'admin_delete_staff','admin_set_meeting_code');
--   3) 웹:    중앙홀 동쪽 '회의실' 포털 → 이름·입장 코드로 입장,
--             ⚙️ 직원 등급 관리 → 관리자 PIN → 직원 추가/등급 변경/삭제/공용 코드 변경
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 1. 직원 명단 테이블 ─────────────────────────────────────────────────────
--  · 등급: A(임원) · B(직원) → 회의실 입장 가능 / C(대기) → 입장 불가
--  · access_code: 직원 개인 입장 코드(평문 저장 — 개인용 짧은 코드, 관리자만 조회)
--  · 로그인 계정이 아니라 '회의실 출입 명단'이므로 개인 코드는 평문으로 둡니다.
--    (공용 A·B 코드만 gallery_config 에 bcrypt 해시로 보관합니다.)
create table if not exists public.gallery_staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  grade       text not null default 'B' check (grade in ('A', 'B', 'C')),
  access_code text not null default '',
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 이름은 대소문자·앞뒤 공백을 무시하고 한 명만
create unique index if not exists gallery_staff_name_uidx
  on public.gallery_staff (lower(btrim(name)));

-- 직접 접근 차단 — RLS 켜고 정책을 만들지 않는다(아래 SECURITY DEFINER RPC 로만)
alter table public.gallery_staff enable row level security;
revoke all on public.gallery_staff from anon, authenticated;

-- ── 2. 공용 A·B 회의실 코드 ─────────────────────────────────────────────────
--  gallery_config('meeting_ab_pin') 에 crypt(code, gen_salt('bf')) 해시로 보관.
create or replace function public.meeting_code_ok(code_input text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored text;
begin
  if code_input is null or length(btrim(code_input)) = 0 then
    return false;
  end if;
  select value_hash into stored
    from public.gallery_config
   where key = 'meeting_ab_pin';
  if stored is null or stored = '' then
    return false;
  end if;
  return stored = crypt(btrim(code_input), stored);
end;
$$;

--  미등록 이름도 공용 코드만 맞으면 입장을 허용할지 (기본 1 = 허용)
--  '0' 으로 바꾸면 명단에 등록된 직원만 들어올 수 있습니다.
create or replace function public.meeting_common_allow()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v text;
begin
  select value_hash into v from public.gallery_config where key = 'meeting_common_allow';
  return coalesce(btrim(coalesce(v, '1')), '1') <> '0';
end;
$$;

-- ── 3. RPC 1 — 회의실 입장 인증 ────────────────────────────────────────────
--  반환 예: {"ok": true, "name": "서규명", "grade": "A"}
--           {"ok": true, "name": "방문자", "grade": "B", "common": true}
--           {"ok": false, "error": "grade"}    ← C 등급(공용 코드로도 우회 불가)
--           {"ok": false, "error": "invalid"}  ← 이름/코드 불일치
create or replace function public.verify_meeting_access(p_name text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row record;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' or coalesce(btrim(p_code), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_row
    from public.gallery_staff
   where lower(btrim(name)) = lower(v_name)
   limit 1;

  if v_row.id is not null then
    -- 명단에 있는 이름: C 등급은 어떤 코드로도 통과하지 않는다
    if v_row.grade = 'C' then
      return jsonb_build_object('ok', false, 'error', 'grade');
    end if;
    if v_row.grade in ('A', 'B') and (
         (coalesce(v_row.access_code, '') <> '' and btrim(v_row.access_code) = btrim(p_code))
         or public.meeting_code_ok(p_code)
       ) then
      return jsonb_build_object('ok', true, 'name', v_row.name, 'grade', v_row.grade);
    end if;
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- 명단에 없는 이름: 공용 A·B 코드가 맞고 허용 설정이면 B 등급으로 입장
  if public.meeting_common_allow() and public.meeting_code_ok(p_code) then
    return jsonb_build_object('ok', true, 'name', v_name, 'grade', 'B', 'common', true);
  end if;

  return jsonb_build_object('ok', false, 'error', 'invalid');
end;
$$;

-- ── 4. 관리자 도우미 ────────────────────────────────────────────────────────
create or replace function public.staff_list_json()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'name', s.name, 'grade', s.grade,
           'access_code', s.access_code, 'note', coalesce(s.note, ''),
           'created_at', s.created_at, 'updated_at', s.updated_at
         ) order by s.created_at), '[]'::jsonb)
    from public.gallery_staff s;
$$;

-- ── 5. RPC 2 — 직원 명단(관리자 전용) ──────────────────────────────────────
create or replace function public.admin_list_staff(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  return jsonb_build_object('ok', true, 'staff', public.staff_list_json(),
                            'common_set', exists (select 1 from public.gallery_config where key = 'meeting_ab_pin'));
end;
$$;

-- ── 6. RPC 3 — 직원 추가/수정(관리자 전용) ─────────────────────────────────
--  p_id 가 null 이면 추가, 있으면 그 직원을 수정한다.
create or replace function public.admin_upsert_staff(
  pin_input text, p_id uuid, p_name text, p_grade text, p_code text, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_grade text := upper(btrim(coalesce(p_grade, 'B')));
  v_code  text := btrim(coalesce(p_code, ''));
  v_note  text := btrim(coalesce(p_note, ''));
  v_other uuid;
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;
  if v_grade not in ('A', 'B', 'C') then
    return jsonb_build_object('ok', false, 'error', 'grade');
  end if;

  select id into v_other from public.gallery_staff
   where lower(btrim(name)) = lower(v_name) and (p_id is null or id <> p_id)
   limit 1;
  if v_other is not null then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;

  if p_id is null then
    insert into public.gallery_staff (name, grade, access_code, note)
    values (v_name, v_grade, v_code, v_note);
  else
    update public.gallery_staff
       set name = v_name, grade = v_grade, access_code = v_code,
           note = v_note, updated_at = now()
     where id = p_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'missing');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'staff', public.staff_list_json());
end;
$$;

-- ── 7. RPC 4 — 직원 삭제(관리자 전용) ──────────────────────────────────────
create or replace function public.admin_delete_staff(pin_input text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  delete from public.gallery_staff where id = p_id;
  return jsonb_build_object('ok', true, 'staff', public.staff_list_json());
end;
$$;

-- ── 8. RPC 5 — 공용 A·B 회의실 코드 변경(관리자 전용) ─────────────────────
--  화면(⚙️ 직원 등급 관리)에서 입력한 새 코드를 bcrypt 해시로만 저장한다.
--  어떤 응답에도 코드 평문은 담지 않는다.
create or replace function public.admin_set_meeting_code(pin_input text, new_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code text := btrim(coalesce(new_code, ''));
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  if length(v_code) < 4 then
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  insert into public.gallery_config (key, value_hash, updated_at)
  values ('meeting_ab_pin', crypt(v_code, gen_salt('bf')), now())
  on conflict (key) do update
    set value_hash = excluded.value_hash, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

--  미등록 이름의 공용 코드 입장 허용/차단 (관리자 전용, 선택)
create or replace function public.admin_set_common_allow(pin_input text, p_allow boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.gallery_pin_ok(pin_input) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  insert into public.gallery_config (key, value_hash, updated_at)
  values ('meeting_common_allow', case when p_allow then '1' else '0' end, now())
  on conflict (key) do update
    set value_hash = excluded.value_hash, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- ── 9. 권한 — anon 은 RPC 만 부를 수 있다(테이블 직접 접근은 revoke 로 차단) ─
revoke all on function public.meeting_code_ok(text) from public;
revoke all on function public.meeting_common_allow() from public;
revoke all on function public.staff_list_json() from public;

grant execute on function public.verify_meeting_access(text, text) to anon, authenticated;
grant execute on function public.admin_list_staff(text) to anon, authenticated;
grant execute on function public.admin_upsert_staff(text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_delete_staff(text, uuid) to anon, authenticated;
grant execute on function public.admin_set_meeting_code(text, text) to anon, authenticated;
grant execute on function public.admin_set_common_allow(text, boolean) to anon, authenticated;

-- ============================================================================
--  [코드 등록] — 관리자 PIN(예: 본인 PIN)과 공용 A·B 코드를 한 번 넣습니다.
--  실행 뒤 이 파일에는 코드를 적어 두지 마세요(해시만 남습니다).
-- ============================================================================
-- select public.admin_set_meeting_code('관리자PIN', '공용A·B코드');
-- 확인: select key, length(value_hash), updated_at from public.gallery_config
--        where key in ('meeting_ab_pin', 'meeting_common_allow');
-- ============================================================================

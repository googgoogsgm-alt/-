-- ============================================================================
--  전시관 이미지(사진) 판넬 지원만 추가 — 기존 판넬·PIN 은 그대로 둡니다.
-- ============================================================================
--  이미 `supabase_setup.sql` 을 실행해 2~5번 판넬 저장을 쓰고 있는 DB 에서,
--  사진 판넬(2~5번에 사진 올리기)만 더 켜고 싶을 때 이 파일만 실행하면 됩니다.
--
--  · 기존 gallery_panels 의 행(영상 판넬)은 건드리지 않습니다.
--  · gallery_config 의 관리자 PIN 해시도 건드리지 않습니다.
--  · 다시 실행해도 안전합니다(if not exists / drop … if exists / create or replace).
--
--  실행 : Supabase 대시보드 → SQL Editor → 이 파일 전체 붙여넣고 Run
-- ============================================================================

-- 1) kind 제약을 'image' 까지 넓히고 image_url 컬럼을 더한다.
alter table public.gallery_panels drop constraint if exists gallery_panels_kind_check;
alter table public.gallery_panels
  add constraint gallery_panels_kind_check check (kind in ('shorts', 'video', 'image'));
alter table public.gallery_panels add column if not exists image_url text;

-- 2) 예전 6인자 저장 함수는 지우고, 이미지 주소를 받는 7인자 함수로 바꾼다.
drop function if exists public.save_gallery_panel(text, text, int, text, text, text);

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

  if p_slot_no is null or p_slot_no < 2 or p_slot_no > 5 then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  if v_kind not in ('shorts', 'video', 'image') then
    v_kind := 'shorts';
  end if;

  if v_kind = 'image' then
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

-- 3) 실행 권한은 이전과 같이: anon 은 RPC 로만 부를 수 있다.
revoke all on function public.save_gallery_panel(text, text, int, text, text, text, text) from public;
grant execute on function public.save_gallery_panel(text, text, int, text, text, text, text)
  to anon, authenticated;

-- 4) 확인
--    select kind, count(*) from public.gallery_panels group by kind;   -- 기존 영상 판넬 그대로
--    select column_name from information_schema.columns
--      where table_name = 'gallery_panels' and column_name = 'image_url';  -- image_url 이 보이면 완료

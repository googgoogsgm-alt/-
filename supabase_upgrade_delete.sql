-- ============================================================================
--  재롱둥이 머니 쇼츠 · 3D 전시관 — [최소 업그레이드] 판넬 삭제(빈 슬롯) 지원
-- ============================================================================
--  무엇을 고치나
--   지금 DB 의 clear_gallery_panel 은 행을 DELETE 한다. 그래서 #2~#5 판넬을
--   '삭제'해도 새로고침하면 exhibits.json 에 들어 있던 기본 쇼츠가 다시 나타난다.
--   → 지운 칸을 kind='empty' 행으로 남겨(UPSERT) 새로고침·다른 기기에서도 빈 슬롯으로 보이게 한다.
--
--  이 파일이 하는 일 (기존 판넬·PIN 은 그대로 둡니다)
--   1) gallery_panels 의 kind 제약에 'empty' 를 더한다  → ('shorts','video','image','empty')
--   2) clear_gallery_panel(pin_input, p_ticker_id, p_slot_no) 를
--      DELETE 대신 (ticker_id, slot_no, video_id=null, title='', kind='empty', image_url=null, updated_at=now())
--      UPSERT 로 바꾼다. 반환: {"ok": true, "ticker_id": …, "slot_no": …, "kind": "empty", "video_id": null}
--   3) 함수 실행 권한(anon) 을 다시 준다.
--
--  안전한 이유
--   · 다시 실행해도 안전합니다(create or replace / drop constraint if exists).
--   · 사진(image_url) 컬럼이 아직 없는 DB(예전 supabase_setup.sql 만 실행한 DB)에서도
--     오류 없이 돌도록, 컬럼 유무를 확인해 두 가지 함수 본문 중 하나를 만듭니다.
--   · 기존 2~5번 판넬 행은 전혀 건드리지 않습니다(삭제·변경 없음).
--
--  실행 방법
--   Supabase 대시보드 → SQL Editor → 아래 전체를 붙여 실행 (New query → Run)
--
--  실행 뒤 확인
--   select public.clear_gallery_panel('본인PIN', 'gold', 5);   -- {"ok": true, …, "kind": "empty"}
--   select ticker_id, slot_no, kind from public.gallery_panels order by ticker_id, slot_no;
--   → 지운 칸이 kind = 'empty' 로 보이면 완료. (지우지 않았다면 행이 그대로입니다)
--   ※ 위 확인용 select 는 실제로 gold #5 를 비웁니다. 확인만 하려면 실행하지 마세요.
--
--  이미지(사진) 판넬까지 함께 쓰려면 supabase_upgrade_image.sql 도 실행하세요.
-- ============================================================================

-- ── 1. kind 제약에 'empty' 추가 ─────────────────────────────────────────────
alter table public.gallery_panels drop constraint if exists gallery_panels_kind_check;
alter table public.gallery_panels
  add constraint gallery_panels_kind_check
  check (kind in ('shorts', 'video', 'image', 'empty'));

-- ── 2. clear_gallery_panel → 삭제 대신 kind='empty' UPSERT ──────────────────
--    image_url 컬럼이 있는 DB 와 없는 DB 모두에서 안전하게 만들기 위해
--    컬럼 유무를 확인한 뒤 알맞은 본문으로 함수를 만든다.
do $upd$
declare
  has_image_col boolean;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'gallery_panels'
       and column_name  = 'image_url'
  ) into has_image_col;

  if has_image_col then
    -- 사진 판넬까지 쓰는 DB (supabase_upgrade_image.sql 또는 새 supabase_setup.sql 실행 후)
    execute $fn$
      create or replace function public.clear_gallery_panel(
        pin_input   text,
        p_ticker_id text,
        p_slot_no   int
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = public, extensions
      as $body$
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
      $body$;
    $fn$;
  else
    -- 사진 컬럼이 아직 없는 DB — image_url 을 건드리지 않는 본문으로 만든다.
    execute $fn$
      create or replace function public.clear_gallery_panel(
        pin_input   text,
        p_ticker_id text,
        p_slot_no   int
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = public, extensions
      as $body$
      begin
        if not public.gallery_pin_ok(pin_input) then
          return jsonb_build_object('ok', false, 'error', 'pin');
        end if;
        if p_slot_no is null or p_slot_no < 2 or p_slot_no > 5 then
          return jsonb_build_object('ok', false, 'error', 'slot');
        end if;

        insert into public.gallery_panels
          (ticker_id, slot_no, video_id, title, kind, updated_at)
        values
          (p_ticker_id, p_slot_no, null, '', 'empty', now())
        on conflict (ticker_id, slot_no) do update
          set video_id   = null,
              title      = '',
              kind       = 'empty',
              updated_at = now();

        return jsonb_build_object('ok', true, 'ticker_id', p_ticker_id, 'slot_no', p_slot_no,
                                  'kind', 'empty', 'video_id', null);
      end;
      $body$;
    $fn$;
  end if;
end
$upd$;

-- ── 3. 실행 권한 (브라우저 anon 키가 이 RPC 를 부를 수 있게) ─────────────────
revoke all on function public.clear_gallery_panel(text, text, int) from public;
grant execute on function public.clear_gallery_panel(text, text, int) to anon, authenticated;

-- ── 4. Realtime — 이미 켜져 있으면 그대로, 아니면 켠다 ──────────────────────
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

-- ============================================================================
--  확인용 (선택)
--   1) 함수가 바뀌었는지:  select prosrc from pg_proc where proname = 'clear_gallery_panel';
--      → 본문에 "kind' = 'empty'" (또는 kind = 'empty') 가 보이고 delete from 이 없으면 완료.
--   2) 지운 칸 표식:       select ticker_id, slot_no, kind from public.gallery_panels
--                          where kind = 'empty';
--   3) 웹에서: #2~#5 판넬을 열고 🗑️ 이 판넬 삭제 → 새로고침해도 그 칸이 '대기 슬롯'으로 남으면 완료.
-- ============================================================================

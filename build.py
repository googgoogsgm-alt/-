#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""index.template.html + exhibits.json (+ catalog.json, news.json) + three.min.js → index.html 빌드.

index.html 은 three.js 와 기본 전시 데이터를 품고 있어서,
파일 하나만 있어도(오프라인·file://) 전시관이 열립니다.

전시 데이터 세 가지
  · exhibits.json = 부스·종목·판넬에 걸린 쇼츠(1번 판넬은 자동 최신, 2~5번은 기본값)
  · catalog.json  = 노래를 뺀 채널 전체 아카이브 — 편집 화면의 '전체 영상' 목록.
                    없으면 내장하지 않고 전시관 데이터만으로 동작합니다.
  · news.json     = 📺 뉴스 TV(국제상품 주요 뉴스) 화면에 아래→위로 흐르는 뉴스 목록.
                    없으면 화면은 '뉴스 준비 중' 상태로 남습니다.
서버로 열면 세 파일을 항상 먼저 읽으므로, 파일을 갱신하면 새로고침만으로 반영됩니다.

    python3 build.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "src", "index.template.html")
THREE = os.path.join(HERE, "vendor", "three.min.js")
DATA = os.path.join(HERE, "exhibits.json")
CATALOG = os.path.join(HERE, "catalog.json")
NEWS = os.path.join(HERE, "news.json")
BRIEF = os.path.join(HERE, "secretary_brief.json")
OUT = os.path.join(HERE, "index.html")


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _embed(obj) -> str:
    """html 안에 넣을 수 있게 </ 를 이스케이프한 JSON 문자열."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def main():
    with open(TPL, encoding="utf-8") as f:
        tpl = f.read()
    with open(THREE, encoding="utf-8") as f:
        three = f.read()
    data = _load_json(DATA)

    if "</script" in three.lower():
        raise SystemExit("three.min.js 안에 </script> 문자열이 있어 그대로 넣을 수 없습니다.")

    catalog = None
    if os.path.exists(CATALOG):
        try:
            catalog = _load_json(CATALOG)
            if not catalog.get("videos"):
                catalog = None
        except ValueError as e:
            raise SystemExit(f"catalog.json 을 읽지 못했습니다: {e}")

    news = None
    if os.path.exists(NEWS):
        try:
            news = _load_json(NEWS)
            if not news.get("items"):
                news = None
        except ValueError as e:
            raise SystemExit(f"news.json 을 읽지 못했습니다: {e}")

    brief = None
    if os.path.exists(BRIEF):
        try:
            brief = _load_json(BRIEF)
            if not brief.get("symbols"):
                brief = None
        except ValueError as e:
            raise SystemExit(f"secretary_brief.json 을 읽지 못했습니다: {e}")

    html = (tpl
            .replace("/*__THREE_JS__*/", three)
            .replace("/*__EXHIBITS_JSON__*/", _embed(data))
            .replace("/*__CATALOG_JSON__*/", _embed(catalog) if catalog else "null")
            .replace("/*__NEWS_JSON__*/", _embed(news) if news else "null")
            .replace("/*__SECRETARY_BRIEF_JSON__*/", _embed(brief) if brief else "null"))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    kb = os.path.getsize(OUT) / 1024
    n_t = len(data.get("tickers", []))
    n_v = sum(len([v for v in t.get("videos", []) if v]) for t in data.get("tickers", []))
    auto = sum(1 for t in data.get("tickers", []) if t.get("auto_slot"))
    line = f"index.html 빌드 완료 · {kb:.0f}KB · 종목 {n_t}개 / 영상 {n_v}편 내장"
    if auto:
        line += f" · 1번 판넬 자동 {auto}종목"
    print(line)
    if catalog:
        print(f"  catalog.json 내장 · 영상 {len(catalog.get('videos', []))}편 "
              f"(노래 {catalog.get('meta', {}).get('excluded_songs', 0)}편 제외)")
    else:
        print("  catalog.json 없음 · 편집 화면은 전시관 데이터만으로 동작합니다"
              "(python3 update_shorts.py --catalog 로 만들 수 있습니다)")
    if news:
        print(f"  news.json 내장 · 📺 뉴스 TV {len(news.get('items', []))}건 "
              f"(기준 {news.get('meta', {}).get('updated', '')})")
    else:
        print("  news.json 없음 · 뉴스 TV 는 '뉴스 준비 중' 상태로 남습니다")
    if brief:
        print(f"  secretary_brief.json 내장 · 🩷 희망이 비서 종목 {len(brief.get('symbols', []))}개 "
              f"(변곡 {brief.get('meta', {}).get('inflection_at', '')})")
    else:
        print("  secretary_brief.json 없음 · 희망이는 뉴스·종목 데이터로만 답합니다"
              "(python3 export_brief.py 로 만들 수 있습니다)")


if __name__ == "__main__":
    main()

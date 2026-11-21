#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""채널의 새 쇼츠를 읽어 exhibits.json 을 갱신하는 유틸리티.

- 유튜브 채널 RSS(최신 15편)와 채널 '쇼츠' 탭(전체 목록)을 읽어 영상 ID·제목·날짜를 모읍니다.
- 노래 영상(블랙리스트)은 버리고, 종목 키워드(화이트리스트)에 맞는 영상만 종목 판넬에 넣습니다.
- 이미 있는 영상은 건너뛰고 새 영상만 앞쪽에 추가합니다. (중복 없음)

사용 예:
    python3 update_shorts.py                # 실제 갱신 (exhibits.json 백업 후 저장)
    python3 update_shorts.py --dry-run      # 무엇이 바뀔지만 확인
    python3 update_shorts.py --slot1-auto   # 1번 판넬만 각 종목 최신 쇼츠로 자동 갱신 + catalog.json
    python3 update_shorts.py --catalog      # 채널 전체 아카이브 catalog.json 만 다시 만들기
    python3 update_shorts.py --from-cache   # 네트워크 없이 .cache/ 아카이브로 점검
    python3 update_shorts.py --from-file feed.xml   # 저장해 둔 RSS 파일로 오프라인 테스트
    python3 update_shorts.py --self-test    # 내장 샘플로 필터 로직 자체 점검

2단계 구조
  · 1번 판넬(index 0) = 각 종목의 가장 최신 쇼츠가 자동으로 걸린다(--slot1-auto).
  · 2~5번 판넬(index 1..4) = 사용자가 전시관 안에서 직접 고른 영상. 이 모드는 그 칸을
    건드리지 않는다. 최신 영상이 이미 2~5번에 들어 있으면 1번과 자리만 맞바꾼다(영상 유실 없음).
  · catalog.json = 노래를 뺀 채널 전체 아카이브(편집 화면의 '전체 영상' 목록).

표준 라이브러리만 사용합니다(별도 설치 없음).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

MAX_PER_TICKER = 5           # 종목당 전시 판넬 수
HERE = os.path.dirname(os.path.abspath(__file__))
EXHIBITS = os.path.join(HERE, "exhibits.json")
CATALOG = os.path.join(HERE, "catalog.json")
CACHE_ALL_SHORTS = os.path.join(HERE, ".cache", "all_shorts.json")
CACHE_PLAYLISTS = os.path.join(HERE, ".cache", "playlists_scan.json")
CHANNEL_ID = "UCyicBXHBc9G3BFqokbRVUGA"
CHANNEL_HANDLE = "@재롱둥이-r4y"
CHANNEL_SHORTS_URL = "https://www.youtube.com/@%EC%9E%AC%EB%A1%B1%EB%91%A5%EC%9D%B4-r4y/shorts"
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=" + CHANNEL_ID
UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# ── 노래(전시 제외) 블랙리스트 ────────────────────────────────────────────────
SONG_KEYWORDS = [
    "마지막잎새", "하얀나비", "별이빛나는밤에", "0시에이별", "돌지않는풍차",
    "그사람이름은잊었지만", "비내리는 고모령", "비내리는고모령", "갈대의 순정",
    "꽃바람여인", "비내리는명동거리", "내사랑울보", "가을편지", "사람나고 돈났지",
    "사람나고돈났지", "아득히먼곳", "가을을남기고간사랑", "내마음 갈곳을 잃어",
    "내마음갈곳을잃어", "독도방송국", "전속가수",
    # 채널 아카이브(catalog) 점검에서 확인된 노래 제목들(정확히 이 제목이면 노래)
    "고맙소", "대전부르스", "이름모를소녀", "거리에서", "달맞이꽃", "파란낙엽",
    "너무아픈사랑은사랑이아니었음을", "추억만들기", "가을우체국앞에서", "사나이부르스",
    "구월이오는소리", "애모의노래", "영등포에밤", "낙엽따라가버린사랑", "나를두고가려무나",
]
# 제목이 정확히 이 단어 하나뿐이면 노래로 본다(예: "정", "안녕", "사랑아")
SONG_EXACT = ["정", "안녕", "사랑아", "동백아가씨", "목포의 눈물", "당신", "타인", "내일"]

# ── 종목별 키워드 화이트리스트 (앞쪽이 우선) ─────────────────────────────────
TICKER_KEYWORDS = {
    "gold": ["골드", "금값", "금 선물"],
    "copper": ["구리"],
    "oil": ["오일", "WTI", "유가", "원유"],
    "gas": ["천연가스"],
    "eur": ["유로화", "유로"],
    "chf": ["스위스프랑", "스위스 프랑"],
    "cad": ["캐나다달러", "캐나다 달러"],
    "aud": ["호주달러", "호주 달러", "호주달라"],
    "jpy": ["엔화", "엔 선물", "엔선물", "JPY", "6J"],
    "gbp": ["영국 파운드", "영국파운드", "파운드", "GBP", "6B"],
    "nzd": ["뉴질랜드달러", "뉴질랜드 달러", "뉴질랜드", "NZD", "6N"],
    "es": ["S&P500", "S&P 500", "에스앤피500", "스탠다드앤푸어스"],
    "hsi": ["항생지수", "항셍지수", "항셍"],
    "nq": ["나스닥", "NASDAQ", "NQ 선물"],
    "ym": ["다우존스", "다우", "DOW"],
    "rty": ["러셀2000", "러셀"],
    "zn": ["미국채10년물", "미국채 10년물", "미국채", "10년물", "국채선물"],
    "zb": ["미국채 30년물", "미국채30년물", "30년물", "ZB"],
    "zf": ["미국채 5년물", "미국채5년물", "5년물", "ZF"],
    "zt": ["미국채 2년물", "미국채2년물", "2년물", "ZT"],
    "silver": ["은 선물", "실버", "SI"],
    "platinum": ["백금", "플래티넘"],
    "bz": ["브렌트"],
    "rb": ["가솔린", "RBOB"],
    "ho": ["난방유", "히팅오일"],
    "cattle": ["생우", "육우"],
    "soyoil": ["대두유", "콩기름"],
    "sugar": ["원당", "설탕"],
    "wheat": ["밀", "소맥"],
    "soy": ["대두", "콩"],
    "corn": ["옥수수"],
    "hogs": ["돈육", "돼지고기"],
    "recruit": ["인턴", "모집"],
    "dokdo": ["독도국제무역", "독도버스", "독도"],
}
# 키워드가 없어도 이런 낱말이 들어 있으면 '거래 관련 영상'으로 보고 미분류로 알린다
TRADE_HINTS = ["전망", "매매", "손익", "수익", "진입", "손절", "차트", "시세", "선물", "환율"]


def kst_now() -> str:
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")


def fetch(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def parse_rss(xml_text: str) -> list[dict]:
    ns = {"a": "http://www.w3.org/2005/Atom",
          "yt": "http://www.youtube.com/xml/schemas/2015"}
    root = ET.fromstring(xml_text)
    out = []
    for e in root.findall("a:entry", ns):
        vid = e.findtext("yt:videoId", default="", namespaces=ns)
        title = e.findtext("a:title", default="", namespaces=ns)
        published = e.findtext("a:published", default="", namespaces=ns)
        if vid:
            out.append({"id": vid, "title": title.strip(), "date": published[:10]})
    return out


def parse_shorts_page(html: str) -> list[dict]:
    """채널 쇼츠 탭 HTML(ytInitialData)에서 (ID, 제목) 목록을 뽑는다."""
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return []
    data = json.loads(m.group(1))
    items: list[dict] = []

    def walk(node):
        if isinstance(node, dict):
            if "shortsLockupViewModel" in node:
                it = node["shortsLockupViewModel"]
                vid = it.get("entityId", "").replace("shorts-shelf-item-", "")
                acc = it.get("accessibilityText", "") or ""
                title = re.split(r",\s*조회수", acc)[0].strip()
                if vid:
                    items.append({"id": vid, "title": title, "date": ""})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return items


def classify(title: str) -> tuple[str | None, str]:
    """제목 → (종목 id | None, 사유)."""
    t = title.strip()
    compact = t.replace(" ", "")
    if not t:
        return None, "제목 없음"
    for song in SONG_KEYWORDS:
        if song.replace(" ", "") in compact:
            return None, f"노래(블랙리스트: {song})"
    if t in SONG_EXACT:
        return None, "노래(제목 일치)"
    # 채용 공고는 안내데스크의 '인턴사원 모집' 판넬로 먼저 보낸다
    for w in TICKER_KEYWORDS["recruit"]:
        if w.replace(" ", "") in compact:
            return "recruit", "채용 키워드 일치"
    # 그 밖에는 키워드가 가장 길게 일치하는 종목을 고른다 (예: '스위스프랑' > '프랑')
    best: tuple[int, str] | None = None
    for ticker, words in TICKER_KEYWORDS.items():
        for w in words:
            if w.replace(" ", "") in compact:
                if best is None or len(w) > best[0]:
                    best = (len(w), ticker)
    if best:
        return best[1], "종목 키워드 일치"
    if any(h in t for h in TRADE_HINTS):
        return None, "거래 관련으로 보이나 종목 미분류"
    return None, "관련 없음"


def parse_continuations(html: str) -> list[str]:
    """쇼츠 탭 HTML 에서 다음 페이지 토큰을 뽑는다."""
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return []
    data = json.loads(m.group(1))
    tokens: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if "continuationCommand" in node:
                tok = node["continuationCommand"].get("token")
                if tok and tok not in tokens:
                    tokens.append(tok)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return tokens


def fetch_more_shorts(html: str, max_pages: int = 30, verbose: bool = True) -> list[dict]:
    """이너튜브 browse API 로 쇼츠 탭의 다음 페이지들을 이어서 읽는다."""
    key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    cver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
    if not key or not cver:
        return []
    url = "https://www.youtube.com/youtubei/v1/browse?key=" + key.group(1) + "&prettyPrint=false"
    ctx = {"client": {"clientName": "WEB", "clientVersion": cver.group(1), "hl": "ko", "gl": "KR"}}
    queue = parse_continuations(html)
    seen, out, pages, dead = set(), [], 0, 0
    while queue and pages < max_pages and dead < 6:
        tok = queue.pop(0)
        if tok in seen:
            continue
        seen.add(tok)
        body = json.dumps({"context": ctx, "continuation": tok}).encode()
        req = urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json", "User-Agent": UA["User-Agent"]})
        try:
            resp = json.loads(urllib.request.urlopen(req, timeout=40).read().decode())
        except Exception as e:
            if verbose:
                print(f"! 다음 페이지 실패: {e.__class__.__name__}")
            dead += 1
            continue
        before = len(out)
        out.extend(parse_shorts_data(resp))
        for t in parse_continuations_raw(resp):
            if t not in seen and t not in queue:
                queue.append(t)
        pages += 1
        if len(out) == before:
            dead += 1
    if verbose:
        print(f"· 추가 페이지 {pages}장에서 {len(out)}편 수집")
    return out


def parse_shorts_data(data) -> list[dict]:
    items: list[dict] = []

    def walk(node):
        if isinstance(node, dict):
            if "shortsLockupViewModel" in node:
                it = node["shortsLockupViewModel"]
                vid = it.get("entityId", "").replace("shorts-shelf-item-", "")
                acc = it.get("accessibilityText", "") or ""
                title = re.split(r",\s*조회수", acc)[0].strip()
                if vid:
                    items.append({"id": vid, "title": title, "date": ""})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return items


def parse_continuations_raw(data) -> list[str]:
    tokens: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if "continuationCommand" in node:
                tok = node["continuationCommand"].get("token")
                if tok:
                    tokens.append(tok)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return tokens


def collect_live(deep: bool = False, verbose: bool = True) -> list[dict]:
    videos: dict[str, dict] = {}
    try:
        for v in parse_rss(fetch(RSS_URL)):
            videos.setdefault(v["id"], v)
        if verbose:
            print(f"· RSS {len(videos)}편 확인")
    except Exception as e:  # 네트워크 실패는 치명적이지 않다
        print(f"! RSS를 읽지 못했습니다: {e.__class__.__name__}: {e}")
    try:
        html = fetch(CHANNEL_SHORTS_URL)
        for v in parse_shorts_page(html):
            cur = videos.get(v["id"])
            if cur:
                if not cur.get("title"):
                    cur["title"] = v["title"]
            else:
                videos[v["id"]] = v
        if verbose:
            print(f"· 쇼츠 탭 포함 총 {len(videos)}편 확인")
        if deep:
            for v in fetch_more_shorts(html, verbose=verbose):
                if v["id"] not in videos:
                    videos[v["id"]] = v
            if verbose:
                print(f"· 심층 수집 총 {len(videos)}편 확인")
    except Exception as e:
        print(f"! 쇼츠 탭을 읽지 못했습니다: {e.__class__.__name__}: {e}")
    return list(videos.values())


def load_exhibits(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def apply_updates(data: dict, found: list[dict], dry_run: bool = False,
                  limit: int = MAX_PER_TICKER) -> dict:
    tickers = {t["id"]: t for t in data["tickers"]}
    added: list[tuple[str, str, str]] = []
    skipped: list[tuple[str, str]] = []
    unsorted: list[tuple[str, str]] = []

    for v in found:
        ticker, reason = classify(v["title"])
        if not ticker:
            if reason.startswith("거래 관련"):
                unsorted.append((v["id"], v["title"]))
            else:
                skipped.append((v["id"], f"{v['title']} ({reason})"))
            continue
        t = tickers.get(ticker)
        if not t:
            unsorted.append((v["id"], v["title"]))
            continue
        if any(x and x.get("id") == v["id"] for x in t["videos"]):
            continue
        kind = v.get("kind", "shorts")
        t["videos"].insert(0, {"id": v["id"], "title": v["title"], "kind": kind,
                               "date": v.get("date", "")})
        if len(t["videos"]) > limit:          # 종목당 판넬 수를 넘으면 오래된 것부터 정리
            del t["videos"][limit:]
        added.append((ticker, v["id"], v["title"]))

    result = {"added": added, "skipped": skipped, "unsorted": unsorted}
    if added and not dry_run:
        data["meta"]["updated"] = kst_now()
        data["meta"]["last_sync"] = datetime.now(timezone(timedelta(hours=9))).strftime(
            "%Y-%m-%d %H:%M KST")
    return result


def save(data: dict, path: str = EXHIBITS) -> None:
    if os.path.exists(path):
        shutil.copyfile(path, path + ".bak")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ── 1번 판넬 자동(종목별 최신) + 전체 아카이브 catalog.json ───────────────────

def recency(v: dict, rank: int) -> tuple:
    """최신 순서 비교값. 날짜가 있으면 날짜, 없으면 수집 순서(rank가 작을수록 최신)."""
    d = str(v.get("date") or "")
    return (1 if d else 0, d, -rank)


def latest_per_ticker(found: list[dict]) -> dict:
    """종목별 가장 최근 영상 1편(노래·미분류 제외)."""
    latest: dict[str, tuple[int, dict]] = {}
    for rank, v in enumerate(found):
        ticker, _reason = classify(v.get("title", ""))
        if not ticker:
            continue
        cur = latest.get(ticker)
        if cur is None or recency(v, rank) > recency(cur[1], cur[0]):
            latest[ticker] = (rank, v)
    return {k: v for k, (_r, v) in latest.items()}


def update_slot1(data: dict, latest_map: dict, dry_run: bool = False) -> dict:
    """각 종목 1번 판넬(index 0)만 최신 영상으로 바꾼다. 2~5번(index 1..4)은 보존.

    최신 영상이 이미 2~5번에 들어 있으면 1번과 자리를 맞바꾼다(영상 유실 없음).
    """
    byid = {t["id"]: t for t in data.get("tickers", [])}
    changed, same, unknown = [], [], []
    touched = []
    stamp = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M KST")

    for tid, v in latest_map.items():
        t = byid.get(tid)
        if t is None:
            unknown.append((tid, v.get("id", "")))
            continue
        vids = t.setdefault("videos", [])
        entry = {"id": v["id"], "title": v.get("title", ""),
                 "kind": v.get("kind", "shorts"), "date": v.get("date", "")}
        cur = vids[0] if vids else None
        if cur and cur.get("id") == v["id"]:
            if t.get("auto_slot", {}).get("id") != v["id"]:
                touched.append(tid)
            t["auto_slot"] = {"id": v["id"], "title": v.get("title", ""),
                              "updated": v.get("date") or kst_now(), "mode": "auto"}
            same.append((tid, v["id"], v.get("title", "")))
            continue

        dup = None
        for i in range(1, len(vids)):
            if vids[i] and vids[i].get("id") == v["id"]:
                dup = i
                break
        if dup is not None:                      # 2~5번에 있던 영상 → 자리 맞바꿈
            vids[0] = entry
            vids[dup] = cur
            how = f"{dup + 1}번 칸과 자리 맞바꿈"
        else:
            if vids:
                vids[0] = entry
            else:
                vids.append(entry)
            how = "1번 칸 교체"
        t["auto_slot"] = {"id": v["id"], "title": v.get("title", ""),
                          "updated": v.get("date") or kst_now(), "mode": "auto",
                          "previous": (cur or {}).get("id")}
        touched.append(tid)
        changed.append((tid, v["id"], v.get("title", ""), how))

    if touched and not dry_run:
        data.setdefault("meta", {})["updated"] = kst_now()
        data["meta"]["last_slot1_sync"] = stamp
        data["meta"]["slot1_auto"] = True
    return {"changed": changed, "same": same, "unknown": unknown, "touched": touched}


def cache_videos() -> list[dict]:
    """로컬 .cache/ 아카이브(쇼츠 전체 + 재생목록)에서 영상 목록을 모은다(네트워크 없이)."""
    out: list[dict] = []
    try:
        with open(CACHE_ALL_SHORTS, encoding="utf-8") as f:
            for v in json.load(f):
                if v.get("id"):
                    out.append({"id": v["id"], "title": v.get("title", ""),
                                "date": v.get("date", ""), "kind": v.get("kind", "shorts")})
    except Exception:
        pass
    try:
        with open(CACHE_PLAYLISTS, encoding="utf-8") as f:
            for name, arr in json.load(f).items():
                for v in arr:
                    if v.get("id"):
                        out.append({"id": v["id"], "title": v.get("title", ""),
                                    "date": v.get("date", ""), "kind": "video",
                                    "playlist": name})
    except Exception:
        pass
    return out


def build_catalog(data: dict, found: list[dict], extra: list[dict] | None = None,
                  source: str = "live") -> dict:
    """노래를 뺀 채널 전체 아카이브 — 편집 화면의 '전체 영상' 목록.

    각 항목: id, title, date, kind, matched_ticker (제목으로 종목을 못 정하면 null).
    """
    seen: dict[str, dict] = {}
    rank = 0
    excluded = 0

    def add(v: dict, default_kind: str = "shorts") -> None:
        nonlocal rank, excluded
        vid = (v.get("id") or "").strip()
        if not vid:
            return
        title = (v.get("title") or "").strip()
        if vid in seen:
            cur = seen[vid]
            if not cur["title"] and title:
                cur["title"] = title
            if not cur["date"] and v.get("date"):
                cur["date"] = v["date"]
            return
        ticker, reason = classify(title)
        if reason.startswith("노래"):
            excluded += 1
            return
        seen[vid] = {"id": vid, "title": title, "date": v.get("date") or "",
                     "kind": v.get("kind") or default_kind, "matched_ticker": ticker,
                     "_rank": rank}
        rank += 1

    for v in found:
        add(v)
    for v in (extra or []):
        add(v, v.get("kind") or "shorts")

    videos = sorted(seen.values(), key=lambda e: (1 if e["date"] else 0, e["date"], -e["_rank"]),
                    reverse=True)
    for e in videos:
        e.pop("_rank", None)
    meta = (data or {}).get("meta", {})
    return {
        "meta": {
            "title": "재롱둥이 머니 쇼츠 · 전체 영화 아카이브",
            "channel": meta.get("channel", {"handle": CHANNEL_HANDLE}),
            "generated": json_time(),
            "source": source,
            "total": len(videos),
            "excluded_songs": excluded,
            "note": "노래 쇼츠는 빼고 모았습니다. 편집 화면의 '전체 영상' 목록으로 쓰입니다.",
        },
        "videos": videos,
    }


def json_time() -> str:
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M KST")


def save_catalog(catalog: dict, path: str = CATALOG) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def report_catalog(catalog: dict) -> None:
    per: dict[str, int] = {}
    for v in catalog["videos"]:
        key = v.get("matched_ticker") or "미분류"
        per[key] = per.get(key, 0) + 1
    top = sorted(per.items(), key=lambda kv: -kv[1])[:8]
    print(f"  catalog.json · 영상 {len(catalog['videos'])}편 (노래 {catalog['meta']['excluded_songs']}편 제외)")
    print("  종목별:", ", ".join(f"{k} {n}" for k, n in top))


def report(data: dict) -> None:
    total = 0
    for t in data["tickers"]:
        total += len([v for v in t["videos"] if v])
        kinds = {}
        for v in t["videos"]:
            if not v:            # 2~5번 판넬에서 사용자가 비운 칸
                continue
            kinds[v.get("kind", "shorts")] = kinds.get(v.get("kind", "shorts"), 0) + 1
        detail = ", ".join(f"{k} {n}" for k, n in kinds.items())
        print(f"  · {t['zone']:6s} {t['name']:14s} {len([v for v in t['videos'] if v]):2d}편 ({detail})")
    print(f"  합계 {len(data['tickers'])}개 종목 / {total}편")


SELF_TEST_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>재롱둥이 머니 쇼츠</title>
  <entry><yt:videoId>testGOLD1</yt:videoId><title>골드 오늘의 전망</title><published>2026-11-18T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testSONG1</yt:videoId><title>하얀나비</title><published>2026-11-17T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testSONG2</yt:videoId><title>정</title><published>2026-11-17T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testCAD1</yt:videoId><title>캐나다달러 오늘에 전망</title><published>2026-11-16T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testDOKDO1</yt:videoId><title>독도버스내 독도국제무역.com 인턴 모집</title><published>2026-11-15T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testETC1</yt:videoId><title>오늘 날씨 정리</title><published>2026-11-14T01:00:00+00:00</published></entry>
  <entry><yt:videoId>testCOPPER1</yt:videoId><title>구리 차트 점검</title><published>2026-11-13T01:00:00+00:00</published></entry>
</feed>
"""


def self_test() -> int:
    print("[self-test] 내장 샘플 피드로 필터 로직 점검")
    found = parse_rss(SELF_TEST_FEED)
    cases = {
        "testGOLD1": "gold",
        "testSONG1": None,
        "testSONG2": None,
        "testCAD1": "cad",
        "testDOKDO1": "recruit",
        "testETC1": None,
        "testCOPPER1": "copper",
    }
    ok = True
    for v in found:
        got, reason = classify(v["title"])
        want = cases[v["id"]]
        mark = "OK " if got == want else "FAIL"
        if got != want:
            ok = False
        print(f"  {mark} {v['title']} → {got} / {want}  ({reason})")
    data = load_exhibits(EXHIBITS)
    res = apply_updates(data, found, dry_run=True)
    print(f"  [dry-run] 추가 예정 {len(res['added'])}편, 노래 제외 {len(res['skipped'])}편, "
          f"미분류 {len(res['unsorted'])}편")
    for row in res["added"]:
        print("    +", row)

    # ── 1번 판넬 자동 로직 점검(메모리 사본에서만) ──
    print("[self-test] 1번 판넬 자동(최신) + 2~5번 보존 점검")
    sample = {
        "meta": {},
        "tickers": [
            {"id": "gold", "videos": [
                {"id": "oldA", "title": "골드 예전", "kind": "shorts"},
                {"id": "u1", "title": "골드 내가 고른 1", "kind": "shorts"},
                {"id": "newB", "title": "골드 최신(B)", "kind": "shorts"},
                {"id": "u3", "title": "골드 내가 고른 3", "kind": "shorts"},
            ]},
            {"id": "copper", "videos": [
                {"id": "cOld", "title": "구리 예전", "kind": "shorts"},
            ]},
        ],
    }
    latest = {
        "gold": {"id": "newB", "title": "골드 최신(B)", "date": "2026-11-18"},
        "copper": {"id": "cNew", "title": "구리 최신", "date": "2026-11-18"},
    }
    r = update_slot1(sample, latest, dry_run=True)
    g = sample["tickers"][0]["videos"]
    c = sample["tickers"][1]["videos"]
    checks = [
        ("1번 칸이 최신", g[0]["id"] == "newB"),
        ("2~5번 영상 유실 없음", {v["id"] for v in g[1:]} == {"u1", "oldA", "u3"}),
        ("1번과 자리 맞바꿈", "자리 맞바꿈" in r["changed"][0][3]),
        ("빈 종목도 1번 칸 생성", c[0]["id"] == "cNew" and len(c) == 1),
        ("auto_slot 표시", sample["tickers"][0].get("auto_slot", {}).get("id") == "newB"),
    ]
    for name, passed in checks:
        print(f"  {'OK ' if passed else 'FAIL'} {name}")
        ok = ok and passed

    # ── catalog.json 구성 점검 ──
    print("[self-test] catalog.json(노래 제외 · 종목 표시) 점검")
    cat = build_catalog(sample, found, extra=[{"id": "testSONG1", "title": "하얀나비"},
                                              {"id": "testGOLD1", "title": "골드 오늘의 전망"}],
                        source="self-test")
    ids = [v["id"] for v in cat["videos"]]
    cat_ok = ("testSONG1" not in ids and "testGOLD1" in ids
              and all(v["matched_ticker"] == "gold" for v in cat["videos"] if v["id"] == "testGOLD1"))
    print(f"  {'OK ' if cat_ok else 'FAIL'} 노래 제외 {cat['meta']['excluded_songs']}편 · "
          f"수록 {cat['meta']['total']}편 · 종목 표시")
    ok = ok and cat_ok

    print("[self-test]", "통과" if ok else "실패")
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="재롱둥이 머니 쇼츠 전시관 exhibits.json 갱신")
    ap.add_argument("--dry-run", action="store_true", help="저장 없이 변경 예정만 출력")
    ap.add_argument("--from-file", metavar="XML", help="저장해 둔 RSS XML 파일로 실행(오프라인)")
    ap.add_argument("--report", action="store_true", help="현재 전시 현황만 출력")
    ap.add_argument("--self-test", action="store_true", help="내장 샘플로 필터 로직 점검")
    ap.add_argument("--deep", action="store_true", help="쇼츠 탭을 끝까지 넘겨 전체 아카이브 수집")
    ap.add_argument("--limit", type=int, default=MAX_PER_TICKER, help="종목당 최대 영상 수(기본 5)")
    ap.add_argument("--slot1-auto", action="store_true",
                    help="1번 판넬만 종목별 최신으로 자동 갱신(2~5번 보존) + catalog.json")
    ap.add_argument("--catalog", action="store_true", help="catalog.json(전체 아카이브)만 다시 만들기")
    ap.add_argument("--from-cache", action="store_true",
                    help="네트워크 없이 .cache/ 아카이브로 점검(자동 최신화 로직 확인용)")
    args = ap.parse_args(argv)

    if not os.path.exists(EXHIBITS):
        print(f"exhibits.json 이 없습니다: {EXHIBITS}")
        return 2
    if args.self_test:
        return self_test()

    data = load_exhibits(EXHIBITS)
    if args.report:
        print("현재 전시 현황")
        report(data)
        return 0

    if args.from_cache:
        found = cache_videos()
        source = "cache"
        print(f"· 로컬 .cache/ 아카이브 {len(found)}편 확인")
    elif args.from_file:
        with open(args.from_file, encoding="utf-8") as f:
            found = parse_rss(f.read())
        source = "file"
        print(f"· 파일에서 {len(found)}편 확인")
    else:
        deep = args.deep or args.slot1_auto or args.catalog
        found = collect_live(deep=deep)
        source = "live"

    # ── 1번 판넬 자동 최신화 ──
    if args.slot1_auto:
        latest = latest_per_ticker(found)
        res = update_slot1(data, latest, dry_run=args.dry_run)
        print(f"1번 판넬 자동 · 최신 {len(latest)}종목 확인 / 바뀜 {len(res['changed'])} / "
              f"그대로 {len(res['same'])}")
        for tid, vid, title, how in res["changed"]:
            print(f"  ↑ [{tid}] {title}  ({vid}) · {how}")
        for tid, vid, title in res["same"]:
            print(f"  = [{tid}] {title}  ({vid})")
        for tid, vid in res["unknown"]:
            print(f"  ? [{tid}] 전시관에 없는 종목 ({vid})")
        print("  2~5번 판넬은 사용자 선택으로 보고 건드리지 않았습니다.")
        if args.dry_run:
            print("(dry-run) exhibits.json · catalog.json 은 저장하지 않았습니다.")
        else:
            if res["changed"] or res.get("touched"):
                save(data)
                print(f"exhibits.json 저장 완료 · {data['meta'].get('updated', '')} (백업: exhibits.json.bak)")
            cat = build_catalog(data, found, extra=cache_videos() if source != "cache" else [],
                                source=source)
            save_catalog(cat)
            report_catalog(cat)
            print(f"catalog.json 저장 완료 · {CATALOG}")
        return 0

    # ── catalog.json 만 다시 만들기 ──
    if args.catalog:
        cat = build_catalog(data, found, extra=cache_videos() if source != "cache" else [], source=source)
        save_catalog(cat)
        report_catalog(cat)
        print(f"catalog.json 저장 완료 · {CATALOG}")
        return 0

    res = apply_updates(data, found, dry_run=args.dry_run, limit=args.limit)
    print(f"추가 {len(res['added'])}편 / 노래·무관 제외 {len(res['skipped'])}편 / 미분류 {len(res['unsorted'])}편")
    for ticker, vid, title in res["added"]:
        print(f"  + [{ticker}] {title}  ({vid})")
    if res["unsorted"]:
        print("  ※ 종목을 정하지 못한 거래 관련 영상(직접 추가 판단):")
        for vid, title in res["unsorted"]:
            print(f"     - {title}  ({vid})")
    if res["skipped"]:
        print("  제외한 영상:")
        for vid, why in res["skipped"][:40]:
            print(f"     - {why}  ({vid})")

    if args.dry_run:
        print("(dry-run) exhibits.json 은 저장하지 않았습니다.")
    elif res["added"]:
        save(data)
        print(f"exhibits.json 저장 완료 · {data['meta']['updated']} (백업: exhibits.json.bak)")
    else:
        print("새로 추가할 영상이 없습니다.")
    print("  ※ 1번 판넬만 자동 최신으로 돌리려면 --slot1-auto 를 쓰세요(2~5번 판넬 보존).")
    print("현재 전시 현황")
    report(load_exhibits(EXHIBITS))
    return 0


if __name__ == "__main__":
    sys.exit(main())

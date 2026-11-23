#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""전시관 AI 비서 '희망이' 일일 동기화 브리프 생성기.

trading/ 폴더는 **읽기 전용**으로만 읽는다(어떤 파일도 쓰지 않는다).
  · trading/watchlist.json        — 승인 7종목 · 지표 설정 · 수평선/무효화선
  · trading/forecast_latest.json  — 현재가 · 예측 분위(P10/P50/P90) · 백테스트 적중률
  · trading/oi_history.json       — 일별 OI · 차근월물 비중(롤오버)
  · trading/inflection_filter.py --all — 변곡 점수·등급·★ 고순도·특화 필터 (실행)
        실행이 실패하면 metaverse-gallery/.cache/inflection_last.json 캐시를 쓴다.

출력: metaverse-gallery/secretary_brief.json
  · 공개 가능한 분석 방법론 + 7종목 현재 상태 + 방(zone)별 요약 + 뉴스 카드
  · 개인정보(이메일·전화번호·계좌·개인 일정)는 절대 담지 않는다.

    python3 metaverse-gallery/export_brief.py
    python3 metaverse-gallery/export_brief.py --no-run   # 변곡 실행 없이 캐시만
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TRADING = os.path.join(ROOT, "trading")
CACHE_DIR = os.path.join(HERE, ".cache")
CACHE_INFLECTION = os.path.join(CACHE_DIR, "inflection_last.json")
OUT = os.path.join(HERE, "secretary_brief.json")

WATCHLIST = os.path.join(TRADING, "watchlist.json")
FORECAST = os.path.join(TRADING, "forecast_latest.json")
OI_HISTORY = os.path.join(TRADING, "oi_history.json")
NEWS = os.path.join(HERE, "news.json")

KST = timezone(timedelta(hours=9))

ZONE_OF = {
    "GC=F": "metals",
    "6S=F": "fx",
    "6C=F": "fx",
    "ZN=F": "rates",
    "NGF27.NYM": "energy",
    "ZW=F": "ags",
    "CL=F": "energy",
}
ZONE_NAME = {
    "fx": "통화", "metals": "금속", "index": "지수",
    "rates": "금리", "energy": "에너지", "ags": "농축산물",
}
ZONE_EN = {
    "fx": "CURRENCY", "metals": "METALS", "index": "INDEX",
    "rates": "RATES", "energy": "ENERGY", "ags": "AGS",
}
ZONE_ORDER = ["fx", "metals", "index", "rates", "energy", "ags"]

METHODOLOGY = {
    "horizon": "1~6개월 스윙 (단기 시세 알림 없음)",
    "indicators": {
        "macd": "MACD 12·130·9 — 단기 12·장기 130 EMA, 9일 신호선. 0선 돌파·다이버전스를 변곡 신호로 본다",
        "cci": "CCI 90 · ±100 — 90기간으로 노이즈를 줄이고 ±100 이탈·재이탈을 추세 전환 체크포인트로 쓴다",
        "rsi": "RSI 14 — 30/70 과매수·과매도, 30 탈출을 매수 신호로 본다",
        "ma": "이동평균 20/60/120/200일선 — 배열과 이격(disp%)으로 추세 위치를 판단",
        "sweep": "일봉 20·60일 / 주봉 12·26주 스윕 — 고점·저점 털기 뒤 종가 안착 여부",
        "cot": "CFTC COT 52주 — 투기 순매수와 0~100 지수(15 미만 극단 저·85 초과 극단 고)",
        "dxy": "DXY 20일 역상관 확인 +1점 — 다이버전스가 달러 20일 추세와 엇박자일 때만 가산",
    },
    "structure": "v2.1 2단 구조 — 3.0점 이상이면 일반 변곡, 그중 조건을 모두 갖춘 ★ 고순도 변곡을 따로 표시",
    "anti_effect": "역효과 차단 — 검증에서 역효과였던 방향은 점수에서 막는다 (GC=F 매도 34.3% · ZN=F 매수 43.8%)",
    "specialized": "4종 특화 필터 — ZW/ZC(곡물), 3-2-1 크랙(정유), NG/HO(가스·난방유), 6S WILLCO(스위스프랑)",
    "guards": "야후 롤오버 거래량 가드 · OI·만기 롤오버·FND/LTD 규칙 — 만기 직전 저거래량 아티팩트를 걸러 낸다",
    "walk_forward": "Walk-Forward 적중률 55% 미만 구간은 관망 — 억지 신호를 만들지 않는다",
    "disclaimer": "정보 제공용 분석이다. 매매 권유·수익 보장이 아니며, 확인된 값만 수치로 말한다.",
}


def kst_now():
    return datetime.now(KST)


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def run_inflection(no_run=False):
    """trading/inflection_filter.py --all 실행. 실패하면 캐시를 쓴다."""
    if not no_run:
        try:
            p = subprocess.run(
                [sys.executable, os.path.join(TRADING, "inflection_filter.py"), "--all"],
                cwd=ROOT, capture_output=True, text=True, timeout=240,
            )
            if p.returncode == 0 and p.stdout.strip().startswith("{"):
                data = json.loads(p.stdout)
                try:
                    os.makedirs(CACHE_DIR, exist_ok=True)
                    with open(CACHE_INFLECTION, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                except Exception:
                    pass
                data["_source"] = "live"
                return data
            sys.stderr.write("[export_brief] inflection_filter 실패(rc=%s) — 캐시로 대체\n" % p.returncode)
        except Exception as e:
            sys.stderr.write("[export_brief] inflection_filter 실행 오류(%s) — 캐시로 대체\n" % e)
    cached = load_json(CACHE_INFLECTION)
    if cached:
        cached["_source"] = "cache"
        return cached
    return {"macro": {}, "symbols": [], "_source": "none"}


def sev(x, nd=2):
    """숫자를 보기 좋게 — 정수는 그대로, 소수는 nd 자리."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if abs(v - round(v)) < 1e-9:
        return int(round(v))
    return round(v, nd)


def short_levels(levels):
    if not isinstance(levels, dict):
        return []
    out = []
    for k, v in levels.items():
        if v is None:
            continue
        out.append({"name": str(k), "value": sev(v, 5)})
    return out


def forecast_block(fx):
    """forecast_latest.json 한 종목 → 현재가·예측·백테스트 요약."""
    if not fx:
        return None
    fc = fx.get("forecast") or {}
    bt_raw = fx.get("backtest") or {}
    bt = bt_raw.get("results") if isinstance(bt_raw.get("results"), dict) else bt_raw
    if not isinstance(bt, dict):
        bt = {}
    picks = {}
    for h in ("1주", "1개월", "3개월", "6개월"):
        if h in fc:
            d = fc[h]
            picks[h] = {
                "P10": sev(d.get("P10")), "P50": sev(d.get("P50")), "P90": sev(d.get("P90")),
                "up_pct": sev(d.get("p_up_pct"), 1),
            }
    hits = {}
    for h in ("1개월", "3개월", "6개월"):
        if h in bt and bt[h].get("direction_hit_blend_pct") is not None:
            hits[h] = {
                "dir_pct": sev(bt[h].get("direction_hit_blend_pct"), 1),
                "cover_pct": sev(bt[h].get("coverage_p10_p90_pct"), 1),
                "mape_pct": sev(bt[h].get("mape_p50_pct"), 2),
                "n": bt[h].get("n"),
            }
    ind = fx.get("inductor_snapshot") or {}
    return {
        "base_price": sev(fx.get("live_price"), 5),
        "base_time": fx.get("live_time") or "",
        "anchor_date": fx.get("anchor_bar_date") or "",
        "forecast": picks,
        "backtest": hits,
        "indicators": {
            "rsi14": sev(ind.get("rsi14"), 1),
            "cci90": sev(ind.get("cci90"), 1),
            "macd_hist": sev(ind.get("macd_hist"), 2),
            "sma20": sev(ind.get("sma20")),
            "sma60": sev(ind.get("sma60")),
        },
    }


def oi_latest(sym, oi_hist):
    """oi_history.json 의 마지막 날짜 스냅샷."""
    rows = (oi_hist or {}).get(sym) or {}
    if not isinstance(rows, dict) or not rows:
        return None
    day = sorted(rows.keys())[-1]
    r = rows[day] or {}
    return {
        "date": day,
        "total_oi": sev(r.get("total_oi")),
        "active_contract": r.get("active_contract") or "",
        "active_oi": sev(r.get("active_oi")),
        "next_contract": r.get("next_contract") or "",
        "next_oi": sev(r.get("next_oi")),
        "next_oi_share_pct": sev(r.get("next_oi_share_pct"), 1),
    }


def build_symbol(code, wl, flt, fx, oi):
    w = (wl.get("symbols") or {}).get(code) or {}
    lv = (w.get("levels") or {})
    stops = (w.get("active_stops") or {})
    out = {
        "code": code,
        "name": w.get("name") or (flt or {}).get("name") or code,
        "zone": ZONE_OF.get(code, ""),
        "active_contract": w.get("active_contract") or "",
        "next_contract": w.get("next_contract") or "",
        "kiwoom_code": w.get("kiwoom_code") or "",
        "levels": short_levels(lv),
        "stops": {k: sev(v, 5) for k, v in stops.items() if v is not None},
        "note": (w.get("notes") or "")[:220],
    }
    if flt:
        sc = flt.get("scores") or {}
        out["price"] = sev(flt.get("close"), 5)
        out["price_date"] = flt.get("last_date") or ""
        out["change_pct"] = sev(flt.get("change_pct"), 2)
        out["score"] = {
            "buy": sev(sc.get("bull_score"), 1),
            "sell": sev(sc.get("bear_score"), 1),
            "threshold": sev(sc.get("threshold"), 1),
            "grade": flt.get("grade") or "",
            "high_purity": bool(flt.get("high_purity")),
            "high_purity_sides": flt.get("high_purity_sides") or [],
        }
        ind = flt.get("macd") or {}
        cc = flt.get("cci") or {}
        out["indicators"] = {
            "macd_bias": ind.get("bias") or "",
            "macd_hist": sev(ind.get("hist"), 2),
            "cci90": sev(cc.get("value"), 1),
            "cci_zone": cc.get("zone") or "",
            "rsi14": sev((flt.get("rsi14") or {}).get("value"), 1),
        }
        oor = flt.get("open_interest") or {}
        if oor.get("available"):
            out["oi_rollover"] = {
                "as_of": str(oor.get("date_hint") or "")[:10],
                "total_oi": sev(oor.get("total_oi")),
                "total_oi_change_pct": sev(oor.get("total_oi_change_pct"), 1),
                "active_contract": oor.get("active_contract") or "",
                "active_oi": sev(oor.get("active_oi")),
                "next_contract": oor.get("next_contract") or "",
                "next_oi": sev(oor.get("next_oi")),
                "next_oi_share_pct": sev(oor.get("next_oi_share_pct"), 1),
                "regime": oor.get("price_oi_regime") or "",
            }
        cot = flt.get("cot") or {}
        if cot.get("available"):
            out["cot"] = {
                "report_date": cot.get("report_date") or "",
                "net": sev(cot.get("net")),
                "weekly_change": sev(cot.get("weekly_change")),
                "index_pct": sev(cot.get("cot_index_pct"), 1),
                "range_52w": [sev(cot.get("min_52w")), sev(cot.get("max_52w"))],
            }
        cr = flt.get("contract_and_rollover") or {}
        if cr:
            out["rollover"] = {
                "active": cr.get("active_contract") or "",
                "next": cr.get("next_contract") or "",
                "remaining_trading_days": cr.get("remaining_trading_days"),
                "spread_pct": sev(cr.get("rollover_spread_pct"), 2),
            }
        out["signals"] = [str(s) for s in (flt.get("signals") or [])][:5]
        out["risks"] = [str(s) for s in (flt.get("risk_alerts") or [])][:4]
        vs = flt.get("volatility_and_stops") or {}
        if vs.get("calc_long_invalidation") is not None:
            out["calc_stops"] = {
                "long": sev(vs.get("calc_long_invalidation"), 5),
                "short": sev(vs.get("calc_short_invalidation"), 5),
                "atr14": sev(vs.get("atr14"), 3),
                "atr_pct": sev(vs.get("atr_pct"), 2),
            }
    fb = forecast_block(fx)
    if fb:
        out["forecast"] = fb
    if oi:
        out["oi_history_latest"] = oi
    return out


def build_zone(name, symbols, news_rooms):
    items = ((news_rooms or {}).get(name) or {}).get("items") or []
    return {
        "name": ZONE_NAME[name],
        "en": ZONE_EN[name],
        "symbols": [{"code": s["code"], "name": s["name"]} for s in symbols],
        "news": [
            {
                "tag": i.get("tag") or "",
                "code": i.get("code") or "",
                "headline": i.get("headline") or "",
                "price": i.get("price") or "",
                "change": i.get("change") or "",
                "lines": (i.get("lines") or [])[:2],
            }
            for i in items[:4]
        ],
    }


def main():
    no_run = "--no-run" in sys.argv
    wl = load_json(WATCHLIST, {}) or {}
    fc_all = (load_json(FORECAST, {}) or {}).get("symbols") or {}
    oi_hist = load_json(OI_HISTORY, {}) or {}
    news = load_json(NEWS, {}) or {}
    flt = run_inflection(no_run)

    flt_by = {}
    for s in (flt.get("symbols") or []):
        flt_by[s.get("symbol")] = s

    codes = list((wl.get("symbols") or {}).keys()) or list(flt_by.keys())
    symbols = [build_symbol(c, wl, flt_by.get(c), fc_all.get(c), oi_latest(c, oi_hist)) for c in codes]
    symbols = [s for s in symbols if s]

    zones = {}
    for z in ZONE_ORDER:
        zs = [s for s in symbols if s.get("zone") == z]
        zones[z] = build_zone(z, zs, news.get("rooms") or {})

    # 예측 적중률 요약 — 종목별 1개월·6개월 방향 적중률과 커버리지
    hits = []
    for s in symbols:
        b = (s.get("forecast") or {}).get("backtest") or {}
        if not b:
            continue
        row = {"code": s["code"], "name": s["name"]}
        for h in ("1개월", "3개월", "6개월"):
            if h in b:
                row[h] = b[h]
        hits.append(row)

    now = kst_now()
    brief = {
        "meta": {
            "title": "희망이 비서 브리프 — 독도국제무역.com 국제상품",
            "generated_at": now.strftime("%Y-%m-%d %H:%M KST"),
            "generated_label": now.strftime("%Y.%m.%d %H:%M KST"),
            "sync": "매일 09:30 동기화",
            "owner": "회장님",
            "assistant": "희망이",
            "sources": [
                "trading/watchlist.json", "trading/forecast_latest.json",
                "trading/oi_history.json", "trading/inflection_filter.py v2.1",
                "metaverse-gallery/news.json",
            ],
            "inflection_source": flt.get("_source") or "none",
            "inflection_at": flt.get("generated_at") or "",
            "news_updated": (news.get("meta") or {}).get("updated") or "",
        },
        "methodology": METHODOLOGY,
        "macro": flt.get("macro") or {},
        "symbols": symbols,
        "forecast_hits": hits,
        "zones": zones,
        "news": {
            "updated": (news.get("meta") or {}).get("updated") or "",
            "updated_label": (news.get("meta") or {}).get("updated_label") or "",
            "hall": [
                {
                    "tag": i.get("tag") or "", "code": i.get("code") or "",
                    "headline": i.get("headline") or "", "price": i.get("price") or "",
                    "change": i.get("change") or "",
                }
                for i in (news.get("items") or [])[:7]
            ],
        },
    }

    txt = json.dumps(brief, ensure_ascii=False, separators=(",", ":"))
    # 개인정보 방지선 — 메일·전화·계좌 형태가 섞이면 실패로 멈춘다.
    import re
    leaks = []
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", txt):
        leaks.append("email")
    if re.search(r"01[016789][-\s]?\d{3,4}[-\s]?\d{4}", txt):
        leaks.append("phone")
    if re.search(r"\d{3}-\d{2,6}-\d{4,6}", txt):
        leaks.append("account")
    if leaks:
        raise SystemExit("secretary_brief.json 에 개인정보로 보이는 값이 있습니다: " + ", ".join(leaks))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(brief, f, ensure_ascii=False, indent=1)

    kb = os.path.getsize(OUT) / 1024
    print(f"secretary_brief.json 생성 · {kb:.1f}KB · 종목 {len(symbols)}개 · 방 {len(zones)}개 "
          f"· 변곡 {brief['meta']['inflection_source']} ({brief['meta']['inflection_at']})")


if __name__ == "__main__":
    main()

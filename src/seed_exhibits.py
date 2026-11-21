#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""exhibits.json 시드 생성기.

채널(@재롱둥이-r4y) 쇼츠 탭 전체 아카이브(.cache/all_shorts.json)와
재생목록 스캔(.cache/playlists_scan.json)을 읽어
종목별로 최신 최대 10편을 골라 exhibits.json 을 만든다.

    python3 update_shorts.py --deep --dry-run >/dev/null   # (선택) 최신 수집
    python3 src/seed_exhibits.py

노래 쇼츠는 update_shorts.classify() 의 블랙리스트로 걸러진다.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache")
sys.path.insert(0, ROOT)
from update_shorts import classify  # noqa: E402

MAX_PER_TICKER = 5

CHANNEL = {
    "name": "재롱둥이 머니 쇼츠",
    "handle": "@재롱둥이-r4y",
    "url": "https://www.youtube.com/@%EC%9E%AC%EB%A1%B1%EB%91%A5%EC%9D%B4-r4y",
    "channel_id": "UCyicBXHBc9G3BFqokbRVUGA",
}

ZONES = [
    {"id": "fx", "name": "통화", "en": "CURRENCY", "color": "#2f7fd6",
     "desc": "주요 통화 선물(6E·6B·6S·6C·6A·6J·6N)"},
    {"id": "index", "name": "지수", "en": "INDEX", "color": "#7b4bd6",
     "desc": "S&P500(ES)·나스닥100(NQ)·다우(YM)·러셀2000(RTY)·항셍(HSI)"},
    {"id": "rates", "name": "금리", "en": "RATES", "color": "#c0455f",
     "desc": "미국채 30년(ZB)·10년(ZN)·5년(ZF)·2년(ZT)물 선물"},
    {"id": "metals", "name": "금속", "en": "METALS", "color": "#c9963f",
     "desc": "골드(GC)·은(SI)·백금(PL)·구리(HG)"},
    {"id": "energy", "name": "에너지", "en": "ENERGY", "color": "#e0642e",
     "desc": "WTI(CL)·브렌트(BZ)·가솔린(RB)·난방유(HO)·천연가스(NG)"},
    {"id": "ags", "name": "농축산물", "en": "AGRI & LIVESTOCK", "color": "#3f9b5f",
     "desc": "소맥(ZW)·대두(ZS)·대두유(ZL)·옥수수(ZC)·생우(LE)·돈육(HE)·원당(SB)"},
    {"id": "desk", "name": "안내데스크", "en": "INFORMATION DESK", "color": "#2b3a55",
     "desc": "독도국제무역 소개와 인턴사원 모집 안내"},
]

# 종목 메타데이터 (영상은 채널 아카이브에서 자동 수집)
TICKERS = [
    dict(id="gold", zone="metals", name="골드", code="GC", market="COMEX", unit="USD/트로이온스",
         one_liner="안전자산 대표주자. 실질금리와 달러가 방향을 가른다.",
         specs=["계약 단위 100 트로이온스", "최소 변동 0.10달러 = 10달러", "결제 통화 USD"],
         checks=["미국 실질금리·달러지수(DX) 방향", "중앙은행 매수·ETF 자금 흐름",
                 "만기 임박 시 차근월물(GCG 등) 롤오버 확인"],
         extra=[("vI-hBUcUveo", "video"), ("QsjR8opJsXc", "video")]),
    dict(id="copper", zone="metals", name="구리", code="HG", market="COMEX", unit="USD/파운드",
         one_liner="경기 선행지표로 불리는 산업금속. 중국 수요가 핵심.",
         specs=["계약 단위 25,000 파운드", "최소 변동 0.0005달러 = 12.50달러", "결제 통화 USD"],
         checks=["중국 제조업 지표·재고(LME·SHFE)", "광산 공급 차질·관세 뉴스", "달러 강세 여부"],
         extra=[]),
    dict(id="oil", zone="energy", name="오일 (WTI)", code="CL", market="NYMEX", unit="USD/배럴",
         one_liner="OPEC+ 감산과 재고, 지정학이 만드는 에너지 대표 종목.",
         specs=["계약 단위 1,000 배럴", "최소 변동 0.01달러 = 10달러", "결제 통화 USD"],
         checks=["EIA 주간 재고(수요일 밤)", "OPEC+ 감산·증산 결정", "중동·러시아 지정학 리스크"],
         extra=[("2tKElZAFhz8", "video"), ("aP0UuKQtewQ", "video"),
                ("GAgckokf-j4", "video"), ("RsoauuNQjE4", "video")]),
    dict(id="gas", zone="energy", name="천연가스", code="NG", market="NYMEX", unit="USD/MMBtu",
         one_liner="겨울 수요와 재고가 만드는 변동성 큰 종목.",
         specs=["계약 단위 10,000 MMBtu", "최소 변동 0.001달러 = 10달러", "결제 통화 USD"],
         checks=["EIA 가스 재고(목요일 밤)·난방 수요", "월물 간 백워데이션 구조", "허리케인·수출 터미널"],
         extra=[]),
    dict(id="bz", zone="energy", name="브렌트유", code="BZ", market="NYMEX", unit="USD/배럴",
         one_liner="세계 원유 가격의 기준. OPEC+와 중동 뉴스에 가장 민감하다.",
         specs=["계약 단위 1,000 배럴", "최소 변동 0.01달러 = 10달러", "결제 통화 USD"],
         checks=["OPEC+ 감산·증산 결정", "호르무즈·중동 지정학", "WTI와의 스프레드"],
         extra=[]),
    dict(id="rb", zone="energy", name="가솔린 RBOB", code="RB", market="NYMEX", unit="USD/갤런",
         one_liner="휘발유 도매가. 정제마진(크랙)과 여름 수요를 그대로 반영한다.",
         specs=["계약 단위 42,000 갤런", "최소 변동 0.0001 = 4.20달러", "결제 통화 USD"],
         checks=["미 휘발유 재고·정제가동률", "크랙 스프레드(RBOB-WTI)", "드라이빙 시즌 수요"],
         extra=[]),
    dict(id="ho", zone="energy", name="난방유", code="HO", market="NYMEX", unit="USD/갤런",
         one_liner="겨울 난방 수요와 디젤 정제마진의 바로미터.",
         specs=["계약 단위 42,000 갤런", "최소 변동 0.0001 = 4.20달러", "결제 통화 USD"],
         checks=["미 동부 난방 수요·기온", "디젤 재고·수출", "천연가스와의 대체 수요"],
         extra=[]),
    dict(id="eur", zone="fx", name="유로화", code="6E", market="CME", unit="USD/EUR",
         one_liner="달러지수의 절반을 차지하는 최대 통화 선물.",
         specs=["계약 단위 125,000 EUR", "최소 변동 0.00005 = 6.25달러", "소수점 5자리 표기"],
         checks=["ECB 금리 결정·정책 발언", "미·유로 금리차", "유로존 경기 지표"],
         extra=[("ha-hZrui2j4", "video")]),
    dict(id="chf", zone="fx", name="스위스프랑", code="6S", market="CME", unit="USD/CHF",
         one_liner="대표적 안전자산 통화. SNB 개입이 변수.",
         specs=["계약 단위 125,000 CHF", "최소 변동 0.00005 = 6.25달러", "소수점 5자리 표기"],
         checks=["SNB 금리 결정·외환시장 개입", "유럽 리스크 시 안전자산 수요", "미·스위스 금리차"],
         extra=[]),
    dict(id="cad", zone="fx", name="캐나다달러", code="6C", market="CME", unit="USD/CAD",
         one_liner="유가와 미국 경기에 함께 묶인 통화.",
         specs=["계약 단위 100,000 CAD", "최소 변동 0.00005 = 5달러", "소수점 5자리 표기"],
         checks=["WTI 유가 방향", "BoC 금리 결정·미·캐 금리차", "캐나다 고용·주택 지표"],
         extra=[("1VtKo2UmzUo", "video")]),
    dict(id="aud", zone="fx", name="호주달러", code="6A", market="CME", unit="USD/AUD",
         one_liner="중국 경기와 원자재 가격에 민감한 통화.",
         specs=["계약 단위 100,000 AUD", "최소 변동 0.00005 = 5달러", "소수점 5자리 표기"],
         checks=["중국 경기·철광석 가격", "RBA 금리 결정", "위험자산 선호(리스크온/오프)"],
         extra=[]),
    dict(id="jpy", zone="fx", name="엔화", code="6J", market="CME", unit="USD/JPY",
         one_liner="세계에서 가장 유동성 큰 통화쌍. 금리차와 안전자산 수요가 방향을 가른다.",
         specs=["계약 단위 12,500,000 JPY", "최소 변동 0.0000005 = 6.25달러", "소수점 6자리 표기"],
         checks=["BoJ 금리 결정·구두 개입", "미·일 장기금리차", "위험회피 국면의 엔화 강세"],
         extra=[]),
    dict(id="gbp", zone="fx", name="영국 파운드", code="6B", market="CME", unit="USD/GBP",
         one_liner="달러지수에서 세 번째 비중. 영란은행(BoE) 금리와 영국 물가가 방향을 가른다.",
         specs=["계약 단위 62,500 GBP", "최소 변동 0.0001 = 6.25달러", "소수점 5자리 표기"],
         checks=["BoE 금리 결정·영국 CPI", "미·영 금리차와 달러지수", "영국 소매판매·고용 지표"],
         extra=[]),
    dict(id="nzd", zone="fx", name="뉴질랜드달러", code="6N", market="CME", unit="USD/NZD",
         one_liner="유제품·중국 경기에 민감한 소형 통화. RBNZ 결정이 변수.",
         specs=["계약 단위 100,000 NZD", "최소 변동 0.0001 = 10달러", "소수점 5자리 표기"],
         checks=["RBNZ 금리 결정·GDT 유제품 경매", "호주달러·중국 경기 동조", "위험자산 선호(리스크온/오프)"],
         extra=[]),
    dict(id="es", zone="index", name="S&P500", code="ES", market="CME", unit="포인트",
         one_liner="미국 대표 지수 선물. 글로벌 위험자산의 기준선.",
         specs=["계약 단위 50달러 × 지수", "최소 변동 0.25포인트 = 12.50달러", "분기물(3·6·9·12월) 만기"],
         checks=["FOMC·CPI 등 매크로 일정", "빅테크 실적·AI 투자 사이클", "야간 시간대(글로벌) 변동성"],
         extra=[]),
    dict(id="hsi", zone="index", name="항셍지수", code="HSI", market="HKFE", unit="포인트",
         one_liner="홍콩 항셍(Hang Seng) 지수 선물. 중국 정책에 민감.",
         specs=["계약승수 HK$50 / 포인트", "최소 변동 1포인트 = HK$50", "영상 제목은 '항생지수'로도 표기"],
         checks=["중국 경기부양책·규제 뉴스", "홍콩 유동성·남향 자금", "야간 거래 시간대 변동성"],
         extra=[]),
    dict(id="nq", zone="index", name="나스닥100", code="NQ", market="CME", unit="포인트",
         one_liner="AI·빅테크 비중이 큰 성장주 지수. 지수 선물 가운데 변동성이 가장 크다.",
         specs=["계약 단위 20달러 × 지수", "최소 변동 0.25포인트 = 5달러", "분기물(3·6·9·12월) 만기"],
         checks=["빅테크 실적·AI 설비투자", "FOMC·금리 경로", "야간 시간대 변동성과 갭"],
         extra=[("G2qZ3KKZHZA", "shorts")]),
    dict(id="ym", zone="index", name="다우존스", code="YM", market="CBOT", unit="포인트",
         one_liner="미국 대형 우량주 30개. 산업재·금융 비중이 높아 경기 흐름을 반영한다.",
         specs=["계약 단위 5달러 × 지수", "최소 변동 1포인트 = 5달러", "분기물(3·6·9·12월) 만기"],
         checks=["다우 편입 종목 실적·주가", "제조업·서비스 PMI", "S&P500 대비 상대 강도"],
         extra=[]),
    dict(id="rty", zone="index", name="러셀2000", code="RTY", market="CME", unit="포인트",
         one_liner="미국 중소형주 2000개. 내수 경기와 자금조달 금리에 민감하다.",
         specs=["계약 단위 50달러 × 지수", "최소 변동 0.1포인트 = 5달러", "분기물(3·6·9·12월) 만기"],
         checks=["미국 소형주 자금 흐름", "신용 스프레드·금리", "경기 침체 신호(실업수당 등)"],
         extra=[]),
    dict(id="zn", zone="rates", name="미국채 10년물", code="ZN", market="CBOT", unit="32분의 1 표기",
         one_liner="금리의 기준선. 32분의 1 단위로 움직인다.",
         specs=["액면 100,000달러", "1/32 단위(1/64 = 15.625달러)", "표기 예: 105'16 = 105+16/32"],
         checks=["미 CPI·고용·FOMC 일정", "10년물 금리와의 역방향 관계", "분기 만기 롤오버(ZN→ZNH 등)"],
         extra=[]),
    dict(id="zb", zone="rates", name="미국채 30년물", code="ZB", market="CBOT", unit="32분의 1 표기",
         one_liner="장기 금리의 끝. 재정 적자와 기대 인플레이션에 가장 민감하다.",
         specs=["액면 100,000달러", "1/32 단위(1/64 = 15.625달러)", "표기 예: 106'06 = 106+06/32"],
         checks=["미 재정적자·국채 입찰 수요", "기대 인플레이션(유가)", "30년 금리와 장단기 스프레드"],
         extra=[]),
    dict(id="zf", zone="rates", name="미국채 5년물", code="ZF", market="CBOT", unit="32분의 1 표기",
         one_liner="중기 금리 벤치마크. 연준 정책 경로를 가장 직접 반영한다.",
         specs=["액면 100,000달러", "1/32의 1/4 단위(7.8125달러)", "표기 예: 104'09.75"],
         checks=["FOMC 금리 경로·점도표", "5년물 입찰 수요", "2·10년 스프레드"],
         extra=[]),
    dict(id="zt", zone="rates", name="미국채 2년물", code="ZT", market="CBOT", unit="32분의 1 표기",
         one_liner="연준 기준금리에 가장 민감한 단기물. 인상·인하 기대를 즉시 반영한다.",
         specs=["액면 200,000달러", "1/32의 1/8 단위(7.8125달러)", "표기 예: 101'30.375"],
         checks=["연준 기준금리 기대(페드워치)", "2년물 입찰·수급", "단기물 변동과 커브"],
         extra=[]),
    dict(id="silver", zone="metals", name="은", code="SI", market="COMEX", unit="USD/트로이온스",
         one_liner="금보다 변동성이 큰 귀금속이자 산업금속. 금/은 비율이 핵심 지표.",
         specs=["계약 단위 5,000 트로이온스", "최소 변동 0.005달러 = 25달러", "결제 통화 USD"],
         checks=["금/은 비율(Gold-Silver Ratio)", "태양광·전자 산업 수요", "COMEX 재고·증거금 변경"],
         extra=[]),
    dict(id="platinum", zone="metals", name="백금", code="PL", market="NYMEX", unit="USD/트로이온스",
         one_liner="자동차 촉매 수요가 큰 귀금속. 공급이 남아프리카에 집중돼 있다.",
         specs=["계약 단위 50 트로이온스", "최소 변동 0.10달러 = 5달러", "결제 통화 USD"],
         checks=["남아공 광산 공급·전력난", "자동차·수소 수요", "금·팔라듐과의 스프레드"],
         extra=[]),
    dict(id="wheat", zone="ags", name="밀", code="ZW", market="CBOT", unit="센트/부셸",
         one_liner="흑해 공급과 WASDE 보고서가 만드는 대표 곡물.",
         specs=["계약 단위 5,000 부셸", "최소 변동 1/4센트 = 12.50달러", "32분의 1 계열 표기"],
         checks=["USDA WASDE 보고서", "흑해·러시아 수출 뉴스", "미국 겨울밀 작황"],
         extra=[]),
    dict(id="soy", zone="ags", name="대두", code="ZS", market="CBOT", unit="센트/부셸",
         one_liner="남미 작황과 중국 수입이 가격을 흔든다.",
         specs=["계약 단위 5,000 부셸", "최소 변동 1/4센트 = 12.50달러", "32분의 1 계열 표기"],
         checks=["브라질·아르헨티나 작황", "중국 수입 물량·무역 협상", "대두유·대두박 동조 여부"],
         extra=[]),
    dict(id="corn", zone="ags", name="옥수수", code="ZC", market="CBOT", unit="센트/부셸",
         one_liner="사료·에탄올 수요와 남미 작황이 가격을 흔든다.",
         specs=["계약 단위 5,000 부셸", "최소 변동 1/4센트 = 12.50달러", "32분의 1 계열 표기"],
         checks=["USDA WASDE·재고 보고서", "브라질 2기작 옥수수 작황", "에탄올 마진·중국 수입"],
         extra=[]),
    dict(id="hogs", zone="ags", name="돈육", code="HE", market="CME", unit="센트/파운드",
         one_liner="도축량과 수출이 가격을 결정하는 축산 선물.",
         specs=["계약 단위 40,000 파운드", "최소 변동 0.025센트 = 10달러", "결제 통화 USD"],
         checks=["주간 도축량·육류 재고", "미국 수출 주문·멕시코·중국 수요", "사료값(옥수수·대두박)"],
         extra=[]),
    dict(id="cattle", zone="ags", name="생우", code="LE", market="CME", unit="센트/파운드",
         one_liner="도축량·사료값·수출이 가격을 결정하는 축산 선물.",
         specs=["계약 단위 40,000 파운드", "최소 변동 0.025센트 = 10달러", "결제 통화 USD"],
         checks=["주간 도축량·Cattle on Feed", "사료값(옥수수·대두박)", "소 사육 두수 주기"],
         extra=[]),
    dict(id="soyoil", zone="ags", name="대두유", code="ZL", market="CBOT", unit="센트/파운드",
         one_liner="바이오디젤 수요와 남미 작황이 가격을 흔든다.",
         specs=["계약 단위 60,000 파운드", "최소 변동 0.01센트 = 6달러", "결제 통화 USD"],
         checks=["미 바이오디젤 의무량·정책", "대두 압착 마진", "팜유와의 스프레드"],
         extra=[]),
    dict(id="sugar", zone="ags", name="원당", code="SB", market="ICE", unit="센트/파운드",
         one_liner="브라질·인도 작황과 에탄올 배분이 가격을 가른다.",
         specs=["계약 단위 112,000 파운드", "최소 변동 0.01센트 = 11.20달러", "결제 통화 USD"],
         checks=["브라질 사탕수수·에탄올 배분", "인도 수출 정책·작황", "원유·에탄올 가격 연동"],
         extra=[]),
    dict(id="dokdo", zone="desk", name="독도국제무역", code="DOKDO TRADE", market="안내", unit="국제 상품 가격",
         one_liner="독도국제무역.com — 국제 상품 가격을 제공하는 안내 창구.",
         specs=["홈페이지: 독도국제무역.com", "국제 상품 가격 정보 제공", "쇼츠로 사업 소식 공유"],
         checks=["신규 소식은 채널 쇼츠로 먼저 공개", "문의는 홈페이지 안내 참고"],
         extra=[("m-5rRiiWKOQ", "video"), ("URMP0uyz448", "video")]),
    dict(id="recruit", zone="desk", name="인턴사원 모집", code="RECRUIT", market="독도버스", unit="채용 안내",
         one_liner="독도버스 안 독도국제무역.com에서 인턴사원을 모집합니다.",
         specs=["모집: 인턴사원", "채널: 독도버스 내 독도국제무역.com", "상세 조건은 영상 설명 참고"],
         checks=["모집 조건·기간은 영상에서 확인"],
         extra=[]),
]


def load_json(name, default):
    """전시실 순서 고정용 — TICKERS 나열 순서와 무관하게 방별 순서로 정렬한다."""
    return _load_json_impl(name, default)


ORDER = ["eur", "gbp", "chf", "cad", "aud", "jpy", "nzd",
         "es", "nq", "ym", "hsi", "rty",
         "zn", "zb", "zf", "zt",
         "gold", "silver", "platinum", "copper",
         "oil", "bz", "gas", "rb", "ho",
         "wheat", "soy", "soyoil", "corn", "hogs", "cattle", "sugar",
         "dokdo", "recruit"]


def sort_tickers(tickers):
    rank = {tid: i for i, tid in enumerate(ORDER)}
    return sorted(tickers, key=lambda t: (rank.get(t["id"], 999), t["id"]))


def _load_json_impl(name, default):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    archive = load_json("all_shorts.json", [])
    if not archive:
        print("쇼츠 아카이브(.cache/all_shorts.json)가 없습니다. update_shorts.py --deep 으로 먼저 수집하세요.")
        return
    titles = {}
    for row in load_json("shorts_titles.json", []):
        titles[row[0]] = row[1]
    for row in load_json("oembed_shorts.json", []):
        if row.get("oembed_title"):
            titles[row["id"]] = row["oembed_title"]
    for rows in load_json("playlists_scan.json", {}).values():
        for row in rows:
            if row.get("title"):
                titles[row["id"]] = row["title"]

    dates = {}
    rss_path = os.path.join(CACHE, "rss.xml")
    if os.path.exists(rss_path):
        import xml.etree.ElementTree as ET
        ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
        for e in ET.parse(rss_path).getroot().findall("a:entry", ns):
            dates[e.find("yt:videoId", ns).text] = e.find("a:published", ns).text[:10]

    by_ticker = {t["id"]: [] for t in TICKERS}
    for it in archive:
        tid, _ = classify(it["title"])
        if tid in by_ticker:
            by_ticker[tid].append({"id": it["id"], "title": it["title"] or titles.get(it["id"], it["id"]),
                                   "kind": "shorts", "date": dates.get(it["id"], "")})

    # 이미 만들어 둔 exhibits.json 이 있으면 서버(Supabase) 접속 설정과 1번 판넬 자동 정보를 지키고,
    # 새로 수집한 영상이 없을 때는 기존 영상 목록을 그대로 둔다.
    prev = {}
    prev_meta = {}
    if os.path.exists(os.path.join(ROOT, "exhibits.json")):
        try:
            with open(os.path.join(ROOT, "exhibits.json"), encoding="utf-8") as f:
                _old = json.load(f)
            prev = {t["id"]: t for t in _old.get("tickers", [])}
            prev_meta = _old.get("meta") or {}
        except ValueError:
            prev, prev_meta = {}, {}

    tickers, total = [], 0
    for t in TICKERS:
        vids = list(by_ticker[t["id"]])
        have = {v["id"] for v in vids}
        for vid, kind in t["extra"]:
            if vid not in have:
                vids.append({"id": vid, "title": titles.get(vid, vid), "kind": kind,
                             "date": dates.get(vid, "")})
        vids = vids[:MAX_PER_TICKER]
        old = prev.get(t["id"]) or {}
        if not vids and old.get("videos"):
            vids = old["videos"]        # 이번 수집에 없는 종목은 기존 판넬 영상을 유지
        total += len(vids)
        item = {
            "id": t["id"], "zone": t["zone"], "name": t["name"], "code": t["code"],
            "market": t["market"], "unit": t["unit"], "one_liner": t["one_liner"],
            "specs": t["specs"], "checks": t["checks"], "videos": vids,
        }
        if old.get("auto_slot"):
            item["auto_slot"] = old["auto_slot"]
        tickers.append(item)

    kst = timezone(timedelta(hours=9))
    data = {
        "meta": {
            "title": "재롱둥이 머니 쇼츠 · 국제상품 3D 전시관",
            "subtitle": "6개 전시실에 종목별 쇼츠 5판넬을 걸어 다니며 보는 1단계 시제품",
            "channel": CHANNEL,
            "updated": datetime.now(kst).strftime("%Y-%m-%d"),
            "stage": "1단계 · 단독 시제품 (로컬 실행)",
            "panels_per_ticker": MAX_PER_TICKER,
            "realtime": {
                "supabaseUrl": "",
                "supabaseAnonKey": "",
                "room": "gallery",
                "note": "2단계: 위 두 값을 채우면 방문자 간 실시간 채팅·아바타 동기화·음성방 시그널링이 자동으로 켜집니다. 비워 두면 로컬 미리보기(동일 브라우저 탭 간)로 동작합니다."
            },
            "disclaimer": "전시된 정보는 계약 스펙·체크 포인트 정리이며, 실시간 시세나 매매 권유가 아닙니다.",
        },
        "zones": ZONES,
        "tickers": sort_tickers(tickers),
    }
    # 서버 접속 설정(realtime)은 기존 파일 값을 그대로 살린다(없으면 빈 값 = 로컬 모드).
    rt = prev_meta.get("realtime") or {}
    if rt.get("supabaseUrl") and rt.get("supabaseAnonKey"):
        data["meta"]["realtime"] = rt
        data["meta"]["stage"] = prev_meta.get("stage") or data["meta"]["stage"]

    out = os.path.join(ROOT, "exhibits.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"exhibits.json 작성: 종목 {len(tickers)}개 / 영상 {total}편 "
          f"(종목당 최대 {MAX_PER_TICKER}칸)")
    for t in tickers:
        print(f"  {t['zone']:6s} {t['name']:12s} {len(t['videos']):2d}편")


if __name__ == "__main__":
    main()

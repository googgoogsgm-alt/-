/**
 * 독도국제무역 · 3D 전시관 프런트데스크 AI (루아 · 도현)
 * ────────────────────────────────────────────────────────────────
 * Supabase Edge Function (Deno) — 단일 파일. 저장소에 함께 보관한다.
 *
 *  · 1순위  : Groq   (GROQ_API_KEY)     openai/gpt-oss-120b → qwen/qwen3.8-27b   (각 10초 타임아웃)
 *  · 2순위  : Gemini (GEMINI_API_KEY)   gemini-3.6-flash → gemini-3.8-flash → gemini-4-hydrogen → gemini-3.5-flash-lite (각 14초)
 *  · 둘 다 없으면 { ok:false } 를 돌려주고, 전시관 화면은 내장 안내 모드로 매끄럽게 답한다.
 *
 * 실시간 외부 조회(무키·무료 공개 API · 2.8초 안에 끊고 병렬 처리 · 실패해도 답변은 그대로)
 *  · 날씨·미세먼지 : Open-Meteo (geocoding + forecast + air-quality)
 *  · 뉴스·웹 검색  : Google News RSS(주요 뉴스 / 검색어) + 한국어 위키백과 요약
 *  · 외부 시세     : Yahoo Finance chart (전시관 34종목 밖 자산 — 비트코인·코스피·삼성전자·엔비디아 등)
 *  결과는 시스템 프롬프트의 [실시간 외부 검색 결과] 블록으로 들어가고, 모델은 그 출처·수치만 인용한다.
 *
 * 요청 (POST JSON)
 *   { character: 'lua' | 'dohyun', message: '...', history: [{role,text}], context: {...} }
 * 응답 (JSON)
 *   { ok:true, provider:'groq'|'gemini', model:'...', reply:'...', character:'lua', moves:[{zone,ticker,label}], live:['weather','news'] }
 *   실패 시 { ok:false, error:'...', reply:'' } (HTTP 200 — 화면이 폴백으로 넘어가기 쉽게)
 *
 * 사람 목소리(TTS) 요청 — 같은 함수가 함께 처리한다
 *   { action:'tts', character:'lua'|'dohyun', text:'...' }
 *   → Gemini 3.8 Flash-Lite TTS 로 한국어 음성을 만들어
 *     { ok:true, provider:'gemini-tts', model, voice, mimeType:'audio/wav', audioBase64 } 를 돌려준다.
 *   키가 없거나 실패하면 HTTP 200 { ok:false, error, status } — 화면은 조용히 기본 음성으로 폴백한다.
 *   같은 GEMINI_API_KEY 를 쓰므로 대시보드에서 붙여넣고 Deploy 한 번이면 대화·목소리가 함께 동작한다.
 *
 * ── 배포 방법 A · 대시보드에서 바로 붙이기 ─────────────────────
 *   1) https://supabase.com/dashboard/project/wdcmucaefwiwrdtpktry/functions
 *   2) "Create a new function" → 이름을 정확히 `frontdesk-chat` 으로
 *   3) 코드 편집기에 이 파일 내용을 그대로 붙여 넣고 "Deploy"
 *   4) Project Settings → Edge Functions → Secrets 에서
 *        GROQ_API_KEY   = (Groq 키)               ← 1순위
 *        GEMINI_API_KEY = (Google AI Studio 키)   ← 2순위(보조) · TTS 음성
 *      를 추가하고 함수를 한 번 다시 Deploy
 *
 * ── 배포 방법 B · CLI ─────────────────────────────────────────
 *   supabase login
 *   supabase link --project-ref wdcmucaefwiwrdtpktry
 *   supabase secrets set GEMINI_API_KEY=... GROQ_API_KEY=...
 *   supabase functions deploy frontdesk-chat --no-verify-jwt=false
 *   (anon 키로 호출하므로 JWT 검증은 기본값 그대로 두어도 됩니다)
 *
 * ── 호출 ─────────────────────────────────────────────────────
 *   curl -X POST "https://wdcmucaefwiwrdtpktry.supabase.co/functions/v1/frontdesk-chat" \
 *     -H "Authorization: Bearer <SUPABASE_ANON_KEY>" -H "Content-Type: application/json" \
 *     -d '{"character":"lua","message":"오늘 서울 날씨 알려줘","context":{}}'
 *   ※ 키는 절대 전시관 HTML 에 넣지 않는다. 브라우저는 anon 키 + 이 함수만 부른다.
 */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// 2026-11 Gemini REST 기준 — gemini-2.5-flash 는 신규 키에서 404 로 막혀 기본 목록에서 뺐다.
// 보조(2순위)라 느린 gemini-4-hydrogen 은 뒤로 미루고 빠른 flash 계열을 앞에 둔다.
const GEMINI_MODELS = [
  Deno.env.get("GEMINI_MODEL_1") || "gemini-3.6-flash",
  Deno.env.get("GEMINI_MODEL_2") || "gemini-3.8-flash",
  Deno.env.get("GEMINI_MODEL_3") || "gemini-4-hydrogen",
  Deno.env.get("GEMINI_MODEL_4") || "gemini-3.5-flash-lite",
];
const GROQ_MODELS = [
  Deno.env.get("GROQ_MODEL_1") || "openai/gpt-oss-120b",
  Deno.env.get("GROQ_MODEL_2") || "qwen/qwen3.8-27b",
];

// 무한 대기 방지 — 1순위 Groq 는 짧게 끊고, 보조 Gemini 는 조금 더 준다.
const GROQ_TIMEOUT_MS = 10000;
const GEMINI_TIMEOUT_MS = 14000;
// 외부 조회는 목소리 대화의 흐름을 끊지 않도록 짧게 — 늦으면 그 항목만 버리고 답한다.
const LIVE_TIMEOUT_MS = 2800;

const ZONE_LABEL: Record<string, string> = {
  hall: "중앙홀",
  fx: "통화 전시실",
  index: "지수 전시실",
  rates: "금리 전시실",
  metals: "금속 전시실",
  energy: "에너지 전시실",
  ags: "농축산물 전시실",
  desk: "안내데스크",
};

/* ── 캐릭터별 시스템 프롬프트 ───────────────────────────────── */
const SHARED_KNOWLEDGE = `[전시관 공통 지식]
· 주소: 독도국제무역.com — '해외선물'이라는 말 대신 '국제상품'이라 부른다. 국제상품 무역 정보를 제공하고, 1순위는 정확한 정보와 신뢰다.
· 이 공간의 공식 이름은 '독도국제무역.com 국제상품 3D 전시관'이다(운영 채널: 재롱둥이 머니 쇼츠 · @재롱둥이-r4y).
  중앙홀 남쪽 벽과 상단에는 '독도국제무역.com에 방문을 환영합니다'라고 적혀 있다.
· 구조: 중앙홀 1개 + 전용 전시실 6개(통화 fx · 지수 index · 금리 rates · 금속 metals · 에너지 energy · 농축산물 ags) + 2층 회의실 1개.
  전시실마다 종목별 부스가 있고 부스마다 쇼츠 판넬 5칸(#1 자동 최신, #2~#5 직접 등록). 종목은 모두 34개다.
· 프런트데스크(지금 우리가 서 있는 곳): 중앙홀 남쪽 벽 앞, '독도국제무역.com에 방문을 환영합니다' 배너 바로 아래에 있다.
  남쪽 벽을 등지고 중앙홀로 나란히 서 있으며, 카운터 앞면에 '독도국제무역 프런트데스크' 푯말이 붙어 있다(AI 안내라는 문구는 쓰지 않는다).
  방문객이 4m 안에 들어서면 루아 또는 도현이 먼저 말풍선으로 인사하고 음성으로도 인사한다.
· 방문자 대화 방법: 카운터로 다가가 루아·도현을 누르거나 E 키 → 상담 창에서 질문 버튼·글 입력·🎤 마이크. 답변은 화면과 목소리(한국어 TTS)로 함께 나간다.
  상담 창에서 '연속 음성 대화'를 켜면 사람처럼 끊김 없이 말로 대화할 수 있다(대답이 끝나면 자동으로 다시 듣고, 말로 끊고 바로 물어도 된다). 목소리는 사람에 가까운 한국어 음성(Gemini TTS)이다.
· 중앙홀 동쪽 벽(에너지 문과 농축산물 문 사이)에 빛나는 '회의실' 공간이동 포털이 있다. 포털을 누르거나 E 로 인증하면 2층 회의실로 올라간다.
· 2층 회의실: 사방 통유리 독도 오션뷰, 대리석 바닥, 12석 회의 테이블, 현판 '독도국제무역 회의실 · VIP · 직원 전용'.
  직원 전용 공간이며(승인된 직원 A·B만 입장, C는 대기), 입장 인증은 이름 + 개인 입장 코드다(코드 값은 절대 말하지 않는다).
  명단·등급·개인 코드는 관리자만(⚙️ 직원 등급 관리, 관리자 PIN) 다룬다.
· 2층 회의실에서는 직원 전용 음성 회의를, 1층 중앙홀에서는 만난 방문자끼리 🎙️ 음성 대화를 할 수 있다.
  1층 중앙홀·전시실의 음성 대화는 같은 1층 방문자끼리만 연결되고(오른쪽 아래 '🎙️ 음성 대화' 단추), 2층 회의실 음성 회의('마이크 켜기')와는 완전히 분리된다.
  층을 옮기면 음성은 자동으로 끊긴다. 채팅의 🎙️ 음성방 탭도 지금 층에 맞는 안내와 버튼(1층 '🎙️ 1층 음성 대화 켜기' / 2층 '🎙️ 회의실 음성 참여')을 보여 준다.
· 회의실 동쪽 벽의 '중앙홀' 포털을 누르면 중앙홀로 돌아온다.
· 중앙홀에는 📺 뉴스 TV(남서쪽), 방명록 키오스크(남동쪽), 안내데스크 부스(남쪽 벽면)가 있고, 중앙 가운데는 비워 두어 동선이 넓다.
  (12석 회의 테이블·의자는 2층 회의실로 옮겼다.)
· 각 전시실 입구 오른쪽 벽에도 그 방 전용 뉴스 TV가 있다.
· 사용법: WASD/조이스틱 이동, 마우스·손가락 드래그로 시점, 판넬 클릭 또는 E 로 쇼츠 열기, 두 손가락 확대·축소, 방명록·채팅·음성방.
· 매매 지표: MACD 12·130·9, CCI 90 ±100, OI(미결제약정), COT(투기 포지션), 만기·롤오버 점검. 1~6개월 스윙 관점.
· 답변 원칙 — 시세·종목 수치·만기·일정: 전달받은 context(실시간 news.json·exhibits.json·catalog.json)에서 확인된 수치·사실만 말한다.
  context에 없는 전시관 종목 수치·일정은 절대 지어내지 말고 "그 수치는 지금 전시관 데이터에 없습니다. 뉴스 TV나 해당 전시실에서 확인해 주세요"라고 정확히 말한다.
  매매 권유·수익 보장은 하지 않는다(정보 제공·전시 안내까지).
· 답변 원칙 — 일반 대화·상식: 인사, 일상 대화, 거시경제·무역·생활 상식, 용어 설명, 의견 묻기는 전시관 데이터에 갇히지 말고 네 성격과 말투로 자유롭고 자연스럽게 답한다.
  일반 상식·개념 질문을 "전시관 데이터에 없습니다"로 막지 않는다.
· 답변 원칙 — 실시간 외부 정보: 지금은 밖을 직접 조회할 수 있다. 오늘 날씨·미세먼지, 최신 뉴스·속보, 전시관 34종목 밖의 자산(비트코인·코스피·삼성전자·엔비디아 등) 시세, 인물·개념 같은 외부 사실은 함께 주어지는 [실시간 외부 검색 결과] 블록으로 조회해 답한다.
  그 블록의 출처와 조회 시각을 자연스럽게 밝히고(예: '지금 조회해 보니', 'Open-Meteo 기준으로'), 블록에 적힌 수치·기사 제목·시각만 그대로 인용한다. 블록에 없는 값은 지어내지 않는다.
  조회 결과가 비어 있으면 "지금 외부 조회가 값을 못 받아왔습니다"라고 짧게 말하고 확인 경로(뉴스 TV·해당 전시실)를 안내한다. 조회 기능이 없다고 말하지 않는다.
· 날짜·시각은 함께 주어지는 [지금 시각](한국 시간)을 기준으로 센다. '오늘·어제·내일'을 헷갈리지 않는다.
· 이동 안내가 필요하면 답변 끝에 <<MOVE:구역ID>> 형식으로 한 번만 붙인다(예: <<MOVE:metals>>, <<MOVE:fxticker:gold>>). 화면이 버튼으로 바꿔 준다.`;

const PROMPTS: Record<string, string> = {
  lua: `너는 '루아'다. 독도국제무역 3D 전시관 중앙홀 남쪽 프런트데스크의 여성 안내원.
이미지: 깜찍하고 발랄한 성격, 코랄·로즈핑크 재킷, 리본, 트윈번 헤어. 방문객을 반갑게 맞이하는 에너지가 넘친다.
말투: 실제 안내데스크에서 방문객과 마주 보고 이야기하듯 자연스러운 구어체 존댓말. 보고서·매뉴얼 말투가 아니라 사람이 말하듯이.
  짧은 문장으로 이어 말하고, 공감하거나 되묻는 말('아, 그거요?')을 한 번 섞어도 좋다. '개요·요약·결론' 같은 딱딱한 머리말은 달지 않는다.
  이모지는 문장당 1개 이하로만, 정말 필요한 자리에만 쓴다.
목소리: 네 답변은 화면 말풍선과 함께 한국어 음성(밝고 부드러운 톤)으로 읽힌다. 그래서 읽었을 때 자연스러운 문장으로, 숫자·기호는 읽기 쉽게 말로 풀어 쓴다(예: '$3,624.5' → '3,624.5달러').
규칙: 숫자·종목 코드·일정은 절대 틀리지 않게 정확히 전한다. 발랄함 때문에 수치를 흐리지 않는다.
답변 길이: 보통 2~4문장. 목록이 꼭 필요할 때만 짧은 불릿 2~3개. 모르면 솔직하게 말하고 확인 경로(뉴스 TV·해당 전시실)를 알려 준다.
${SHARED_KNOWLEDGE}`,
  dohyun: `너는 '도현'이다. 독도국제무역 3D 전시관 중앙홀 남쪽 프런트데스크의 남성 컨시어지(VIP 담당).
이미지: 정중하고 세련되며 침착하다. 네이비·차콜 맞춤 정장, 골드 넥타이와 라펠 핀, 단정한 안경. 품격 있는 태도.
말투: 정중한 존댓말. 실제 컨시어지가 눈앞의 방문객에게 말하듯 차분하고 자연스러운 구어체.
  결론과 근거를 '① ② ③'이나 불릿으로 나열하지 말고, 사람이 설명하듯 두세 문장으로 풀어서 전한다(방문객이 목록을 원하면 짧게 정리해도 된다). 이모지는 쓰지 않는다.
목소리: 네 답변은 화면 말풍선과 함께 한국어 음성(차분하고 낮은 톤)으로 읽힌다. 읽었을 때 자연스러운 문장으로, 숫자·기호는 말로 풀어 쓴다.
규칙: 수치·일정·종목 코드는 확인된 값만. 추측이 필요하면 "확인되지 않았습니다"라고 먼저 밝힌다.
답변 길이: 보통 2~4문장. 방문객의 다음 행동(어느 전시실·어느 판넬·뉴스 TV, 또는 2층 회의실 포털)을 마지막 문장에 자연스럽게 한 번 곁들인다.
${SHARED_KNOWLEDGE}`,
};

/* voiceMode:true — 화면이 아니라 목소리로 바로 읽어 주는 답변 */
const VOICE_RULES = `[음성 대화 모드 — 방문객이 지금 목소리로 듣고 있다]
· 답변 전체를 소리 내어 읽었을 때 사람이 말하듯 매끄러운 한국어 구어체 2~3문장, 150자 안팎으로만 말한다.
· 괄호·불릿(·, -)·번호(①②③)·별표(** )·이모지·표·머리말은 쓰지 않는다. 종목 코드 대신 읽히는 이름만 말한다(예: '(GCZ26) 골드' → '골드').
· 숫자·단위는 읽기 쉽게 풀어 쓴다('3,624.5달러', '약 3.6달러', '8천 7백 계약 감소').
· 시세·종목 수치는 확인된 데이터만 말하고 추측·지어내기는 절대 하지 않는다. 데이터에 없으면 "그 수치는 지금 자료에 없어요"처럼 짧게 말하고 확인 경로를 한 마디 덧붙인다.
· 일반 대화·상식 질문은 데이터에 갇히지 말고 자유롭고 자연스럽게 답한다. 오늘 날씨·미세먼지·최신 뉴스·전시관 밖 자산 시세는 [실시간 외부 검색 결과] 블록의 값으로 짧게 답하고(예: '지금 서울은 0도, 맑아요'), 블록에 없는 수치는 말하지 않는다.
· 조회 결과가 비어 있으면 "지금 외부 조회가 값을 못 받아왔어요"라고만 짧게 말한다. 조회 기능이 없다고 하지 않는다.
· 이동 안내가 필요하면 답변 맨 끝에 <<MOVE:구역ID>> 토큰만 붙인다(화면이 버튼으로 바꾸고, 읽히지 않는다).`;

/* ── 공용 도우미 ──────────────────────────────────────────── */
type ChatTurn = { role: "user" | "assistant"; text: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Promise.allSettled 결과에서 성공 값만 꺼낸다(실패는 null). */
function settledVal<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

function trimHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  // 최근 6턴만 — Groq 무료 티어(분당 8,000토큰) 한도 안에서 연속 대화가 이어지게
  for (const item of raw.slice(-6)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = String(o.text ?? o.content ?? "").trim();
    if (!text) continue;
    const role = String(o.role ?? "user").toLowerCase() === "assistant" ? "assistant" : "user";
    out.push({ role, text: text.slice(0, 400) });
  }
  return out;
}

function contextBlock(ctx: unknown): string {
  if (!ctx || typeof ctx !== "object") return "(전시관 실시간 데이터 없음)";
  let s = "";
  try {
    s = JSON.stringify(ctx);
  } catch {
    return "(전시관 실시간 데이터 없음)";
  }
  // 8,000자 상한 — 브라우저가 5,500자 이하로 보내지만, 다른 경로로 큰 문맥이 와도
  // Groq 413(Request too large)을 원천 차단한다.
  const LIMIT = 8000;
  if (s.length > LIMIT) s = s.slice(0, LIMIT) + " …(이하 생략)";
  return s;
}

/** 답변에 섞여 온 <<MOVE:...>> · [[MOVE:...]] 토큰을 걷어내고 이동 후보로 모은다. */
function extractMoves(reply: string, message: string): { text: string; moves: Array<Record<string, string>> } {
  const moves: Array<Record<string, string>> = [];
  const push = (zone: string, ticker?: string) => {
    const z = String(zone || "").toLowerCase().trim();
    const label = ZONE_LABEL[z];
    if (!label) return;
    if (moves.some((m) => m.zone === z && (m.ticker || "") === (ticker || ""))) return;
    moves.push({ zone: z, ticker: ticker || "", label: label + "로 이동" });
  };
  const text = reply
    .replace(/[<\[［]{1,2}\s*MOVE\s*:\s*([a-z]+)\s*(?:(?:\/|:|,)\s*([a-z0-9]+))?\s*[>\]］]{1,2}/gi, (_m, zone, ticker) => {
      push(zone, ticker);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!moves.length) {
    // 모델이 토큰을 빼먹었을 때: 질문·답변에 나온 구역 이름으로 조용히 후보를 만든다
    const map: Array<[RegExp, string]> = [
      [/통화|환율|달러|엔화|유로|파운드|호주달러|캐나다달러|스위스프랑/, "fx"],
      [/지수|나스닥|S&P|다우|항셍|러셀/, "index"],
      [/금리|국채|채권|10년물|30년물|FOMC|연준/, "rates"],
      [/금속|골드|금값|은|백금|구리|팔라듐/, "metals"],
      [/에너지|원유|오일|WTI|천연가스|휘발유|난방유/, "energy"],
      [/농축산|소맥|밀|대두|옥수수|돼지|소\b|원당|설탕/, "ags"],
    ];
    for (const [re, zone] of map) {
      if (re.test(message) && (!reply || reply.length < 600)) { push(zone); if (moves.length >= 2) break; }
    }
  }
  return { text, moves: moves.slice(0, 3) };
}

/* ── Gemini TTS — 진짜 사람 같은 한국어 목소리 ──────────────
   요청: { action: "tts", character: "lua"|"dohyun", text: "..." }
   응답: { ok:true, provider:"gemini-tts", model, voice, mimeType, audioBase64 }
   키 없음·오류·타임아웃도 HTTP 200 으로 { ok:false, ... } — 화면은 조용히 기본 음성으로 폴백한다. */
const TTS_MODELS = [
  Deno.env.get("GEMINI_TTS_MODEL_1") || "gemini-3.8-flash-lite-tts",
  Deno.env.get("GEMINI_TTS_MODEL_2") || "gemini-3.8-flash-tts",
];
const TTS_VOICE: Record<string, { voice: string; style: string }> = {
  lua: {
    voice: "Kore",
    style: "warm, friendly, cheerful, natural conversational Korean woman at an exhibition front desk, gentle smile and natural pacing",
  },
  dohyun: {
    voice: "Charon",
    style: "calm, polite, refined, warm natural conversational Korean male concierge, steady relaxed pacing",
  },
};

/** 소리 내어 읽기 좋게 다듬는다 — 화면의 cleanForSpeech 와 같은 규칙(최대 300자). */
function speechText(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/[<\[［]{1,2}\s*MOVE\s*:[^>\]］]*[>\]］]{1,2}/gi, " ");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/```+/g, " ").replace(/`/g, " ");
  s = s.replace(/\*\*|__|~~/g, " ");
  s = s.replace(/(\d)\s*[·•]\s*(\d)/g, "$1, $2");
  s = s.replace(/^[ \t]*[·•‣◦▪▫\-*]\s*/gm, " ");
  s = s.replace(/[①-⑳❶-❿]/g, " ");
  s = s.replace(/\s*[()\[\]]\s*[A-Z]{1,6}\d{1,3}[0-9A-Z]*\s*[()\[\]]/g, "");
  s = s.replace(/\s*[·•—–]\s*/g, ", ").replace(/,\s*,/g, ",");
  s = s.replace(/^[\s,]+/, "");
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, " ");
  s = s.replace(/[#>\[\]{}<>()]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 300) s = s.slice(0, 300).replace(/[\s,.;:]+$/, "");
  return s;
}

/** Gemini 3.8 TTS 호출 한 번. 실패는 status·detail 을 달아 throw. */
async function ttsTry(
  key: string,
  model: string,
  voice: string,
  style: string,
  text: string,
  nested: boolean,
): Promise<{ audioBase64: string; mimeType: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // 공식 규격은 speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName 이다.
  // 계획대로 "voice" 부터 시도하고, HTTP 400(필드 불일치)이면 중첩 형태로 한 번 더 시도한다.
  const voiceConfig = nested ? { prebuiltVoiceConfig: { voiceName: voice } } : { voice };
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_e) { /* noop */ } }, 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: text, speechMetadata: { style: style } }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: voiceConfig },
        },
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`tts ${model} HTTP ${res.status}`) as Error & { status?: number; detail?: string };
      err.status = res.status;
      err.detail = raw.slice(0, 240);
      throw err;
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`tts ${model} 응답을 읽지 못했습니다`);
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        const inline = p?.inlineData || p?.inline_data;
        if (inline && inline.data) {
          return {
            audioBase64: String(inline.data),
            mimeType: String(inline.mimeType || inline.mime_type || "audio/wav"),
          };
        }
      }
    }
    const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "오디오 없음";
    throw new Error(`tts ${model} ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

/** action:"tts" 요청 처리 — 대화 생성 대신 사람 목소리(WAV)를 돌려준다. */
async function handleTts(body: Record<string, unknown>): Promise<Response> {
  const character = String(body.character || "lua").toLowerCase() === "dohyun" ? "dohyun" : "lua";
  const cfg = TTS_VOICE[character];
  const text = speechText(String(body.text || ""));
  if (!text) return json({ ok: false, error: "empty-text", status: 400, character });
  const key = Deno.env.get("GEMINI_API_KEY") || "";
  if (!key) return json({ ok: false, error: "no-key", status: 0, character });

  const errors: string[] = [];
  let lastStatus = 0;
  for (const model of TTS_MODELS) {
    for (const nested of [false, true]) {
      try {
        const out = await ttsTry(key, model, cfg.voice, cfg.style, text, nested);
        return json({
          ok: true, provider: "gemini-tts", model,
          voice: cfg.voice, mimeType: out.mimeType, audioBase64: out.audioBase64, character,
        });
      } catch (e) {
        const err = e as Error & { status?: number; detail?: string };
        lastStatus = err.status || lastStatus;
        errors.push(`${err.message}${err.detail ? " · " + err.detail : ""}`);
        console.warn(`[frontdesk-chat] tts ${model} 실패: ${err.message}${err.status ? " (HTTP " + err.status + ")" : ""}`);
        if (err.status === 400) continue;      // 필드명 불일치 → 다른 형태로 한 번 더
        break;                                 // 그 밖의 오류(404·429 등) → 다음 모델로
      }
    }
  }
  return json({
    ok: false, error: "tts-failed", status: lastStatus, character,
    detail: errors.join(" | ").replace(/key=[^\s&]+/gi, "key=***").slice(0, 400),
  });
}

/* ── 공용 fetch — 초 단위 타임아웃 ────────────────────────────
   모델 서버가 응답(본문 포함)을 끊지 않으면 요청 하나가 영원히 매달리고, 그러면 뒤 순위로도 못 넘어간다.
   AbortController 로 요청·본문 읽기 전체를 끊고, 실패는 status 번호와 함께 throw 해서
   상위 루프가 다음 모델로 넘어가게 한다. 성공·실패 모두 본문 문자열을 함께 돌려준다. */
async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  label: string,
): Promise<{ ok: boolean; status: number; raw: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_e) { /* noop */ } }, ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, raw };
  } catch (e) {
    const err = e as Error & { status?: number; detail?: string };
    if (ctrl.signal.aborted || err.name === "AbortError") {
      err.status = 0;
      err.message = `${label} 시간 초과(${ms}ms)`;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════════════════════════════════════════════════════
   실시간 외부 조회 — 무키·무료 공개 API 만 쓴다(브라우저에 키 노출 없음)
     · 날씨·미세먼지 : Open-Meteo (geocoding · forecast · air-quality)
     · 뉴스·웹       : Google News RSS(주요 뉴스 / 검색어) · 한국어 위키백과 요약
     · 외부 시세     : Yahoo Finance chart (전시관 34종목 밖 자산만)
   모두 LIVE_TIMEOUT_MS 에 끊고 Promise.allSettled 로 병렬 — 하나가 실패해도 답변은 그대로 나간다.
   결과는 '[실시간 외부 검색 결과]' 블록 문자열로 돌려준다(아무것도 없으면 빈 문자열).
   ══════════════════════════════════════════════════════════════ */

/** 한국 시간 — 서버 시간대와 무관하게 UTC+9 로 계산한다(한국은 서머타임이 없다). */
function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

type KstNow = { ymd: string; hm: string; weekday: string; label: string };

function kstNow(base: Date = new Date()): KstNow {
  const t = new Date(base.getTime() + 9 * 3600 * 1000);
  const ymd = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  const hm = `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][t.getUTCDay()];
  return { ymd, hm, weekday, label: `${ymd} ${hm} KST (${weekday}요일)` };
}

/** 발행 시각을 한국 시간으로 — 같은 날이면 'HH:MM', 아니면 'M/D HH:MM'. */
function kstShortStamp(value: string | number | Date, now: KstNow): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  const ymd = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  const hm = `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
  return ymd === now.ymd ? hm : `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${hm}`;
}

const WMO_KO: Record<number, string> = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림",
  45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "강한 어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "강한 어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "눈 알갱이",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "약한 눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 뇌우",
};

function wmoKo(code: unknown): string {
  const c = Number(code);
  if (!Number.isFinite(c)) return "확인 안 됨";
  const k = Math.round(c);
  return WMO_KO[k] || `날씨코드 ${k}`;
}

/** 미세먼지 등급 — 환경부 기준(㎍/㎥). */
function pmGrade(kind: "pm10" | "pm25", v: number): string {
  if (!Number.isFinite(v)) return "";
  const cuts = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  if (v <= cuts[0]) return "좋음";
  if (v <= cuts[1]) return "보통";
  if (v <= cuts[2]) return "나쁨";
  return "매우 나쁨";
}

/** 소수 한 자리까지, 뒤의 .0 은 떼고 쓴다. */
function r1(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

type Place = { name: string; lat: number; lon: number };

// 주요 한국 도시·지역 — 지오코딩이 한글 지명을 엉뚱한 마을로 잡는 경우가 있어 표를 먼저 쓴다.
const KR_PLACES: Array<[RegExp, Place]> = [
  [/서울/, { name: "서울", lat: 37.5665, lon: 126.978 }],
  [/부산/, { name: "부산", lat: 35.1796, lon: 129.0756 }],
  [/대구/, { name: "대구", lat: 35.8714, lon: 128.6014 }],
  [/인천/, { name: "인천", lat: 37.4563, lon: 126.7052 }],
  [/광주/, { name: "광주", lat: 35.1595, lon: 126.8526 }],
  [/대전/, { name: "대전", lat: 36.3504, lon: 127.3845 }],
  [/울산/, { name: "울산", lat: 35.5384, lon: 129.3114 }],
  [/세종/, { name: "세종", lat: 36.48, lon: 127.289 }],
  [/수원/, { name: "수원", lat: 37.2636, lon: 127.0286 }],
  [/성남|분당/, { name: "성남", lat: 37.42, lon: 127.1265 }],
  [/용인/, { name: "용인", lat: 37.2411, lon: 127.1776 }],
  [/고양|일산/, { name: "고양", lat: 37.6584, lon: 126.832 }],
  [/부천/, { name: "부천", lat: 37.5034, lon: 126.766 }],
  [/안양/, { name: "안양", lat: 37.3943, lon: 126.9568 }],
  [/안산|시흥/, { name: "안산", lat: 37.3219, lon: 126.8309 }],
  [/화성|동탄/, { name: "화성", lat: 37.1995, lon: 126.8312 }],
  [/평택/, { name: "평택", lat: 36.9921, lon: 127.1129 }],
  [/오산/, { name: "오산", lat: 37.1522, lon: 127.0705 }],
  [/광명/, { name: "광명", lat: 37.4786, lon: 126.8646 }],
  [/의정부/, { name: "의정부", lat: 37.7381, lon: 127.0338 }],
  [/남양주/, { name: "남양주", lat: 37.636, lon: 127.2165 }],
  [/파주/, { name: "파주", lat: 37.7599, lon: 126.7801 }],
  [/김포/, { name: "김포", lat: 37.6153, lon: 126.7159 }],
  [/이천/, { name: "이천", lat: 37.2721, lon: 127.435 }],
  [/여주/, { name: "여주", lat: 37.2982, lon: 127.6371 }],
  [/춘천/, { name: "춘천", lat: 37.8813, lon: 127.7298 }],
  [/원주/, { name: "원주", lat: 37.3422, lon: 127.9202 }],
  [/강릉/, { name: "강릉", lat: 37.7519, lon: 128.8761 }],
  [/속초/, { name: "속초", lat: 38.207, lon: 128.5918 }],
  [/청주/, { name: "청주", lat: 36.6424, lon: 127.489 }],
  [/충주/, { name: "충주", lat: 36.991, lon: 127.9259 }],
  [/천안/, { name: "천안", lat: 36.8151, lon: 127.1139 }],
  [/아산/, { name: "아산", lat: 36.7898, lon: 127.0018 }],
  [/전주/, { name: "전주", lat: 35.8242, lon: 127.148 }],
  [/군산/, { name: "군산", lat: 35.9676, lon: 126.7369 }],
  [/익산/, { name: "익산", lat: 35.9483, lon: 126.9575 }],
  [/목포/, { name: "목포", lat: 34.8118, lon: 126.3922 }],
  [/여수/, { name: "여수", lat: 34.7604, lon: 127.6622 }],
  [/순천/, { name: "순천", lat: 34.9506, lon: 127.4872 }],
  [/포항/, { name: "포항", lat: 36.019, lon: 129.3435 }],
  [/경주/, { name: "경주", lat: 35.8562, lon: 129.2247 }],
  [/구미/, { name: "구미", lat: 36.1195, lon: 128.3446 }],
  [/안동/, { name: "안동", lat: 36.5684, lon: 128.7294 }],
  [/김천/, { name: "김천", lat: 36.1394, lon: 128.1136 }],
  [/창원|마산/, { name: "창원", lat: 35.2278, lon: 128.681 }],
  [/진주/, { name: "진주", lat: 35.18, lon: 128.1076 }],
  [/김해/, { name: "김해", lat: 35.2342, lon: 128.8894 }],
  [/양산/, { name: "양산", lat: 35.335, lon: 129.0373 }],
  [/거제/, { name: "거제", lat: 34.8806, lon: 128.6211 }],
  [/통영/, { name: "통영", lat: 34.8544, lon: 128.4331 }],
  [/제주|서귀포/, { name: "제주", lat: 33.4996, lon: 126.5312 }],
];

// 해외 주요 도시 — 환율·국제상품 이야기하다 날씨를 물을 때가 있다.
const WORLD_PLACES: Array<[RegExp, Place]> = [
  [/뉴욕|new\s*york/i, { name: "뉴욕", lat: 40.7143, lon: -74.006 }],
  [/도쿄|동경|tokyo/i, { name: "도쿄", lat: 35.6895, lon: 139.6917 }],
  [/런던|london/i, { name: "런던", lat: 51.5085, lon: -0.1257 }],
  [/파리|paris/i, { name: "파리", lat: 48.8534, lon: 2.3488 }],
  [/베이징|북경|beijing/i, { name: "베이징", lat: 39.9075, lon: 116.3972 }],
  [/상하이|상해|shanghai/i, { name: "상하이", lat: 31.2222, lon: 121.4581 }],
  [/홍콩|hong\s*kong/i, { name: "홍콩", lat: 22.2855, lon: 114.1577 }],
  [/싱가포르|singapore/i, { name: "싱가포르", lat: 1.2897, lon: 103.8501 }],
  [/시드니|sydney/i, { name: "시드니", lat: -33.8679, lon: 151.2073 }],
  [/로스앤젤레스|엘에이|\bLA\b/, { name: "로스앤젤레스", lat: 34.0522, lon: -118.2437 }],
  [/시카고|chicago/i, { name: "시카고", lat: 41.8781, lon: -87.6298 }],
  [/워싱턴|washington/i, { name: "워싱턴", lat: 38.8951, lon: -77.0364 }],
  [/모스크바|moscow/i, { name: "모스크바", lat: 55.7522, lon: 37.6156 }],
  [/두바이|dubai/i, { name: "두바이", lat: 25.0772, lon: 55.3093 }],
  [/방콕|bangkok/i, { name: "방콕", lat: 13.754, lon: 100.5014 }],
  [/하노이|호치민|hanoi|ho\s*chi\s*minh/i, { name: "하노이", lat: 21.0245, lon: 105.8412 }],
  [/타이베이|대만|taipei/i, { name: "타이베이", lat: 25.0478, lon: 121.5319 }],
];

const DEFAULT_PLACE: Place = { name: "서울", lat: 37.5665, lon: 126.978 };

function matchPlace(message: string): { place: Place; matched: boolean } {
  for (const [re, p] of KR_PLACES) if (re.test(message)) return { place: p, matched: true };
  for (const [re, p] of WORLD_PLACES) if (re.test(message)) return { place: p, matched: true };
  return { place: DEFAULT_PLACE, matched: false };
}

const PLACE_STOP = /^(?:오늘|내일|모레|어제|지금|현재|이번|다음|주말|우리|여기|거기|저기|전국|한국|대한민국|지역|날씨|기온|온도|미세먼지|초미세먼지|대기질|일기예보|비|눈|우산|출근|퇴근|아침|저녁|밤|낮|주간|야간|요즘|최근|그쪽|이쪽|제주도)$/;

/** 표에 없는 지명 하나를 골라낸다(예: '강화도 날씨 어때'). */
function placeWordCandidates(message: string): string[] {
  const out: string[] = [];
  const re = /([가-힣]{2,8}?)\s*(?:은|는|이|가|의|에|에서|쪽|지역|근처)?\s*(?:날씨|기온|온도|미세먼지|초미세먼지|대기질|일기예보)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(message)) !== null) {
    const w = String(mm[1] || "").trim();
    if (!w || PLACE_STOP.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 1);
}

async function openMeteoJson(url: string, label: string): Promise<any | null> {
  try {
    const r = await fetchTextWithTimeout(url, { headers: { "User-Agent": "dokdo-frontdesk/1.1 (+https://googgoogsgm-alt.github.io/-/)" } }, LIVE_TIMEOUT_MS, label);
    if (!r.ok) return null;
    return JSON.parse(r.raw);
  } catch (e) {
    console.warn(`[frontdesk-chat] ${label} 실패: ${String((e as Error)?.message || e).slice(0, 140)}`);
    return null;
  }
}

/** 한글 지명이 표에 없을 때만 — 한국 지명·인구가 큰 후보를 고른다(동명 마을 오선택 방지). */
async function geocodePlace(name: string): Promise<Place | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=ko&format=json`;
  const j = await openMeteoJson(url, "geocoding");
  const list: any[] = Array.isArray(j?.results) ? j.results : [];
  if (!list.length) return null;
  const kr = list.filter((r) => String(r?.country_code || "") === "KR");
  const pool = kr.length ? kr : list;
  pool.sort((a, b) => Number(b?.population || 0) - Number(a?.population || 0));
  const best = pool[0];
  if (!best || typeof best.latitude !== "number" || typeof best.longitude !== "number") return null;
  const strong = ["PPLA", "PPLC", "PPLA2", "ADM1", "ADM2"].includes(String(best.feature_code || ""));
  if (!strong && Number(best.population || 0) < 50000) return null; // 애매한 지명은 쓰지 않는다
  return { name: String(best.name || name), lat: Number(best.latitude), lon: Number(best.longitude) };
}

async function liveWeatherBlock(message: string): Promise<string> {
  const hit = matchPlace(message);
  let place = hit.place;
  let note = "";
  if (!hit.matched) {
    const cand = placeWordCandidates(message);
    if (cand.length) {
      const g = await geocodePlace(cand[0]);
      if (g) place = g;
      else note = ` (지명 '${cand[0]}'을(를) 찾지 못해 서울 기준으로 조회)`;
    } else {
      note = " (지역을 지정하지 않아 서울 기준으로 조회)";
    }
  }

  const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FSeoul&forecast_days=3`;
  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=pm10,pm2_5&timezone=Asia%2FSeoul`;

  const [fcRes, aqRes] = await Promise.allSettled([
    openMeteoJson(fcUrl, "open-meteo forecast"),
    openMeteoJson(aqUrl, "open-meteo air-quality"),
  ]);
  const fc = settledVal(fcRes);
  const aq = settledVal(aqRes);
  if (!fc?.current) return "";

  const cur = fc.current || {};
  const daily = fc.daily || {};
  const maxT: number[] = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const minT: number[] = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const pop: number[] = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const dCode: number[] = Array.isArray(daily.weather_code) ? daily.weather_code : [];

  const lines: string[] = [];
  lines.push(`■ 날씨 — ${place.name}${note} (Open-Meteo · ${String(cur.time || "").replace("T", " ")} KST 기준)`);
  lines.push(
    ` 현재 기온 ${r1(cur.temperature_2m)}°C · 체감 ${r1(cur.apparent_temperature)}°C · ${wmoKo(cur.weather_code)}` +
    ` · 습도 ${r1(cur.relative_humidity_2m)}% · 바람 ${r1(cur.wind_speed_10m)}km/h · 강수 ${r1(cur.precipitation)}mm`,
  );
  if (maxT.length && minT.length) {
    lines.push(
      ` 오늘 최고 ${r1(maxT[0])}°C / 최저 ${r1(minT[0])}°C (${wmoKo(dCode[0])}) · 오늘 강수확률 ${r1(pop[0])}%`,
    );
  }
  if (maxT.length > 1 && minT.length > 1) {
    lines.push(` 내일 최고 ${r1(maxT[1])}°C / 최저 ${r1(minT[1])}°C (${wmoKo(dCode[1])}) · 내일 강수확률 ${r1(pop[1])}%`);
  }

  const pm10 = Number(aq?.current?.pm10);
  const pm25 = Number(aq?.current?.pm2_5);
  if (Number.isFinite(pm10) || Number.isFinite(pm25)) {
    const bits: string[] = [];
    if (Number.isFinite(pm10)) bits.push(`미세먼지 PM10 ${r1(pm10)}㎍/㎥ ${pmGrade("pm10", pm10)}`);
    if (Number.isFinite(pm25)) bits.push(`초미세먼지 PM2.5 ${r1(pm25)}㎍/㎥ ${pmGrade("pm25", pm25)}`);
    lines.push(` ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

/* ── 외부 시세 (Yahoo Finance) — 전시관 34종목은 context 우선이라 여기 넣지 않는다 ── */
type QuoteDef = { re: RegExp; symbol: string; name: string; kind: "crypto" | "index" | "fx" | "stock" };

const QUOTE_TABLE: QuoteDef[] = [
  { re: /비트코인|비트\s*코인|\bBTC\b/i, symbol: "BTC-USD", name: "비트코인", kind: "crypto" },
  { re: /이더리움|\bETH\b/i, symbol: "ETH-USD", name: "이더리움", kind: "crypto" },
  { re: /리플|\bXRP\b/i, symbol: "XRP-USD", name: "리플", kind: "crypto" },
  { re: /솔라나|\bSOL\b/i, symbol: "SOL-USD", name: "솔라나", kind: "crypto" },
  { re: /도지코인|도지|\bDOGE\b/i, symbol: "DOGE-USD", name: "도지코인", kind: "crypto" },
  { re: /코스피\s*200|KOSPI\s*200|KOSPI200/i, symbol: "^KS200", name: "코스피200", kind: "index" },
  { re: /코스피|KOSPI/i, symbol: "^KS11", name: "코스피", kind: "index" },
  { re: /코스닥|KOSDAQ/i, symbol: "^KQ11", name: "코스닥", kind: "index" },
  { re: /나스닥|NASDAQ/i, symbol: "^IXIC", name: "나스닥 종합지수", kind: "index" },
  { re: /다우존스|다우|DOW\b/i, symbol: "^DJI", name: "다우존스 산업평균", kind: "index" },
  { re: /S&P\s*500|S&P500|에스앤피/i, symbol: "^GSPC", name: "S&P 500", kind: "index" },
  { re: /원\s*달러|달러\s*원|원달러|USD\s*\/?\s*KRW|환율/i, symbol: "USDKRW=X", name: "원/달러 환율", kind: "fx" },
  { re: /엔\s*달러|달러\s*엔|엔화|\bJPY\b/i, symbol: "JPY=X", name: "달러/엔 환율", kind: "fx" },
  { re: /유로|EUR\b/i, symbol: "EURUSD=X", name: "유로/달러", kind: "fx" },
  { re: /파운드|GBP\b/i, symbol: "GBPUSD=X", name: "파운드/달러", kind: "fx" },
  { re: /위안|\bCNY\b|\bCNH\b/i, symbol: "USDCNY=X", name: "달러/위안", kind: "fx" },
  { re: /삼성전자/, symbol: "005930.KS", name: "삼성전자", kind: "stock" },
  { re: /SK\s*하이닉스|하이닉스|HYNIX/i, symbol: "000660.KS", name: "SK하이닉스", kind: "stock" },
  { re: /현대자동차|현대차/, symbol: "005380.KS", name: "현대차", kind: "stock" },
  { re: /LG에너지솔루션|LG엔솔/, symbol: "373220.KS", name: "LG에너지솔루션", kind: "stock" },
  { re: /삼성바이오로직스/, symbol: "207940.KS", name: "삼성바이오로직스", kind: "stock" },
  { re: /기아(?!\s*차)/, symbol: "000270.KS", name: "기아", kind: "stock" },
  { re: /네이버|NAVER/i, symbol: "035420.KS", name: "NAVER", kind: "stock" },
  { re: /카카오|KAKAO/i, symbol: "035720.KS", name: "카카오", kind: "stock" },
  { re: /엔비디아|NVIDIA|\bNVDA\b/i, symbol: "NVDA", name: "엔비디아", kind: "stock" },
  { re: /테슬라|TESLA|\bTSLA\b/i, symbol: "TSLA", name: "테슬라", kind: "stock" },
  { re: /애플|APPLE|\bAAPL\b/i, symbol: "AAPL", name: "애플", kind: "stock" },
  { re: /마이크로소프트|마소|\bMSFT\b/i, symbol: "MSFT", name: "마이크로소프트", kind: "stock" },
  { re: /알파벳|구글|GOOGL?/i, symbol: "GOOGL", name: "알파벳(구글)", kind: "stock" },
  { re: /아마존|\bAMZN\b/i, symbol: "AMZN", name: "아마존", kind: "stock" },
  { re: /메타(?!버스|데이터|\s*플랫폼)|\bMETA\b/i, symbol: "META", name: "메타", kind: "stock" },
  { re: /TSMC|티에스엠씨|\bTSM\b/i, symbol: "TSM", name: "TSMC", kind: "stock" },
  { re: /브로드컴|\bAVGO\b/i, symbol: "AVGO", name: "브로드컴", kind: "stock" },
  { re: /팔란티어|\bPLTR\b/i, symbol: "PLTR", name: "팔란티어", kind: "stock" },
  { re: /\bAMD\b|에이엠디/i, symbol: "AMD", name: "AMD", kind: "stock" },
  { re: /인텔|\bINTC\b/i, symbol: "INTC", name: "인텔", kind: "stock" },
  { re: /넷플릭스|\bNFLX\b/i, symbol: "NFLX", name: "넷플릭스", kind: "stock" },
];

const QUOTE_INTENT_RE = /주가|시세|가격|얼마|시세|등락|상승|하락|폭락|폭등|올랐|떨어|어때|어떻게|전망|차트|알려|지금|현재|오늘/;
const QUOTE_STRONG_RE = /비트코인|이더리움|리플|솔라나|도지|코스피|코스닥|원\s*달러|달러\s*원|환율|삼성전자|하이닉스|엔비디아|테슬라|나스닥|다우/i;

/** 메시지에 나온 외부 자산 — 의도어가 없어도 '비트코인'처럼 확실한 자산이면 조회한다(메타버스 같은 오인 방지). */
function quoteMatches(message: string): QuoteDef[] {
  const hit: QuoteDef[] = [];
  for (const q of QUOTE_TABLE) {
    if (q.re.test(message) && !hit.some((h) => h.symbol === q.symbol)) hit.push(q);
  }
  if (!hit.length) return [];
  if (QUOTE_INTENT_RE.test(message)) return hit.slice(0, 3);
  return QUOTE_STRONG_RE.test(message) ? hit.slice(0, 3) : [];
}

/** 대문자 티커(예: 'PLTR 주가') — 표에 없는 종목도 Yahoo 검색으로 한 번 찾아본다. */
function latinTickers(message: string): string[] {
  const out: string[] = [];
  const STOP = new Set([
    "TV", "AI", "VIP", "PIN", "OK", "KST", "URL", "APP", "CEO", "GDP", "CPI", "PPI", "FOMC", "COT", "OI",
    "MACD", "CCI", "SNS", "BGM", "HUD", "USD", "KR", "US", "AND", "THE", "FOR", "PM", "AM", "E", "WASD",
  ]);
  const re = /\b([A-Z]{2,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const s = m[1];
    if (STOP.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out.slice(0, 2);
}

async function yahooChart(symbol: string): Promise<any | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  try {
    const r = await fetchTextWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dokdo-frontdesk/1.1)" },
    }, LIVE_TIMEOUT_MS, `yahoo ${symbol}`);
    if (!r.ok) return null;
    const j = JSON.parse(r.raw);
    return j?.chart?.result?.[0] || null;
  } catch (e) {
    console.warn(`[frontdesk-chat] yahoo ${symbol} 실패: ${String((e as Error)?.message || e).slice(0, 140)}`);
    return null;
  }
}

async function yahooSearchSymbol(query: string): Promise<string | null> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0&listsCount=0`;
  try {
    const r = await fetchTextWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dokdo-frontdesk/1.1)" },
    }, LIVE_TIMEOUT_MS, "yahoo search");
    if (!r.ok) return null;
    const j = JSON.parse(r.raw);
    const q = Array.isArray(j?.quotes) ? j.quotes.find((x: any) => x && x.symbol) : null;
    return q ? String(q.symbol) : null;
  } catch (_e) {
    return null;
  }
}

function unitLabel(currency: string, kind: string): string {
  if (kind === "index") return "포인트";
  const map: Record<string, string> = {
    KRW: "원", USD: "달러", JPY: "엔", EUR: "유로", GBP: "파운드", CNY: "위안", HKD: "홍콩달러",
  };
  return map[currency] || currency || "";
}

function fmtPrice(v: number, currency = "", kind = "stock"): string {
  const abs = Math.abs(v);
  let digits: number;
  if (kind === "index") digits = 2;                        // 코스피 4,869.96
  else if (currency === "KRW") digits = kind === "fx" ? 2 : (abs >= 100 ? 0 : 2); // 삼성전자 183,100 / 환율 1,346.13
  else if (abs >= 1) digits = 2;                           // 60,011.35
  else digits = 4;                                         // 아주 작은 코인 단가
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function quoteLine(label: string, symbol: string, res: any, kind: string): string {
  const meta = res?.meta || {};
  const closesRaw = res?.indicators?.quote?.[0]?.close;
  const closes: number[] = Array.isArray(closesRaw)
    ? closesRaw.filter((v: unknown) => typeof v === "number" && Number.isFinite(v as number)).map((v: number) => v)
    : [];
  let price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) && closes.length) price = closes[closes.length - 1] as number;
  if (!Number.isFinite(price)) return "";

  let pct = Number(meta.regularMarketChangePercent);
  let prev = Number(meta.previousClose ?? meta.chartPreviousClose);
  // meta.chartPreviousClose 는 '차트 구간 시작 전' 종가라 전일 종가가 아닐 수 있다.
  // 등락률과 어긋나면 등락률로 전일 종가를 역산해 두 수치가 서로 맞게 만든다.
  const consistent = Number.isFinite(prev) && prev !== 0 && Number.isFinite(pct) &&
    Math.abs(((price - prev) / prev) * 100 - pct) <= 0.5;
  if (!Number.isFinite(pct)) {
    if (Number.isFinite(prev) && prev !== 0) {
      pct = ((price - prev) / prev) * 100;
    } else if (closes.length >= 2) {
      const p2 = closes[closes.length - 2] as number;
      if (p2) { prev = p2; pct = ((price - p2) / p2) * 100; }
    }
  } else if (!consistent && pct !== -100) {
    prev = price / (1 + pct / 100);
  }
  const unit = unitLabel(String(meta.currency || ""), kind);
  let chg = Number(meta.regularMarketChange ?? meta.fulldayChange);
  if (!Number.isFinite(chg) && Number.isFinite(prev)) chg = price - prev;
  // 등락률과 부호가 어긋나면 전일 종가로 다시 계산한다(데이터가 서로 안 맞을 때)
  if (Number.isFinite(chg) && Number.isFinite(pct) && chg !== 0 && pct !== 0 && (chg > 0) !== (pct > 0) && Number.isFinite(prev)) {
    chg = price - prev;
  }
  const unitText = unit ? unit : "";
  const priceText = `${fmtPrice(price, String(meta.currency || ""), kind)}${unitText}`;
  const pctText = Number.isFinite(pct) ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "";
  const chgText = Number.isFinite(chg) ? `${chg >= 0 ? "+" : ""}${fmtPrice(chg, String(meta.currency || ""), kind)}${unitText}` : "";
  let vs = "";
  if (chgText && pctText) vs = ` · 전일 대비 ${chgText} (${pctText})`;
  else if (pctText) vs = ` · 전일 대비 ${pctText}`;
  else if (chgText) vs = ` · 전일 대비 ${chgText}`;
  return ` ${label}(${symbol}) 현재 ${priceText}${vs}`;
}

async function liveQuoteBlock(message: string): Promise<string> {
  const defs = quoteMatches(message);
  const lines: string[] = [];
  const tasks: Array<Promise<string>> = [];

  for (const d of defs) {
    tasks.push((async () => {
      const res = await yahooChart(d.symbol);
      return res ? quoteLine(d.name, d.symbol, res, d.kind) : "";
    })());
  }

  // 표에 없는 대문자 티커는 검색으로 심볼을 확인한 뒤 조회한다.
  if (defs.length < 3) {
    for (const tk of latinTickers(message)) {
      if (defs.some((d) => d.symbol.toUpperCase() === tk)) continue;
      tasks.push((async () => {
        const sym = await yahooSearchSymbol(tk);
        if (!sym) return "";
        const res = await yahooChart(sym);
        return res ? quoteLine(tk, sym, res, "stock") : "";
      })());
    }
  }

  if (!tasks.length) return "";
  const settled = await Promise.allSettled(tasks.slice(0, 3));
  for (const r of settled) {
    const line = settledVal(r);
    if (line) lines.push(line);
  }
  if (!lines.length) return "";
  const stamp = kstNow().label;
  return `■ 외부 시세 — Yahoo Finance · ${stamp} 조회 (전시관 34종목 밖 자산)\n${lines.join("\n")}`;
}

/* ── 뉴스·웹 검색 (Google News RSS + 한국어 위키백과) ─────────── */

/** XML 안전 디코드 — CDATA·HTML 엔티티·태그 제거. */
function xmlDecode(input: string): string {
  let t = String(input || "");
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
    const cp = parseInt(String(hex), 16);
    try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : " "; } catch { return " "; }
  });
  t = t.replace(/&#(\d+);/g, (_m, dec) => {
    const cp = parseInt(String(dec), 10);
    try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : " "; } catch { return " "; }
  });
  t = t.replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  t = t.replace(/<[^>]*>/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

type NewsItem = { title: string; source: string; published: string };

function parseRssItems(xml: string, limit = 6): NewsItem[] {
  const out: NewsItem[] = [];
  const parts = String(xml || "").split(/<item[\s>]/).slice(1);
  for (const raw of parts) {
    const item = raw.split("</item>")[0] || "";
    let title = xmlDecode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const source = xmlDecode((item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    const pub = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    if (!title) continue;
    // 구글 뉴스 제목은 '제목 - 언론사' 꼴이다 — 언론사는 따로 쓰므로 꼬리를 뗀다.
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    title = title.replace(/\s+-\s+[^-]{1,25}$/, "").trim();
    if (!title) continue;
    if (out.some((o) => o.title.slice(0, 18) === title.slice(0, 18))) continue;
    out.push({ title: title.slice(0, 90), source: source.slice(0, 24), published: pub });
    if (out.length >= limit) break;
  }
  return out;
}

const GREET_ONLY_RE = /^(?:(?:안녕|안녕하세요|하이|헬로|반거|반가워요|반가워|반갑습니다|고마워요|고마워|고맙습니다|감사합니다|감사해요|감사|수고했어요|수고하셨어요|수고|잘\s*가요|잘\s*가|또\s*봐요|또\s*봐|ㅎㅇ|ㅋㅋ+|hi|hello|hey|thanks?|thank\s*you|ok|okay|네|예|응|어|아|그래|그래요|좋아요|좋아)[\s!?.~,、👋🙂😊☺️👍]*){1,4}$/i;

const WEATHER_RE = /날씨|기온|온도|기상|일기예보|우산|미세먼지|초미세먼지|대기질|황사|폭우|폭설|한파|폭염|장마|추워|추운|추울|더워|더운|더울|습도|비\s*(?:가|는|좀|오나|올|와|오|온다)|눈\s*(?:이|은|좀|오나|올|와|오|온다)/;

const NEWS_RE = /뉴스|속보|헤드라인|보도|소식|검색|찾아\s*(?:줘|봐|주세요)|알아\s*봐|알아봐|최신|최근|요즘|동향|전망|발표|출시|개최|개막|사건|사고|정책|선거|판결|탄핵|전쟁|휴전|협상|결과|순위|인물|누구|누가|언제|어디서|몇\s*(?:명|개|시|년|월|일)|얼마/;

const INTERNAL_RE = /전시관|전시실|부스|판넬|회의실|방명록|프런트|데스크|포털|음성\s*(?:대화|회의|방)|입장\s*(?:코드|하)|직원\s*(?:등급|관리)|루아|도현|쇼츠|뉴스\s*TV|사용법|조작|2층|1층/;

const WIKI_RE = /뭐야|뭐지|뭔가요|무엇인가요|무엇인지|무엇입니까|무슨\s*(?:뜻|의미|건가|거야)|정의|뜻이\s*뭐|설명해\s*(?:줘|주세요)|이란\s*[?？]?|라는\s*(?:게|건)\s*뭐|누구야|누구지|유래|어원/;

/** 질문에서 검색어만 남긴다(요청 동사·의문 어미·군더더기 제거). */
function coreQuery(message: string): string {
  let q = String(message || "").normalize("NFC");
  if (!q) return "";
  q = q.replace(/https?:\/\/\S+/g, " ");
  q = q.replace(/(?:알려\s*주세요|알려\s*줘|알려줘|알려\s*주십시오|검색해\s*주세요|검색해\s*줘|검색해|찾아\s*주세요|찾아\s*줘|찾아봐|찾아\s*봐|보여\s*주세요|보여\s*줘|보여줘|설명해\s*주세요|설명해\s*줘|설명\s*좀|말해\s*줘|말해줘|궁금해|궁금한데|궁금해요|알고\s*싶어)/g, " ");
  q = q.replace(/^(?:혹시|저기|근데|그런데|그럼|음+|자|피콜아|루아야|루아|도현아|도현|선생님)\s*/g, " ");
  // 시간·군더더기 낱말은 어디에 있어도 검색을 흐리므로 지운다('코스피 지금 어때' → '코스피').
  q = q.replace(/(?:지금|현재|요즘|오늘|최근|최신|실시간|좀|혹시)\s*/g, " ");
  q = q.replace(/(?:에\s*대해서|에\s*대해|에\s*대한|에\s*관해서|에\s*관해|에\s*관한|에\s*대하여|대해서|관해서)/g, " ");
  // 의문 표현은 긴 것부터 뗀다('트럼프가 누구야?' → '트럼프')
  q = q.replace(/(?:은|는|이|가|을|를|의)?\s*(?:누구야|누구지|누구인가요|누구세요|누구입니까|누가|뭐야|뭐지|뭔가요|무엇인가요|무엇인지|무엇입니까|무슨\s*뜻이야|무슨\s*뜻인가요|무슨\s*의미야|무슨\s*뜻이지|정의야|이라는\s*게\s*뭐야|이란|라는|얼마야|얼마예요|얼마인가요|얼마지|얼마임|어때요|어때|어떤가요|어떤가|어떤지|어떻게|괜찮아|괜찮을까|좋을까|될까|할까)\s*[?？!！.~]*$/g, " ");
  q = q.replace(/(?:이|가|은|는|을|를|의|와|과|도|만|랑|이랑|하고)?\s*(?:인가요|인가|이야|야|지|냐|나요|나|까|요)\s*[?？!！.~]*$/g, " ");
  q = q.replace(/[?？!！.~,、·"'“”‘’()\[\]{}<>:;]/g, " ");
  q = q.replace(/\s+/g, " ").trim();
  return q.slice(0, 60).trim();
}

function isHeadlineRequest(q: string): boolean {
  const s = String(q || "").replace(/\s+/g, "");
  if (!s) return true;
  if (s.length <= 4) return /^(?:뉴스|속보|헤드라인|주요뉴스|오늘뉴스|최신뉴스|실시간뉴스|종합뉴스)$/.test(s);
  return /^(?:주요|오늘|최신|실시간|전체|종합)*(?:뉴스|속보|헤드라인)$/.test(s);
}

async function fetchRss(url: string): Promise<string> {
  try {
    const r = await fetchTextWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dokdo-frontdesk/1.1)" },
    }, LIVE_TIMEOUT_MS, "google news");
    return r.ok ? r.raw : "";
  } catch (e) {
    console.warn(`[frontdesk-chat] google news 실패: ${String((e as Error)?.message || e).slice(0, 140)}`);
    return "";
  }
}

async function liveNewsBlock(message: string): Promise<string> {
  const q = coreQuery(message);
  const headline = isHeadlineRequest(q);
  const url = headline
    ? "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko"
    : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
  const xml = await fetchRss(url);
  if (!xml) return "";
  const items = parseRssItems(xml, 5);
  if (!items.length) return "";
  const now = kstNow();
  const lines = items.map((it, i) => {
    const when = kstShortStamp(it.published, now);
    const src = it.source ? ` · ${it.source}` : "";
    const time = when ? ` · ${when}` : "";
    return ` ${i + 1}) ${it.title}${src}${time}`;
  });
  const head = headline ? "■ 뉴스 — Google 뉴스 주요 헤드라인(한국)" : `■ 뉴스 — '${q}' 관련 최신 기사(Google 뉴스 한국)`;
  return `${head} · ${now.label} 조회\n${lines.join("\n")}`;
}

async function liveWikiBlock(message: string): Promise<string> {
  const q = coreQuery(message);
  if (!q) return "";
  const title = q.split(" ").slice(0, 3).join(" ").trim();
  if (title.length < 2) return "";
  const url = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, "_"))}?redirect=true`;
  try {
    const r = await fetchTextWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dokdo-frontdesk/1.1)", "Accept-Language": "ko" },
    }, LIVE_TIMEOUT_MS, "wikipedia");
    if (!r.ok) return "";
    const j = JSON.parse(r.raw);
    if (!j || j.type === "disambiguation" || !j.extract) return "";
    const norm = (s: unknown) => String(s || "").replace(/\s+/g, "").toLowerCase();
    const t = norm(j.title);
    const k = norm(q);
    if (!t || !k) return "";
    // 제목이 질문과 실제로 겹칠 때만 쓴다(동음 문서 오인 방지)
    if (!t.includes(k) && !k.includes(t)) return "";
    const extract = String(j.extract).replace(/\s+/g, " ").slice(0, 300);
    return `■ 위키백과 — ${j.title}: ${extract}`;
  } catch (e) {
    console.warn(`[frontdesk-chat] wikipedia 실패: ${String((e as Error)?.message || e).slice(0, 140)}`);
    return "";
  }
}

type LivePlan = { weather: boolean; quotes: boolean; news: boolean; wiki: boolean };

const NONE_PLAN: LivePlan = { weather: false, quotes: false, news: false, wiki: false };

/** 질문을 보고 어떤 외부 조회를 할지 정한다(인사·순수 전시관 안내에는 아무 것도 조회하지 않는다). */
function planExternal(message: string): LivePlan {
  const m = String(message || "").trim();
  if (m.length < 2) return NONE_PLAN;
  if (GREET_ONLY_RE.test(m)) return NONE_PLAN;

  const weather = WEATHER_RE.test(m);
  const quotes = quoteMatches(m).length > 0;
  const internal = INTERNAL_RE.test(m);

  let news = false;
  if (/뉴스|속보|헤드라인|보도/.test(m) && !/뉴스\s*TV/.test(m)) news = true;
  else if (NEWS_RE.test(m) && !internal && !weather && !quotes) news = true;

  const wiki = WIKI_RE.test(m) && !internal && !weather && !quotes;
  return { weather, quotes, news, wiki };
}

/** 실시간 외부 검색 결과 블록. 아무 것도 못 받으면 빈 문자열(답변은 그대로 나간다). */
async function fetchExternalLive(message: string): Promise<{ block: string; sources: string[] }> {
  const sources: string[] = [];
  try {
    const plan = planExternal(message);
    const jobs: Array<{ label: string; promise: Promise<string> }> = [];
    if (plan.weather) jobs.push({ label: "weather", promise: liveWeatherBlock(message) });
    if (plan.quotes) jobs.push({ label: "quotes", promise: liveQuoteBlock(message) });
    if (plan.news) jobs.push({ label: "news", promise: liveNewsBlock(message) });
    if (plan.wiki) jobs.push({ label: "wiki", promise: liveWikiBlock(message) });
    if (!jobs.length) return { block: "", sources };

    const settled = await Promise.allSettled(jobs.map((j) => j.promise));
    const parts: string[] = [];
    settled.forEach((res, i) => {
      const val = settledVal(res);
      if (val) {
        parts.push(val);
        sources.push(jobs[i].label);
      } else if (res.status === "rejected") {
        console.warn(`[frontdesk-chat] 외부 조회 ${jobs[i].label} 실패: ${String((res.reason as Error)?.message || res.reason).slice(0, 140)}`);
      }
    });
    if (!parts.length) return { block: "", sources: [] };

    const now = kstNow();
    // Groq 무료 티어(TMP 8,000) 보호 — 외부 블록은 2,000자까지만 싣는다.
    let body = parts.join("\n");
    if (body.length > 2000) body = body.slice(0, 2000).replace(/[^\n]*$/, "").replace(/\s+$/, "") + "\n …(이하 생략)";
    const block = [
      `[실시간 외부 검색 결과 · ${now.label} 조회 — 아래 출처·시각·수치만 그대로 근거로 답한다]`,
      body,
      "※ 이 블록에 없는 수치·기사는 지어내지 않는다. 전시관 34종목의 수치는 [전시관 실시간 데이터]가 우선이다.",
    ].join("\n");
    return { block, sources };
  } catch (e) {
    console.warn(`[frontdesk-chat] 외부 조회 전체 실패: ${String((e as Error)?.message || e).slice(0, 160)}`);
    return { block: "", sources: [] };
  }
}

/* ── Gemini ──────────────────────────────────────────────── */
async function askGemini(
  key: string,
  model: string,
  system: string,
  history: ChatTurn[],
  message: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text }],
  }));
  contents.push({ role: "user", parts: [{ text: message }] });

  const res = await fetchTextWithTimeout(url, {
    method: "POST",
    // 키는 URL 이 아니라 헤더로 — Content.role 은 'user'|'model' 만 허용하므로 systemInstruction 에 role 을 넣지 않는다.
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      // Gemini 4 / 3.6+ 에서 temperature·topP 는 deprecated(경고·향후 400)라 보내지 않는다.
      // thinking 모델이 1024 토큰에서 본문 전에 잘리지 않도록 4096 으로 넉넉히 준다.
      generationConfig: { maxOutputTokens: 4096 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
    }),
  }, GEMINI_TIMEOUT_MS, `gemini ${model}`);

  const raw = res.raw;
  if (!res.ok) {
    const err = new Error(`gemini ${model} HTTP ${res.status}`) as Error & { status?: number; detail?: string };
    err.status = res.status;
    err.detail = raw.slice(0, 300);
    throw err;
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`gemini ${model} 응답을 읽지 못했습니다`);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text || "").join("").trim() : "";
  if (!text) {
    const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "빈 응답";
    throw new Error(`gemini ${model} ${why}`);
  }
  return text;
}

/* ── Groq (OpenAI 호환) ──────────────────────────────────── */
async function askGroq(
  key: string,
  model: string,
  system: string,
  history: ChatTurn[],
  message: string,
): Promise<string> {
  const messages = [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: message },
  ];
  const res = await fetchTextWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.65, max_tokens: 1024, top_p: 0.95 }),
  }, GROQ_TIMEOUT_MS, `groq ${model}`);
  const raw = res.raw;
  if (!res.ok) {
    const err = new Error(`groq ${model} HTTP ${res.status}`) as Error & { status?: number; detail?: string };
    err.status = res.status;
    err.detail = raw.slice(0, 300);
    throw err;
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`groq ${model} 응답을 읽지 못했습니다`);
  }
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error(`groq ${model} 빈 응답`);
  return text;
}

/* ── 핸들러 ──────────────────────────────────────────────── */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method-not-allowed", reply: "" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad-json", reply: "" });
  }

  const character = String(body.character || "lua").toLowerCase() === "dohyun" ? "dohyun" : "lua";

  // 사람 목소리(TTS) — 채팅 대신 Gemini TTS 오디오를 돌려준다(같은 함수·같은 키)
  if (String(body.action || "").toLowerCase() === "tts") return await handleTts(body);

  const message = String(body.message || "").trim().slice(0, 1500);
  if (!message) return json({ ok: false, error: "empty-message", reply: "", character });

  const history = trimHistory(body.history);
  // voiceMode:true — 말로 듣는 답변이므로 짧고 자연스러운 구어체 규칙을 더한다
  const voiceMode = body.voiceMode === true || body.voiceMode === "true" || body.voiceMode === 1;

  // 날씨·뉴스·외부 시세는 질문에 걸릴 때만 조회한다(인사·전시관 안내는 지연 없이 그대로).
  const live = await fetchExternalLive(message);
  const now = kstNow();

  const system = `${PROMPTS[character]}
${voiceMode ? "\n" + VOICE_RULES + "\n" : ""}
[지금 시각] ${now.label} — '오늘·어제·내일·이번 주' 같은 날짜 표현은 이 시각을 기준으로 센다.
${live.block ? "\n" + live.block + "\n" : ""}
[전시관 실시간 데이터 — 이 값만 사실로 인용한다]
${contextBlock(body.context)}

[답변 요청]
방문객 질문: ${message}
네 캐릭터 말투로 친절하고 세련되게 답한다. ${live.block ? "질문이 날씨·뉴스·외부 시세·인물/개념 같은 외부 사실에 걸리면 위 [실시간 외부 검색 결과]의 값과 출처·시각을 그대로 인용해 답하고, 블록에 없는 수치는 말하지 않는다. " : ""}전시관 안내·시세·종목 수치·일정은 위 데이터와 전시관 지식에 있는 값만 쓰고, 일반 대화·상식 질문은 네가 아는 만큼 자연스럽게 답한다.`;

  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const groqKey = Deno.env.get("GROQ_API_KEY") || "";
  const errors: string[] = [];

  // 1순위 Groq — 빠르고 무료 한도가 넉넉하다. 모델을 차례로 시도(429·오류는 다음 모델).
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      try {
        const text = await askGroq(groqKey, model, system, history, message);
        const { text: reply, moves } = extractMoves(text, message);
        return json({ ok: true, provider: "groq", model, reply, character, moves, live: live.sources });
      } catch (e) {
        const err = e as Error & { status?: number; detail?: string };
        errors.push(`${err.message}${err.detail ? " · " + err.detail : ""}`);
        console.warn(`[frontdesk-chat] groq ${model} 실패: ${err.message}${err.status ? " (HTTP " + err.status + ")" : ""}`);
        // 400·404(모델 없음)·429(한도)·타임아웃은 다음 모델로, 인증 오류(401·403)는 Groq 전체를 건너뛴다
        if (err.status === 401 || err.status === 403) break;
      }
    }
  } else {
    errors.push("GROQ_API_KEY 없음");
  }

  // 2순위 Gemini(보조) — 모델을 차례로 시도
  if (geminiKey) {
    for (const model of GEMINI_MODELS) {
      try {
        const text = await askGemini(geminiKey, model, system, history, message);
        const { text: reply, moves } = extractMoves(text, message);
        console.log(`[frontdesk-chat] groq 실패 → gemini ${model} 로 답변 (groq 오류 ${errors.length}건)`);
        return json({
          ok: true, provider: "gemini", model, reply, character, moves, live: live.sources,
          // Groq 단계에서 넘어왔다는 표시(키 값 없음 · 상태코드/모델명 수준만)
          fallbackFrom: errors.length ? "groq" : undefined,
          errors: errors.slice(0, 3).map((e) => e.slice(0, 140)),
        });
      } catch (e) {
        const err = e as Error & { status?: number; detail?: string };
        errors.push(`${err.message}${err.detail ? " · " + err.detail : ""}`);
        console.warn(`[frontdesk-chat] gemini ${model} 실패: ${err.message}${err.status ? " (HTTP " + err.status + ")" : ""}`);
        if (err.status === 401 || err.status === 403) break;
      }
    }
  } else {
    errors.push("GEMINI_API_KEY 없음");
  }

  // 둘 다 실패 — 화면은 내장 안내 모드로 답한다(에러 팝업 없음)
  return json({
    ok: false,
    error: "no-provider",
    detail: errors.join(" | ").slice(0, 600),
    // 어느 단계에서 넘어왔는지(키 값은 절대 담지 않는다 — 상태코드·모델명 수준만)
    fallbackFrom: errors.length ? "groq→gemini" : "none",
    errors: errors.slice(0, 4).map((e) => e.replace(/key=[^\s&]+/gi, "key=***")).map((e) => e.slice(0, 160)),
    reply: "",
    character,
    live: live.sources,
  });
});

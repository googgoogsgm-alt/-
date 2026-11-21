/**
 * 독도국제무역 · 3D 전시관 프런트데스크 AI (루아 · 도현)
 * ────────────────────────────────────────────────────────────────
 * Supabase Edge Function (Deno) — 단일 파일. 저장소에 함께 보관한다.
 *
 *  · 1순위  : Gemini (GEMINI_API_KEY)   gemini-3.8-flash → gemini-3.6-flash → gemini-2.5-flash
 *  · 백업   : Groq   (GROQ_API_KEY)     openai/gpt-oss-120b → qwen/qwen3.8-27b
 *  · 둘 다 없으면 { ok:false } 를 돌려주고, 전시관 화면은 내장 안내 모드로 매끄럽게 답한다.
 *
 * 요청 (POST JSON)
 *   { character: 'lua' | 'dohyun', message: '...', history: [{role,text}], context: {...} }
 * 응답 (JSON)
 *   { ok:true, provider:'gemini'|'groq', model:'...', reply:'...', character:'lua', moves:[{zone,ticker,label}] }
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
 *        GEMINI_API_KEY = (Google AI Studio 키)   ← 1순위
 *        GROQ_API_KEY   = (Groq 키)               ← 백업(선택)
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
 *     -d '{"character":"lua","message":"오늘 핵심 시장 뉴스 알려줘","context":{}}'
 *   ※ 키는 절대 전시관 HTML 에 넣지 않는다. 브라우저는 anon 키 + 이 함수만 부른다.
 */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// 2026-11 Gemini REST 기준 — gemini-2.5-flash 는 신규 키에서 404 로 막혀 기본 목록에서 뺐다.
const GEMINI_MODELS = [
  Deno.env.get("GEMINI_MODEL_1") || "gemini-4-hydrogen",
  Deno.env.get("GEMINI_MODEL_2") || "gemini-3.8-flash",
  Deno.env.get("GEMINI_MODEL_3") || "gemini-3.6-flash",
  Deno.env.get("GEMINI_MODEL_4") || "gemini-3.5-flash-lite",
];
const GROQ_MODELS = [
  Deno.env.get("GROQ_MODEL_1") || "openai/gpt-oss-120b",
  Deno.env.get("GROQ_MODEL_2") || "qwen/qwen3.8-27b",
];

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
· 2층 회의실: 대리석 바닥·네이비/글라스 벽, 12석 회의 테이블, 현판 '독도국제무역 회의실 · VIP · 직원 A·B 등급'.
  직원 등급 A·B만 입장할 수 있고 C 등급은 입장할 수 없다. 명단·등급·개인 코드는 관리자만(⚙️ 직원 등급 관리, 관리자 PIN) 다룬다.
  입장 인증은 이름 + 개인 입장 코드이며, 관리자가 정한 공용 A·B 코드로도 들어갈 수 있다(코드 값은 절대 말하지 않는다).
· 2층 회의실에서는 A·B 등급 전용 음성 회의를, 1층 중앙홀에서는 만난 방문자끼리 🎙️ 음성 대화를 할 수 있다.
  1층 중앙홀·전시실의 음성 대화는 같은 1층 방문자끼리만 연결되고(오른쪽 아래 '🎙️ 음성 대화' 단추), 2층 회의실 음성 회의('마이크 켜기')와는 완전히 분리된다.
  층을 옮기면 음성은 자동으로 끊긴다. 채팅의 🎙️ 음성방 탭도 지금 층에 맞는 안내와 버튼(1층 '🎙️ 1층 음성 대화 켜기' / 2층 '🎙️ 회의실 음성 참여')을 보여 준다.
· 회의실 동쪽 벽의 '중앙홀' 포털을 누르면 중앙홀로 돌아온다.
· 중앙홀에는 📺 뉴스 TV(남서쪽), 방명록 키오스크(남동쪽), 안내데스크 부스(남쪽 벽면)가 있고, 중앙 가운데는 비워 두어 동선이 넓다.
  (12석 회의 테이블·의자는 2층 회의실로 옮겼다.)
· 각 전시실 입구 오른쪽 벽에도 그 방 전용 뉴스 TV가 있다.
· 사용법: WASD/조이스틱 이동, 마우스·손가락 드래그로 시점, 판넬 클릭 또는 E 로 쇼츠 열기, 두 손가락 확대·축소, 방명록·채팅·음성방.
· 매매 지표: MACD 12·130·9, CCI 90 ±100, OI(미결제약정), COT(투기 포지션), 만기·롤오버 점검. 1~6개월 스윙 관점.
· 답변 원칙: 전달받은 context(실시간 news.json·exhibits.json·catalog.json)에 있는 사실만 수치로 말한다.
  확인되지 않은 실시간 시세·수치·일정은 절대 지어내지 말고 "그 수치는 지금 전시관 데이터에 없습니다. 뉴스 TV나 해당 전시실에서 확인해 주세요"라고 정확히 말한다.
  매매 권유·수익 보장은 하지 않는다(정보 제공·전시 안내까지).
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
· 확인된 데이터만 말하고 추측은 절대 하지 않는다. 데이터에 없으면 "그 수치는 지금 자료에 없어요"처럼 짧게 말하고 확인 경로를 한 마디 덧붙인다.
· 이동 안내가 필요하면 답변 맨 끝에 <<MOVE:구역ID>> 토큰만 붙인다(화면이 버튼으로 바꾸고, 읽히지 않는다).`;

/* ── 공용 도우미 ──────────────────────────────────────────── */
type ChatTurn = { role: "user" | "assistant"; text: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
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

  const res = await fetch(url, {
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
  });

  const raw = await res.text();
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
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.65, max_tokens: 1024, top_p: 0.95 }),
  });
  const raw = await res.text();
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
  const system = `${PROMPTS[character]}
${voiceMode ? "\n" + VOICE_RULES + "\n" : ""}
[지금 전시관의 실시간 데이터 — 이 값만 사실로 인용한다]
${contextBlock(body.context)}

[답변 요청]
방문객 질문: ${message}
위 데이터와 전시관 지식을 동원해, 네 캐릭터 말투로 친절하고 세련되게 답한다. 수치는 데이터에 있는 값만 쓴다.`;

  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const groqKey = Deno.env.get("GROQ_API_KEY") || "";
  const errors: string[] = [];

  // 1순위 Gemini — 모델을 차례로 시도(429·오류면 다음 모델)
  if (geminiKey) {
    for (const model of GEMINI_MODELS) {
      try {
        const text = await askGemini(geminiKey, model, system, history, message);
        const { text: reply, moves } = extractMoves(text, message);
        return json({ ok: true, provider: "gemini", model, reply, character, moves });
      } catch (e) {
        const err = e as Error & { status?: number; detail?: string };
        errors.push(`${err.message}${err.detail ? " · " + err.detail : ""}`);
        console.warn(`[frontdesk-chat] gemini ${model} 실패: ${err.message}${err.status ? " (HTTP " + err.status + ")" : ""}`);
        // 400·404(모델 없음) 와 429(한도) 는 다음 모델로, 인증 오류(401·403)는 Gemini 전체를 건너뛴다
        if (err.status === 401 || err.status === 403) break;
      }
    }
  } else {
    errors.push("GEMINI_API_KEY 없음");
  }

  // 2순위 Groq 백업
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      try {
        const text = await askGroq(groqKey, model, system, history, message);
        const { text: reply, moves } = extractMoves(text, message);
        console.log(`[frontdesk-chat] gemini 실패 → groq ${model} 로 답변 (gemini 오류 ${errors.length}건)`);
        return json({
          ok: true, provider: "groq", model, reply, character, moves,
          // Gemini 단계에서 넘어왔다는 표시(키 값 없음 · 상태코드/모델명 수준만)
          fallbackFrom: errors.length ? "gemini" : undefined,
          errors: errors.slice(0, 3).map((e) => e.slice(0, 140)),
        });
      } catch (e) {
        const err = e as Error & { status?: number; detail?: string };
        errors.push(`${err.message}${err.detail ? " · " + err.detail : ""}`);
        if (err.status === 401 || err.status === 403) break;
      }
    }
  } else {
    errors.push("GROQ_API_KEY 없음");
  }

  // 둘 다 실패 — 화면은 내장 안내 모드로 답한다(에러 팝업 없음)
  return json({
    ok: false,
    error: "no-provider",
    detail: errors.join(" | ").slice(0, 600),
    // 어느 단계에서 넘어왔는지(키 값은 절대 담지 않는다 — 상태코드·모델명 수준만)
    fallbackFrom: errors.length ? "gemini→groq" : "none",
    errors: errors.slice(0, 4).map((e) => e.replace(/key=[^\s&]+/gi, "key=***")).map((e) => e.slice(0, 160)),
    reply: "",
    character,
  });
});

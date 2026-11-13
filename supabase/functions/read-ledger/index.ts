// 거래장 사진 읽기: 저장소 사진 → Claude Haiku → 잔액 대조(금액·잔액 자동 교정) → (불일치·불명확 시) Sonnet 재시도
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODELS = { fast: "claude-haiku-5-5", accurate: "claude-sonnet-5-5" };

const PROMPT = `이 사진은 한국 의약품 도매/제약회사의 거래처 전자거래장(거래처 원장)입니다.
표의 거래 행을 위에서 아래 순서 그대로 모두 읽어 ledger 도구로 돌려주세요.

규칙
- kind: 매출·출고·판매 → "판매", 입금·수금 → "수금", 전기이월·전월이월·이월 → "이월", 반품 → "반품", 매출할인·할인 → "매출할인"
- 금액이 마이너스(-)로 찍힌 판매 행은 반품입니다: kind "반품", amount는 양수로. (적요에 할인이라고 적힌 마이너스 행은 "매출할인")
- 매출할인은 잔액을 줄이는 행입니다. 판매로 읽지 마세요.
- 거래장 모양: 한 거래가 두 줄로 찍히는 경우가 많습니다. 왼쪽 위=날짜, 왼쪽 아래=품목/적요, 가운데 위=수량, 가운데 아래=단가, 오른쪽 위=금액, 오른쪽 아래=잔액입니다. 수금(카드·현금·입금) 행도 똑같이 오른쪽 위가 수금액, 오른쪽 아래가 잔액입니다. 수금액이 바로 앞 잔액과 같아서 잔액이 0이 되는 경우도 흔하니 숫자가 같다고 위아래를 바꾸지 마세요.
- 두 줄짜리 거래는 반드시 한 행으로 합쳐서 돌려주세요. 날짜가 있는 윗줄과 바로 아래 품목/적요 줄이 한 거래입니다. 한 거래를 두 행으로 나누지 마세요.
- 가운데 아래 숫자(단가)는 금액이 아닙니다. 금액은 오른쪽 위 숫자입니다.
- 금액은 표에 찍힌 숫자를 그대로 쓰세요. 수량×단가로 직접 계산하거나 잔액 숫자를 금액에 옮겨 적지 마세요.
- 사진 맨 위나 맨 아래에서 거래의 한 줄만 잘려 보이면(날짜 줄만 있거나 품목 줄만 있는 경우) 그 거래는 넣지 마세요.
- 수금(카드·현금·입금) 행의 금액이 0이면 잘못 읽은 것입니다. 오른쪽 위 숫자를 다시 확인하세요.
- amount: 그 행의 거래 총액(원, 부가세 포함 합계). 단가·수량이 아니라 금액/합계 칸의 값. 쉼표 없이 정수.
- balance: 그 행 거래 후 잔액 칸의 값. 없으면 null.
- date: YYYY-MM-DD. 연도가 생략됐으면 표의 다른 날짜·출력일로 추정. 이월 행에 날짜가 없으면 "".
- item: 품목명이나 적요(없으면 "").
- 소계·합계·월계·누계 같은 요약 행은 넣지 마세요.
- 같은 날짜에 품목이 여러 줄이어도 거래장에 금액과 잔액이 따로 찍힌 행 단위로 읽으세요.
- 글자가 흐려 확실하지 않은 행은 추측하지 말고 unclear를 true로 표시하세요.
- customer_name: 거래처(병원/의원) 이름이 보이면 적고, 없으면 "".`;

const TOOL = {
  name: "ledger",
  description: "거래장에서 읽은 거래 행",
  input_schema: {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string" },
            kind: { type: "string", enum: ["이월", "판매", "수금", "반품", "매출할인"] },
            amount: { type: "integer" },
            item: { type: "string" },
            balance: { type: ["integer", "null"] },
            unclear: { type: "boolean" },
          },
          required: ["date", "kind", "amount", "item", "balance", "unclear"],
        },
      },
      notes: { type: "string" },
    },
    required: ["customer_name", "rows"],
  },
};

type Row = { date: string; kind: string; amount: number; item: string; balance: number | null; unclear: boolean; ok?: boolean; fixed?: string | boolean };

function check(rows: Row[]) {
  let prev: number | null = null;
  let bad = 0;
  for (const r of rows) {
    if (r.unclear) bad++;
    if (r.balance == null) { r.ok = undefined; continue; }
    if (r.kind === "이월" || prev == null) { r.ok = true; prev = r.balance; continue; }
    const delta = r.kind === "판매" ? r.amount : -r.amount;
    r.ok = prev + delta === r.balance;
    if (!r.ok) bad++;
    prev = r.balance;
  }
  return bad;
}

// 자동 교정: 잔액이 안 맞는 곳 근처에서
//  (1) 금액↔잔액을 위아래 바꿔 읽은 행 → 맞바꿔 보기 (fixed='swap')
//  (2) 두 줄짜리 거래를 두 행으로 나눠 읽은 경우 → 붙은 두 행을 한 거래로 합쳐 보기 (fixed='merge')
//  (3) 앞·뒤 행 잔액은 맞는데 이 행 금액만 틀린 경우 → 잔액 차이로 금액 계산 (fixed='derive')
// 고친 행과 다음 행까지 잔액이 맞고 전체 불일치가 줄어들 때만 채택
function merged(a: Row, b: Row): Row {
  const kind = a.kind !== "이월" ? a.kind : b.kind;
  return { ...a, date: a.date || b.date, kind, amount: Math.abs(a.amount || a.balance || 0), balance: b.balance,
    item: (a.item && a.item !== "매출할인" ? a.item : "") || b.item || a.item, unclear: a.unclear && b.unclear, fixed: "merge" };
}
function autoSwap(rows: Row[]) {
  let bad = check(rows);
  let from = 0;
  for (let guard = 0; guard < 20 && bad > 0; guard++) {
    const i = rows.findIndex((r, k) => k >= from && r.ok === false);
    if (i < 0) break;
    let done = false;
    const tries: Array<() => { trial: Row[]; at: number } | null> = [
      ...[i - 1, i].map((j) => () => {
        const r = rows[j];
        if (!r || r.kind === "이월" || r.balance == null || r.fixed) return null;
        const trial = rows.map((x) => ({ ...x }));
        trial[j] = { ...r, amount: Math.abs(r.balance), balance: r.amount, fixed: "swap" };
        return { trial, at: j };
      }),
      ...[i - 1, i].map((j) => () => {
        const a = rows[j], b = rows[j + 1];
        if (!a || !b || b.balance == null || (a.kind === "이월" && a.amount !== 0)) return null; // 진짜 전기이월은 합치지 않음
        const trial = rows.map((x) => ({ ...x }));
        trial.splice(j, 2, merged(a, b));
        return { trial, at: j };
      }),
      () => { // (3) 금액만 잘못 읽은 행: 바로 앞 잔액과 이 행 잔액의 차이가 금액
        const r = rows[i]; if (!r || r.kind === "이월" || r.balance == null || r.fixed) return null;
        let p = i - 1; while (p >= 0 && rows[p].balance == null) p--;
        if (p < 0 || rows[p].ok === false) return null;
        const diff = r.balance - (rows[p].balance as number);
        const amt = r.kind === "판매" ? diff : -diff;
        if (amt <= 0) return null; // 판매면 잔액이 늘고, 수금·반품·할인이면 줄어야 함
        const nx = rows.slice(i + 1).find((x) => x.balance != null);
        if (nx && nx.ok === false) return null; // 다음 행 잔액도 맞아야 (잔액을 잘못 읽은 경우 제외)
        const trial = rows.map((x) => ({ ...x }));
        trial[i] = { ...r, amount: amt, fixed: "derive" };
        return { trial, at: i };
      },
    ];
    for (const t of tries) {
      const r = t(); if (!r) continue;
      const b2 = check(r.trial);
      const localOk = r.trial.slice(r.at, r.at + 2).every((x) => x.ok !== false);
      if (b2 < bad && localOk) { rows.splice(0, rows.length, ...r.trial); bad = b2; done = true; break; }
    }
    from = done ? 0 : i + 1; // 못 고친 불일치는 건너뛰고 다음 불일치 확인
  }
  check(rows);
  return bad;
}

async function readWith(model: string, key: string, b64: string, mediaType: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "ledger" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  const tu = (body.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (!tu) throw new Error("읽기 결과가 비어 있습니다.");
  const out = tu.input as { customer_name: string; rows: Row[]; notes?: string };
  out.rows = (out.rows ?? []).map((r) => {
    const a = Math.round(Number(r.amount) || 0);
    const kind = a < 0 && r.kind === "판매" ? (/할인/.test(r.item ?? "") ? "매출할인" : "반품") : r.kind; // 마이너스 판매 = 반품(적요가 할인이면 매출할인)
    return { ...r, kind, amount: Math.abs(a) };
  });
  return { ...out, usage: body.usage };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "NO_KEY", message: "ANTHROPIC_API_KEY가 Supabase Secrets에 없습니다." }, 500);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      db: { schema: "receivables" },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "AUTH", message: "로그인이 필요합니다." }, 401);

    const { photo_id } = await req.json();
    const { data: photo, error: pe } = await sb.from("photos").select("*").eq("id", photo_id).single();
    if (pe || !photo) return json({ error: "PHOTO", message: "사진을 찾을 수 없거나 권한이 없습니다." }, 404);

    const { data: blob, error: de } = await sb.storage.from("ledger-photos").download(photo.storage_path);
    if (de || !blob) return json({ error: "DOWNLOAD", message: "사진 파일을 불러오지 못했습니다." }, 404);
    const mediaType = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(blob.type) ? blob.type : "image/jpeg";
    const b64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));

    let used = "haiku";
    let result = await readWith(MODELS.fast, key, b64, mediaType);
    let bad = autoSwap(result.rows);
    if (bad > 0 || result.rows.length === 0) {
      try {
        const r2 = await readWith(MODELS.accurate, key, b64, mediaType);
        const bad2 = autoSwap(r2.rows);
        if (r2.rows.length > 0 && bad2 <= bad) { result = r2; bad = bad2; used = "sonnet"; }
      } catch (_) { /* 재시도 실패 시 Haiku 결과 유지 */ }
    }

    await sb.from("photos").update({
      read_model: used,
      read_result: { customer_name: result.customer_name, rows: result.rows, notes: result.notes ?? "", bad },
      status: "읽기완료",
    }).eq("id", photo_id);

    return json({ model: used, customer_name: result.customer_name, rows: result.rows, bad, notes: result.notes ?? "" });
  } catch (e) {
    return json({ error: "READ", message: String((e as Error).message ?? e) }, 500);
  }
});

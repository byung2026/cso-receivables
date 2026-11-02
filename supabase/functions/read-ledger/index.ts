// 거래장 사진 읽기: 저장소 사진 → Claude Haiku → 잔액 대조 → (불일치·불명확 시) Sonnet 재시도
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
- kind: 매출·출고·판매 → "판매", 입금·수금 → "수금", 전기이월·전월이월·이월 → "이월", 반품 → "반품"
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
            kind: { type: "string", enum: ["이월", "판매", "수금", "반품"] },
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

type Row = { date: string; kind: string; amount: number; item: string; balance: number | null; unclear: boolean; ok?: boolean };

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
  out.rows = (out.rows ?? []).map((r) => ({ ...r, amount: Math.abs(Math.round(Number(r.amount) || 0)) }));
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
    let bad = check(result.rows);
    if (bad > 0 || result.rows.length === 0) {
      try {
        const r2 = await readWith(MODELS.accurate, key, b64, mediaType);
        const bad2 = check(r2.rows);
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

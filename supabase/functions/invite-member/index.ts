// 관리자 전용: 동료를 회전일 차트로 초대 (초대 메일 링크 → 앱 주소로 이동, 이름 미리 등록)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_URL = "https://byung2026.github.io/cso-receivables/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    // 1) 호출한 사람이 관리자인지 확인 (본인 권한으로)
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "AUTH", message: "로그인이 필요합니다." }, 401);
    const { data: isAdmin } = await asUser.rpc("is_admin");
    if (isAdmin !== true) return json({ error: "FORBIDDEN", message: "관리자만 초대할 수 있습니다." }, 403);

    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim().slice(0, 20);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "EMAIL", message: "이메일 형식이 맞지 않습니다." }, 400);
    if (!name) return json({ error: "NAME", message: "이름을 입력하세요." }, 400);

    // 2) 서버 권한으로 초대 메일 발송
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: APP_URL, data: { display_name: name } });
    if (error) {
      const m = /already|registered|exists/i.test(error.message)
        ? "이미 가입된 이메일입니다. 비밀번호를 모르면 로그인 화면의 '비밀번호를 잊으셨나요?'를 쓰게 하세요."
        : /rate|limit/i.test(error.message)
        ? "메일 발송 한도에 걸렸습니다. 1시간쯤 뒤에 다시 시도하세요."
        : error.message;
      return json({ error: "INVITE", message: m }, 400);
    }

    // 3) 이름 미리 등록 → 동료는 비밀번호만 정하면 바로 시작
    await admin.schema("receivables").from("members")
      .upsert({ user_id: data.user.id, display_name: name, active: true }, { onConflict: "user_id" });

    return json({ ok: true, email, name });
  } catch (e) {
    return json({ error: "SERVER", message: String((e as Error).message ?? e) }, 500);
  }
});

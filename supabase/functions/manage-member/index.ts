// 관리자 전용: 아이디로 동료 계정 직접 만들기 / 임시 비밀번호로 초기화 / 사용 중지·다시 사용
// 아이디는 내부적으로 '<아이디>@cso-chart.invalid' 형태의 가짜 메일로 저장 (메일 발송 없음)
// 첫 로그인 때 비밀번호를 바꾸도록 user_metadata.must_change_pw = true 표시
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ID_DOMAIN = "cso-chart.invalid";
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
    // 1) 호출한 사람이 관리자인지 확인
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "AUTH", message: "로그인이 필요합니다." }, 401);
    const { data: isAdmin } = await asUser.rpc("is_admin");
    if (isAdmin !== true) return json({ error: "FORBIDDEN", message: "관리자만 할 수 있습니다." }, 403);

    const body = await req.json();
    const action = String(body.action ?? "");
    const password = String(body.password ?? "");
    if ((action === "create" || action === "reset") && password.length < 8)
      return json({ error: "PW", message: "임시 비밀번호는 8자 이상으로 정하세요." }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    if (action === "create") {
      const loginId = String(body.login_id ?? "").trim().toLowerCase();
      const name = String(body.name ?? "").trim().slice(0, 20);
      if (!/^[a-z0-9][a-z0-9._-]{2,19}$/.test(loginId))
        return json({ error: "ID", message: "아이디는 영문 소문자·숫자로 3~20자 (예: hong01)" }, 400);
      if (!name) return json({ error: "NAME", message: "이름을 입력하세요." }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: `${loginId}@${ID_DOMAIN}`, password, email_confirm: true,
        user_metadata: { display_name: name, login_id: loginId, must_change_pw: true },
      });
      if (error) {
        const m = /already|registered|exists/i.test(error.message) ? "이미 있는 아이디입니다. 다른 아이디를 쓰세요." : error.message;
        return json({ error: "CREATE", message: m }, 400);
      }
      await admin.schema("receivables").from("members")
        .upsert({ user_id: data.user.id, display_name: name, active: true, login_id: loginId }, { onConflict: "user_id" });
      return json({ ok: true, login_id: loginId, name });
    }

    if (action === "reset" || action === "disable" || action === "enable") {
      const uid = String(body.user_id ?? "");
      if (!uid || uid === user.id) return json({ error: "TARGET", message: "본인 계정은 여기서 바꿀 수 없습니다." }, 400);
      // 다른 관리자 계정은 건드리지 않음
      const { data: targetIsAdmin, error: ae } = await admin.schema("receivables").rpc("is_admin_uid", { p_uid: uid });
      if (ae) return json({ error: "SERVER", message: ae.message }, 500);
      if (targetIsAdmin === true) return json({ error: "TARGET", message: "관리자 계정은 바꿀 수 없습니다." }, 400);
      if (action !== "reset") {
        // 사용 중지: 로그인 차단(ban) + members.active=false (데이터 접근도 막힘). 다시 사용: 둘 다 해제
        const off = action === "disable";
        const { error: be } = await admin.auth.admin.updateUserById(uid, { ban_duration: off ? "876000h" : "none" });
        if (be) return json({ error: "BAN", message: be.message }, 400);
        const { error: me } = await admin.schema("receivables").from("members").update({ active: !off }).eq("user_id", uid);
        if (me) return json({ error: "SERVER", message: me.message }, 500);
        return json({ ok: true, active: !off });
      }
      const { data: got, error: ge } = await admin.auth.admin.getUserById(uid);
      if (ge || !got?.user) return json({ error: "TARGET", message: "계정을 찾을 수 없습니다." }, 404);
      const { error } = await admin.auth.admin.updateUserById(uid, {
        password, user_metadata: { ...(got.user.user_metadata ?? {}), must_change_pw: true },
      });
      if (error) return json({ error: "RESET", message: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "ACTION", message: "알 수 없는 요청입니다." }, 400);
  } catch (e) {
    return json({ error: "SERVER", message: String((e as Error).message ?? e) }, 500);
  }
});

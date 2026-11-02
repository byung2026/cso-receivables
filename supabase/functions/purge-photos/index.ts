// 매일 새벽 실행: 올린 지 3개월 지난 거래장 사진 파일 삭제 (거래 기록은 그대로)
// 입력값을 받지 않고 '3개월 지난 사진'만 지우므로, 누가 호출해도 정해진 정리만 일어납니다.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const KEEP_MONTHS = 3;

Deno.serve(async () => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false }, db: { schema: "receivables" },
  });
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);

  let purged = 0;
  for (let round = 0; round < 20; round++) {
    const { data: rows, error } = await admin.from("photos")
      .select("id, storage_path").is("purged_at", null).lt("created_at", cutoff.toISOString()).limit(100);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    if (!rows?.length) break;
    const { error: re } = await admin.storage.from("ledger-photos").remove(rows.map((r) => r.storage_path));
    if (re) return new Response(JSON.stringify({ error: re.message, purged }), { status: 500 });
    await admin.from("photos").update({ purged_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
    purged += rows.length;
  }
  return new Response(JSON.stringify({ ok: true, purged, cutoff: cutoff.toISOString() }), {
    headers: { "Content-Type": "application/json" },
  });
});

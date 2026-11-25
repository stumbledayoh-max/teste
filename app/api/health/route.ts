import { backendMode, isConfigured } from "@/lib/backends";
import { adminEnabled, isDevAdminToken } from "@/lib/admin";
import { DEFAULT_TTL_DAYS } from "@/lib/token";
import { json } from "@/lib/http";
import { withPublicCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — estado do servidor de licenças (sem segredos). */
async function handleGet() {
  return json({
    ok: true,
    service: "license-key-server",
    store: backendMode(),
    supabaseConfigured: isConfigured(),
    adminEnabled: adminEnabled(),
    adminUsesDevToken: isDevAdminToken(),
    tokenTtlDays: DEFAULT_TTL_DAYS,
    time: new Date().toISOString(),
  });
}

export const GET = withPublicCors(handleGet);
export const OPTIONS = withPublicCors(() => new Response(null, { status: 204 }));

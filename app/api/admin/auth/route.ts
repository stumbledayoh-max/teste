import { adminEnabled, isValidAdminToken } from "@/lib/admin";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { json, readJson, tooMany } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/auth — valida o token do painel antes de abrir a tela.
 * Rate limit duro: 10 tentativas por 10 minutos por IP.
 */
export async function POST(req: Request) {
  const limit = rateLimit(`admin-auth:${clientIp(req)}`, 10, 10 * 60_000);
  if (!limit.ok) return tooMany(limit.retryAfter);

  if (!adminEnabled()) {
    return json(
      { ok: false, reason: "Painel desabilitado: configure ADMIN_TOKEN nas variáveis de ambiente." },
      503,
    );
  }

  const body = await readJson<{ token?: string }>(req);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!isValidAdminToken(token)) {
    return json({ ok: false, reason: "Token inválido." }, 401);
  }
  return json({ ok: true });
}

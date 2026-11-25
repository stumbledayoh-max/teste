import { licensing } from "@/lib/licensing";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { badRequest, json, readJson, serverError, tooMany } from "@/lib/http";
import { withPublicCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/deactivate
 * { token, deviceId }
 * → { ok, license }
 *
 * Libera o assento para o usuário ativar em outro aparelho.
 */
async function handlePOST(req: Request) {
  try {
    const limit = rateLimit(`deactivate:ip:${clientIp(req)}`, 30, 60_000);
    if (!limit.ok) return tooMany(limit.retryAfter);

    const body = await readJson<{ token?: string; deviceId?: string }>(req);
    if (!body) return badRequest("JSON inválido.");

    const token = typeof body.token === "string" ? body.token.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!token || !deviceId) return badRequest("token e deviceId são obrigatórios.");

    const result = await licensing.deactivate({ token, deviceId });
    if (!result.ok) return json({ ok: false, code: result.code, reason: result.reason }, 403);

    return json({ ok: true, license: result.license });
  } catch (e) {
    return serverError(e);
  }
}

export const POST = withPublicCors(handlePOST);
export const OPTIONS = withPublicCors(() => new Response(null, { status: 204 }));

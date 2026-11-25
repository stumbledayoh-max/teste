import { licensing } from "@/lib/licensing";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { badRequest, json, readJson, serverError, tooMany } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/validate
 * { token, deviceId }
 * → { ok, license, expiresAt, token? }  (token novo só quando perto de expirar)
 *
 * É o endpoint que o app chama no boot e no heartbeat. Revogação e expiração
 * sempre vencem aqui, mesmo que o token local ainda esteja assinado.
 */
export async function POST(req: Request) {
  try {
    const limit = rateLimit(`validate:ip:${clientIp(req)}`, 120, 60_000);
    if (!limit.ok) return tooMany(limit.retryAfter);

    const body = await readJson<{ token?: string; deviceId?: string }>(req);
    if (!body) return badRequest("JSON inválido.");

    const token = typeof body.token === "string" ? body.token.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!token) return badRequest("token é obrigatório.", "INVALID_TOKEN");
    if (!deviceId) return badRequest("deviceId é obrigatório.");

    const result = await licensing.validate({ token, deviceId });
    if (!result.ok) {
      return json({ ok: false, code: result.code, reason: result.reason }, 403);
    }

    return json({
      ok: true,
      license: result.license,
      expiresAt: result.expiresAt,
      token: result.token,
    });
  } catch (e) {
    return serverError(e);
  }
}

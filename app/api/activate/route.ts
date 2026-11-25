import { clientIp, rateLimit } from "@/lib/ratelimit";
import { licensing } from "@/lib/licensing";
import { badRequest, json, readJson, serverError, tooMany } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  key?: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
}

/**
 * POST /api/activate
 * { key, deviceId, deviceName?, platform? }
 * → { ok, token, expiresAt, license }
 */
export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const ipLimit = rateLimit(`activate:ip:${ip}`, 20, 5 * 60_000);
    if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);

    const body = await readJson<Body>(req);
    if (!body) return badRequest("JSON inválido.");

    const key = typeof body.key === "string" ? body.key.trim() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!key) return badRequest("Informe a key.");
    if (!deviceId) return badRequest("deviceId é obrigatório.");

    // trava por key (evita varrer combinações a partir de muitos IPs)
    const keyLimit = rateLimit(`activate:key:${key.slice(0, 32)}`, 10, 5 * 60_000);
    if (!keyLimit.ok) return tooMany(keyLimit.retryAfter);

    const result = await licensing.activate({
      key,
      deviceId,
      deviceName: body.deviceName,
      platform: body.platform,
    });

    if (!result.ok) {
      const status = result.code === "SEAT_LIMIT" ? 409 : 403;
      return json({ ok: false, code: result.code, reason: result.reason }, status);
    }

    return json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      license: result.license,
    });
  } catch (e) {
    return serverError(e);
  }
}

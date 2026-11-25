import { checkAdmin } from "@/lib/admin";
import { licensing } from "@/lib/licensing";
import { badRequest, json, readJson, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/devices
 * { licenseId, deviceId, revoked }
 *
 * Revogar um dispositivo derruba só aquele aparelho e libera o assento.
 */
export async function PATCH(req: Request) {
  const auth = checkAdmin(req);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.code);

  try {
    const body = await readJson<{ licenseId?: string; deviceId?: string; revoked?: boolean }>(req);
    if (!body?.licenseId || !body?.deviceId) return badRequest("licenseId e deviceId são obrigatórios.");

    const license = await licensing.setDeviceRevoked(body.licenseId, body.deviceId, body.revoked !== false);
    if (!license) return json({ ok: false, reason: "Licença não encontrada." }, 404);
    return json({ ok: true, license });
  } catch (e) {
    return serverError(e);
  }
}

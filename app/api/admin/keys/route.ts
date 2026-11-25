import { checkAdmin } from "@/lib/admin";
import { licensing } from "@/lib/licensing";
import { badRequest, json, readJson, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/keys — lista licenças + dispositivos + estatísticas. */
export async function GET(req: Request) {
  const auth = checkAdmin(req);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.code);

  try {
    const [licenses, stats] = await Promise.all([licensing.list(), licensing.stats()]);
    return json({ ok: true, licenses, stats });
  } catch (e) {
    return serverError(e);
  }
}

interface CreateBody {
  count?: number;
  plan?: string;
  maxDevices?: number;
  expiresInDays?: number | null;
  email?: string | null;
  note?: string | null;
}

/**
 * POST /api/admin/keys — gera N keys.
 * As keys em texto puro voltam SÓ nesta resposta; o banco guarda apenas o hash.
 */
export async function POST(req: Request) {
  const auth = checkAdmin(req);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.code);

  try {
    const body = await readJson<CreateBody>(req);
    if (!body) return badRequest("JSON inválido.");

    const { keys, licenses } = await licensing.createLicenses({
      count: body.count,
      plan: body.plan,
      maxDevices: body.maxDevices,
      expiresInDays: body.expiresInDays,
      email: body.email,
      note: body.note,
    });

    return json({ ok: true, keys, licenses }, 201);
  } catch (e) {
    return serverError(e);
  }
}

/** PATCH /api/admin/keys — revoga ou reativa uma licença. */
export async function PATCH(req: Request) {
  const auth = checkAdmin(req);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.code);

  try {
    const body = await readJson<{ licenseId?: string; revoked?: boolean }>(req);
    if (!body?.licenseId) return badRequest("licenseId é obrigatório.");

    const license = await licensing.setRevoked(body.licenseId, body.revoked !== false);
    if (!license) return json({ ok: false, reason: "Licença não encontrada." }, 404);
    return json({ ok: true, license });
  } catch (e) {
    return serverError(e);
  }
}

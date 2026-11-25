import { NextResponse } from "next/server";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex",
      ...headers,
    },
  });
}

export function badRequest(reason: string, code = "BAD_REQUEST") {
  return json({ ok: false, code, reason }, 400);
}

export function tooMany(retryAfter: number) {
  return json(
    { ok: false, code: "RATE_LIMITED", reason: "Muitas tentativas. Espere um pouco e tente de novo." },
    429,
    { "retry-after": String(retryAfter) },
  );
}

export function serverError(e: unknown) {
  const message = e instanceof Error ? e.message : "erro desconhecido";
  const config = /não configurado|not configured/i.test(message);
  return json(
    {
      ok: false,
      code: config ? "NOT_CONFIGURED" : "SERVER_ERROR",
      reason: config
        ? "Servidor de licenças não configurado (Supabase/segredo). Veja o README."
        : "Erro interno ao processar a licença.",
      detail: process.env.NODE_ENV === "production" ? undefined : message,
    },
    config ? 503 : 500,
  );
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text) return {} as T;
    if (text.length > 16_384) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

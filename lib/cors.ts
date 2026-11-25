import { json } from "./http";

/**
 * CORS para as rotas públicas.
 *
 * O cliente pode ser um app nativo com WebView carregando HTML de
 * `file://` / `appassets://` (Origin: null) ou de outro domínio. Sem estes
 * headers, o `fetch` do SDK falharia no APK por CORS.
 *
 * É seguro liberar `*` aqui: nenhuma rota pública usa cookies/sessão — a
 * autorização é sempre um token no corpo da requisição.
 */
export const PUBLIC_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  vary: "origin",
};

type Handler = (req: Request) => Promise<Response> | Response;

/** Envolve um handler adicionando os headers de CORS na resposta. */
export function withPublicCors(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return preflight();
    const res = await handler(req);
    for (const [key, value] of Object.entries(PUBLIC_CORS)) res.headers.set(key, value);
    return res;
  };
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

/** Resposta JSON de erro com CORS (usada pelo OPTIONS/handlers). */
export function corsJson(data: unknown, status = 200) {
  const res = json(data, status);
  for (const [key, value] of Object.entries(PUBLIC_CORS)) res.headers.set(key, value);
  return res;
}

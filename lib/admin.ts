import { safeEqual } from "./keys";

/**
 * Autenticação do painel admin.
 *
 * Defina `ADMIN_TOKEN` (string longa e aleatória) em produção. Sem ela, em
 * produção o painel e as rotas /api/admin ficam desligados (503).
 * Em desenvolvimento o token padrão é `dev-admin` (mostrado na tela).
 */

export const DEV_ADMIN_TOKEN = "dev-admin";

export function adminEnabled(): boolean {
  return !!process.env.ADMIN_TOKEN || process.env.NODE_ENV !== "production";
}

export function expectedAdminToken(): string {
  return process.env.ADMIN_TOKEN || DEV_ADMIN_TOKEN;
}

export function isDevAdminToken(): boolean {
  return !process.env.ADMIN_TOKEN;
}

export function checkAdmin(req: Request): { ok: true } | { ok: false; code: number; reason: string } {
  if (!adminEnabled()) {
    return {
      ok: false,
      code: 503,
      reason: "Painel desabilitado: configure a variável ADMIN_TOKEN para habilitar em produção.",
    };
  }

  const header = req.headers.get("x-admin-token") ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const provided = header || bearer;

  if (!provided) return { ok: false, code: 401, reason: "Token de admin ausente." };
  if (!safeEqual(provided, expectedAdminToken())) {
    return { ok: false, code: 401, reason: "Token de admin inválido." };
  }
  return { ok: true };
}

/** Valida o token direto (usado pelo endpoint de login do painel). */
export function isValidAdminToken(token: string): boolean {
  return adminEnabled() && safeEqual(token ?? "", expectedAdminToken());
}

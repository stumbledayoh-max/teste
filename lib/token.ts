import crypto from "node:crypto";
import { hmacSecret } from "./secret";
import { safeEqual } from "./keys";

/**
 * Token de licença: `base64url(payload).base64url(hmac)`.
 *
 * Stateless de propósito: o cliente guarda o token e o app valida a assinatura
 * localmente (offline), mas o servidor continua sendo a fonte da verdade —
 * revogação/expiração sempre vence, porque o app revalida periodicamente.
 */

export interface TokenPayload {
  /** id da licença */
  lid: string;
  /** device id que ativou */
  did: string;
  /** plano (pro, lifetime, trial...) */
  plan: string;
  /** emitido em (epoch seconds) */
  iat: number;
  /** expira em (epoch seconds) */
  exp: number;
}

export const DEFAULT_TTL_DAYS = Number(process.env.LICENSE_TOKEN_TTL_DAYS || 30);

const b64u = (buf: Buffer | string): string =>
  Buffer.isBuffer(buf) ? buf.toString("base64url") : Buffer.from(buf).toString("base64url");

export function signToken(payload: TokenPayload): string {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", hmacSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = crypto.createHmac("sha256", hmacSecret()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.lid !== "string" || typeof payload.did !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** expiração efetiva: o menor entre TTL do token e a validade da licença. */
export function tokenExpiry(licenseExpiresAt: string | null, ttlDays = DEFAULT_TTL_DAYS): Date {
  const byTtl = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  if (!licenseExpiresAt) return byTtl;
  const byLicense = new Date(licenseExpiresAt);
  return byLicense < byTtl ? byLicense : byTtl;
}

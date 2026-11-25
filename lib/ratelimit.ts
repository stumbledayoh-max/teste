/**
 * Rate limit simples em memória (janela fixa).
 *
 * Protege contra força bruta de keys e de token de admin. Em serverless cada
 * instância tem seu próprio contador — para limite global e distribuído, troque
 * por Upstash Redis (`@upstash/ratelimit`) mantendo a mesma assinatura.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    if (buckets.size > MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - current.count, retryAfter: 0 };
}

/** IP do cliente a partir dos headers (Vercel: x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

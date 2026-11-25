import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Segredo usado para assinar os tokens (HMAC-SHA256).
 *
 * Em produção: defina `LICENSE_HMAC_SECRET` (32+ bytes aleatórios).
 * Em desenvolvimento: geramos um segredo local persistente em `.data/secret`
 * para os tokens sobreviverem a um restart do `npm run dev`.
 */
let cached: string | null = null;

export function hmacSecret(): string {
  if (cached) return cached;

  const fromEnv = process.env.LICENSE_HMAC_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cached = fromEnv;
    return cached;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "LICENSE_HMAC_SECRET não configurado. Defina um segredo de pelo menos 32 caracteres antes de rodar em produção.",
    );
  }

  const dir = path.join(process.cwd(), ".data");
  const file = path.join(dir, "secret");
  try {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v.length >= 16) {
        cached = v;
        return cached;
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    const v = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, v, { mode: 0o600 });
    cached = v;
    return cached;
  } catch {
    // filesystem read-only (serverless): segredo volátil, tokens caem no restart
    cached = crypto.randomBytes(32).toString("hex");
    return cached;
  }
}

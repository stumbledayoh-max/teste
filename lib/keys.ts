import crypto from "node:crypto";

/**
 * Formato da key (Crockford base32, sem I/L/O/U para não confundir):
 *
 *   ENJOY-XXXXXXX-XXXXXXX-XXXXXXX
 *         └────── 20 chars (100 bits) ──────┘ + 1 dígito verificador
 *
 * A key em texto puro só existe no momento da criação (é devolvida uma vez
 * para o admin). No banco fica apenas o SHA-256 — vazar o banco não vaza keys.
 */

export const KEY_PREFIX = (process.env.LICENSE_KEY_PREFIX || "ENJOY").toUpperCase();

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_LEN = 20;
const GROUP = 7;
const TOTAL_LEN = BODY_LEN + 1; // corpo + verificador

function checksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += ALPHABET.indexOf(body[i]) * (i + 2);
  }
  return ALPHABET[sum % ALPHABET.length];
}

/** Gera uma key nova, já formatada para exibição. */
export function generateKey(): string {
  const bytes = crypto.randomBytes(BODY_LEN);
  let body = "";
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[bytes[i] & 31];
  const full = body + checksum(body);
  const groups = full.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? [full];
  return `${KEY_PREFIX}-${groups.join("-")}`;
}

/** Tira prefixo, espaços, hífens e normaliza caracteres ambíguos. */
export function normalizeKey(input: string): string {
  let s = (input || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");

  // o prefixo também passa pelo mapa de caracteres ambíguos (ENJOY → ENJ0Y)
  const prefix = KEY_PREFIX.replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
  if (prefix && s.startsWith(prefix) && s.length > TOTAL_LEN) s = s.slice(prefix.length);
  return s;
}

export type KeyCheck = { ok: true; normalized: string } | { ok: false; reason: string };

/** Valida formato + dígito verificador. Não consulta o banco. */
export function checkKey(input: string): KeyCheck {
  const normalized = normalizeKey(input);
  if (normalized.length !== TOTAL_LEN) {
    return { ok: false, reason: `A key precisa ter ${TOTAL_LEN} caracteres sem o prefixo.` };
  }
  for (const c of normalized) {
    if (!ALPHABET.includes(c)) return { ok: false, reason: `Caractere inválido na key: "${c}".` };
  }
  const body = normalized.slice(0, BODY_LEN);
  if (checksum(body) !== normalized[BODY_LEN]) {
    return { ok: false, reason: "Dígito verificador não confere — confira se copiou a key inteira." };
  }
  return { ok: true, normalized };
}

/** SHA-256 usado como índice no banco (nunca guardamos a key em claro). */
export function hashKey(normalized: string): string {
  return crypto.createHash("sha256").update(`${KEY_PREFIX}:${normalized}`).digest("hex");
}

/** Pedaços inofensivos que o painel pode mostrar sem expor a key. */
export function keyHint(formatted: string): { key_prefix: string; key_hint: string } {
  const n = normalizeKey(formatted);
  return {
    key_prefix: `${KEY_PREFIX}-${n.slice(0, 3)}`,
    key_hint: n.slice(-4),
  };
}

/** Comparação de strings em tempo constante (para tokens/admin). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

#!/usr/bin/env node
/**
 * Gera uma key offline (mesmo alfabeto/checksum do servidor) — útil para
 * conferir o formato ou preparar keys antes de subir o banco.
 *
 *   node scripts/new-key.mjs [quantidade]
 *
 * Só imprimir a key NÃO a registra em lugar nenhum: para vender/entregar,
 * gere pelo painel /admin (que grava o hash no Supabase).
 */

import crypto from "node:crypto";

const PREFIX = (process.env.LICENSE_KEY_PREFIX || "ENJOY").toUpperCase();
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_LEN = 20;

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 2);
  return ALPHABET[sum % ALPHABET.length];
}

function generateKey() {
  const bytes = crypto.randomBytes(BODY_LEN);
  let body = "";
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[bytes[i] & 31];
  const full = body + checksum(body);
  return `${PREFIX}-${full.match(/.{1,7}/g).join("-")}`;
}

const count = Math.min(Math.max(Number(process.argv[2] ?? 1) || 1, 1), 50);
const keys = Array.from({ length: count }, generateKey);
console.log(keys.join("\n"));
console.error(`\n${count} key(s) geradas (não registradas no banco).`);

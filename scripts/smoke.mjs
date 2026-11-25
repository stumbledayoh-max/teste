#!/usr/bin/env node
/**
 * Teste ponta a ponta do servidor de licenças.
 *
 *   npm run dev            # em outro terminal
 *   npm run smoke          # BASE_URL=http://localhost:3000 por padrão
 *
 * Cobre: geração → ativação → validação → limite de assentos → revogação →
 * dispositivo errado → desativação (libera assento).
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN || "dev-admin";

let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`);
  }
}

async function call(path, { method = "GET", body, admin = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(admin ? { "x-admin-token": ADMIN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const deviceA = `smoke-a-${Date.now()}`;
const deviceB = `smoke-b-${Date.now()}`;
const deviceC = `smoke-c-${Date.now()}`;

async function main() {
  console.log(`\nservidor: ${BASE}\n`);

  const health = await call("/api/health");
  check("GET /api/health responde ok", health.status === 200 && health.data.ok === true);
  console.log(`     modo de armazenamento: ${health.data.store}`);

  /* ------------------------------ geração ------------------------------ */
  console.log("\n[1] admin gera key");
  const created = await call("/api/admin/keys", {
    method: "POST",
    admin: true,
    body: { count: 1, plan: "smoke", maxDevices: 1, expiresInDays: 30, email: "smoke@test.dev", note: "smoke test" },
  });
  const key = created.data.keys?.[0];
  const licenseId = created.data.licenses?.[0]?.id;
  check("key criada no formato PREFIXO-XXXXXXX-XXXXXXX-XXXXXXX", /^[A-Z]+-[0-9A-Z]{7}-[0-9A-Z]{7}-[0-9A-Z]{7}$/.test(key ?? ""), key);

  const list = await call("/api/admin/keys", { admin: true });
  check("key aparece na listagem", Array.isArray(list.data.licenses) && list.data.licenses.length >= 1);
  const masked = list.data.licenses?.find((l) => l.id === licenseId);
  check("key NÃO é devolvida pela listagem (só hash)", JSON.stringify(list.data).indexOf(key) === -1 && !!masked?.keyHint);

  /* ------------------------------ ativação ----------------------------- */
  console.log("\n[2] ativação");
  const actA = await call("/api/activate", {
    method: "POST",
    body: { key, deviceId: deviceA, deviceName: "Aparelho A", platform: "android" },
  });
  check("ativa no dispositivo A", actA.data.ok === true && !!actA.data.token);
  check("token tem 2 partes (payload.assinatura)", (actA.data.token ?? "").split(".").length === 2);
  check("assentos usados = 1", actA.data.license?.seatsUsed === 1, JSON.stringify(actA.data.license));

  const actAgain = await call("/api/activate", {
    method: "POST",
    body: { key, deviceId: deviceA, deviceName: "Aparelho A", platform: "android" },
  });
  check("re-ativar o mesmo dispositivo não consome assento", actAgain.data.ok === true && actAgain.data.license?.seatsUsed === 1);

  const actB = await call("/api/activate", {
    method: "POST",
    body: { key, deviceId: deviceB, deviceName: "Aparelho B" },
  });
  check("segundo dispositivo é barrado (SEAT_LIMIT)", actB.status === 409 && actB.data.code === "SEAT_LIMIT");

  const bad = await call("/api/activate", {
    method: "POST",
    body: { key: key.slice(0, -1) + (key.endsWith("0") ? "1" : "0"), deviceId: deviceC },
  });
  check("key com dígito verificador errado é recusada", bad.data.ok === false && bad.data.code === "INVALID_KEY");

  const junk = await call("/api/activate", { method: "POST", body: { key: "ENJOY-AAAAAAA-BBBBBBB-CCCCCCC", deviceId: deviceC } });
  check("key inexistente com checksum válido não ativa", junk.data.ok === false);

  /* ------------------------------ validação ---------------------------- */
  console.log("\n[3] validação");
  const token = actA.data.token;
  const val = await call("/api/validate", { method: "POST", body: { token, deviceId: deviceA } });
  check("token válido em /api/validate", val.data.ok === true);

  const wrongDevice = await call("/api/validate", { method: "POST", body: { token, deviceId: deviceB } });
  check("token usado em outro device é recusado", wrongDevice.data.ok === false && wrongDevice.data.code === "DEVICE_MISMATCH");

  const tampered = await call("/api/validate", {
    method: "POST",
    body: { token: token.slice(0, -3) + "abc", deviceId: deviceA },
  });
  check("token adulterado é recusado", tampered.data.ok === false && tampered.data.code === "INVALID_TOKEN");

  /* ----------------------------- revogação ----------------------------- */
  console.log("\n[4] revogação da licença");
  const revoked = await call("/api/admin/keys", {
    method: "PATCH",
    admin: true,
    body: { licenseId, revoked: true },
  });
  check("licença revogada pelo painel", revoked.data.license?.status === "revoked");

  const valAfterRevoke = await call("/api/validate", { method: "POST", body: { token, deviceId: deviceA } });
  check("validação falha na hora após revogação", valAfterRevoke.data.ok === false && valAfterRevoke.data.code === "REVOKED");

  const actAfterRevoke = await call("/api/activate", { method: "POST", body: { key, deviceId: deviceC } });
  check("não ativa em aparelho novo com key revogada", actAfterRevoke.data.ok === false && actAfterRevoke.data.code === "REVOKED");

  await call("/api/admin/keys", { method: "PATCH", admin: true, body: { licenseId, revoked: false } });

  /* ---------------------- desativação / assento ------------------------ */
  console.log("\n[5] desativação libera o assento");
  const deact = await call("/api/deactivate", { method: "POST", body: { token, deviceId: deviceA } });
  check("dispositivo A desativado", deact.data.ok === true);

  const actC = await call("/api/activate", { method: "POST", body: { key, deviceId: deviceC, deviceName: "Aparelho C" } });
  check("aparelho C entra no assento liberado", actC.data.ok === true && actC.data.license?.seatsUsed === 1);

  const oldToken = await call("/api/validate", { method: "POST", body: { token, deviceId: deviceA } });
  check("token de A morre após desativação", oldToken.data.ok === false && oldToken.data.code === "DEVICE_REVOKED");

  /* --------------------------- autorização ----------------------------- */
  console.log("\n[6] rotas admin protegidas");
  const noAuth = await fetch(`${BASE}/api/admin/keys`);
  check("sem token admin → 401", noAuth.status === 401);
  const badAuth = await fetch(`${BASE}/api/admin/keys`, { headers: { "x-admin-token": "chute" } });
  check("token admin errado → 401", badAuth.status === 401);

  /* ----------------------------- expiração ----------------------------- */
  console.log("\n[7] expiração");
  const short = await call("/api/admin/keys", {
    method: "POST",
    admin: true,
    body: { count: 1, maxDevices: 1, expiresInDays: 1 },
  });
  const expLic = await call("/api/admin/keys", { admin: true });
  const created2 = expLic.data.licenses?.find((l) => l.keyPrefix === short.data.licenses?.[0]?.keyPrefix);
  check("licença com validade tem expiresAt", !!created2?.expiresAt);

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passaram · ${fail} falharam\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n\x1b[31merro fatal:\x1b[0m", e);
  process.exit(1);
});

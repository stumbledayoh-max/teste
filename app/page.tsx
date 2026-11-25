import Link from "next/link";
import { adminEnabled, isDevAdminToken } from "@/lib/admin";
import { backendMode } from "@/lib/backends";
import { DEFAULT_TTL_DAYS } from "@/lib/token";

export const dynamic = "force-dynamic";

const STORE_LABEL: Record<string, string> = {
  supabase: "Supabase (produção)",
  file: "JSON local (.data/) — modo dev",
  unconfigured: "não configurado",
};

export default function HomePage() {
  const store = backendMode();
  const admin = adminEnabled();
  const devToken = isDevAdminToken();

  return (
    <main>
      <div className="wrap">
        <section className="hero">
          <div className="row">
            <span className={`badge ${store === "unconfigured" ? "bad" : store === "supabase" ? "ok" : "warn"}`}>
              <span className="dot" /> armazenamento: {STORE_LABEL[store]}
            </span>
            <span className={`badge ${admin ? "ok" : "bad"}`}>
              <span className="dot" /> painel admin {admin ? "ativo" : "desligado"}
            </span>
            <span className="badge">token válido por {DEFAULT_TTL_DAYS} dias</span>
          </div>

          <h1>
            Licenças por key, do jeito certo:
            <br />
            ativar, expirar e <span style={{ color: "var(--accent)" }}>revogar</span>.
          </h1>

          <p className="lede">
            Um servidor de licenciamento completo para o <strong>seu</strong> app: key gerada e guardada
            como hash, ativação amarrada ao dispositivo, limite de assentos, expiração por plano e
            revogação que derruba o aparelho na hora. Backend Supabase, deploy na Vercel e um SDK
            pronto para o navegador ou para o WebView do APK.
          </p>

          <div className="row">
            <Link href="/activate" className="badge ok" style={{ padding: "10px 16px", fontSize: "0.85rem" }}>
              Ativar uma key →
            </Link>
            <Link href="/admin" className="badge" style={{ padding: "10px 16px", fontSize: "0.85rem" }}>
              Gerar keys no painel
            </Link>
          </div>

          {devToken && (
            <div className="alert warn small">
              Modo desenvolvimento: o painel está liberado com o token <code>dev-admin</code>. Defina{" "}
              <code>ADMIN_TOKEN</code> antes de publicar.
            </div>
          )}
        </section>

        <section className="grid three" style={{ marginBottom: 18 }}>
          <div className="card">
            <h3>1. Gerar</h3>
            <p className="small">
              O admin cria N keys de uma vez (formato <code>ENJOY-XXXXXXX-XXXXXXX-XXXXXXX</code>).
              A key em texto puro aparece <strong>uma única vez</strong>; o banco guarda só o SHA-256
              com dígito verificador.
            </p>
          </div>
          <div className="card">
            <h3>2. Ativar</h3>
            <p className="small">
              O cliente manda <code>key + deviceId</code>. O servidor confere key, validade e assentos,
              registra o dispositivo e devolve um token assinado (HMAC-SHA256).
            </p>
          </div>
          <div className="card">
            <h3>3. Validar</h3>
            <p className="small">
              No boot e no heartbeat o app chama <code>/api/validate</code>. Revogou a key? O token
              morre no servidor mesmo que o cliente ainda tenha cópia local.
            </p>
          </div>
        </section>

        <section className="grid two" style={{ alignItems: "start" }}>
          <div className="card">
            <h2>API</h2>
            <p className="small">Quatro rotas públicas + três de admin. Tudo JSON.</p>
            <pre>
{`POST /api/activate    { key, deviceId, deviceName?, platform? }
POST /api/validate    { token, deviceId }
POST /api/deactivate  { token, deviceId }
GET  /api/health

GET   /api/admin/keys      (x-admin-token)
POST  /api/admin/keys      { count, plan, maxDevices, expiresInDays }
PATCH /api/admin/keys      { licenseId, revoked }
PATCH /api/admin/devices   { licenseId, deviceId, revoked }`}
            </pre>
          </div>

          <div className="card">
            <h2>No seu app</h2>
            <p className="small">
              O SDK em <code>sdk/license-client.ts</code> resolve device id, cache, carência offline e
              heartbeat.
            </p>
            <pre>
{`import { LicenseClient } from "@/sdk/license-client";

const lic = new LicenseClient({ product: "meu-app" });

await lic.activate("ENJOY-XXXXXXX-XXXXXXX-XXXXXXX");
if (!lic.isLicensed()) return mostrarTelaDeAtivacao();

lic.startHeartbeat();   // revalida a cada 6h
// lic.deactivate()     // libera o assento`}
            </pre>
          </div>
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Como isso é seguro</h2>
          <div className="grid two">
            <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--muted)" }}>
              <li>Key nunca é gravada em claro — só hash SHA-256 + prefixo/últimos 4 dígitos.</li>
              <li>Tokens assinados com HMAC-SHA256; payload não pode ser forjado no cliente.</li>
              <li>RLS ligado e sem policies: anon/authenticated não leem nada; service_role só no servidor.</li>
            </ul>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--muted)" }}>
              <li>Limite de assentos garantido por trigger no Postgres (duas ativações ao mesmo tempo não furam).</li>
              <li>Rate limit por IP e por key contra força bruta.</li>
              <li>Revogação e expiração sempre vencem o cache local do cliente.</li>
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}

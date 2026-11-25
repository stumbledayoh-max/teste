"use client";

import { useEffect, useMemo, useState } from "react";
import { LicenseClient, type LicenseSession } from "@/sdk/license-client";

type Msg = { kind: "ok" | "bad" | "warn"; text: string } | null;

export default function ActivatePage() {
  const client = useMemo(() => new LicenseClient({ product: "demo-app" }), []);

  const [deviceId, setDeviceId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"" | "activate" | "validate" | "deactivate" | "copy">("");
  const [msg, setMsg] = useState<Msg>(null);
  const [session, setSession] = useState<LicenseSession | null>(null);
  const [licensed, setLicensed] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    setSession(client.session());
    setLicensed(client.isLicensed());
  };

  useEffect(() => {
    setDeviceId(client.deviceId());
    const s = client.session();
    setSession(s);
    setLicensed(client.isLicensed());
    if (s) {
      // valida em background ao abrir a página
      void client.validate().then((r) => {
        refresh();
        if (!r.ok && !r.offline) setMsg({ kind: "bad", text: r.reason ?? "Licença inválida." });
        else if (r.ok) setMsg({ kind: "ok", text: "Licença confirmada no servidor." });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function doActivate(e: React.FormEvent) {
    e.preventDefault();
    setBusy("activate");
    setMsg(null);
    const r = await client.activate(key.trim());
    setBusy("");
    if (r.ok) {
      refresh();
      setKey("");
      setMsg({ kind: "ok", text: "Key ativada neste dispositivo. Token emitido." });
    } else {
      setMsg({ kind: r.offline ? "warn" : "bad", text: r.reason ?? "Falha ao ativar." });
    }
  }

  async function doValidate() {
    setBusy("validate");
    setMsg(null);
    const r = await client.validate();
    setBusy("");
    refresh();
    if (r.ok) {
      setMsg({
        kind: "ok",
        text: r.refreshed ? "Licença válida — token renovado." : "Licença válida.",
      });
    } else {
      setMsg({ kind: r.offline ? "warn" : "bad", text: r.reason ?? "Licença inválida." });
    }
  }

  async function doDeactivate() {
    setBusy("deactivate");
    setMsg(null);
    const r = await client.deactivate();
    setBusy("");
    refresh();
    setMsg(
      r.ok
        ? { kind: "ok", text: "Dispositivo desativado. O assento foi liberado." }
        : { kind: "bad", text: r.reason ?? "Não foi possível desativar." },
    );
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setMsg({ kind: "warn", text: "Não consegui copiar — selecione o texto manualmente." });
    }
  }

  return (
    <main>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <div className="hero">
          <span className="badge">cliente de exemplo · usa o SDK</span>
          <h1>Ativar key</h1>
          <p className="lede">
            Esta tela é um cliente real do servidor: gera um <code>deviceId</code> persistente, pede a
            ativação, guarda o token e revalida contra a API. O mesmo fluxo vale para o APK — dentro do
            WebView, o caminho do SDK é idêntico.
          </p>
        </div>

        <div className="grid two" style={{ alignItems: "start" }}>
          <form className="card" onSubmit={doActivate}>
            <h2>Entrar com a key</h2>
            <p className="small">Cole a key que você recebeu. Espaços e hífens não importam.</p>

            <div className="stack" style={{ marginTop: 14 }}>
              <label className="field">
                Key de licença
                <input
                  className="key-input"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toUpperCase())}
                  placeholder="ENJOY-XXXXXXX-XXXXXXX-XXXXXXX"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                />
              </label>

              <label className="field">
                Device ID deste aparelho
                <div className="row" style={{ gap: 8 }}>
                  <input readOnly value={deviceId} className="mono" style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="tiny ghost"
                    onClick={() => copy(deviceId)}
                    disabled={!deviceId}
                  >
                    {copied ? "copiado" : "copiar"}
                  </button>
                </div>
              </label>

              <button className="primary" type="submit" disabled={busy === "activate" || key.trim().length < 8}>
                {busy === "activate" ? "Ativando…" : "Ativar neste dispositivo"}
              </button>

              {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
            </div>
          </form>

          <div className="card accent">
            <div className="spread">
              <h2 style={{ marginBottom: 0 }}>Status</h2>
              <span className={`badge ${licensed ? "ok" : "bad"}`}>
                <span className="dot" /> {licensed ? "licenciado" : "não licenciado"}
              </span>
            </div>

            {!session && (
              <p className="small" style={{ marginTop: 12 }}>
                Nenhuma sessão salva neste navegador. Ative uma key para criar a primeira.
              </p>
            )}

            {session && (
              <div className="stack" style={{ marginTop: 14 }}>
                <div className="grid two" style={{ gap: 10 }}>
                  <div className="kpi">
                    <span className="v">{session.plan}</span>
                    <span className="l">plano</span>
                  </div>
                  <div className="kpi">
                    <span className="v">
                      {session.seatsUsed}/{session.maxDevices}
                    </span>
                    <span className="l">assentos</span>
                  </div>
                </div>

                <div className="small muted">
                  Expira em{" "}
                  <strong style={{ color: "var(--text)" }}>
                    {session.expiresAt ? new Date(session.expiresAt).toLocaleString("pt-BR") : "—"}
                  </strong>
                  {session.email ? (
                    <>
                      {" "}
                      · titular <strong style={{ color: "var(--text)" }}>{session.email}</strong>
                    </>
                  ) : null}
                  <br />
                  Carência offline: {client.offlineDaysLeft()} dia(s).
                </div>

                <label className="field">
                  Token de licença
                  <textarea
                    readOnly
                    value={session.token}
                    className="mono"
                    style={{ fontSize: "0.7rem", minHeight: 64 }}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>

                <div className="row">
                  <button type="button" onClick={doValidate} disabled={busy === "validate"}>
                    {busy === "validate" ? "Validando…" : "Revalidar agora"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={doDeactivate}
                    disabled={busy === "deactivate"}
                  >
                    {busy === "deactivate" ? "Desativando…" : "Desativar este aparelho"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2>O que o servidor faz por trás</h2>
          <pre>
{`1. normaliza a key e confere o dígito verificador (rejeita erro de digitação
   antes de qualquer consulta ao banco)
2. procura pelo SHA-256 da key e checa status + validade
3. conta assentos ativos; se a key já está cheia → SEAT_LIMIT (409)
4. registra o dispositivo (device_id + nome + plataforma + primeiro/último acesso)
5. devolve token  base64url(payload).base64url(hmac-sha256)
   payload = { lid, did, plan, iat, exp }`}
          </pre>
        </div>
      </div>
    </main>
  );
}

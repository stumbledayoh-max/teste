"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

interface ApiDevice {
  deviceId: string;
  name: string | null;
  platform: string | null;
  firstSeen: string;
  lastSeen: string;
  revoked: boolean;
}

interface ApiLicense {
  id: string;
  keyPrefix: string;
  keyHint: string;
  plan: string;
  status: "active" | "revoked" | "expired";
  maxDevices: number;
  seatsUsed: number;
  expiresAt: string | null;
  email: string | null;
  note: string | null;
  createdAt: string;
  devices: ApiDevice[];
}

interface Stats {
  total: number;
  active: number;
  revoked: number;
  expired: number;
  expiringIn30d: number;
  devices: number;
  mode: string;
  tokenTtlDays: number;
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "nunca";

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [checking, setChecking] = useState(false);

  const [licenses, setLicenses] = useState<ApiLicense[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  /* gerador */
  const [count, setCount] = useState(1);
  const [plan, setPlan] = useState("pro");
  const [maxDevices, setMaxDevices] = useState(1);
  const [days, setDays] = useState<string>("365");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newKeys, setNewKeys] = useState<string[]>([]);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-admin-token": token,
          ...(init.headers ?? {}),
        },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.reason || `Falha (${res.status})`);
      }
      return data;
    },
    [token],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api("/api/admin/keys");
      setLicenses(data.licenses as ApiLicense[]);
      setStats(data.stats as Stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar.");
      if (/token/i.test(String(e))) {
        setAuthed(false);
        sessionStorage.removeItem("lic.admin.token");
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const saved = sessionStorage.getItem("lic.admin.token");
    if (saved) {
      setToken(saved);
      setAuthed(true);
    }
  }, []);

  useEffect(() => {
    if (authed) void load();
  }, [authed, load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setAuthError("");
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.reason || "Token inválido.");
      sessionStorage.setItem("lic.admin.token", token);
      setAuthed(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Falha no login.");
    } finally {
      setChecking(false);
    }
  }

  function logout() {
    sessionStorage.removeItem("lic.admin.token");
    setAuthed(false);
    setToken("");
    setLicenses([]);
    setStats(null);
    setNewKeys([]);
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setError("");
    setNotice("");
    setNewKeys([]);
    try {
      const data = await api("/api/admin/keys", {
        method: "POST",
        body: JSON.stringify({
          count,
          plan,
          maxDevices,
          expiresInDays: days.trim() === "" ? null : Number(days),
          email: email.trim() || null,
          note: note.trim() || null,
        }),
      });
      setNewKeys(data.keys as string[]);
      setNotice(`${(data.keys as string[]).length} key(s) gerada(s). Copie agora — não guardamos o texto puro.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar keys.");
    } finally {
      setGenerating(false);
    }
  }

  async function toggleLicense(l: ApiLicense) {
    try {
      await api("/api/admin/keys", {
        method: "PATCH",
        body: JSON.stringify({ licenseId: l.id, revoked: l.status !== "revoked" }),
      });
      setNotice(l.status === "revoked" ? "Licença reativada." : "Licença revogada — tokens morrem na próxima validação.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao atualizar licença.");
    }
  }

  async function toggleDevice(l: ApiLicense, d: ApiDevice) {
    try {
      await api("/api/admin/devices", {
        method: "PATCH",
        body: JSON.stringify({ licenseId: l.id, deviceId: d.deviceId, revoked: !d.revoked }),
      });
      setNotice(d.revoked ? "Dispositivo reativado." : "Dispositivo revogado — assento liberado.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao atualizar dispositivo.");
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return licenses;
    return licenses.filter((l) =>
      [l.id, l.plan, l.email ?? "", l.note ?? "", ...l.devices.map((d) => `${d.name} ${d.deviceId}`)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [licenses, query]);

  function downloadCsv() {
    const rows = [["key"], ...newKeys.map((k) => [k])];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `keys-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(newKeys.join("\n"));
      setNotice("Keys copiadas para a área de transferência.");
    } catch {
      setError("Não consegui copiar; use o CSV.");
    }
  }

  /* ------------------------------- login ------------------------------- */

  if (!authed) {
    return (
      <main>
        <div className="wrap" style={{ maxWidth: 460 }}>
          <form className="card" onSubmit={login} style={{ marginTop: 40 }}>
            <h1 style={{ fontSize: "1.6rem" }}>Painel admin</h1>
            <p className="small">
              Informe o <code>ADMIN_TOKEN</code> configurado no servidor. Em desenvolvimento o padrão é{" "}
              <code>dev-admin</code>.
            </p>
            <div className="stack" style={{ marginTop: 14 }}>
              <label className="field">
                Token de administrador
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="••••••••••••"
                  autoComplete="off"
                />
              </label>
              <button className="primary" type="submit" disabled={checking || !token}>
                {checking ? "Verificando…" : "Entrar"}
              </button>
              {authError && <div className="alert bad">{authError}</div>}
            </div>
          </form>
        </div>
      </main>
    );
  }

  /* ------------------------------ dashboard ---------------------------- */

  return (
    <main>
      <div className="wrap">
        <div className="spread" style={{ marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: "clamp(1.6rem, 3vw, 2.1rem)" }}>Painel admin</h1>
            <p className="small" style={{ margin: 0 }}>
              {stats ? `Armazenamento: ${stats.mode === "supabase" ? "Supabase" : "JSON local (dev)"} · token de licença válido por ${stats.tokenTtlDays} dias` : "Carregando…"}
            </p>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => void load()} disabled={loading}>
              {loading ? "Atualizando…" : "Atualizar"}
            </button>
            <button className="ghost" onClick={logout}>
              Sair
            </button>
          </div>
        </div>

        {error && <div className="alert bad" style={{ marginBottom: 12 }}>{error}</div>}
        {notice && <div className="alert ok" style={{ marginBottom: 12 }}>{notice}</div>}

        {stats && (
          <div className="grid three" style={{ marginBottom: 16 }}>
            <div className="card tight kpi">
              <span className="v">{stats.active}</span>
              <span className="l">licenças ativas</span>
            </div>
            <div className="card tight kpi">
              <span className="v">{stats.devices}</span>
              <span className="l">dispositivos ativos</span>
            </div>
            <div className="card tight kpi">
              <span className="v">{stats.expiringIn30d}</span>
              <span className="l">expirando em 30 dias</span>
            </div>
            <div className="card tight kpi">
              <span className="v">{stats.total}</span>
              <span className="l">total de keys</span>
            </div>
            <div className="card tight kpi">
              <span className="v">{stats.revoked}</span>
              <span className="l">revogadas</span>
            </div>
            <div className="card tight kpi">
              <span className="v">{stats.expired}</span>
              <span className="l">vencidas</span>
            </div>
          </div>
        )}

        <div className="grid two" style={{ alignItems: "start" }}>
          <form className="card accent" onSubmit={generate}>
            <h2>Gerar keys</h2>
            <p className="small">
              As keys aparecem em texto puro só aqui, uma vez. O banco guarda apenas o hash.
            </p>

            <div className="grid two" style={{ gap: 10, marginTop: 12 }}>
              <label className="field">
                Quantidade
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
              <label className="field">
                Plano
                <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                  <option value="pro">pro</option>
                  <option value="trial">trial</option>
                  <option value="lifetime">lifetime</option>
                  <option value="team">team</option>
                </select>
              </label>
              <label className="field">
                Dispositivos por key
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxDevices}
                  onChange={(e) => setMaxDevices(Number(e.target.value))}
                />
              </label>
              <label className="field">
                Validade (dias)
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={days}
                  placeholder="vazio = nunca expira"
                  onChange={(e) => setDays(e.target.value)}
                />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                E-mail do cliente (opcional)
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="cliente@exemplo.com"
                  autoComplete="off"
                />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                Observação interna (opcional)
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="ex.: pedido #1042 · pagamento pix"
                  autoComplete="off"
                />
              </label>
            </div>

            <button className="primary" type="submit" disabled={generating} style={{ marginTop: 12 }}>
              {generating ? "Gerando…" : `Gerar ${count > 1 ? `${count} keys` : "key"}`}
            </button>
          </form>

          <div className="card">
            <div className="spread">
              <h2 style={{ marginBottom: 0 }}>Keys recém-geradas</h2>
              {newKeys.length > 0 && (
                <div className="row">
                  <button className="tiny" onClick={copyAll}>
                    copiar todas
                  </button>
                  <button className="tiny" onClick={downloadCsv}>
                    CSV
                  </button>
                </div>
              )}
            </div>

            {newKeys.length === 0 ? (
              <p className="small" style={{ marginTop: 12 }}>
                Nada gerado ainda nesta sessão. Gere uma key ao lado — ela é exibida uma única vez.
              </p>
            ) : (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newKeys.map((k, i) => (
                      <tr key={k}>
                        <td className="muted">{i + 1}</td>
                        <td>
                          <span className="key-cell">{k}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              Perdeu as keys? Não tem como recuperar — revogue estas e gere outras.
            </p>
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="spread" style={{ marginBottom: 12 }}>
            <h2 style={{ marginBottom: 0 }}>Licenças</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="buscar por e-mail, nota, device id…"
              style={{ maxWidth: 280 }}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="small" style={{ marginBottom: 0 }}>
              {licenses.length === 0 ? "Nenhuma key criada ainda." : "Nenhum resultado para a busca."}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Plano</th>
                    <th>Status</th>
                    <th>Assentos</th>
                    <th>Expira</th>
                    <th>Criada</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <Fragment key={l.id}>
                      <tr>
                        <td>
                          <span className="key-cell">
                            {l.keyPrefix || "KEY"}···{l.keyHint || "????"}
                          </span>
                          <div className="mono-id">{l.email ?? l.note ?? l.id.slice(0, 8)}</div>
                        </td>
                        <td>{l.plan}</td>
                        <td>
                          <span
                            className={`badge ${l.status === "active" ? "ok" : l.status === "expired" ? "warn" : "bad"}`}
                          >
                            <span className="dot" /> {l.status === "active" ? "ativa" : l.status === "expired" ? "vencida" : "revogada"}
                          </span>
                        </td>
                        <td>
                          {l.seatsUsed}/{l.maxDevices}
                        </td>
                        <td>{fmtDate(l.expiresAt)}</td>
                        <td>{fmtDate(l.createdAt)}</td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button
                              className="tiny ghost"
                              onClick={() => setOpenId(openId === l.id ? null : l.id)}
                            >
                              {openId === l.id ? "fechar" : `devices (${l.devices.length})`}
                            </button>
                            <button
                              className={`tiny ${l.status === "revoked" ? "" : "danger"}`}
                              onClick={() => void toggleLicense(l)}
                            >
                              {l.status === "revoked" ? "reativar" : "revogar"}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {openId === l.id && (
                        <tr key={`${l.id}-devices`}>
                          <td colSpan={7} style={{ whiteSpace: "normal", background: "rgba(255,255,255,0.02)" }}>
                            {l.devices.length === 0 ? (
                              <span className="small muted">Nenhum dispositivo ativou esta key ainda.</span>
                            ) : (
                              l.devices.map((d) => (
                                <div className="device-row" key={d.deviceId}>
                                  <div className="spread">
                                    <span className="small">
                                      <strong>{d.name ?? "dispositivo"}</strong>{" "}
                                      {d.platform ? <span className="muted">· {d.platform}</span> : null}
                                      {d.revoked ? <span className="badge bad" style={{ marginLeft: 8 }}>revogado</span> : null}
                                    </span>
                                    <button className="tiny ghost" onClick={() => void toggleDevice(l, d)}>
                                      {d.revoked ? "reativar" : "revogar"}
                                    </button>
                                  </div>
                                  <span className="mono-id">{d.deviceId}</span>
                                  <span className="mono-id">
                                    primeiro acesso {fmtDateTime(d.firstSeen)} · último {fmtDateTime(d.lastSeen)}
                                  </span>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

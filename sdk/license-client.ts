/**
 * SDK do cliente de licenças — sem dependências, roda no navegador, no WebView
 * do Android/iOS e em Node.
 *
 *   const lic = new LicenseClient({ baseUrl: "https://lic.seuapp.com", product: "meu-app" });
 *   await lic.activate("ENJOY-XXXXXXX-XXXXXXX-XXXXXXX");
 *   if (lic.isLicensed()) { ...libera o app... }
 *   lic.startHeartbeat();           // revalida no servidor (revogação vence)
 *
 * Regra de ouro: `isLicensed()` libera o app offline dentro do período de
 * carência, mas quem manda é o servidor — quando ele responde "revogado",
 * a sessão local é apagada na hora.
 */

export interface LicenseSession {
  token: string;
  expiresAt: string;
  plan: string;
  email: string | null;
  maxDevices: number;
  seatsUsed: number;
  /** última vez que o servidor confirmou a licença (ISO) */
  lastOk: string;
}

export interface ActivateResult {
  ok: boolean;
  code?: string;
  reason?: string;
  session?: LicenseSession;
  offline?: boolean;
}

export interface ValidateResult extends ActivateResult {
  refreshed?: boolean;
}

export interface LicenseClientOptions {
  /** base do servidor de licenças; default = mesma origem */
  baseUrl?: string;
  /** separa licenças de apps diferentes no mesmo storage */
  product?: string;
  /** storage custom (default: localStorage quando existir) */
  storage?: Storage;
  /** fetch custom (útil em ambientes com proxy) */
  fetchImpl?: typeof fetch;
  /** dias de tolerância offline antes de bloquear */
  graceDays?: number;
  /** intervalo do heartbeat (default 6h) */
  heartbeatMs?: number;
  /** chamado a cada mudança de estado (bom para re-render/telemetria) */
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}

const memStore = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
  } as Storage;
})();

function detectPlatform(): string {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav) return "node";
  const ua = nav.userAgent || "";
  if (/android/i.test(ua)) return /wv\)/.test(ua) ? "android-webview" : "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/windows/i.test(ua)) return "windows";
  if (/mac os/i.test(ua)) return "macos";
  if (/linux/i.test(ua)) return "linux";
  return "web";
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return (c as Crypto).randomUUID();
  const b = new Uint8Array(16);
  if (c && "getRandomValues" in c) (c as Crypto).getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function tokenPayloadExp(token: string): number | null {
  try {
    const body = token.split(".")[0];
    const json = JSON.parse(
      typeof atob === "function" ? atob(body.replace(/-/g, "+").replace(/_/g, "/")) : "",
    ) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

export class LicenseClient {
  private baseUrl: string;
  private product: string;
  private store: Storage;
  private fetchImpl: typeof fetch;
  private graceDays: number;
  private heartbeatMs: number;
  private onEvent?: LicenseClientOptions["onEvent"];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LicenseClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.product = opts.product ?? "default";
    this.store =
      opts.storage ??
      (typeof localStorage !== "undefined" ? localStorage : memStore);
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : (async () => {
      throw new Error("fetch indisponível");
    }) as typeof fetch);
    this.graceDays = opts.graceDays ?? 7;
    this.heartbeatMs = opts.heartbeatMs ?? 6 * 60 * 60 * 1000;
    this.onEvent = opts.onEvent;
  }

  /* --------------------------- identidade --------------------------- */

  /** ID estável do dispositivo (persistido; sobrevive a F5 e restart do app). */
  deviceId(): string {
    const k = `lic.deviceId.${this.product}`;
    let id = this.store.getItem(k);
    if (!id) {
      id = uuid();
      this.store.setItem(k, id);
    }
    return id;
  }

  /** Uso do aparelho (para o painel admin mostrar algo legível). */
  deviceName(): string {
    if (typeof navigator === "undefined") return "servidor";
    const platform = detectPlatform();
    const w = typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : "";
    return `${platform}${w ? ` · ${w}` : ""}`;
  }

  /* ---------------------------- sessão ------------------------------ */

  session(): LicenseSession | null {
    try {
      const raw = this.store.getItem(`lic.session.${this.product}`);
      return raw ? (JSON.parse(raw) as LicenseSession) : null;
    } catch {
      return null;
    }
  }

  private save(session: LicenseSession | null): void {
    const k = `lic.session.${this.product}`;
    if (session) this.store.setItem(k, JSON.stringify(session));
    else this.store.removeItem(k);
    this.onEvent?.({ type: session ? "session:set" : "session:cleared" });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; reason?: string };
    return data;
  }

  /* --------------------------- operações ---------------------------- */

  async activate(key: string): Promise<ActivateResult> {
    try {
      const data = await this.post<{
        ok: boolean;
        token?: string;
        expiresAt?: string;
        license?: { plan: string; email: string | null; maxDevices: number; seatsUsed: number };
        code?: string;
        reason?: string;
      }>("/api/activate", {
        key,
        deviceId: this.deviceId(),
        deviceName: this.deviceName(),
        platform: detectPlatform(),
      });

      if (!data.ok || !data.token || !data.license) {
        return { ok: false, code: data.code ?? "ERROR", reason: data.reason ?? "Não foi possível ativar." };
      }

      const session: LicenseSession = {
        token: data.token,
        expiresAt: data.expiresAt ?? "",
        plan: data.license.plan,
        email: data.license.email,
        maxDevices: data.license.maxDevices,
        seatsUsed: data.license.seatsUsed,
        lastOk: new Date().toISOString(),
      };
      this.save(session);
      return { ok: true, session };
    } catch {
      return { ok: false, code: "OFFLINE", reason: "Sem conexão com o servidor de licenças.", offline: true };
    }
  }

  async validate(): Promise<ValidateResult> {
    const current = this.session();
    if (!current) return { ok: false, code: "NO_SESSION", reason: "Nenhuma licença ativa neste aparelho." };

    try {
      const data = await this.post<{
        ok: boolean;
        token?: string;
        expiresAt?: string;
        license?: { plan: string; email: string | null; maxDevices: number; seatsUsed: number };
        code?: string;
        reason?: string;
      }>("/api/validate", { token: current.token, deviceId: this.deviceId() });

      if (!data.ok || !data.license) {
        // revogado/expirado/trocado: limpa a sessão local imediatamente
        this.save(null);
        return { ok: false, code: data.code ?? "INVALID", reason: data.reason ?? "Licença inválida." };
      }

      const refreshed = !!data.token;
      const session: LicenseSession = {
        token: data.token ?? current.token,
        expiresAt: data.expiresAt ?? current.expiresAt,
        plan: data.license.plan,
        email: data.license.email,
        maxDevices: data.license.maxDevices,
        seatsUsed: data.license.seatsUsed,
        lastOk: new Date().toISOString(),
      };
      this.save(session);
      return { ok: true, session, refreshed };
    } catch {
      return { ok: false, offline: true, code: "OFFLINE", reason: "Sem conexão — usando carência offline." };
    }
  }

  async deactivate(): Promise<ActivateResult> {
    const current = this.session();
    if (!current) return { ok: true };
    try {
      const data = await this.post<{ ok: boolean; reason?: string }>("/api/deactivate", {
        token: current.token,
        deviceId: this.deviceId(),
      });
      this.save(null);
      return { ok: data.ok, reason: data.reason };
    } catch {
      return { ok: false, offline: true, reason: "Sem conexão — tente de novo online." };
    }
  }

  /* ----------------------------- estado ----------------------------- */

  /**
   * O app está liberado?
   *  - token válido e assinado (exp não vencido), e
   *  - última confirmação do servidor dentro do período de carência.
   */
  isLicensed(): boolean {
    const s = this.session();
    if (!s?.token) return false;
    const exp = tokenPayloadExp(s.token);
    if (exp !== null && exp * 1000 < Date.now()) return false;
    const lastOk = new Date(s.lastOk).getTime();
    if (Number.isFinite(lastOk)) {
      const graceMs = this.graceDays * 86_400_000;
      if (Date.now() - lastOk > graceMs) return false;
    }
    return true;
  }

  /** Dias restantes até o servidor exigir nova validação. */
  offlineDaysLeft(): number {
    const s = this.session();
    if (!s) return 0;
    const elapsed = Date.now() - new Date(s.lastOk).getTime();
    return Math.max(0, Math.ceil((this.graceDays * 86_400_000 - elapsed) / 86_400_000));
  }

  startHeartbeat(intervalMs = this.heartbeatMs): void {
    this.stopHeartbeat();
    void this.validate();
    this.timer = setInterval(() => void this.validate(), intervalMs);
    // em navegador, tenta de novo quando a rede volta
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", () => void this.validate(), { once: true });
    }
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { detectPlatform, uuid as generateDeviceId };

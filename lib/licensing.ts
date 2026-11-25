import { backend } from "./backends";
import { SeatLimitError, type DeviceRow, type LicenseRow } from "./backends/types";
import { checkKey, generateKey, hashKey, keyHint } from "./keys";
import { DEFAULT_TTL_DAYS, signToken, tokenExpiry, verifyToken } from "./token";

/* ------------------------------- tipos ---------------------------------- */

export interface PublicLicense {
  id: string;
  /** prefixo + últimos 4 da key (nunca a key inteira) */
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
  devices: PublicDevice[];
}

export interface PublicDevice {
  deviceId: string;
  name: string | null;
  platform: string | null;
  firstSeen: string;
  lastSeen: string;
  revoked: boolean;
}

export type FailCode =
  | "INVALID_KEY"
  | "INVALID_TOKEN"
  | "REVOKED"
  | "EXPIRED"
  | "SEAT_LIMIT"
  | "DEVICE_REVOKED"
  | "DEVICE_MISMATCH"
  | "BAD_REQUEST";

export type Result<T> = ({ ok: true } & T) | { ok: false; code: FailCode; reason: string };

export interface ActivateInput {
  key: string;
  deviceId: string;
  deviceName?: string;
  platform?: string;
}

export interface ValidateInput {
  token: string;
  deviceId: string;
}

/* ------------------------------ helpers --------------------------------- */

const REASONS: Record<FailCode, string> = {
  INVALID_KEY: "Key inválida. Confira se digitou/copiou corretamente.",
  INVALID_TOKEN: "Sessão de licença inválida ou expirada. Ative a key novamente.",
  REVOKED: "Esta licença foi revogada.",
  EXPIRED: "Esta licença expirou.",
  SEAT_LIMIT: "Limite de dispositivos desta key já foi atingido. Desative outro aparelho ou fale com o suporte.",
  DEVICE_REVOKED: "Este dispositivo foi desativado pelo suporte.",
  DEVICE_MISMATCH: "Este token pertence a outro dispositivo.",
  BAD_REQUEST: "Pedido inválido.",
};

const fail = (code: FailCode, reason = REASONS[code]) => ({ ok: false as const, code, reason });

const clean = (s: unknown, max = 120): string | null => {
  if (typeof s !== "string") return null;
  const v = s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return v || null;
};

const isExpired = (row: LicenseRow): boolean =>
  !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now();

const seatsUsed = (devices: DeviceRow[]): number => devices.filter((d) => !d.revoked).length;

function toPublic(row: LicenseRow, devices: DeviceRow[]): PublicLicense {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    keyHint: row.key_hint,
    plan: row.plan,
    status: row.status === "revoked" ? "revoked" : isExpired(row) ? "expired" : "active",
    maxDevices: row.max_devices,
    seatsUsed: seatsUsed(devices),
    expiresAt: row.expires_at,
    email: row.email,
    note: row.note,
    createdAt: row.created_at,
    devices: devices.map((d) => ({
      deviceId: d.device_id,
      name: d.device_name,
      platform: d.platform,
      firstSeen: d.first_seen,
      lastSeen: d.last_seen,
      revoked: d.revoked,
    })),
  };
}


/**
 * Versão da licença que o cliente pode ver: sem os outros dispositivos
 * (um usuário com key compartilhada não precisa ver os aparelhos dos outros).
 */
function forClient(license: PublicLicense, deviceId: string): PublicLicense {
  return {
    ...license,
    keyPrefix: "",
    keyHint: "",
    devices: license.devices.filter((d) => d.deviceId === deviceId),
  };
}

/* ------------------------------ serviço --------------------------------- */

export class LicenseService {
  private get db() {
    return backend();
  }

  /* ---------- criar ---------- */

  async createLicenses(input: {
    count?: number;
    plan?: string;
    maxDevices?: number;
    expiresInDays?: number | null;
    email?: string | null;
    note?: string | null;
  }): Promise<{ keys: string[]; licenses: PublicLicense[] }> {
    const count = Math.min(Math.max(Number(input.count ?? 1) || 1, 1), 200);
    const plan = clean(input.plan, 32) ?? "pro";
    const maxDevices = Math.min(Math.max(Number(input.maxDevices ?? 1) || 1, 1), 20);
    const days = input.expiresInDays === null || input.expiresInDays === undefined
      ? null
      : Math.min(Math.max(Number(input.expiresInDays) || 0, 1), 3650);
    const expires_at = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

    const keys: string[] = [];
    const licenses: PublicLicense[] = [];

    for (let i = 0; i < count; i++) {
      const key = generateKey();
      const checked = checkKey(key);
      if (!checked.ok) throw new Error(`key gerada inválida: ${checked.reason}`);
      const hint = keyHint(key);

      const row = await this.db.insertLicense({
        key_hash: hashKey(checked.normalized),
        key_prefix: hint.key_prefix,
        key_hint: hint.key_hint,
        plan,
        status: "active",
        max_devices: maxDevices,
        expires_at,
        email: clean(input.email, 160),
        note: clean(input.note, 300),
      });

      await this.db.log({
        license_id: row.id,
        device_id: null,
        kind: "admin",
        detail: { action: "create", plan, maxDevices, expires_at },
      });

      keys.push(key);
      licenses.push(toPublic(row, []));
    }

    return { keys, licenses };
  }

  /* ---------- ativar ---------- */

  async activate(input: ActivateInput): Promise<
    Result<{ token: string; expiresAt: string; license: PublicLicense }>
  > {
    const deviceId = clean(input.deviceId, 128);
    if (!deviceId) return fail("BAD_REQUEST", "deviceId é obrigatório.");

    const checked = checkKey(input.key ?? "");
    if (!checked.ok) {
      await this.db.log({ license_id: null, device_id: deviceId, kind: "denied", detail: { reason: checked.reason } });
      return fail("INVALID_KEY", checked.reason);
    }

    const row = await this.db.findByKeyHash(hashKey(checked.normalized));
    if (!row) {
      await this.db.log({ license_id: null, device_id: deviceId, kind: "denied", detail: { reason: "not_found" } });
      return fail("INVALID_KEY");
    }

    const logDenied = async (code: FailCode) => {
      await this.db.log({ license_id: row.id, device_id: deviceId, kind: "denied", detail: { code } });
      return fail(code);
    };

    if (row.status === "revoked") return logDenied("REVOKED");
    if (isExpired(row)) return logDenied("EXPIRED");

    const deviceName = clean(input.deviceName, 64);
    const platform = clean(input.platform, 48);
    const now = new Date().toISOString();
    const existing = await this.db.getDevice(row.id, deviceId);

    if (existing) {
      if (existing.revoked) return logDenied("DEVICE_REVOKED");
      await this.db.touchDevice(row.id, deviceId, { device_name: deviceName ?? existing.device_name, platform: platform ?? existing.platform });
    } else {
      const devices = await this.db.listDevices(row.id);
      if (seatsUsed(devices) >= row.max_devices) return logDenied("SEAT_LIMIT");
      try {
        await this.db.insertDevice({
          license_id: row.id,
          device_id: deviceId,
          device_name: deviceName,
          platform,
          first_seen: now,
          last_seen: now,
          revoked: false,
        });
      } catch (e) {
        if (e instanceof SeatLimitError || (e as Error)?.name === "SeatLimitError") return logDenied("SEAT_LIMIT");
        throw e;
      }
    }

    const exp = tokenExpiry(row.expires_at);
    const token = signToken({
      lid: row.id,
      did: deviceId,
      plan: row.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(exp.getTime() / 1000),
    });

    await this.db.log({ license_id: row.id, device_id: deviceId, kind: "activate", detail: { platform } });

    const devices = await this.db.listDevices(row.id);
    return { ok: true, token, expiresAt: exp.toISOString(), license: forClient(toPublic(row, devices), deviceId) };
  }

  /* ---------- validar ---------- */

  async validate(input: ValidateInput): Promise<
    Result<{ license: PublicLicense; expiresAt: string; token?: string }>
  > {
    const payload = verifyToken(input.token ?? "");
    if (!payload) return fail("INVALID_TOKEN");
    if (payload.did !== input.deviceId) return fail("DEVICE_MISMATCH");

    const row = await this.db.getLicense(payload.lid);
    if (!row) return fail("REVOKED");
    if (row.status === "revoked") return fail("REVOKED");
    if (isExpired(row)) return fail("EXPIRED");

    const device = await this.db.getDevice(row.id, payload.did);
    if (!device || device.revoked) return fail("DEVICE_REVOKED");

    await this.db.touchDevice(row.id, payload.did);

    const devices = await this.db.listDevices(row.id);
    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    const refresh = remaining < 7 * 86_400; // renova quando faltam menos de 7 dias

    await this.db.log({ license_id: row.id, device_id: payload.did, kind: "validate", detail: { refresh } });

    let token: string | undefined;
    let expiresAt = new Date(payload.exp * 1000).toISOString();
    if (refresh) {
      const exp = tokenExpiry(row.expires_at);
      token = signToken({
        lid: row.id,
        did: payload.did,
        plan: row.plan,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(exp.getTime() / 1000),
      });
      expiresAt = exp.toISOString();
    }

    return { ok: true, license: forClient(toPublic(row, devices), payload.did), expiresAt, token };
  }

  /* ---------- desativar (libera assento) ---------- */

  async deactivate(input: ValidateInput): Promise<Result<{ license: PublicLicense }>> {
    const payload = verifyToken(input.token ?? "");
    if (!payload) return fail("INVALID_TOKEN");
    if (payload.did !== input.deviceId) return fail("DEVICE_MISMATCH");

    const row = await this.db.getLicense(payload.lid);
    if (!row) return fail("INVALID_TOKEN");

    await this.db.updateDevice(row.id, payload.did, { revoked: true });
    await this.db.log({ license_id: row.id, device_id: payload.did, kind: "deactivate", detail: null });

    const devices = await this.db.listDevices(row.id);
    return { ok: true, license: forClient(toPublic(row, devices), payload.did) };
  }

  /* ---------- admin ---------- */

  async list(): Promise<PublicLicense[]> {
    const [rows, devices] = await Promise.all([this.db.listLicenses(), this.db.listAllDevices()]);
    return rows.map((r) => toPublic(r, devices.filter((d) => d.license_id === r.id)));
  }

  async setRevoked(licenseId: string, revoked: boolean): Promise<PublicLicense | null> {
    const row = await this.db.getLicense(licenseId);
    if (!row) return null;
    await this.db.updateLicense(licenseId, {
      status: revoked ? "revoked" : "active",
      revoked_at: revoked ? new Date().toISOString() : null,
    });
    await this.db.log({
      license_id: licenseId,
      device_id: null,
      kind: "revoke",
      detail: { target: "license", revoked },
    });
    const devices = await this.db.listDevices(licenseId);
    return toPublic({ ...row, status: revoked ? "revoked" : "active" }, devices);
  }

  async setDeviceRevoked(
    licenseId: string,
    deviceId: string,
    revoked: boolean,
  ): Promise<PublicLicense | null> {
    const row = await this.db.getLicense(licenseId);
    if (!row) return null;
    await this.db.updateDevice(licenseId, deviceId, { revoked });
    await this.db.log({
      license_id: licenseId,
      device_id: deviceId,
      kind: "revoke",
      detail: { target: "device", revoked },
    });
    const devices = await this.db.listDevices(licenseId);
    return toPublic(row, devices);
  }

  async stats() {
    const [rows, devices] = await Promise.all([this.db.listLicenses(), this.db.listAllDevices()]);
    const now = Date.now();
    const active = rows.filter((r) => r.status === "active" && !isExpired(r));
    const expiring = active.filter(
      (r) => r.expires_at && new Date(r.expires_at).getTime() - now < 30 * 86_400_000,
    );
    return {
      total: rows.length,
      active: active.length,
      revoked: rows.filter((r) => r.status === "revoked").length,
      expired: rows.filter((r) => r.status !== "revoked" && isExpired(r)).length,
      expiringIn30d: expiring.length,
      devices: devices.filter((d) => !d.revoked).length,
      mode: this.db.mode,
      tokenTtlDays: DEFAULT_TTL_DAYS,
    };
  }
}

export const licensing = new LicenseService();

/** Contrato de armazenamento — implementado por Supabase e pelo JSON local. */

export type LicenseStatus = "active" | "revoked";

export interface LicenseRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  key_hint: string;
  plan: string;
  status: LicenseStatus;
  max_devices: number;
  expires_at: string | null;
  email: string | null;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface DeviceRow {
  license_id: string;
  device_id: string;
  device_name: string | null;
  platform: string | null;
  first_seen: string;
  last_seen: string;
  revoked: boolean;
}

export interface EventRow {
  license_id: string | null;
  device_id: string | null;
  kind: "activate" | "validate" | "deactivate" | "revoke" | "denied" | "admin";
  detail: Record<string, unknown> | null;
  created_at?: string;
}

export type LicenseInsert = Omit<LicenseRow, "id" | "created_at" | "revoked_at">;

export interface Backend {
  readonly mode: "supabase" | "file";

  insertLicense(input: LicenseInsert): Promise<LicenseRow>;
  updateLicense(id: string, patch: Partial<LicenseRow>): Promise<void>;
  findByKeyHash(hash: string): Promise<LicenseRow | null>;
  getLicense(id: string): Promise<LicenseRow | null>;
  listLicenses(): Promise<LicenseRow[]>;

  insertDevice(device: DeviceRow): Promise<void>;
  touchDevice(licenseId: string, deviceId: string, patch?: Partial<DeviceRow>): Promise<void>;
  updateDevice(licenseId: string, deviceId: string, patch: Partial<DeviceRow>): Promise<void>;
  getDevice(licenseId: string, deviceId: string): Promise<DeviceRow | null>;
  listDevices(licenseId: string): Promise<DeviceRow[]>;
  listAllDevices(): Promise<DeviceRow[]>;

  log(event: EventRow): Promise<void>;
  listEvents(limit: number): Promise<EventRow[]>;
}

/** Lançado quando o limite de dispositivos da licença é atingido. */
export class SeatLimitError extends Error {
  constructor() {
    super("SEAT_LIMIT");
    this.name = "SeatLimitError";
  }
}

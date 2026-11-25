import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Backend,
  DeviceRow,
  EventRow,
  LicenseInsert,
  LicenseRow,
} from "./types";

/**
 * Backend de desenvolvimento: um JSON em `.data/license-db.json`.
 *
 * Serve para rodar tudo sem configurar Supabase (preview, testes, demo).
 * NÃO use em produção serverless: o filesystem da Vercel é efêmero/read-only.
 * Sem `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, o sistema só sobe assim
 * quando `NODE_ENV !== "production"`.
 */

interface Db {
  licenses: LicenseRow[];
  devices: DeviceRow[];
  events: (EventRow & { created_at: string })[];
}

const EMPTY: Db = { licenses: [], devices: [], events: [] };

let queue: Promise<unknown> = Promise.resolve();

export class FileBackend implements Backend {
  readonly mode = "file" as const;
  private file: string;

  constructor(dir = path.join(process.cwd(), ".data")) {
    this.file = path.join(dir, "license-db.json");
  }

  private async read(): Promise<Db> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const db = JSON.parse(raw) as Partial<Db>;
      return {
        licenses: db.licenses ?? [],
        devices: db.devices ?? [],
        events: db.events ?? [],
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private async write(db: Db): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, this.file);
  }

  /** Serializa read-modify-write para não perder dados em concorrência. */
  private mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const db = await this.read();
      const out = await fn(db);
      await this.write(db);
      return out;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  async insertLicense(input: LicenseInsert): Promise<LicenseRow> {
    return this.mutate((db) => {
      const row: LicenseRow = {
        ...input,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        revoked_at: null,
      };
      db.licenses.push(row);
      return row;
    });
  }

  async updateLicense(id: string, patch: Partial<LicenseRow>): Promise<void> {
    await this.mutate((db) => {
      const i = db.licenses.findIndex((l) => l.id === id);
      if (i >= 0) db.licenses[i] = { ...db.licenses[i], ...patch };
    });
  }

  async findByKeyHash(hash: string): Promise<LicenseRow | null> {
    const db = await this.read();
    return db.licenses.find((l) => l.key_hash === hash) ?? null;
  }

  async getLicense(id: string): Promise<LicenseRow | null> {
    const db = await this.read();
    return db.licenses.find((l) => l.id === id) ?? null;
  }

  async listLicenses(): Promise<LicenseRow[]> {
    const db = await this.read();
    return [...db.licenses].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async insertDevice(device: DeviceRow): Promise<void> {
    await this.mutate((db) => {
      const exists = db.devices.some(
        (d) => d.license_id === device.license_id && d.device_id === device.device_id,
      );
      if (exists) return;
      const used = db.devices.filter(
        (d) => d.license_id === device.license_id && !d.revoked,
      ).length;
      const lic = db.licenses.find((l) => l.id === device.license_id);
      if (lic && used >= lic.max_devices) {
        const err = new Error("SEAT_LIMIT");
        err.name = "SeatLimitError";
        throw err;
      }
      db.devices.push(device);
    });
  }

  async touchDevice(licenseId: string, deviceId: string, patch: Partial<DeviceRow> = {}): Promise<void> {
    await this.mutate((db) => {
      const d = db.devices.find((x) => x.license_id === licenseId && x.device_id === deviceId);
      if (d) Object.assign(d, patch, { last_seen: new Date().toISOString() });
    });
  }

  async updateDevice(licenseId: string, deviceId: string, patch: Partial<DeviceRow>): Promise<void> {
    await this.mutate((db) => {
      const d = db.devices.find((x) => x.license_id === licenseId && x.device_id === deviceId);
      if (d) Object.assign(d, patch);
    });
  }

  async getDevice(licenseId: string, deviceId: string): Promise<DeviceRow | null> {
    const db = await this.read();
    return db.devices.find((d) => d.license_id === licenseId && d.device_id === deviceId) ?? null;
  }

  async listDevices(licenseId: string): Promise<DeviceRow[]> {
    const db = await this.read();
    return db.devices.filter((d) => d.license_id === licenseId);
  }

  async listAllDevices(): Promise<DeviceRow[]> {
    const db = await this.read();
    return db.devices;
  }

  async log(event: EventRow): Promise<void> {
    await this.mutate((db) => {
      db.events.push({ ...event, created_at: new Date().toISOString() });
      if (db.events.length > 2000) db.events.splice(0, db.events.length - 2000);
    });
  }

  async listEvents(limit = 100): Promise<(EventRow & { created_at: string })[]> {
    const db = await this.read();
    return db.events.slice(-limit).reverse();
  }
}

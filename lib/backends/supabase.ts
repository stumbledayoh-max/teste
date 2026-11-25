import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SeatLimitError, type Backend, type DeviceRow, type EventRow, type LicenseInsert, type LicenseRow } from "./types";

/**
 * Backend de produção: Supabase (Postgres) com a service_role key.
 *
 * Regras importantes:
 *  - a service_role key só existe no servidor (rotas /api). Nunca no cliente;
 *  - RLS fica ligado e sem policies: nem anon nem authenticated leem as tabelas;
 *  - o limite de assentos também é garantido no banco por trigger
 *    (`lic_seat_guard`), então duas ativações simultâneas não furam o limite.
 */

export class SupabaseBackend implements Backend {
  readonly mode = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "license-key-server" } },
    });
  }

  private one<T>(data: T | null, error: { message: string } | null): T | null {
    if (error) throw new Error(`supabase: ${error.message}`);
    return data;
  }

  async insertLicense(input: LicenseInsert): Promise<LicenseRow> {
    const { data, error } = await this.db
      .from("licenses")
      .insert({
        key_hash: input.key_hash,
        key_prefix: input.key_prefix,
        key_hint: input.key_hint,
        plan: input.plan,
        status: input.status,
        max_devices: input.max_devices,
        expires_at: input.expires_at,
        email: input.email,
        note: input.note,
      })
      .select("*")
      .single();
    return this.one(data as LicenseRow, error)!;
  }

  async updateLicense(id: string, patch: Partial<LicenseRow>): Promise<void> {
    const { error } = await this.db.from("licenses").update(patch).eq("id", id);
    if (error) throw new Error(`supabase: ${error.message}`);
  }

  async findByKeyHash(hash: string): Promise<LicenseRow | null> {
    const { data, error } = await this.db
      .from("licenses")
      .select("*")
      .eq("key_hash", hash)
      .maybeSingle();
    return this.one(data as LicenseRow | null, error);
  }

  async getLicense(id: string): Promise<LicenseRow | null> {
    const { data, error } = await this.db.from("licenses").select("*").eq("id", id).maybeSingle();
    return this.one(data as LicenseRow | null, error);
  }

  async listLicenses(): Promise<LicenseRow[]> {
    const { data, error } = await this.db
      .from("licenses")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    return this.one((data ?? []) as LicenseRow[], error) ?? [];
  }

  async insertDevice(device: DeviceRow): Promise<void> {
    const { error } = await this.db.from("license_devices").insert(device);
    if (error) {
      // P0001 = raise exception do trigger lic_seat_guard
      if (error.message.includes("SEAT_LIMIT") || error.code === "P0001") throw new SeatLimitError();
      // corrida: o device já existia (unique constraint)
      if (error.code === "23505") return;
      throw new Error(`supabase: ${error.message}`);
    }
  }

  async touchDevice(licenseId: string, deviceId: string, patch: Partial<DeviceRow> = {}): Promise<void> {
    const { error } = await this.db
      .from("license_devices")
      .update({ ...patch, last_seen: new Date().toISOString() })
      .eq("license_id", licenseId)
      .eq("device_id", deviceId);
    if (error) throw new Error(`supabase: ${error.message}`);
  }

  async updateDevice(licenseId: string, deviceId: string, patch: Partial<DeviceRow>): Promise<void> {
    const { error } = await this.db
      .from("license_devices")
      .update(patch)
      .eq("license_id", licenseId)
      .eq("device_id", deviceId);
    if (error) throw new Error(`supabase: ${error.message}`);
  }

  async getDevice(licenseId: string, deviceId: string): Promise<DeviceRow | null> {
    const { data, error } = await this.db
      .from("license_devices")
      .select("*")
      .eq("license_id", licenseId)
      .eq("device_id", deviceId)
      .maybeSingle();
    return this.one(data as DeviceRow | null, error);
  }

  async listDevices(licenseId: string): Promise<DeviceRow[]> {
    const { data, error } = await this.db
      .from("license_devices")
      .select("*")
      .eq("license_id", licenseId)
      .order("last_seen", { ascending: false });
    return this.one((data ?? []) as DeviceRow[], error) ?? [];
  }

  async listAllDevices(): Promise<DeviceRow[]> {
    const { data, error } = await this.db
      .from("license_devices")
      .select("*")
      .order("last_seen", { ascending: false })
      .limit(1000);
    return this.one((data ?? []) as DeviceRow[], error) ?? [];
  }

  async log(event: EventRow): Promise<void> {
    try {
      await this.db.from("license_events").insert(event);
    } catch {
      /* auditoria nunca derruba o fluxo principal */
    }
  }

  async listEvents(limit = 100): Promise<(EventRow & { created_at: string })[]> {
    const { data, error } = await this.db
      .from("license_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    return this.one((data ?? []) as (EventRow & { created_at: string })[], error) ?? [];
  }
}

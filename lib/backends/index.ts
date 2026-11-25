import { FileBackend } from "./file";
import { SupabaseBackend } from "./supabase";
import type { Backend } from "./types";

let cached: Backend | null = null;

export function isConfigured(): boolean {
  return !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Escolhe o backend:
 *  - Supabase quando SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY existem;
 *  - senão, JSON local (só fora de produção).
 */
export function backend(): Backend {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && serviceRole) {
    cached = new SupabaseBackend(url, serviceRole);
    return cached;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Backend de licenças não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente.",
    );
  }

  cached = new FileBackend();
  return cached;
}

/** Modo atual sem lançar exceção (usado por /api/health e pela UI). */
export function backendMode(): "supabase" | "file" | "unconfigured" {
  if (isConfigured()) return "supabase";
  return process.env.NODE_ENV === "production" ? "unconfigured" : "file";
}

export * from "./types";

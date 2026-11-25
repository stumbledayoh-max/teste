import type { Metadata, Viewport } from "next";
import { NavLinks } from "@/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: "Key Server — licenças com ativação por dispositivo",
  description:
    "Servidor de licenças por key: ativação por dispositivo, limite de assentos, expiração, revogação instantânea e painel admin. Next.js + Supabase.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#060910",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="site-header">
          <div className="wrap">
            <a className="brand" href="/">
              <span className="logo" aria-hidden>
                K
              </span>
              key-server
            </a>
            <NavLinks />
          </div>
        </header>

        {children}

        <footer className="footer">
          <div className="wrap">
            Keys guardadas como SHA-256 · tokens assinados com HMAC-SHA256 · RLS fechado no Supabase ·
            pronto para Vercel. Projeto de licenciamento da sua própria aplicação.
          </div>
        </footer>
      </body>
    </html>
  );
}

# Key Server — licenças com ativação por dispositivo

Servidor de licenciamento completo para o **seu** app: key única por cliente, ativação amarrada ao
aparelho, limite de assentos, expiração por plano e revogação que derruba o dispositivo na hora —
com painel de administração e SDK pronto para navegador/WebView.

> Este projeto é para licenciar software que você desenvolve ou tem autorização para distribuir.
> Ele não contorna a proteção de licença de aplicativos de terceiros.

```
Next.js 16 (App Router)  ─┬─  /api/activate     ─┐
       React 19           ├─  /api/validate      ├──  Postgres (Supabase)
       TypeScript         ├─  /api/deactivate    │    licenses
                          └─  /api/admin/*       ┘    license_devices
                                                    license_events
```

---

## Índice

1. [O que já está pronto](#o-que-já-está-pronto)
2. [Rodar em 3 comandos](#rodar-em-3-comandos)
3. [Configurar o Supabase](#configurar-o-supabase)
4. [Variáveis de ambiente](#variáveis-de-ambiente)
5. [Deploy na Vercel](#deploy-na-vercel)
6. [API](#api)
7. [SDK — usar no seu app](#sdk--usar-no-seu-app)
8. [Fluxos de operação (suporte/loja)](#fluxos-de-operação)
9. [Modelo de segurança](#modelo-de-segurança)
10. [Limites conhecidos e próximos passos](#limites-conhecidos-e-próximos-passos)

---

## O que já está pronto

| Recurso | Como funciona |
| --- | --- |
| **Key única** | `ENJOY-XXXXXXX-XXXXXXX-XXXXXXX` — base32 Crockford (100 bits) + dígito verificador |
| **Key nunca em claro** | No banco só existe `sha256(prefixo:key)` + prefixo + últimos 4 dígitos |
| **Ativação por dispositivo** | `deviceId` estável gerado e persistido no cliente |
| **Limite de assentos** | Checagem na API **e** trigger no Postgres (não fura em corrida) |
| **Expiração** | Por licença (`expires_at = null` ⇒ vitalícia) e por token (TTL padrão 30 dias) |
| **Revogação** | Da licença inteira ou de um aparelho específico, com liberação de assento |
| **Token assinado** | `base64url(payload).base64url(hmac-sha256)` — não dá para forjar no cliente |
| **Carência offline** | 7 dias por padrão: app abre sem rede, mas revalida quando volta |
| **Rate limit** | Por IP e por key (brute force em key de 100 bits já é inviável, mas custa barato) |
| **Auditoria** | `license_events`: ativações, validações, negações, revogações |
| **Painel admin** | Gerar em lote, copiar/CSV, buscar, revogar licença ou aparelho, KPIs |
| **Modo dev sem banco** | Sem `SUPABASE_*` roda com JSON local em `.data/` — nada para configurar |

---

## Rodar em 3 comandos

```bash
npm install
npm run dev            # http://localhost:3000
# em outro terminal:
npm run smoke          # 20+ verificações ponta a ponta contra o servidor local
```

Sem variáveis de ambiente o app sobe em **modo dev** (JSON em `.data/`, painel liberado com o token
`dev-admin`). Perfeito para ver o fluxo funcionando antes de plugar o Supabase.

Telas:

- `/` — visão geral e status do backend
- `/activate` — cliente de exemplo: ativa key, guarda token, revalida, desativa
- `/admin` — gerar keys, listar, revogar, ver dispositivos

---

## Configurar o Supabase

O schema já está em [`supabase/migrations/0001_license_system.sql`](supabase/migrations/0001_license_system.sql)
e foi aplicado no projeto **kvolexdhcmiqyguqbsyl** (`stumbledayoh@gmail.com's Project`).

Para aplicar em outro projeto:

```bash
supabase link --project-ref SEU_REF
supabase db push
```

ou cole o SQL no **SQL Editor** do painel.

O que a migration cria:

- `licenses` — key (hash), plano, status, assentos, validade, e-mail, nota
- `license_devices` — um registro por aparelho, PK `(license_id, device_id)`
- `license_events` — auditoria
- `lic_seat_guard()` — trigger que levanta `SEAT_LIMIT` quando o limite estoura
- RLS **ligado e sem policies** + `revoke` de `anon`/`authenticated`: só a `service_role`
  (usada exclusivamente no servidor) enxerga os dados

---

## Variáveis de ambiente

Copie `.env.example` para `.env.local`:

| Variável | Obrigatória | Para que serve |
| --- | --- | --- |
| `SUPABASE_URL` | produção | URL do projeto (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | produção | acesso server-side; **nunca** exponha no cliente |
| `LICENSE_HMAC_SECRET` | produção | assina os tokens (`openssl rand -hex 32`) |
| `ADMIN_TOKEN` | produção | senha do painel (`openssl rand -hex 24`) |
| `LICENSE_KEY_PREFIX` | opcional | prefixo das keys (padrão `ENJOY`) |
| `LICENSE_TOKEN_TTL_DAYS` | opcional | validade do token (padrão `30`) |

Sem `ADMIN_TOKEN` em produção o painel fica **desligado** (503) — de propósito.
Sem `LICENSE_HMAC_SECRET` em produção o servidor recusa iniciar o fluxo de tokens.

---

## Deploy na Vercel

```bash
npm i -g vercel
vercel                 # primeiro deploy (preview)
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add LICENSE_HMAC_SECRET production
vercel env add ADMIN_TOKEN production
vercel --prod
```

Detalhes:

- Todas as rotas são `runtime = "nodejs"` e `force-dynamic` (nada de cache em resposta de licença).
- O **modo JSON local não existe em produção** (filesystem da Vercel é efêmero): sem as variáveis do
  Supabase a API responde `503 NOT_CONFIGURED` — falha explícita, nunca licença liberada por engano.
- Rate limit em memória é por instância. Se precisar de limite global, troque `lib/ratelimit.ts` por
  Upstash (`@upstash/ratelimit`) mantendo a assinatura de `rateLimit()`.
- Coloque o painel atrás de SSO/Vercel Authentication se for algo de time.

---

## API

### Públicas

```bash
# ativar
curl -X POST http://localhost:3000/api/activate \
  -H 'content-type: application/json' \
  -d '{"key":"ENJOY-XXXXXXX-XXXXXXX-XXXXXXX","deviceId":"abc-123","deviceName":"Pixel 7","platform":"android"}'
# → {"ok":true,"token":"...","expiresAt":"2026-01-22T...","license":{...}}

# revalidar (boot + heartbeat)
curl -X POST http://localhost:3000/api/validate \
  -H 'content-type: application/json' \
  -d '{"token":"...","deviceId":"abc-123"}'
# → {"ok":true,"license":{...}}  |  {"ok":false,"code":"REVOKED"|"EXPIRED"|"DEVICE_REVOKED"|...}

# desativar (libera o assento)
curl -X POST http://localhost:3000/api/deactivate \
  -H 'content-type: application/json' -d '{"token":"...","deviceId":"abc-123"}'

# status do servidor
curl http://localhost:3000/api/health
```

Códigos de falha: `INVALID_KEY`, `INVALID_TOKEN`, `REVOKED`, `EXPIRED`, `SEAT_LIMIT`,
`DEVICE_REVOKED`, `DEVICE_MISMATCH`, `BAD_REQUEST`, `RATE_LIMITED`, `NOT_CONFIGURED`.

### Admin (header `x-admin-token` ou `Authorization: Bearer`)

```bash
curl -X POST http://localhost:3000/api/admin/keys \
  -H 'x-admin-token: dev-admin' -H 'content-type: application/json' \
  -d '{"count":5,"plan":"pro","maxDevices":2,"expiresInDays":365,"email":"cliente@ex.com"}'
# → {"ok":true,"keys":["ENJOY-...","..."],"licenses":[...]}   ← única vez que a key aparece

curl http://localhost:3000/api/admin/keys -H 'x-admin-token: dev-admin'     # lista + stats
curl -X PATCH http://localhost:3000/api/admin/keys -H 'x-admin-token: dev-admin' \
  -H 'content-type: application/json' -d '{"licenseId":"...","revoked":true}'
curl -X PATCH http://localhost:3000/api/admin/devices -H 'x-admin-token: dev-admin' \
  -H 'content-type: application/json' -d '{"licenseId":"...","deviceId":"abc-123","revoked":true}'
```

---

## SDK — usar no seu app

`sdk/license-client.ts` é zero-dependência: navegador, WebView (Android/iOS) e Node.

### Web / SPA

```ts
import { LicenseClient } from "@/sdk/license-client";

const lic = new LicenseClient({ product: "meu-app" }); // baseUrl = mesma origem

const r = await lic.activate(keyDigitadaPeloUsuario);
if (!r.ok) mostrarErro(r.code, r.reason);

if (!lic.isLicensed()) return mostrarTelaDeAtivacao();
lic.startHeartbeat();          // revalida a cada 6h + ao voltar a rede
```

### Gate no boot

```ts
async function boot() {
  const lic = new LicenseClient({ product: "meu-app" });
  const s = lic.session();
  if (!s) return telaDeAtivacao();

  const v = await lic.validate();
  if (!v.ok && !v.offline) return telaDeAtivacao(v.reason);   // revogado/expirado
  if (!v.ok && v.offline && lic.offlineDaysLeft() <= 0) return telaDeAtivacao("Conecte-se para validar");

  liberarApp();
}
```

### Dentro do APK (WebView)

O SDK funciona igual, porque `localStorage` existe no WebView. Para dar ao app nativo uma resposta
sem esperar o JS:

```kotlin
// MainActivity.kt — o JS chama a ponte depois de validar
class LicenseBridge(private val activity: Activity) {
    @JavascriptInterface
    fun onLicense(resultJson: String) {
        val ok = JSONObject(resultJson).optBoolean("ok")
        activity.runOnUiThread {
            if (!ok) activity.startActivity(Intent(activity, ActivationActivity::class.java))
        }
    }
}
webView.addJavascriptInterface(LicenseBridge(this), "LicenseNative")
```

E, no JS: `window.LicenseNative?.onLicense(JSON.stringify({ ok: lic.isLicensed() }))`.

**Checklist do APK** (o servidor de licenças roda fora do app, por HTTPS):

1. `<uses-permission android:name="android.permission.INTERNET" />` (padrão em quase todo projeto).
2. WebView com `settings.domStorageEnabled = true` — o `deviceId` e o token ficam no `localStorage`.
   Se preferir não usar localStorage, passe um `storage` próprio no construtor do `LicenseClient`.
3. Aponte o SDK para o servidor publicado:
   `new LicenseClient({ baseUrl: "https://SEU-PROJETO.vercel.app", product: "meu-app" })`.
4. As rotas públicas respondem `Access-Control-Allow-Origin: *` (sem cookies), então funciona com o
   HTML carregado de `file://`, `appassets://` ou de outro domínio. As rotas `/api/admin` não são
   CORS-abertas de propósito.
5. HTTPS é obrigatório (sem `usesCleartextTraffic`). Domínio precisa ser público — em projeto Vercel
   com **Deployment Protection → Vercel Authentication** ligada, até o app recebe a tela de login;
   desligue a proteção em produção (ou use um domínio próprio).
6. Sem rede o app continua abrindo por até `graceDays` (7 por padrão) usando o último `lastOk`;
   depois disso `isLicensed()` vira `false` até validar de novo.

> Regra: nunca coloque a `service_role` key nem a lógica de decidir "válido" no APK. O binário é
> inspecionável; o que protege é a key nunca estar em claro no banco, o token ser assinado e a
> revogação ser checada no servidor.

---

## Ferramenta offline: `ferramentas/gerador-keys.html`

Um único arquivo HTML — abre com dois cliques (`file://`), **sem servidor, sem Supabase, sem internet**.

- Gera N keys com o **mesmo alfabeto, mesmo dígito verificador e mesmo hash** do servidor
  (SHA-256 puro em JS, conferido byte a byte contra o servidor).
- Exporta `.txt`, `.csv` e o **`.sql` de importação** com `key_hash`, prefixo, finais, plano, assentos,
  validade e e-mail. Rodou esse SQL no Supabase? As keys já ativam na API, sem tocar no código.
- Aba **Verificar**: confere formato/verificador e mostra o hash que o servidor vai procurar.
- Aba **Teste offline**: simula ativação, limite de assentos, expiração e revogação só com
  `localStorage` — bom para demonstrar o fluxo sem banco nenhum.

```bash
open ferramentas/gerador-keys.html        # macOS
xdg-open ferramentas/gerador-keys.html    # Linux
start ferramentas\gerador-keys.html       # Windows
```

Fluxo recomendado para vender sem painel: gerar 10 keys na ferramenta → baixar o `.sql` → colar no
SQL Editor do Supabase → entregar as keys. Para revogar depois, use o `/admin` do site.

> O arquivo não fica em `public/`, então não é servido pelo deploy. Mesmo assim, guarde com cuidado:
> quem tiver o HTML não consegue ativar nada sozinho (precisa do `INSERT` no seu banco).

## Fluxos de operação

| Situação | O que fazer no painel |
| --- | --- |
| Cliente trocou de celular | *devices → revogar* no aparelho antigo (libera o assento) e o cliente ativa no novo |
| Reembolso / fraude | *revogar* a licença — o token morre na próxima validação (≤ 30 dias; o `/validate` do boot já bloqueia) |
| Upgrade de plano | gere uma key nova do plano novo e revogue a antiga |
| Cliente perdeu a key | não dá para recuperar (só existe o hash) — revogue e emita outra |
| Key vazou em grupo de Telegram | revogar a licença; se compartilharam assento, revogar os devices um a um |

Para reduzir o intervalo entre "revogar" e "parar de funcionar": diminua `LICENSE_TOKEN_TTL_DAYS`
(ex.: 7) e use `startHeartbeat(ms)` com intervalo menor no app.

---

## Modelo de segurança

- **Keys**: 100 bits de entropia + checksum. Inviável adivinhar; o rate limit protege a força bruta
  ingênua e a auditoria registra cada negação.
- **Armazenamento**: hash SHA-256 com prefixo como *pepper*. Vazamento do banco não entrega keys.
- **Tokens**: HMAC-SHA256; payload manipulável só invalidaria a assinatura. Comparação de assinatura
  em tempo constante.
- **Autorização**: `service_role` só no servidor; RLS fechado; rotas admin exigem `ADMIN_TOKEN`
  (comparado em tempo constante, com rate limit de 10 tentativas/10 min por IP).
- **Assentos**: trigger `lic_seat_guard` garante o limite mesmo com requisições concorrentes.
- **Falha segura**: em produção, sem configuração o servidor responde 503 — não libera nada.

---

## Limites conhecidos e próximos passos

- **Device ID é gerado no cliente** — um usuário técnico pode copiar o `localStorage` para outro
  aparelho. Para endurecer: assine o device id com um segredo embutido no app + `device_name`
  heurístico, ou use Play Integrity / App Attest para atestado de dispositivo.
- **Rate limit em memória** (por instância) — trocar por Upstash em escala.
- **Sem e-mail de entrega** — plugue Resend/Postmark no `POST /api/admin/keys` para mandar a key.
- **Sem gateway de pagamento** — Stripe/Kiwify/Pix → webhook → `createLicenses()`.
- **Roles de admin** — hoje um token único; para time, migre para Supabase Auth + tabela de papéis.

Ideias de evolução natural: webhook de pagamento emitindo key automática, portal do cliente
(ativar/desativar sozinho) e gráfico de ativações por dia.

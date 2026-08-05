# MYOB Inventory Dashboard

Foundation app for connecting to MYOB Business / AccountRight Online company files via OAuth 2.0 and listing inventory items for a multi-client inventory dashboard.

## Stack

- Node.js 20+ / TypeScript
- Express API + static UI (`public/`)
- Postgres connection store when `DATABASE_URL` is set (Railway); file fallback (`.data/`) for local

## What this gives you

1. OAuth login against MYOB with Contact, Sale, Purchase, and Inventory scopes (`sme-company-file` + contact/sales/purchases/inventory SME scopes)
2. Capture of each client `businessId` (company file GUID) from the OAuth redirect
3. Token exchange + refresh
4. Inventory listing via `GET /{businessId}/Inventory/Item`
5. Connection console UI to authorise files and probe Contact / Sale / Purchase / Inventory access

## MYOB setup (you need to do this)

1. Register for API access at [developer.myob.com](https://developer.myob.com).
2. In [my.MYOB](https://my.myob.com) → **Developer** → **Register App**:
   - App name (e.g. `Esperion Inventory Dashboard`)
   - Redirect URI (must match `MYOB_REDIRECT_URI` exactly)
3. Copy the generated **API Key** and **API Secret** into `.env`.
4. Authorising user must be a company file **Administrator**.
5. For keys created after March 2025, use the new SME scopes (already set in `.env.example`): Contact (`sme-contacts-*`), Sale (`sme-sales`), Purchase (`sme-purchases`), Inventory (`sme-inventory`). Re-run **Connect MYOB** after changing scopes so the company file re-consents.
6. MYOB currently expects redirect URIs to be `https://` for newer keys. For local HTTPS, use a tunnel (ngrok/cloudflared) and register that URL.

### TODO — values only you can provide

- [ ] `MYOB_API_KEY`
- [ ] `MYOB_API_SECRET`
- [ ] Registered redirect URI matching `MYOB_REDIRECT_URI`
- [ ] `DATABASE_URL` (Railway Postgres reference on the app service)
- [ ] Optional: `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`)
- [ ] At least one MYOB company file (sandbox invite or real client file) with an admin user
- [ ] Optional: `MYOB_CF_USERNAME` / `MYOB_CF_PASSWORD` if your file still requires `x-myobapi-cftoken`

## Railway Postgres

1. In the Railway project: **+ New → Database → PostgreSQL**
2. Open your **app** service → **Variables** → add reference `DATABASE_URL` from Postgres
3. Optional: add `TOKEN_ENCRYPTION_KEY` (long random string)
4. Redeploy the app — logs should show `Connection store: postgres`
5. Allied connects once; tokens persist across redeploys

## Run locally

```bash
cp .env.example .env
# edit .env with your MYOB credentials

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → **Connect MYOB**.

### Useful endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/login` | Start OAuth |
| GET | `/auth/callback` | OAuth redirect handler |
| GET | `/auth/status` | Config + connected files |
| POST | `/auth/active` | Switch active company `{ "businessId": "..." }` |
| POST | `/auth/logout` | Clear local connections |
| GET | `/api/connection/probe` | Probe Contact / Sale / Purchase / Inventory endpoint access |
| GET | `/api/inventory/items?top=100` | List inventory items |
| GET | `/api/inventory/locations` | List inventory locations |
| GET | `/api/company` | Active company file metadata |

## Multi-client model

Each client company file is authorised separately (OAuth with `prompt=consent`). The app stores one connection per `businessId` and lets you switch the active file. Re-run **Connect MYOB** for each client.

## Project layout

```
src/
  index.ts            Express entry
  config.ts           Env config
  myob/auth.ts        OAuth authorize / token / refresh
  myob/client.ts      Business API client + inventory helpers
  routes/auth.ts      Auth routes
  routes/api.ts       Inventory / company API
  store/connections.ts Local token + company store
public/               Minimal dashboard UI
.env.example          Credential placeholders
```

## Notes / caveats

- Access tokens last ~20 minutes; refresh tokens ~1 week. The client refreshes automatically when expired.
- Tokens are stored on disk for local/dev convenience — use a real secret store before production.
- The legacy `GET /accountright` company-file list is deprecated for new keys; `businessId` comes from the OAuth redirect.
- Prefer `https://arl2.api.myob.com/accountright` as the API base for current cloud files.
- Rate limits are roughly 8 req/s and 1M req/day per API key; inventory defaults to page size 400 (max 1000).

## Next build steps (suggested)

- Persist connections in a database with encryption at rest
- Per-client sync jobs + caching for the dashboard
- HTTPS redirect URI via reverse proxy / tunnel in staging
- Richer inventory views (locations, adjustments, low-stock filters)

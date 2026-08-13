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
| GET | `/api/dashboard/summary` | Dashboard metrics summary |
| GET | `/api/inventory/items?top=100` | List inventory items |
| GET | `/api/inventory/locations` | List inventory locations |
| GET | `/api/company` | Active company file metadata |
| GET | `/dashboard` | Allied inventory dashboard UI |

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

## Inventory intelligence dashboard (`/dashboard`)

Decision-support product for Allied Fastenings built on read-only MYOB data.
The connection console at `/` is unchanged and remains the admin surface for
OAuth.

### Architecture

```
MYOB Business API  --(read-only GETs)-->  sync engine  -->  Postgres mirror
                                                              |
                                            analytics (SQL + risk scoring)
                                                              |
                                                    /api/insights/*  -->  /dashboard SPA
```

- `src/sync/engine.ts` mirrors items, locations, suppliers, item-layout sales
  invoices/orders, purchase bills/orders, inventory builds and adjustments into
  `myob_*` tables (paged at 400 rows, throttled under MYOB's 8 req/s limit,
  incremental via `LastModified` high-water marks with a 5-minute overlap).
- `src/insights/queries.ts` computes demand, cover, risk, buildability and
  purchasing suggestions. `platform_*` tables hold product-created data only.
- `public/dashboard.*` is the UI: Overview, Inventory, Products & BOM,
  Purchasing (CSV export), Data & Sync.

### Major product/data decisions

1. **MYOB is strictly read-only.** The sync uses GET only; there is no write
   path anywhere in the codebase. Everything the product creates (derived
   relationships, user-entered BOM rows, suggestions) stays in Postgres and is
   labelled as platform data in the UI.
2. **Position quantities are MYOB facts.** On hand / committed / on order /
   available come from the item master and are never recomputed. Our
   transaction mirror is the *evidence* layer that explains them.
   MYOB's `QuantityAvailable` *includes* on-order stock (verified against
   Allied's file: available = on hand − committed + on order for every item
   with an open PO), so analysis never uses it: cover, buildability and
   purchase suggestions use **free stock = on hand − committed**, with open-PO
   incoming subtracted separately — incoming supply is counted exactly once.
3. **Demand = direct sales + build consumption.** Item-layout invoice lines
   (credit notes net off automatically) plus components consumed by Inventory
   Build transactions. These are distinct MYOB movements, so no double
   counting. Adjustments and transfers are never demand.
4. **Product relationships are derived from Build transactions.** The Business
   API does not expose Auto-Build definitions, so composition is observed from
   builds with a single finished item (confidence grows with corroborating
   builds) and can be supplemented by Allied-entered rows, always labelled
   with their source.
5. **Every number is traceable.** Item pages show the underlying invoices,
   bills, builds, adjustments, open orders and purchase history, plus the risk
   factor breakdown and the arithmetic behind any purchase suggestion.
6. **Suppliers are resolved, regions are platform labels.** A product may have
   several suppliers, recorded by Allied in `platform_item_suppliers` with one
   marked preferred. Effective supplier = Allied's preferred → MYOB primary →
   dominant supplier inferred from purchase-bill history (Allied's file sets a
   MYOB primary on 0 of 3,100 items). Every view labels which applied. Supplier regions
   (NZ / Australia / China / Overseas — other) auto-derive from the MYOB
   address country and are overridable on the Suppliers page; region, lead
   time and notes live in `platform_supplier_meta`, never in MYOB.

### Operating it

1. Set `DATABASE_URL` (required), `DASHBOARD_ACCESS_KEY` (recommended) and
   optionally `SYNC_WINDOW_DAYS` / `TARGET_COVER_WEEKS` / `SYNC_INTERVAL_HOURS`.
2. Deploy, open `/dashboard`, run **Full sync** (first run reads the whole
   history window; a few minutes for Allied's dataset).
3. Afterwards use **Incremental sync** (or set `SYNC_INTERVAL_HOURS`).

### Optional tuning

`TARGET_COVER_WEEKS` (default 8) drives purchasing suggestions;
`EXCESS_COVER_WEEKS` (26) and `EXCESS_MIN_VALUE` (250) decide what counts as
overstock; `SYNC_WINDOW_DAYS` (365) bounds transactional history.

### Known limitations (also shown in-app)

- History limited to the sync window; deleted MYOB documents disappear only on
  a full sync; per-location stock split is not exposed by the item master;
  supplier lead times are not yet estimated; service-layout invoices carry no
  item demand.

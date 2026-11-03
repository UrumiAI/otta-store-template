# Otta store

An online store on Cloudflare Workers: [EmDash](https://github.com/emdash-cms/emdash) for
content and [Otta](https://github.com/UrumiAI/otta.sh) for commerce (catalog, stock, cart,
checkout, orders, card payments with Stripe, cash on delivery). It runs as one Worker with
one D1 database.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/UrumiAI/otta-store-template)

This repository holds no store code. The store is the `@urumi.ai/otta-store` package, so an
update is a version bump, not a merge.

## Before you click

- **R2 needs a payment method on your Cloudflare account.** The free allowance still applies;
  the store's two buckets are created during deploy.
- **Have an encryption key ready.** The button asks for `EMDASH_ENCRYPTION_KEY`. Make one with
  `npx emdash secrets generate`, or with
  `node -e "console.log('emdash_enc_v1_'+require('crypto').randomBytes(32).toString('base64url'))"`.
  **Keep a copy in your password manager.** It encrypts the payment keys you enter in the
  admin; without it they have to be entered again.

## What the button creates

A copy of this repository in your GitHub account, and on Cloudflare:

| Binding | What | Notes |
|---|---|---|
| `DB` | D1 database | Your content and every order, cart and customer. |
| `MEDIA` | R2 bucket | Product images. Served publicly. |
| `DOWNLOADS` | R2 bucket | Files buyers pay for. **Keep it private**: never turn on its r2.dev URL or connect a domain to it. It must be a different bucket from `MEDIA` (the build refuses one shared bucket). |
| `SESSION` | KV namespace | Admin sign-in sessions. |
| `IMAGES` | Images | Resizes product photos. |
| `RATE_LIMIT_AUTH`, `RATE_LIMIT_WRITES` | Rate limits | Per-visitor limits on sign-in and on cart and checkout writes. Cash on delivery is only offered with them. Their `namespace_id`s (`1001`, `1002`) are fixed in `wrangler.jsonc`, and Workers in one Cloudflare account that use the same ids **share the counters**: give a second store in the same account its own ids. |

It also sets up **Workers Builds**: every push to your production branch runs `npm run build`
and `npm run deploy`.

## After deploying

### 1. Turn off non-production branch builds

**Do this first.** Workers Builds also builds other branches (such as the weekly update
branch) and uploads each as a preview version. A preview version uses your **live
database**, and opening its URL runs that version's database changes against your live data
before you have decided to update. `wrangler.jsonc` already turns preview URLs off
(`"preview_urls": false`); turning off the builds as well means no such version is uploaded at
all. In the Cloudflare dashboard: your Worker → **Settings** → **Builds** → **Branch control**
→ turn off builds for non-production branches.

### 2. Claim your store

Until you claim it, the admin is locked for everyone. Use either route:

- **From the logs.** In the dashboard, open your Worker → **Logs**. Visit
  `https://<your-worker>.<your-subdomain>.workers.dev/_emdash/admin` once, then search the
  logs for `[otta-setup]`. That line holds your setup link. Open it.
- **With your own token** (nothing is logged). Before anyone visits the site, add a secret
  named `OTTA_SETUP_TOKEN` (Worker → **Settings** → **Variables and Secrets**) of at least 32
  random characters (`A-Z a-z 0-9 - _`; `openssl rand -hex 32` makes one). Then open
  `https://<your-site>/_emdash/admin/setup?setup_token=<your token>`.

The link opens the setup wizard. Choose **Sample content** for three demo products, then
create your account and its passkey. After that, the link stops working and you sign in with
the passkey.

### 3. Take payments

In the admin, open **Store settings**:

- **Cards (Stripe):** enter your Stripe publishable key, secret key and webhook signing secret
  under Payments.
- **Cash on delivery:** turn on "Offer cash on delivery at checkout". It is offered for
  physical products, with the buyer's address and phone.

The demo products have no price until you give them one: open each product and fill in its
**Pricing & stock** cards.

### 4. Email (optional, Workers Paid)

Order and sign-in emails can go through Cloudflare Email Sending, which needs Workers Paid and
a sender domain on Cloudflare. In this order:

1. Onboard the domain for Email Sending and send a test email.
2. Uncomment `"send_email": [{ "name": "EMAIL" }]` in `wrangler.jsonc`.
3. Set the sender: `emailFrom: "store@mail.example.com"` in `astro.config.mjs`, or a build
   variable `OTTA_EMAIL_FROM` (Worker → Settings → Builds → Variables). Push.

The build refuses a sender without the binding.

## Updates

Once a week Dependabot opens one pull request for Otta's packages (`@urumi.ai/*`), and a
separate one when Wrangler has an update. **Merging it deploys the update.** If the build
fails, nothing is deployed and the store keeps running the version before; the build log says
why.

Two kinds of Otta release need more than merging:

- **A release that moves EmDash, Astro or React.** Otta declares the exact versions it works
  with, and Dependabot never touches them (a different one would install a second copy of
  EmDash). So this kind of release does **not** arrive as a working pull request: Dependabot
  holds back Otta's update, or its build stops at `npm install` with an `ERESOLVE` error,
  before Otta's own checks run. You hear about it from Otta's release notes or announcement.
  Then follow [UPGRADING.md](https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md):
  change the pinned versions in `package.json` by hand, together with Otta's, and push.
- **A release that needs a change to this repository's other files** (a new binding in
  `wrangler.jsonc`, say). Its build fails with
  `@urumi.ai/otta-store <version> needs template contract <n> …`. Make the changes that
  section of UPGRADING.md lists, set `otta({ template: <n> })` in `astro.config.mjs`, and
  push.

## If the first visit fails

The first request sets up the database. If the site answers with an error:

- "backing off after a recent migration failure": wait a minute and reload. It retries on
  its own.
- "The migration lock has been held since …": the first setup was cut off, for example by
  the Workers Free CPU limit. Release the lock as the message's link explains (one statement
  in the D1 console of the dashboard), then reload.

## Adding your own code

You can add files under `src/`, but one is risky. **A `src/middleware.ts` of your own runs
before Otta's.** Otta's middleware holds the store's cross-site request check and, until the
store is claimed, the setup-link gate on the admin. If yours answers a request itself instead
of calling `next()`, those checks never run for it. Always call `next()` for paths you do not
own, and never answer `/_emdash/*` or the cart, checkout and account routes yourself.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in EMDASH_ENCRYPTION_KEY
npm run dev
```

## Files

| File | |
|---|---|
| `astro.config.mjs` | The Cloudflare adapter and `otta({ template: 1 })`. Your build options go here. |
| `wrangler.jsonc` | The Worker, its bindings, the cron and logging. |
| `.dev.vars.example` | The secret the button asks for. |
| `src/worker.ts`, `src/live.config.ts` | Wiring Cloudflare and Astro need to find in your repository. |
| `.github/dependabot.yml` | The weekly update of Otta's packages and Wrangler. |

MIT licensed.

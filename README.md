# ZenPay Checkout Backend

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ianmenethil/cf-templates-zenpay-checkout-backend)

<!-- dash-content-start -->

A starter backend for ZenPay's hosted checkout plugin, on Cloudflare Workers, with an admin panel only your team can open.

The plugin runs in your shopper's browser, but it needs a server for the parts a browser must not do. This Worker is that server. It signs each payment with your ZenPay credentials, receives the result ZenPay posts back, checks that the result is genuine, and keeps a record of every payment for you and your shopper's page to read.

- **Signing.** When the shopper presses Pay, your page asks the Worker for the plugin's options. The Worker makes a new payment ID, builds the SHA3-512 fingerprint with `@zp-hcp/server` and returns everything the plugin needs. Your ZenPay username and password are used only inside the fingerprint and never leave the Worker.
- **Callbacks.** ZenPay posts the result of each payment to the Worker. The Worker answers `200` to every callback it can read and store, and changes the payment only when the callback is genuine: the signed token in the callback address and ZenPay's `validationCode` must both check out.
- **One-way states.** A payment is `pending`, `unverified`, `processing`, `succeeded` or `failed`. `succeeded` and `failed` are final: no later callback, genuine or not, changes them.
- **Status for your page.** The shopper's page polls the Worker for the payment's state, so it shows the result from a verified callback and not from the browser's own redirect.
- **Admin panel.** Read every payment and every callback, with the body ZenPay sent, search and filter them, and delete payments. It lives at `/admin` behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/), so only people you allow can sign in.
- **Limits.** Only the websites you list can call the checkout API. [Rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) cap each visitor, and the callbacks that do not verify.
- **Cleans up after itself.** A daily [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) deletes payments, with their callbacks, whose state last changed more than `RETENTION_DAYS` ago (30 by default).

Built with [Hono](https://hono.dev), [D1](https://developers.cloudflare.com/d1/), the Workers [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and `@zp-hcp/server` for ZenPay's fingerprint and callback rules; [React](https://react.dev), [Vite](https://vite.dev), [shadcn/ui](https://ui.shadcn.com) and [Tailwind CSS](https://tailwindcss.com) for the admin panel.

`@zp-hcp/server` is not on the npm registry. `package.json` points at its tarball on Zenith's CDN (`cdn.zenithpayments.support`), `pnpm install` downloads it from there, and `pnpm-lock.yaml` pins its checksum. The machine that installs, builds or runs CI must be able to reach that host.

<!-- dash-content-end -->

## What you need first

- A Cloudflare account, and a domain on Cloudflare for the Worker's [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) (a Custom Domain needs an active zone in your account).
- Cloudflare One (Zero Trust) set up on the account, with a team domain, to put Access in front of `/admin`.
- A GitHub or GitLab account for the Deploy to Cloudflare button, which copies this template into it.
- ZenPay sandbox credentials: an API key, a username, a password and a merchant code.
- A website that shows the Pay button and has ZenPay's hosted checkout plugin script on the page.
- To work on the code: Node.js 22.12 or later, [pnpm](https://pnpm.io) 11 (the exact version is in `packageManager` in `package.json`), and `openssl` (or any other way to make a long random string) for `CALLBACK_TOKEN_SECRET`.

## How a payment flows

```
Shopper's page          This Worker                         ZenPay
      |                      |                                 |
      | 1. POST /api/checkout|                                 |
      |--------------------->| new payment ID, fingerprint,    |
      |                      | signed callback address;        |
      |<---------------------| payment stored as `pending`     |
      | 2. zpPayment({...}).init() opens the ZenPay checkout   |
      |------------------------------------------------------->|
      |                      |                                 |
      |                      | 3. POST /callbacks/zenpay?t=... |
      |                      |<--------------------------------|
      |                      | token + validationCode checked, |
      |                      | state changed, `200` answered   |
      | 4. GET /api/checkout/<id> (polling)                    |
      |--------------------->|                                 |
      |<---------------------| { state, reference }            |
```

1. The shopper's page calls `POST /api/checkout` when Pay is pressed, not when the page loads, because a fingerprint is valid for 15 minutes from its `timestamp`.
2. The page passes the answer to `zpPayment(...)`. ZenPay's hosted checkout opens in the shopper's browser.
3. ZenPay posts the result to the `callbackUrl` the Worker made, which carries a signed `t` token holding the payment's ID, mode and amount.
4. While the shopper waits, the page polls `GET /api/checkout/<merchantUniquePaymentId>` and shows the state.

## Get started

The example values below use a sample company, Menethil, with the shop `shop.ianmenethil.com`, the Worker domain `checkout.ianmenethil.com` and the admin `admin@ianmenethil.com`. Replace them with your own.

### 1. Deploy

Click **Deploy to Cloudflare** above. Cloudflare copies this template into your GitHub or GitLab account, asks for the four secrets (step 2) and deploys the Worker.

The template's `wrangler.jsonc` declares a D1 database binding called `DB`, named `zenpay-checkout-backend`, with no database ID. Cloudflare's deploy button [provisions the resources](https://developers.cloudflare.com/workers/platform/deploy-buttons/) that the Wrangler configuration declares. The template's deploy script, `pnpm run deploy`, builds the admin panel, applies the SQL files in `migrations/` to the database, then deploys the Worker. The migration creates the `payments` and `callbacks` tables.

If the first deploy fails at the migration step, apply the migration by hand and deploy again:

```bash
pnpm exec wrangler d1 migrations apply DB --remote
```

### 2. Set the secrets

The Worker has four secrets. `.dev.vars.example` lists them, which is how Deploy to Cloudflare knows to ask for them.

| Secret                  | What it is                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ZENPAY_API_KEY`        | Your ZenPay API key                                                                                                                   |
| `ZENPAY_USERNAME`       | Your ZenPay username                                                                                                                  |
| `ZENPAY_PASSWORD`       | Your ZenPay password                                                                                                                  |
| `CALLBACK_TOKEN_SECRET` | A long random string of your own, at least 32 bytes, that signs each payment's callback address. Make one with `openssl rand -hex 32` |

To set or change one later: `pnpm exec wrangler secret put ZENPAY_API_KEY`. Changing `CALLBACK_TOKEN_SECRET` makes the callback addresses already given to ZenPay unreadable, so change it when no payment is open.

Until all four are set, `POST /api/checkout` and `POST /callbacks/zenpay` answer `500` with `{"error":"Not configured"}`. The answer names nothing, because the caller is a shopper's browser or ZenPay and cannot fix it. The Worker writes the names of what is missing to its logs (see [Troubleshooting](#troubleshooting)). A callback that gets a `500` is not stored. ZenPay's documentation does not say whether ZenPay posts it again, so do not rely on that.

### 3. Set the settings

In your copy of the repository, edit the `vars` in `wrangler.jsonc` and push the change (Cloudflare redeploys automatically). Do not change them in the dashboard: every deploy overwrites the dashboard values with the ones in `wrangler.jsonc`.

| Variable               | Set it to                                                                                                              | Example                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ZENPAY_MERCHANT_CODE` | Your ZenPay merchant code. Required                                                                                    | `ZenTest1`                                       |
| `ZENPAY_CHECKOUT_URL`  | The ZenPay checkout address. The default is the sandbox. For live payments, ask ZenPay for your program's live address | `https://pay.sandbox.travelpay.com.au/online/v5` |
| `ALLOWED_ORIGINS`      | The origins of the website that shows the Pay button, separated by commas. Required                                    | `https://shop.ianmenethil.com`                   |
| `REDIRECT_URL`         | The page on your shop where the shopper lands after paying. Required                                                   | `https://shop.ianmenethil.com/thanks`            |
| `BRAND_NAME`           | Your company name, shown in the admin panel                                                                            | `Menethil`                                       |
| `RETENTION_DAYS`       | Days to keep a payment after its state last changed, a whole number above 0                                            | `30`                                             |

What each one does when it is wrong:

- **Checkout needs the four secrets and three settings.** `POST /api/checkout` needs the four secrets plus `ZENPAY_MERCHANT_CODE`, `ZENPAY_CHECKOUT_URL` and `REDIRECT_URL`. A callback needs only the four secrets. A missing setting, or a `CALLBACK_TOKEN_SECRET` under 32 bytes, gives `500` with `{"error":"Not configured"}`.
- **`ZENPAY_CHECKOUT_URL`** must be a ZenPay hosted checkout address. The package accepts `https://pay.<program>.com.au/online/v5` (or `v4`), where `<program>` is `travelpay`, `childcareeasypay`, `zenpay`, `b2bpay`, `schooleasypay`, `thoroughbredpayments` or `rentalrewards`, and `pay.sandbox` or `payuat` can stand in for `pay` on the test systems. It refuses any other host, and a refused address gives `500`.
- **`ALLOWED_ORIGINS`** is a list of origins. An origin is the scheme, host and port with no path, such as `https://shop.ianmenethil.com`; a trailing slash is ignored. Until it is set, the checkout API answers `403` with `{"error":"Not configured"}` to everyone.
- **`REDIRECT_URL`** is required: `@zp-hcp/server` refuses a launch without a `redirectUrl`, and says that without one the modal stays open after payment. Until it is a valid web address, the checkout API answers `500` with `{"error":"Not configured"}`. With the modal (`displayMode: 0`, as in the snippet below) the plugin only moves your page to an address that starts with it. With `displayMode: 1` the browser goes to it after payment.
- **`RETENTION_DAYS`** above 3650 counts as 3650. Anything that is not a whole number above 0 (text, `0`, a negative number, `1.5`) counts as 30, so a typo cannot delete everything.

### 4. Give the Worker its own domain

Add a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) such as `checkout.ianmenethil.com` under the Worker's **Settings → Domains & Routes**. The callback address the Worker gives ZenPay is built on the address your page called, so call `/api/checkout` on this domain, not on a `workers.dev` address you do not mean ZenPay to use.

### 5. Protect the admin panel with Cloudflare Access

1. Open [Cloudflare One](https://one.dash.cloudflare.com/) and go to **Access controls → Applications → Create new application → Self-hosted and private → Add public hostname**.
2. Choose the domain `checkout.ianmenethil.com`. Add two destinations for it, one with the path `admin` and one with the path `admin/*`. Cloudflare's [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) page says a path with a wildcard does not cover its parent path, so `admin/*` covers the panel's files and API and `admin` covers `/admin` itself. Only `/admin` is protected. `/callbacks` must stay public, because ZenPay cannot sign in, and `/api/checkout` is called by shoppers' browsers.
3. Add a policy that allows the people who should read payments, for example the selector **Emails** with `admin@ianmenethil.com`, or **Emails ending in** with `@ianmenethil.com`.
4. Save, then copy the application's **Application Audience (AUD) Tag** from the application's settings.
5. In a private browser window, open `https://checkout.ianmenethil.com/admin/` and `https://checkout.ianmenethil.com/admin/api/me`. Both must ask you to sign in. The Worker checks every `/admin` request itself, so a gap in the Access paths shows as a `401` answer and the panel stays closed.

Do not use the Worker's one-click **Protect this Worker behind Access** setting (the **Access** tab of the Worker in the dashboard). Cloudflare describes it as protecting the entire Worker however it is reached, which includes `/callbacks`, so ZenPay would be turned away.

Then set two more `vars` in `wrangler.jsonc` and push the change, as in step 3:

| Variable             | Set it to                   | Example                                                            |
| -------------------- | --------------------------- | ------------------------------------------------------------------ |
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain | `https://menethil.cloudflareaccess.com`                            |
| `ACCESS_AUD`         | The AUD tag from step 4     | `4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2` |

A trailing slash on the team domain is ignored. Until both are set, `/admin` answers `403` with `{"error":"Admin is not configured"}` to everyone.

### 6. Make a test payment

Add the snippet below to a page on your shop's origin (next section), open it, and pay with a ZenPay sandbox test card. Then open `https://checkout.ianmenethil.com/admin`, sign in with Access, and the payment is in the list with the callback ZenPay sent.

## Using it from the shopper's page

Call the Worker when Pay is pressed, pass what it returns to the plugin, then poll for the result. This follows the "Building the Payload" section of ZenPay's hosted checkout documentation, with the Worker supplying the values; the ZenPay plugin script must already be loaded on the page, as that documentation describes.

```javascript
const CHECKOUT = 'https://checkout.ianmenethil.com';

async function pay(amount, customer) {
  // 1. Ask the Worker for a signed launch. Do this on the click, not on page load.
  const response = await fetch(`${CHECKOUT}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // required: without it the Worker does not read the body
    body: JSON.stringify({
      mode: 0, // 0 Make Payment, 1 Tokenise, 2 Custom Payment, 3 Preauthorisation
      paymentAmount: amount, // a number of dollars, at most 2 decimals, for example 49.9
      customerName: customer.name,
      customerEmail: customer.email,
      // Modes 0 and 2 need a name and a reference. For modes 1 and 3 send them as empty text; the fields must still be there.
      customerReference: customer.reference,
    }),
  });
  const launch = await response.json();
  if (!response.ok) throw new Error(launch.error);

  // 2. Open the ZenPay checkout with exactly what the Worker returned.
  const payment = zpPayment({ ...launch, displayMode: 0 });
  payment.init();

  // 3. Poll until a verified callback has settled the payment, or give up after a while.
  return waitForResult(launch.merchantUniquePaymentId);
}

async function waitForResult(id, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${CHECKOUT}/api/checkout/${id}`);
    // A 404, 429 or 500 will not fix itself by asking again at once: stop and show an error.
    if (!response.ok) throw new Error(`Status check failed with ${response.status}`);
    const { state, reference } = await response.json();
    if (state === 'succeeded' || state === 'failed') return { state, reference };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Still pending, processing or unverified: no verified result yet. Tell the shopper the payment is being confirmed.
  return { state: 'unconfirmed', reference: null };
}
```

How the page and the Worker meet:

- **Origin.** The page's origin must be in `ALLOWED_ORIGINS`. The browser sends it as the `Origin` header, and the Worker answers the [CORS](https://developer.mozilla.org/docs/Web/HTTP/CORS) preflight for it. This applies to the status check (`GET /api/checkout/<id>`) as well as to `POST /api/checkout`. A request from any other origin, or with no `Origin` header, gets `403`.
- **A page on the Worker's own origin cannot poll.** A browser sends `Origin` on cross-origin requests and on same-origin `POST`, but not on a same-origin `GET`. A page served from the Worker's own origin therefore gets `403` on the status check. Serve your page from its own origin (here `https://shop.ianmenethil.com`), list that origin in `ALLOWED_ORIGINS`, and keep the Worker on its own domain (here `https://checkout.ianmenethil.com`).
- **Modal or redirect.** The snippet opens the checkout in a modal (`displayMode: 0`). With `displayMode: 1` the browser leaves your page for ZenPay's page and goes to `REDIRECT_URL` afterwards. In redirect mode the page is gone by then, so keep the `merchantUniquePaymentId` somewhere the return page can read it, and poll with it as above.
- **The request body** has its own rules, in [The checkout request](#the-checkout-request).

What to do with the `state` the page reads:

| State        | Meaning                                                                                                                             | What the page does                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`    | Started; no callback has arrived                                                                                                    | Keep polling                                                                                                                                     |
| `processing` | A verified callback says ZenPay is still working (status Pending or InProgress), or gave a status the Worker does not read as final | Keep polling                                                                                                                                     |
| `unverified` | Only callbacks without a `validationCode` arrived, which prove nothing                                                              | Do not fulfil; keep polling until the time limit, then say the payment is being confirmed. See [Unsigned notifications](#unsigned-notifications) |
| `succeeded`  | A verified callback says it succeeded. For Tokenise it means the payment method was saved                                           | Fulfil the order                                                                                                                                 |
| `failed`     | A verified callback says it failed, errored, was cancelled or was suppressed                                                        | Tell the shopper                                                                                                                                 |

Fulfil an order only from `succeeded`, and for the order's real record trust the admin panel or your own server reading this Worker's data, not the browser's redirect. Poll no faster than every second or two: status checks are limited to 60 a minute for each visitor.

Two limits of ZenPay's protocol apply to fulfilment, and [How a callback is judged](#how-a-callback-is-judged) explains both:

- **Custom Payment (mode 2).** Fulfil a mode 2 order for the amount the Worker recorded, not for one the page sends.
- **High-value orders.** Confirm the result through ZenPay's API before you ship goods of high value.

For modes 0 and 2 the `reference` the page reads is ZenPay's payment reference and for mode 3 the preauthorisation reference. For Tokenise (mode 1) the page reads `null`: the saved payment method's token is not handed out by the public status route, and the admin API shows it.

## The checkout request

`POST /api/checkout` takes a JSON body, sent with `Content-Type: application/json`. Without that header the Worker does not read the body and answers `400`. Fields not listed here are ignored, so nothing a page adds reaches the launch. Text fields are trimmed, then checked. The whole body may be at most 8 KB.

| Field               | Type               | Needed for                                                                              | Rules                                                                                                                                                                      |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | number             | Every mode                                                                              | `0` Make Payment, `1` Tokenise, `2` Custom Payment, `3` Preauthorisation. Anything else, text such as `"0"` included, is refused                                           |
| `paymentAmount`     | number, in dollars | Every mode, mode 1 too                                                                  | A number, not text, with at most 2 decimals and at most 10,000,000. It must be above 0 for modes 0, 2 and 3. Mode 1 accepts 0                                              |
| `customerName`      | text               | Modes 0 and 2 need text. Modes 1 and 3 may send empty text, but the field must be there | At most 100 characters, no control characters                                                                                                                              |
| `customerReference` | text               | Modes 0 and 2 need text. Modes 1 and 3 may send empty text, but the field must be there | At most 100 characters, no control characters                                                                                                                              |
| `customerEmail`     | text               | Every mode                                                                              | At most 254 characters, no control characters, one `@`, no spaces, and a dot in the domain. ZenPay's own email check then runs on the launch and can refuse an address too |

A refused request gets `400` with `{"error":"..."}` naming the first thing wrong, for example `customerReference is required for this mode.`, and nothing is stored. A body that is not JSON gets `Malformed JSON in request body`. A body that is JSON but not an object gets `The request body must be a JSON object.`

## What the Worker answers

`POST /api/checkout` answers in this order: allowed origin, rate limit, size, settings, body, ZenPay's launch rules.

| Request                                                                                                                                                   | Response                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/checkout` accepted                                                                                                                             | `200` with the launch: `url`, `apiKey`, `merchantCode`, `fingerprint`, `timestamp`, `merchantUniquePaymentId`, `mode`, `paymentAmount`, the customer fields, `callbackUrl` and `redirectUrl` |
| Body not JSON, not sent as JSON, or a field wrong (the answer says which), or ZenPay's launch rules refuse the request                                    | `400` with `{"error":"..."}`; nothing is stored                                                                                                                                              |
| Origin not in `ALLOWED_ORIGINS`, or no `Origin` header                                                                                                    | `403` with `{"error":"Origin not allowed"}`                                                                                                                                                  |
| `ALLOWED_ORIGINS` not set                                                                                                                                 | `403` with `{"error":"Not configured"}`                                                                                                                                                      |
| Body over 8 KB                                                                                                                                            | `413` with `{"error":"Payload too large"}`                                                                                                                                                   |
| More than 10 requests a minute from one visitor address                                                                                                   | `429` with `{"error":"Too many requests"}`                                                                                                                                                   |
| A secret or setting is missing, `CALLBACK_TOKEN_SECRET` is under 32 bytes, or ZenPay's rules refuse a credential, `ZENPAY_CHECKOUT_URL` or `REDIRECT_URL` | `500` with `{"error":"Not configured"}`; the Worker's logs say which                                                                                                                         |
| The database fails                                                                                                                                        | `500` with `{"error":"Internal server error"}`; no launch is returned                                                                                                                        |
| `GET /api/checkout/<id>` for a known payment                                                                                                              | `200` with `{"merchantUniquePaymentId":"...","state":"...","reference":"..." or null}`; `reference` is always `null` for Tokenise (mode 1)                                                   |
| `GET /api/checkout/<id>` for an ID that is unknown or not shaped like the ones this Worker makes                                                          | `404`; a badly shaped ID never reaches the database                                                                                                                                          |
| More than 60 status checks a minute from one visitor address                                                                                              | `429`                                                                                                                                                                                        |
| `POST /callbacks/zenpay?t=<token>` with a body the Worker can read and store, whatever it holds                                                           | `200` with `{"received":true}`; only a genuine callback changes the payment                                                                                                                  |
| Callback body over 16 KB                                                                                                                                  | `413`; nothing is stored                                                                                                                                                                     |
| A callback that does not verify, once its payment (or its sender, when the address names no payment) has sent more than 60 of them in a minute            | `429`; see [How a callback is judged](#how-a-callback-is-judged)                                                                                                                             |
| Callback while a secret is missing                                                                                                                        | `500` with `{"error":"Not configured"}`; nothing is stored                                                                                                                                   |
| Callback while the database fails                                                                                                                         | `500` with `{"error":"Internal server error"}`; nothing is stored                                                                                                                            |
| Any method but `POST` on `/callbacks/zenpay`                                                                                                              | `404`                                                                                                                                                                                        |
| `GET /`                                                                                                                                                   | `302` to `/admin/`                                                                                                                                                                           |
| `/admin` without a Cloudflare Access sign-in                                                                                                              | `401`                                                                                                                                                                                        |
| `/admin` before `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set                                                                                             | `403` with `{"error":"Admin is not configured"}`                                                                                                                                             |

Every error answer is JSON in the form `{"error":"..."}`, including the `/admin` sign-in answers above, a refused cross-site request and an `/admin/api` path that does not exist.

The admin API is for the panel; it works only with an Access sign-in and from the panel's own pages.

| Request                          | What it does                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/api/me`              | The signed-in email and `BRAND_NAME`                                                                                                                                                                                                                                            |
| `GET /admin/api/payments`        | Payments newest first, 50 at a time. Optional `state=<state>`, `q=<text>` (matches the payment ID, customer name, email or reference, or ZenPay's reference, up to 100 characters) and `before=<nextBefore of the previous answer>`. `400` for an unknown state or a bad cursor |
| `GET /admin/api/payments/:id`    | One payment with all its callbacks, newest first, with their bodies; `404` when unknown                                                                                                                                                                                         |
| `DELETE /admin/api/payments/:id` | Deletes the payment and its callbacks and answers `204`. It answers `204` for an ID that no payment has, too                                                                                                                                                                    |
| `GET /admin/api/callbacks`       | Every callback newest first, 50 at a time, including those that belong to no payment, without bodies. Optional `outcome=verified\|unsigned\|rejected` and `before=<nextBefore of the previous answer>`                                                                          |
| `GET /admin/api/callbacks/:id`   | One callback with its body as received (only the first 4 KB for a rejected callback or one with no payment); `404` when unknown                                                                                                                                                 |

## How a callback is judged

The Worker follows ZenPay's documented order, and the first check that fails decides:

1. **The callback address token.** The `t` token is read first. It was signed by the Worker when the payment started and carries the payment's ID, mode and amount, so the Worker never trusts the body for them. A missing, changed, wrongly signed or expired token is stored as `rejected` with no payment.
2. **The payment.** The token must name a payment this Worker started and still holds; otherwise the callback is stored as `rejected` with no payment.
3. **The body.** It must be a JSON object. A `response.merchantUniquePaymentId` that differs from the token's, or is not text, is `rejected`, signed or not. If the body then has no `validationCode` (or a `null` one), it is an `unsigned` notification (below). A `validationCode` that is not text is `rejected`.
4. **The `validationCode`.** `@zp-hcp/server` checks the body's shape, then the code against `apiKey|username|password|mode|amount|merchantUniquePaymentId|reference`, using the mode and amount from the token. A body of the wrong shape (a status that is text, for example) or a code that does not match is `rejected`; a match is `verified`.
5. **The amount of a Custom Payment.** ZenPay hashes a Custom Payment's amount as `0`, so for mode 2 the `validationCode` does not bind the amount, and a shopper can edit `paymentAmount` in the browser before `zpPayment(...)` opens. The Worker therefore accepts a verified mode 2 callback only when the amount ZenPay reports charged, `response.baseAmount`, equals the amount the payment started with. A missing or different `baseAmount` makes the callback `rejected` with the reason, and the payment keeps its state, so the page keeps showing `pending`. Captured sandbox mode 2 callbacks show `baseAmount` equal to the launch amount; check that against your own program before relying on it. For modes 0, 1 and 3 the `validationCode` is hashed with the amount from the token, so a shopper cannot change it.
6. **The state.** From a verified callback, `paymentStatus` (modes 0 and 2) or `preauthStatus` (mode 3) decides: `3` is `succeeded`; `1`, `4`, `5` and `6` are `failed`; every other number and a missing status are `processing`. A verified Tokenise callback (mode 1) is `succeeded`.

Every callback is stored with its outcome and, for a rejected one, the reason. A repeat of the same body for the same payment adds 1 to `deliveries` instead of adding a row. Two callbacks that arrive at the same moment cannot overwrite each other's final state, because the state is changed by one conditional update that never touches a payment already `succeeded` or `failed`.

The body is judged before the rate limit is applied, and only callbacks that do not verify count against it (60 a minute for each payment, or for each sender address when the token cannot be read). Junk posted to a payment's address therefore cannot make ZenPay's genuine callback answer `429`.

### Unsigned notifications

ZenPay sometimes posts a callback with no `validationCode`. In ZenPay's tests Mode 0 sometimes sent one before the signed callback, and Mode 3 sent one first and, on some tests, nothing else. An unsigned callback cannot be verified, so it never marks a payment succeeded or failed. It moves a payment from `pending` to `unverified` and nothing more, and the body is kept as received (for example a `preauthStatus` that is the text `"Successful"`). A Mode 3 payment can therefore stay `unverified`. Confirm such a payment another way, such as ZenPay's API or portal, before treating it as authorised. The "Unsigned notifications" part of ZenPay's callback documentation lists what the sandbox sent; check it again before relying on it.

### Replays

The callback address token lives for 7 days: a shorter life would make a late signed callback unverifiable. The token carries context only, but a replay is not fully harmless. ZenPay's `validationCode` covers the mode, amount, payment ID and reference, and not `paymentStatus` or `preauthStatus`, so anyone who holds one signed body and its callback address can repost it with a different status (for example `processing` changed to `3`). This is a limit of ZenPay's protocol, not something this Worker can close; the one-way `succeeded` and `failed` states only narrow it. For high-value fulfilment, confirm the result through ZenPay's API.

## Limits and things to know

- **A failed callback is final.** It is not known whether ZenPay can post a failed callback and then a successful one for the same payment ID (a retry inside the modal, for example). Because `failed` is final here, a later success would be stored but not applied. Test this in the sandbox before relying on it.
- **Storage per payment is capped.** The callback address is public, so a payment keeps at most 10 distinct callback bodies: past that, the Worker answers `200` and stores nothing new, though a repeat of a stored body still adds to its `deliveries`, and a verified callback still changes the payment. A rejected callback, or one with no payment, keeps only the first 4 KB of its body; its `size` and the hash used to spot repeats describe the whole body.
- **The callback size limit is a margin.** ZenPay does not publish a largest callback size. The 28 sandbox callbacks in ZenPay's callback examples are all files under 4.7 KB (the largest is 4,644 bytes, and each file also holds test notes, so the bodies are smaller). The 16 KB limit is a margin over those, set by `MAX_BODY_BYTES` in `src/worker/routes/callbacks.ts`. A larger body gets `413` and is not stored.
- **The origin check keeps other websites out; it is not a login.** Anything outside a browser can send any `Origin`. What stands between the public and your payments is that the Worker signs only launches that pass its validation, rate limits each visitor, and never changes a payment without ZenPay's `validationCode`.
- **Rate limits are approximate.** Cloudflare counts per location, so a visitor reaching different locations is counted separately, and bursts can go over the limit. Visitors are told apart by IP address, so many people behind one address share one allowance. See the [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Requests under local development have no visitor address and share one allowance.
- **Personal data is stored.** Each payment keeps the customer's name, email and reference, and each callback keeps ZenPay's body, which holds card and account details ZenPay masks. Restrict access to your Cloudflare account and the admin panel, and keep `RETENTION_DAYS` as short as your records allow.
- **Secrets stay on the server.** The ZenPay username and password appear only inside hashes. The launch the page receives has the API key, which ZenPay's plugin needs, but not the username, the password or `CALLBACK_TOKEN_SECRET`.
- **Callback tokens stay out of the logs.** `observability.enabled` in `wrangler.jsonc` turns on [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), whose entry for each request carries the request URL, and a callback URL carries its token in the query string. `observability.redact_query_string` removes query strings from request URLs in logs and traces, so the token is not logged. Keep it on. Restrict who can read your Worker's logs anyway: they show request paths and the names of settings the Worker reports as missing.
- **Retention.** The daily job runs at 03:00 UTC and deletes payments whose state last changed more than `RETENTION_DAYS` ago, with their callbacks, and callbacks that belong to no payment once their latest delivery is that old. A payment started but never paid is deleted too.
- **Storage is D1.** Each callback is one row. Cloudflare's [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) page lists 2 MB for a row and 500 MB for a database on the Free plan, 10 GB on Workers Paid; check it for the current values. A callback body is capped at 16 KB.
- **Delivery is acknowledged only after the callback is stored.** If D1 is unavailable, the Worker answers an error and stores nothing.

## How the admin panel is secured

- **Cloudflare Access signs people in.** The panel shows the email of the person signed in, for example `admin@ianmenethil.com`. It comes from the Access sign-in, not from your Cloudflare account.
- **The Worker checks every admin request itself**, so the panel cannot be reached around Access, for example on the `workers.dev` address. The Worker runs first for every `/admin` request, including the panel's own page and files (`run_worker_first` in `wrangler.jsonc`). It accepts Cloudflare's [`ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) when the runtime provides it (local development does; a deployed Worker with static assets does not) or verifies the [Access token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) in `Cf-Access-Jwt-Assertion` against your team's public keys. The Worker reads the keys from your team's certs address and asks Cloudflare to cache them for five minutes. Access rotates its signing key every 6 weeks by default, and the keys come from that address, so a rotation needs no change in this repository. The token must be for `ACCESS_AUD` and issued by `ACCESS_TEAM_DOMAIN`.
- **The admin API answers only the panel.** It sends no CORS headers, so browsers stop other sites from reading it, and a browser stops other sites from sending it a change that needs a preflight. Hono's [`csrf`](https://hono.dev/docs/middleware/builtin/csrf) middleware also refuses a change sent as a form, such as a form post from another site. Its answers carry `Cache-Control: no-store`.
- **The panel's pages carry security headers** from Hono's [`secureHeaders`](https://hono.dev/docs/middleware/builtin/secure-headers), including a Content Security Policy that allows only its own script in the production build (inline styles are allowed for shadcn's toast and dialog), and `X-Frame-Options: DENY` so no other page can show the panel in a frame.

## Troubleshooting

Most of these answers do not say which setting is wrong, on purpose. The Worker writes it to its logs. Read them in the Cloudflare dashboard (the Worker's **Observability** page) or live with `pnpm exec wrangler tail`.

| What you see                                                                       | Why, and what to do                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403` on `/admin` with `{"error":"Admin is not configured"}`                       | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty. Set both in `wrangler.jsonc` (step 5) and push. The log line starts with `Admin is not configured`.                                                                                                                                            |
| `403` on `/admin` with `{"error":"Forbidden"}`                                     | Seen where the runtime gives the Worker an Access identity, which is local development: `ACCESS_AUD` in your `.dev.vars` or `wrangler.jsonc` is not the `aud` that `access.dev` simulates (`local-dev`).                                                                                      |
| `401` on `/admin`                                                                  | The request has no valid Access sign-in. Either the Access application does not cover this path (check both `admin` and `admin/*`, step 5), or the token is not for `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.                                                                                    |
| `403` with `{"error":"Not configured"}` on `/api/checkout`                         | `ALLOWED_ORIGINS` is empty. Set it (step 3).                                                                                                                                                                                                                                                  |
| `403` with `{"error":"Origin not allowed"}` on `/api/checkout`                     | The `Origin` header is not in `ALLOWED_ORIGINS`, or there is none. Check the scheme, host and port. A request from `curl` has no `Origin`, and neither does a status check from a page on the Worker's own origin (see [Using it from the shopper's page](#using-it-from-the-shoppers-page)). |
| `500` with `{"error":"Not configured"}` on `/api/checkout`                         | A secret or one of `ZENPAY_MERCHANT_CODE`, `ZENPAY_CHECKOUT_URL` and `REDIRECT_URL` is missing, `CALLBACK_TOKEN_SECRET` is under 32 bytes, or `ZENPAY_CHECKOUT_URL`, `REDIRECT_URL` or a ZenPay credential was refused. The log line starts with `Not configured`.                            |
| A payment stays `pending`                                                          | No callback reached the Worker, or every one was rejected. Open the callbacks list in the panel and filter by `rejected`: the reason says why. If there is none, ZenPay cannot reach the callback address (it must be your public `https` domain, not `localhost`).                           |
| A payment stays `unverified`                                                       | Only callbacks without a `validationCode` arrived. See [Unsigned notifications](#unsigned-notifications).                                                                                                                                                                                     |
| A callback is `rejected` as expired, wrongly signed or not made by this Worker     | `CALLBACK_TOKEN_SECRET` was changed after the payment started, or the token is over 7 days old.                                                                                                                                                                                               |
| `pnpm test` fails in `panel-browser` because the browser cannot be found or opened | Chromium is not installed for Playwright. Run `pnpm exec playwright install chromium` once. On a Linux machine that lacks Chromium's system libraries, add `--with-deps`, as CI does.                                                                                                         |
| The first `pnpm run deploy` stops with "Couldn't find a D1 DB"                     | The database does not exist yet. Follow [Deploy by hand](#deploy-by-hand).                                                                                                                                                                                                                    |

## Develop locally

Requires Node.js 22.12 or later and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`: fill in the four secrets (your ZenPay sandbox credentials, and a callback secret of at least 32 bytes) and uncomment the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` lines so the admin panel opens locally. They match the signed-in user `admin@ianmenethil.com` that `access.dev` in `wrangler.jsonc` simulates. They are commented out in `.dev.vars.example` because Deploy to Cloudflare reads the [Worker secrets](https://developers.cloudflare.com/workers/platform/deploy-buttons/) from that file in [dotenv format](https://hexdocs.pm/dotenvy/dotenv-file-format.html), where a line starting with `#` is a comment and so is skipped. These two are `vars` in `wrangler.jsonc`, not secrets.

Also set `ZENPAY_MERCHANT_CODE`, `ALLOWED_ORIGINS` (for example `http://localhost:3000`, your dev page's origin) and `REDIRECT_URL` (for example `http://localhost:3000/thanks`) in `wrangler.jsonc`.

Then run `pnpm run dev` and open the address Vite prints, usually `http://localhost:5173/`. The root redirects to the panel at `/admin/`. Call `/api/checkout` from your dev page. ZenPay cannot reach `localhost`, so to receive callbacks locally, put a tunnel in front of the dev server (for example [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)) and call `/api/checkout` through the tunnel's address, which becomes the callback address's origin.

| Script                      | What it does                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run dev`              | Applies the migrations to a local D1 database, then runs the Vite dev server with the Worker, the local database, local rate limiters and a simulated Access user; the panel reloads as you edit |
| `pnpm run build`            | Type-checks everything and builds the panel and the Worker into `dist/`                                                                                                                          |
| `pnpm run preview`          | Builds, then serves the production build locally                                                                                                                                                 |
| `pnpm test`                 | Runs the three test projects (see [Tests](#tests)). Run one with `pnpm test --project worker`, `--project panel-unit` or `--project panel-browser`                                               |
| `pnpm run coverage`         | Runs the same tests with Istanbul coverage of `src/` (the shadcn/ui files excluded): a table in the terminal and an HTML report in `coverage/index.html`                                         |
| `pnpm run lint`             | Runs ESLint with type-aware TypeScript rules, React hooks rules and TSDoc rules; any warning fails it                                                                                            |
| `pnpm run format`           | Rewrites every file in Prettier's format (settings in `.prettierrc.json`)                                                                                                                        |
| `pnpm run format:check`     | Fails when a file is not in Prettier's format, and writes nothing                                                                                                                                |
| `pnpm run typegen:check`    | Fails when `worker-configuration.d.ts` does not match `wrangler.jsonc`                                                                                                                           |
| `pnpm run cf-typegen`       | Regenerates `worker-configuration.d.ts` after a `wrangler.jsonc` change                                                                                                                          |
| `pnpm run check`            | Runs `typegen:check`, `format:check`, `lint` and `build`, then a dry-run deploy with Wrangler                                                                                                    |
| `pnpm run db:migrate`       | Applies the migrations to the deployed database (`wrangler d1 migrations apply DB --remote`)                                                                                                     |
| `pnpm run db:migrate:local` | Applies the migrations to the local database                                                                                                                                                     |
| `pnpm run deploy`           | Builds, applies the migrations to the deployed database, then deploys with Wrangler                                                                                                              |

### Tests

`pnpm test` runs three Vitest projects, set in `vitest.config.ts`:

- **`worker`** (`test/*.test.ts`) runs the Worker's real code inside the Workers runtime, against a real local D1 database with the real migrations, the rate limiters and the built admin panel. It covers the checkout and status routes, callbacks, the admin API, the Access check, the daily clean-up, the database's query plans (each query uses its index) and that the shared types match the migration. The expected fingerprints and `validationCode`s are not computed by `@zp-hcp/server`, which would make the tests circular. They are fixed values in `test/helpers/zenpay-fixtures.ts`: each sits beside the exact pipe string it hashes, and `test/global-setup.ts` recomputes every one with Node's `sha3-512` before any test runs and stops if one differs. SHA3 is not available in the Workers runtime, which is why the check runs in Node. The checkout tests freeze the clock and the payment ID so the route's fingerprint must equal the fixed value. `test/global-setup.ts` also builds the panel, so its files exist for the Worker's `ASSETS` binding.
- **`panel-unit`** (`test/panel/unit`) runs the admin panel's plain functions (the API client, formatting) in Node, with no browser.
- **`panel-browser`** (`test/panel/browser`) renders the panel's components in a real headless Chromium, with Vitest's browser mode, Playwright and `vitest-browser-react`. Install the browser once with `pnpm exec playwright install chromium`.

### What CI runs

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: an install from the lockfile, `pnpm audit`, `typegen:check`, `format:check`, `lint`, `tsc -b`, the Chromium install, `pnpm test`, the build and a dry-run deploy. It is `pnpm run check` plus the audit, the type check and the tests.

## Deploy by hand

Use this instead of the Deploy to Cloudflare button, from a checkout of your copy, after `pnpm install` and `pnpm exec wrangler login`.

The very first time, do not start with `pnpm run deploy`. `wrangler.jsonc` names the database (`zenpay-checkout-backend`) but has no `database_id` yet, so the migration step cannot find it and stops with this message from Wrangler:

```
Couldn't find a D1 DB named 'zenpay-checkout-backend' (bound as 'DB') in the API. Run 'wrangler d1 create zenpay-checkout-backend' to create it.
```

The Worker does not exist yet either, and Wrangler refuses to deploy a new Worker while its required secrets are missing: it says secrets cannot be set in advance and asks for a secrets file. Give the four secrets in a file of their own, `.dev.vars.production`, in JSON:

```json
{
  "ZENPAY_API_KEY": "your key",
  "ZENPAY_USERNAME": "your username",
  "ZENPAY_PASSWORD": "your password",
  "CALLBACK_TOKEN_SECRET": "the output of openssl rand -hex 32"
}
```

Do not use `.dev.vars` for this. It also holds the local-only `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` lines, which would be pushed to production as secrets, and they are `vars` in `wrangler.jsonc`. Git ignores `.dev.vars.production` (the `.gitignore` entry `.dev.vars*`). JSON is safer than a dotenv file here: Wrangler reads a dotenv value's `$NAME` as a variable to fill in, so a password with a `$` in it would change. Delete the file once the Worker holds the secrets.

Then deploy once with Wrangler, which creates a database with that name when the binding has no ID, and use the script:

```bash
pnpm run build
pnpm exec wrangler deploy --secrets-file .dev.vars.production
pnpm run deploy
```

The second command provisions the database, creates the Worker with its secrets from `.dev.vars.production`, and deploys it, though its tables do not exist yet. The third applies `migrations/` and deploys again; run it straight away. In an interactive terminal Wrangler may also write the new `database_id` into `wrangler.jsonc`, which you can keep or discard: later deploys find the database either way. Every deploy after the first is just `pnpm run deploy`. Secrets that a deploy's file does not list keep their values.

To change secrets later, use `pnpm exec wrangler secret put <NAME>` for one, or `pnpm exec wrangler secret bulk .dev.vars.production` for the whole file.

## Project layout

This follows Cloudflare's [React + Vite + Hono template](https://github.com/cloudflare/templates/tree/main/vite-react-template).

```
admin/index.html             The admin panel's page, served at /admin/
migrations/                  The D1 tables (payments, callbacks), as SQL files that `wrangler d1 migrations apply` runs in order
src/react-app/               The admin panel: components/ (components/ui/ holds the shadcn/ui ones, trimmed to what the panel uses), hooks/, lib/ (API calls and formatting), the theme provider, and index.css with Tailwind and the theme colours
src/worker/                  The Worker (Hono): index.ts wires routes/ and runs the daily clean-up; env.ts types the bindings
src/worker/routes/           checkout.ts (the checkout and status routes), callbacks.ts (ZenPay's callbacks), admin.ts (the panel's files and API)
src/worker/lib/              zenpay.ts (launch and callback rules), start-checkout.ts and validation.ts (the checkout request), origin.ts, rate-limit.ts, access.ts (the Access check), payments.ts, callbacks.ts, admin-queries.ts and cursor.ts (database access and paging), retention.ts
src/shared/types.ts          The checkout and admin API's types, used by the Worker, the panel and your page
test/                        Worker tests that run inside the Workers runtime (*.test.ts), setup.ts, global-setup.ts, and helpers/ with the fixed ZenPay values (helpers/zenpay-fixtures.ts)
test/panel/                  The panel's tests: unit/ (Node) and browser/ (real Chromium), and fixtures.ts
components.json              shadcn/ui settings: `pnpm dlx shadcn@latest add <component>` writes into src/react-app/components/ui/
vite.config.ts               Vite with the React, Tailwind and Cloudflare plugins; builds admin/index.html into dist/client, with its files under /admin/assets/
vitest.config.ts             Test settings: the three projects, the Workers runtime, the migrations, fixed test values for Access and ZenPay, and coverage
wrangler.jsonc               Bindings (D1, rate limiters), variables, required secrets, the Cron Trigger and static assets settings
worker-configuration.d.ts    Types generated from wrangler.jsonc by `pnpm run cf-typegen`; do not edit it by hand
tsconfig.json                Points at the other tsconfigs: tsconfig.app.json (the panel), tsconfig.worker.json (the Worker and src/shared), tsconfig.node.json (vite.config.ts), tsconfig.test.json (the Worker tests) and tsconfig.panel-test.json (the panel tests)
tsdoc.json                   The TSDoc tags the code uses (@param, @returns, @throws and {@link}), read by the TSDoc lint rule
eslint.config.js             ESLint rules: TypeScript, React hooks and TSDoc
.prettierrc.json             Prettier settings; .prettierignore lists what it skips
.editorconfig                Editor settings: UTF-8, LF line endings, 2 spaces
.dev.vars.example            The four secrets, and the template for the local `.dev.vars`
pnpm-workspace.yaml          pnpm settings: which packages may run install scripts, and dependency overrides
.github/workflows/ci.yml     CI: audit, generated types, formatting, lint, types, tests, build and a dry-run deploy
.github/secret_scanning.yml  Tells GitHub secret scanning to skip test/, which holds made-up credentials
```

## Reporting a security problem

Do not report a security problem in a public issue. Email the maintainer at the address in the `author` field of `package.json` (`ian@ianmenethil.com`), with what you found and how to reproduce it. If a ZenPay credential or the callback signing secret may have been exposed, replace it first: ask ZenPay for new credentials, or set a new `CALLBACK_TOKEN_SECRET` (step 2).

## License

[MIT](./LICENSE)

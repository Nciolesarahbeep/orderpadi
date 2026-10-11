# OrderPadi

Orders, invoices and payment tracking for WhatsApp and Instagram sellers in Nigeria.

- **Sellers** get a store link (`/s/your-shop`), invoices with their bank details, a list of who owes them, and sales numbers.
- **Free plan:** 20 orders a month. **Pro:** ₦2,500 a month through Paystack, with unlimited orders, no branding, reports and CSV export.
- Plain HTML pages and Vercel serverless functions (Node), with a Neon Postgres database. No build step.

## Pages

| Address | What it is |
| --- | --- |
| `/` | Landing page (`home.html`, served with link-preview tags) |
| `/app` | The seller app: sign up, log in, orders, products, settings |
| `/s/<slug>` | A seller's store, where customers order |
| `/i/<id>` | An invoice or receipt for one order |
| `/admin` | Admin panel (only for admins) |
| `/terms`, `/privacy` | Terms of service and privacy policy |
| `/setup` | Setup check. Delete `setup.html` and `api/health.js` after launch |

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Needed | What it's for |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Neon connection string |
| `JWT_SECRET` | Yes | Long random string that signs login cookies |
| `RESEND_API_KEY` | Yes | Sends sign-up, login and reset codes |
| `EMAIL_FROM` | Before launch | e.g. `OrderPadi <no-reply@yourdomain.com>`. Without a verified domain, Resend only delivers to your own email |
| `ADMIN_EMAILS` | Yes, for `/admin` | Your login email (comma-separate several) |
| `SUPPORT_EMAIL` / `SUPPORT_WHATSAPP` | Before launch | Shown on the home, terms and privacy pages |
| `PAYSTACK_SECRET_KEY` | For Pro | From Paystack → Settings → API Keys & Webhooks |
| `PAYSTACK_PLAN_CODE` | For Pro | The `PLN_…` code of a ₦2,500 monthly plan |

Redeploy after changing any of them.

## Launch checklist

1. Deploy on Vercel from this repo and add the variables above. Open `/setup` and make every required row show a tick.
2. Sign up in `/app` with the email in `ADMIN_EMAILS`, then open `/admin`.
3. Buy a domain and add it in Vercel → Domains. Verify the same domain in Resend, then set `EMAIL_FROM`.
4. Paystack: create a monthly plan of ₦2,500, add the two Paystack variables, and set the webhook URL to `https://<your-domain>/api/paystack-webhook`. Test with test keys first. Switch to live keys once Paystack approves your business (they check that the terms, privacy and contact details are on the site).
5. Test on your phone: sign up, add a product, order from your store as a customer, send the invoice, record a payment, upgrade to Pro, and cancel.
6. Share a store link on WhatsApp and check the preview shows the shop name and picture.
7. Delete `setup.html` and `api/health.js` (the admin panel has the same checks).

## Database

`db/schema.sql` creates everything. Updates made after the first version are in `db/migrations/` and are run once, in order, in the Neon SQL Editor.

## Functions

There are 9 of the 12 allowed on Vercel's free plan: `admin`, `auth`, `billing`, `health`, `me`, `orders`, `paystack-webhook`, `products`, `public`.

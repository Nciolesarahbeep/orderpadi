# OrderPadi

Orders, invoices and payment tracking for WhatsApp and Instagram sellers in Nigeria.

- **Sellers** get a store link (`/s/your-shop`), invoices with their bank details, a list of who owes them, and sales numbers.
- **Free plan:** 20 orders a month, 1 photo per product, 3 group messages a month. **Pro:** ₦2,500 a month through Paystack, with unlimited orders, 3 photos per product, no branding, the profit report, unlimited group messages and CSV downloads.
- **Look:** bold and playful, in light and dark. Sellers pick one of six store colours, add product photos, swipe an order to mark it paid, and make a WhatsApp status picture of their products.
- **Options and categories:** a product can have up to 2 options (like Size and Colour) with up to 20 choices each. A choice can cost extra or be marked sold out. Categories group products on the store page, with search once a store has 8 or more products.
- **Grow:** customers rate their order from the invoice (shown on the store and in the directory, and sellers can reply), promo codes for money off at checkout (2 on Free, 50 on Pro), and a public store directory at `/stores`.
- **Earn more:** invite other sellers with your link (both get a free Pro month after the new seller's first store order), and resell other sellers' products at your own price: the supplier sends the item to your customer and you keep the difference.
- **App and alerts:** sellers add OrderPadi to their home screen and get a phone alert for every new order, "I've paid", review, resale order and back-in-stock request, even with the app closed (web push, `lib/push.js`, `sw.js`). On iPhone this works once it's on the home screen (iOS 16.4 or later).
- **Message customers:** one message to a group (everyone, recent buyers, people who haven't ordered in 2 months, people who owe, or a label). WhatsApp opens one chat at a time with the message filled in; the app remembers who has had it. Customers who ask to stop are left out.
- **Back in stock:** on a sold-out product (or a sold-out choice), customers leave their name and WhatsApp number. The seller sees who's waiting under Stock and messages them all when it's back.
- **Money:** a cost price on each product, an expenses log, and a profit report (sales − what the items cost − expenses) for the last 30 days, this month or last month.
- **Sharing:** every product has its own link (`/s/<slug>?p=<id>`) that previews with its photo, name and price in WhatsApp, and the status picture also makes square posts for Instagram, with a special layout for one product.
- **Seller tools (the More tab):** customer pages with notes, labels and what each person spends and owes; stock counts that go down with every order and come back when one is cancelled; delivery areas with their own fees; saved WhatsApp quick replies; away mode; a history and notes on every order; and search across orders.
- Plain HTML pages and Node server functions, with a Neon Postgres database. Hosted on **Netlify** (`netlify.toml`); `vercel.json` is kept so it can also run on Vercel.
- No npm packages: the database is reached over HTTPS (`lib/db.js`), and login tokens and password hashing use Node's built-in crypto (`lib/jwt.js`, `lib/password.js`).

## Pages

| Address | What it is |
| --- | --- |
| `/` | Landing page (`home.html`, served with link-preview tags) |
| `/app` | The seller app: sign up, log in, orders, products, and the More tab (customers, messages, stock, delivery, expenses, profit, alerts, settings) |
| `/s/<slug>` | A seller's store, where customers order. `?p=<id>` opens one product |
| `/stores` | The store directory: sellers who list their store, by category and state |
| `/i/<id>` | An invoice or receipt for one order |
| `/admin` | Admin panel (only for admins) |
| `/terms`, `/privacy` | Terms of service and privacy policy |
| `/p/<id>` | A product photo (cached for a year; a new photo gets a new address) |
| `/setup` | Setup check. Delete `setup.html` after launch |
| `/sw.js`, `/offline.html` | The service worker (phone alerts, offline page) and the page it shows with no internet |

The seller app gives every screen its own address (`/app#orders`, `/app#order/12`, `/app#product/5`, `/app#customer/7`, `/app#stock`, `/app#settings`…), so a refresh reopens the same screen and the phone's back button works like in an app. The store page does the same for the product sheet, checkout and "order placed" (`#product-12`, `#checkout`, `#done`), and the admin panel for `#sellers`, `#seller/12` and `#events`. The landing page and the seller app open with a short OrderPadi animation once per visit (skipped on refresh and for people who turn off motion).

Shared look: `ui.css` (colours, buttons, cards, animations, light/dark), `ui.js` (light/dark choice, confetti, counting numbers, scroll reveal) and `fredoka.woff`, the heading font (SIL Open Font License, `FREDOKA-OFL.txt`).

## Environment variables (Netlify → Site configuration → Environment variables)

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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | No | Keys for phone alerts. Leave them out: the server makes a pair once and keeps it in the database (`app_keys`). If you ever set them, sellers need to turn alerts on again |

Redeploy after changing any of them (Deploys → Trigger deploy).

## Launch checklist

1. On Netlify: Add new project → Import from GitHub → `orderpadi` → Deploy. The settings come from `netlify.toml`.
2. Add the variables above, then Trigger deploy. Open `/setup` and make every required row show a tick.
3. Sign up in `/app` with the email in `ADMIN_EMAILS`, then open `/admin`.
4. Buy a domain and add it in Netlify → Domain management. Verify the same domain in Resend, then set `EMAIL_FROM`.
5. Paystack: create a monthly plan of ₦2,500, add the two Paystack variables, and set the webhook URL to `https://<your-domain>/api/paystack-webhook`. Test with test keys first. Switch to live keys once Paystack approves your business (they check that the terms, privacy and contact details are on the site).
6. Test on your phone: sign up, add a product, order from your store as a customer, send the invoice, record a payment, upgrade to Pro, and cancel.
7. Share a store link on WhatsApp and check the preview shows the shop name and picture.
8. Delete `setup.html` (the admin panel has the same checks).

## Database

`db/schema.sql` creates everything. Updates made after the first version are in `db/migrations/` and are run once, in order, in the Neon SQL Editor:

- `002_email_otps_ip.sql`: limits email codes per device.
- `003_photos_and_theme.sql`: product photos and store colours.
- `004_options_and_categories.sql`: product options (like Size and Colour) and categories.
- `005_seller_tools.sql`: stock counts, delivery areas, order history, customer notes and labels, quick replies and away mode.
- `006_reviews_promos_directory.sql`: reviews and ratings, promo codes, and the store profile for the directory.
- `007_referrals_resell.sql`: invite links and rewards, and reselling (products offered for resale, resold copies and supply orders).
- `008_alerts_messages_expenses.sql`: phone alerts, messages to many customers, back-in-stock requests, cost prices and expenses.

Phone alerts: everything that lands in a seller's bell is also sent to their phones by `flushPush()` in `lib/push.js`, right after the statement that added it. Each message is encrypted for the phone (RFC 8291) and signed with the server's key (VAPID) using Node's crypto, so there are still no npm packages. Alerts only go to phones whose login is still live, so logging out stops them, and phones the push service says are gone are removed.

Profit: each order line keeps what one item cost the seller when it was sold (`order_items.unit_cost_kobo`, from the product's cost price, or the supplier's price for resold items), so changing a cost price later doesn't rewrite old profit.

Reselling: a resold copy takes its stock, photos and availability from the supplier's product, and its name and options follow the supplier's edits. The order statement takes the supplier's stock and creates one supply order per supplier, so the supplier sees what to send and where. Cancelling the order puts the stock back and cancels supply orders that haven't been sent.

Stock is taken inside the same SQL statement that saves an order. The database refuses any count below zero, so two customers can't both buy the last one: the second order is turned down and nothing of it is saved.

Product photos are shrunk on the seller's phone (about 1000px, under 240 KB) and stored in the `product_photos` table. The admin panel shows how much space they use; Neon's free plan has 512 MB.

## How requests are served

- Static pages (`*.html`, icons, pictures) are copied to `public/` at build time and served directly.
- `netlify/functions/app.mjs` handles `/api/*`, `/`, `/s/*`, `/i/*` and `/p/*`. It passes each request to the matching handler in `api/` through `lib/webAdapter.js`.
- On Vercel, `vercel.json` does the same job: each file in `api/` is its own function (10 of the 12 allowed on the free plan).

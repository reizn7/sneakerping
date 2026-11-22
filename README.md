# SneakPing

Static neon front end (`public/`) + one serverless function (`api/app.js`). Storage: Upstash Redis.

## Deploy (about 15 min)
1. Push this folder to GitHub, then import it in Vercel (no build settings needed).
2. Vercel → Storage → Marketplace → **Upstash Redis** → connect to the project. This sets the Redis env vars automatically.
3. Generate push keys: `npx web-push generate-vapid-keys`
4. Add environment variables in Vercel, then redeploy:

| Name | Value |
|---|---|
| `UPI_ID` | your UPI ID (e.g. `name@okhdfcbank`) |
| `ADMIN_KEY` | a long random string (to approve payments at `/#admin`) |
| `CRON_SECRET` | another long random string |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | from step 3 |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `APP_URL` | your site URL, e.g. `https://sneakping.vercel.app` |
| `TG_TOKEN`, `TG_BOT`, `TG_SECRET` | optional, see below |
| `GEMINI_API_KEY` | optional: enables "Find other retailers" (Google AI Studio key). `GEMINI_MODEL` optional, defaults to `gemini-2.5-flash`; check the current model name and quotas in Google's docs |
| `FETCH_PROXY` | optional, e.g. `https://api.scraperapi.com/?api_key=KEY&url={url}` |

## Telegram (optional, doesn't use your number)
1. In Telegram, chat with **@BotFather** → `/newbot` → copy the token (`TG_TOKEN`) and the bot username without @ (`TG_BOT`).
2. Pick any random `TG_SECRET`, then run once:
   `curl "https://api.telegram.org/bot<TG_TOKEN>/setWebhook?url=<APP_URL>/api/telegram&secret_token=<TG_SECRET>"`

## Checking prices every minute
Vercel's free plan only allows one cron per day, so use a free external pinger:
- **cron-job.org** → new job → URL `https://YOUR_SITE/api/cron?key=<CRON_SECRET>` → every 1 minute.
(Or GitHub Actions on a 5-minute schedule.)

## Payments
Users pay ₹49 to your UPI ID (QR + deep link shown in the app) and submit the UTR. Open `https://YOUR_SITE/#admin`, enter `ADMIN_KEY`, check the UTR in your bank app, and tap Approve.

## Try it first
Use the **demo shoe** in the app. It has simulated prices and sizes so you can test watches, analytics, push, Telegram, payments and cron end to end.

## Honest limits
- Product parsing is best-effort (JSON-LD, meta tags, embedded size data). Adjust `parse()` in `api/app.js` per retailer after testing real links.
- Big retailers may block Vercel IPs. Use `FETCH_PROXY` if you see "blocked".
- Price history starts when the first person tracks a product.
- Without Redis env vars the app uses in-memory storage (local dev only; data won't persist on Vercel).

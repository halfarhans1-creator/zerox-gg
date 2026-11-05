# zerox.gg (Cloudflare, no Netlify)

Everything (website, profiles, uploads, Discord login + badges) runs in ONE Cloudflare Worker. Free plan is enough, no credit card.

## Deploy (5 minutes, from your PC)
1. Install Node.js (https://nodejs.org), open a terminal in this folder.
2. `npm install`
3. `npx wrangler login` (opens the browser, log in / create a free Cloudflare account)
4. `npx wrangler deploy` -> prints your address, e.g. `https://zerox-gg.NAME.workers.dev`
5. Secrets (one command each, it asks for the value):
   ```
   npx wrangler secret put DISCORD_CLIENT_ID
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put DISCORD_GUILD_ID
   npx wrangler secret put DISCORD_STAFF_ROLE_IDS
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put ADMIN_TOKEN     # optional, for staff tools
   ```
   (Same names as before. You can also add them in the dashboard: Workers -> zerox-gg -> Settings -> Variables and Secrets.)
6. Discord Developer Portal -> OAuth2 -> Redirects -> add exactly:
   `https://zerox-gg.NAME.workers.dev/.netlify/functions/discord`
   (the path still says "netlify" on purpose, so the page needs no changes; it does not use Netlify)

## Own domain (zerox.gg)
Cloudflare dashboard -> Workers -> zerox-gg -> Settings -> Domains & Routes -> Add custom domain. Then use that domain in the Discord redirect (step 6).

## Frontend on GitHub Pages instead (optional)
Put your Worker address into `public/config.js` (`api: "https://zerox-gg.NAME.workers.dev"`), optionally set `ALLOWED_ORIGINS` in `wrangler.toml`, and deploy the pages workflow. The Discord redirect stays the Worker address.

## Notes
- Old Netlify data (profiles/uploads) was stored in Netlify Blobs and is not copied over; the new backend starts empty.
- Uploads: up to 1 GB per file in theory, but the free Durable Object storage is 5 GB total.

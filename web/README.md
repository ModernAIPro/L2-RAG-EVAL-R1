# Chatbot web app

The browser version of `../chatbot.py` — same model, same class proxy, same
conversation-history-in-a-list approach.

```bash
cd web
npm install     # first time only
npm run dev
```

Open http://localhost:3000.

There is no `.env` here: the API route reads `../.env`, so your MAI key stays in
the one place the labs already use it. Override the model with `MODEL=...` in
that same file.

## The two files that matter

- `app/api/chat/route.ts` — server-side. Takes the message list, calls the LLM,
  streams tokens back as plain text. The key never reaches the browser.
- `app/page.tsx` — client-side. Holds the messages in React state and appends
  each streamed token to the last bubble.

Like the CLI version, history is never trimmed, so a long conversation will
eventually hit the context limit.

## Deploying to Vercel

Deploy **from this `web/` directory**, not the repo root — that way the Next app
is the project root and only these files are uploaded. The repo-root `.env` is
never part of the upload.

```bash
npm i -g vercel
vercel login
cd web
vercel        # first run links/creates the project
vercel --prod
```

If you instead connect the GitHub repo in the dashboard, set *Settings → Build &
Deployment → Root Directory* to `web`.

Either way the app needs these environment variables — via `vercel env add NAME`,
or under *Settings → Environment Variables* — in the Production, Preview and
Development environments:

| Name | Value | Required |
|---|---|---|
| `OPENAI_API_KEY` | your MAI key | yes |
| `OPENAI_BASE_URL` | `https://learn.modernaipro.com/api/llm/v1` | yes |
| `MODEL` | e.g. `gpt-4o-mini` | no, defaults to `gpt-4o-mini` |
| `CHAT_PASSWORD` | the shared password visitors type | yes in production |

Do **not** add `HF_API_TOKEN` — the web app never uses it. Give a deployment only
the secrets it actually needs.

Preview deployments get the same env vars, so a preview URL is just as live as
production.

### How the key stays out of the browser

- The key is only ever read inside `app/api/chat/route.ts`, which runs on the
  server. The browser talks to `/api/chat`, never to the LLM provider.
- The name has no `NEXT_PUBLIC_` prefix. That prefix is the *only* way Next.js
  inlines a value into the JavaScript sent to the client — without it, the value
  does not exist in the bundle.
- Nothing is committed: `.env` is in `.gitignore`, `web/.gitignore` ignores
  `.env*`, and `../.vercelignore` excludes it from CLI uploads too. On Vercel the
  value lives only in the project's encrypted environment variables.
- Verify it yourself after any change:

  ```bash
  npm run build
  grep -rF "$(grep '^OPENAI_API_KEY=' ../.env | cut -d= -f2-)" .next/static && echo LEAK || echo clean
  ```

### Why there is a password, and why Vercel's own protection is not enough

Nobody can read your key from the deployed site — but `/api/chat` would otherwise
be an open URL, and anyone who has it can spend your key's quota.

Vercel's built-in Deployment Protection does not solve this once you use a custom
domain. Its Standard Protection scope, [by
design](https://vercel.com/docs/deployment-protection), "protects all deployments
**except** production domains", and raising the scope to *All Deployments* needs a
Pro or Enterprise plan. Your custom domain **is** the production domain, so on
Hobby it is public no matter what that toggle says.

Hence the gate in `app/api/chat/route.ts`: every request must carry an
`x-chat-password` header matching `CHAT_PASSWORD`, compared with
`timingSafeEqual`. The page prompts for the password once and keeps it in
`localStorage`; a 401 clears it and re-prompts.

It **fails closed** — in production, a missing `CHAT_PASSWORD` locks the route
rather than opening it, so a forgotten env var cannot silently expose your key.
Locally it stays open so `npm run dev` needs no setup.

To rotate the password:

```bash
vercel env rm CHAT_PASSWORD production
vercel env add CHAT_PASSWORD production
vercel --prod            # env vars only apply to new deployments
```

This is a shared-secret gate, not user accounts: everyone shares one password and
there is no per-visitor rate limiting, so treat the password as the whole of your
security and rotate it when you are done sharing it.

### The custom domain

Live at **https://starkfarms.in**.

DNS stays on Google Cloud DNS (`ns-cloud-c*.googledomains.com`) rather than moving
nameservers to Vercel — the apex is pointed at Vercel with a single `A` record to
`216.198.79.1`. That keeps any other records on the domain, MX especially,
untouched. Vercel issues the certificate and 308-redirects `http` to `https`
automatically.

Useful commands:

```bash
vercel domains inspect starkfarms.in   # verification + nameserver status
dig +short A starkfarms.in             # what the world actually resolves
```

`www.starkfarms.in` is **not** configured — it does not resolve. To add it, add
the subdomain to the project with `vercel domains add www.starkfarms.in` and
create the `CNAME` record it prints in Google Cloud DNS.

Note the asymmetry this creates, and that it is working as intended: the
`*.vercel.app` URLs are still behind Vercel Authentication, while `starkfarms.in`
is public and defended only by `CHAT_PASSWORD`.

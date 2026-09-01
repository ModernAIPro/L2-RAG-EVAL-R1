# Chatbot web app

The browser version of `../rag/chat.py` — grounded in the Apple filings, not in
the model's memory. Every answer is built from retrieved excerpts, cites them by
number, and is checked afterwards to see whether its figures actually appear in
the text it was given.

```bash
cd web
npm install     # first time only
npm run dev
```

Open http://localhost:3000.

There is no `.env` here: the API route reads `../.env`, so your MAI key stays in
the one place the labs already use it. Override the model with `MODEL=...` in
that same file.

**The index must exist first.** `data/` is written by `python ../rag/export_web.py`
and is committed to the repo, because Vercel builds from git. Re-run that export
after every `rag/ingest.py` or the site answers from a stale index. See
`../rag/README.md` for the details.

## The files that matter

- `app/api/chat/route.ts` — server-side. Rewrites a follow-up into a standalone
  question, retrieves the top 5 chunks, refuses outright if the nearest is past
  the distance cutoff, then streams the answer. The key never reaches the browser.
- `lib/retrieval.ts` — loads `data/` once per warm instance and brute-forces the
  1,173 dot products.
- `lib/grounding.ts` — the figure/citation check, a port of `../rag/grounding.py`.
  Keep the two in step or the site and the scripts will disagree about what
  counts as grounded.
- `lib/tracing.ts` — optional Langfuse tracing. See below.
- `app/page.tsx` — client-side. Reads the newline-delimited JSON stream and
  renders the sources and the grounding verdict under each answer. It mints one
  session id per page load and sends it as `x-chat-session`, which is what makes
  a conversation group as one session in tracing.

The response is NDJSON rather than plain text because one stream has to carry
three things that become known at different times: the sources (up front), the
tokens (as they arrive), and the grounding verdict (only once the answer ends).

Like the CLI version, history is never trimmed on the client, though the route
only forwards the last few turns to the model.

## Tracing (Langfuse v4)

Off unless `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`
are set — same three variables as the Python scripts, same names in v4. With
either key missing, `lib/tracing.ts` returns no-ops and the route behaves exactly
as before.

The SDK is the **scoped `@langfuse/*` packages at 5.x**, not the old unscoped
`langfuse` npm package, which stopped at 3.38.20. Note that the two SDKs version
independently: Python's current line is 4.x and JavaScript's is 5.x, so matching
the numbers across languages is the wrong instinct — Langfuse's own SDK-freshness
check flags a JS v4 install as outdated.

| Package | Role |
|---|---|
| `@langfuse/tracing` | `startObservation`, trace attributes |
| `@langfuse/otel` | `LangfuseSpanProcessor` |
| `@langfuse/openai` | `observeOpenAI` wrapper |
| `@langfuse/client` | scores |
| `@opentelemetry/sdk-trace-base` | the provider the processor is attached to |

v5 is OpenTelemetry underneath, and that drives three decisions worth keeping:

- **Input and output go on the root observation, never on the trace.** v5 removed
  `updateTrace` and marks `setTraceIO` legacy; Langfuse derives what the trace
  shows from the root observation. Nothing here writes trace-level IO.
- **The session is set as an explicit span attribute**, not via
  `propagateAttributes`. That helper carries attributes in OpenTelemetry context,
  and context does not survive this route — wrapping span creation in it produced
  traces with `session=None`. Measured, not assumed.

- **`startObservation`, not `startActiveObservation`.** Nesting in v4 normally
  comes from ambient OTel context, but the answer is produced inside a
  `ReadableStream` callback that runs after the handler returns — outside any
  active context. The root span's `SpanContext` is therefore passed to children
  and to `observeOpenAI` explicitly.
- **A private tracer provider.** `setLangfuseTracerProvider` points the SDK at a
  `BasicTracerProvider` we own, rather than registering globally where it would
  contend with Next's own instrumentation.

Both pipelines are flushed before the stream closes — spans through the
processor's `forceFlush()`, scores through `score.flush()`. A serverless instance
can freeze the instant the response ends, and a queued batch that never left is a
trace that never existed.

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
| `EMBED_MODEL` | must match what `rag/ingest.py` used | no, defaults to `text-embedding-3-small` |
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

To rotate the password, from `web/`:

```bash
npm run rotate
```

That is `scripts/rotate-password.sh`. It generates a password, replaces it in all
three Vercel environments, updates `../.env`, redeploys, checks the live site
answers `200`, and prints the new password last. Point it elsewhere with
`SITE=https://example.com npm run rotate`.

The script pipes the value in rather than using `vercel env add`'s interactive
prompt, which matters. Vercel
stores production and preview variables as **sensitive**, meaning write-only: the
dashboard, `vercel env ls` and `vercel env pull` all return `[SENSITIVE]` instead
of the value, and there is no way to read it back. If you type it at the prompt
and forget it, the only fix is another rotation. Rotate all three environments
together, or preview deployments keep accepting the old password.

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

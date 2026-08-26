# Chatbot — terminal and web

A small chatbot in two forms, both talking to the Modern AI Pro class LLM proxy:

- **`chatbot.py`** — a streaming terminal REPL.
- **`web/`** — the same thing in the browser, a Next.js app deployed to Vercel.

Live at **https://starkfarms.in** (password protected).

This repo began as the Level 2 lab kit; the key-minting step below is inherited
from it. The lab files themselves are not here — this is the chatbot work.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Mint your personal MAI key at
[study.modernaipro.com/practice](https://study.modernaipro.com/practice) — it is
shown exactly once — and paste it into `OPENAI_API_KEY` in `.env`. A shared class
token works in the same slot. `OPENAI_BASE_URL` is already set to the class proxy.

> `requirements.txt` is the full lab kit's list. The chatbot itself only needs
> `openai` and `python-dotenv`; the rest (`torch`, `transformers`, ~2GB) is
> inherited and unused by this code.

## Run the terminal chatbot

```bash
python chatbot.py
```

Streams tokens as they arrive, keeps the conversation in memory, `exit` to quit.

## Run the web chatbot

```bash
cd web
npm install
npm run dev            # http://localhost:3000
```

There is no `.env` inside `web/` — the API route reads the repo-root `.env`, so
one key file serves both chatbots. Set `MODEL=` there to use a model other than
the `gpt-4o-mini` default.

## Layout

```
chatbot.py                    terminal client
requirements.txt              Python deps (lab kit's full list)
.env                          your key — git-ignored, never commit
web/
  app/page.tsx                browser UI: messages in React state, streamed in
  app/api/chat/route.ts       server: calls the LLM, holds the key, gates access
  scripts/rotate-password.sh  npm run rotate
  README.md                   deployment and security detail
sessions/                     dated notes on why things are built this way
```

## How the key is protected

The API key is read **only** in `web/app/api/chat/route.ts`, which runs on the
server. The browser talks to `/api/chat` and never to the LLM provider. The
variable has no `NEXT_PUBLIC_` prefix, which is the only mechanism that would
inline it into the client bundle — confirmed by grepping the built `.next/static`
output for the key value.

Because the deployed `/api/chat` is a public URL that spends your quota, it is
gated on a shared `CHAT_PASSWORD`, compared with `timingSafeEqual`. Vercel's own
Deployment Protection does not cover this: its Standard Protection scope excludes
production domains, and `starkfarms.in` is the production domain. The gate fails
closed — a missing password in production locks the route rather than opening it.

Local `npm run dev` has no gate unless you set `CHAT_PASSWORD` in `.env`.

## Deploy and rotate

```bash
cd web
vercel --prod          # deploy
npm run rotate         # new password everywhere, redeploy, verify, print it
```

Full detail, including DNS and the Vercel settings, is in
[`web/README.md`](./web/README.md).

## Before starting new work

Read the newest file in [`sessions/`](./sessions/). Those notes carry the
reasoning behind decisions and the traps already paid for — for example that
Vercel stores production env vars write-only, so a password typed at an
interactive prompt cannot be recovered.

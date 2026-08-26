# Session logs

One file per working session, named `YYYY-MM-DD.md` after the date it ended.
Read the most recent one before starting new work — they carry the *why* behind
decisions and the traps already paid for, which the code itself does not record.

> **This repo is public.** Never put the MAI key, `CHAT_PASSWORD`, or any other
> secret in these files. Record where a value lives, not the value.

| Date | Summary |
|---|---|
| [2026-08-26](./2026-08-26.md) | Chatbot: `chatbot.py` CLI → `web/` Next.js app → Vercel → `starkfarms.in` with a password gate. Pushed to GitHub. |

## Writing a new entry

Start from the shape of the last one — it is worth keeping:

- **What exists now** — a table of the moving parts and their state.
- **Decisions and the reasoning behind them** — especially anything a future
  reader would otherwise "simplify" away without knowing what it defends.
- **Traps hit, so they are not hit again** — the concrete failure and its fix.
- **Open items** — uncommitted work, known gaps, deliberate omissions.

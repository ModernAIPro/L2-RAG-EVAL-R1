# Modern AI Pro — Level 2 · AI Practitioner Labs

The lab kit for the **AI Practitioner** weekend (Level 2 of the Modern AI Pro ladder).
Every hands-on session of the course runs from this one repo. Labs ship and update
**over the course via `git pull`** — clone once, pull each morning.

## Setup (~15 minutes, do this before Day 1)

```bash
git clone https://github.com/balajivis/mai-practitioner-labs.git
cd mai-practitioner-labs
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

*Windows: activate with `.venv\Scripts\activate`. If `python` isn't found, use
`python3` and `pip3` — common on macOS.*

Then **mint your personal MAI key** at
[study.modernaipro.com/practice](https://study.modernaipro.com/practice) (it shows exactly
once) and paste it into `OPENAI_API_KEY` in your `.env`. A shared class token pinned in the
cohort room on class days works in the same slot.

**Smoke-test** — proves Python, the install, and your key in one shot:

```bash
python labs/lab_1.py
```

If it greets you and your key is accepted, you are ready for Level 2.

## The labs

Run in order; each builds on the prior one. *(Labs land here move-by-move over the
weekend — `git pull` at the start of every session.)*

| Day | Lab | Name | Status |
|---|---|---|---|
| 1 (Fri) | 1 | **LLM Calls Done Right** — roles · structured output · streaming · retries · the cost meter | **live** |
| 2 (Sat) | 2 | **A Chatbot Worth Shipping** — memory · context budget · persistence · the LLM-judged gate · Gradio | **live** |
| 2 (Sat) | 3 | **Strong RAG, Proven** — chunking · hybrid (BM25+RRF) · citations · golden set + judge · ablation | **live** |
| 3 (Sun) | 4 | **An Agent You Can Trust** — LangGraph · tools · agentic RAG · budget caps · HITL checkpoint | **live** |
| 3 (Sun) | 5 | **Compose & Ship** — the capstone: one Gradio app wiring Labs 1–4, then your own corpus | **live** |

The `corpus/` folder is Meridian Corp's policy binder — deliberately laced with
multi-hop facts and a superseded policy version, so retrieval mistakes are
visible. After class, swap it for documents from YOUR world: that version of
Lab 5 is your portfolio piece.

## Getting updates

```bash
git pull
```

Before you edit a lab, copy it (`cp labs/lab_2.py my_lab_2.py`) — editing `labs/*.py` in
place causes a merge conflict on the next pull. Your `.env` is git-ignored; pulls never
touch your key.

## Stuck?

The [FAQ](./labs/FAQ.md) covers the usual suspects. In class: ask in the cohort room, or
flag an instructor.

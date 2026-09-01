# RAG over the Apple filings

No framework.

```bash
python rag/ingest.py                 # chunk + embed corpus/*.pdf into rag/.chroma
python rag/ask.py "your question"    # retrieve, then answer with citations
python rag/chat.py                   # the same, as a conversation
python rag/chunks.py                 # inspect what was actually stored
python rag/export_web.py             # publish the index to web/ for the deploy
```

Chunk size is settable without editing the file:

```bash
CHUNK_CHARS=1600 OVERLAP=300 python rag/ingest.py
```

## How it works

**`ingest.py`** — reads each PDF page by page with `pypdf`, splits every page into
1200-character windows with 200 characters of overlap, embeds them in batches of
64 with `text-embedding-3-small` (1536 dims), and stores them in a local Chroma
collection called `filings`.

Chunking happens *within* a page rather than across the whole document, so every
chunk knows its exact page and a citation can point at it. Each chunk carries
`{source, form, year, page}`. The `year` is the point of this corpus: the same
fact has a different value in each filing, so retrieval that ignores the year
gets caught.

Re-running rebuilds the collection from scratch — safe to repeat.

**`ask.py`** — embeds the question, pulls the top 5 chunks, and hands them to the
model numbered `[1]`…`[5]`. It prints what it retrieved before the answer, so you
can see whether a bad answer was a retrieval failure or a generation failure.

**`chat.py`** — the same retrieval, held across turns. Two things a conversation
needs that a single question does not:

- *Follow-ups are not standalone.* "and the year before?" embeds to noise, so it
  is rewritten against the history first (one extra model call per turn). The
  rewrite is printed, because it is usually the reason a follow-up missed.
- *History must not smuggle context.* Only the current turn's excerpts are
  attached, so a chunk retrieved three turns ago cannot quietly ground today's
  answer. The grounding check runs against that turn's excerpts alone.

Type `sources` to dump the last turn's chunks in full.

**`grounding.py`** — the figure/citation check, shared by `ask.py` and `chat.py`
so the two cannot drift. Ported to TypeScript in `web/lib/grounding.ts`; change
one and change the other.

**`chunks.py`** — prints what is in the store. Retrieval can only return what was
chunked, so when an answer looks wrong this says whether the fact was ever there.

**`tracing.py`** — optional Langfuse tracing. See "Tracing" below.

**`export_web.py`** — dumps the store to `web/data/` as flat files the deployed
app can read. See "Wiring the web app" below.

## Answering only from the corpus

The model has Apple's financials memorised — asked outside any RAG, it gives
FY2019 net sales as `$260.174 billion`, which is right. So a correct answer is no
evidence that retrieval worked. Three defences, weakest to strongest:

1. **A distance gate.** Below `MAX_DISTANCE = 1.2`, the question is refused before
   the model is called at all, so it *cannot* answer from memory. This only stops
   wholly off-topic questions. Measured on this corpus:

   | Question | Best distance |
   |---|---|
   | R&D fiscal 2024 (present) | 0.563 |
   | Net sales FY2019 (**absent**) | 0.587 |
   | 2018 World Cup | 1.681 |

   Note the middle row: a plausible Apple question about a year we do not have
   scores like a real hit. Distance cannot catch that.

2. **The system prompt**, which forbids outside knowledge and requires the exact
   reply `NOT IN CORPUS` when the excerpts fall short. Soft — the model may ignore
   it, which is precisely why the third defence exists.

3. **A grounding check after the fact.** Every number the answer states must
   appear in the retrieved text; every `[n]` must be a chunk actually retrieved.
   This is what catches an answer drawn from training.

Filings report millions (`31,370`) while answers restate them as billions
(`31.370 billion`), so the check compares digits with separators stripped.

That comparison is deliberately loose and cuts both ways. A derived figure gets
flagged correctly — asking how net sales changed from FY2023 to FY2025 flags the
`32.876` difference, which appears in no filing because the model computed it.
But stripping separators also means a short number like `8.6` can match an
unrelated digit run in the context and pass unnoticed. Treat the check as a
tripwire, not a proof.

## What is deliberately missing

This is the simple baseline, not a good RAG system. Absent: hybrid search
(BM25 + dense), reranking, query rewriting, a golden question set, and any
measurement at all. Known weak points to measure first:

- **Fixed-size chunking cuts tables in half.** A 10-K's substance is financial
  tables, and print-to-PDF has already flattened them into positioned text.
- **No year filter.** A question about FY2024 can retrieve FY2023 chunks that
  look almost identical. Chroma metadata filtering on `year` would fix this
  cheaply — the metadata is already there, unused.
- **`corpus/` also contains a 10-Q** (Q2 FY2026), which is indexed alongside the
  three 10-Ks. Fine for retrieval, but it breaks the "one company × 3 years"
  framing if you are measuring year coverage.

## Store

`rag/.chroma/` is git-ignored. Delete it to start clean; `ingest.py` recreates it.
Current corpus is 1,173 chunks from 313 pages across four filings.

## Tracing

Optional, and off unless three variables are set in `.env`:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com    # eu. for the EU region
```

**Both keys are required** — the public key alone cannot send traces, and the
region must match the region the keys were minted in. With either key missing,
`tracing.py` falls back to no-ops: same output, no network calls, no Langfuse
import. Nobody needs an account to run the labs.

Mind the variable name: the v4 SDK reads **`LANGFUSE_BASE_URL`** and ignores
`LANGFUSE_HOST`, which plenty of older documentation still shows. Set the wrong
one and traces go to the default region and fail authentication there.

Both sides of this repo are on Langfuse v4: Python `langfuse` 4.15.1 here, and
the v4 scoped `@langfuse/*` packages in `web/`. They are different SDK lines with
different APIs — see `web/README.md` — but the same three environment variables
and the same project.

`ask.py` and `chat.py` print which mode they are in on the first line.

Each question becomes one trace:

| Observation | What it holds |
|---|---|
| `rag-turn` (chain) | the question in, the answer out |
| `retrieve` (retriever) | the 5 chunks with source, page and distance |
| embedding generation | the query embedding, tokens, latency |
| chat generation | the full prompt the model saw — excerpts included — and its reply |
| `grounded` (score) | 1 or 0 from the same `verify()` the terminal prints |

The score is the reason to bother. A wrong answer is usually obvious in the
moment and invisible a week later; `grounded` turns "did it make up a number"
into something you can filter and count. A refusal scores 1 — declining to answer
off-corpus is correct behaviour, not a failure.

Which figures were unsupported, which citations were bad, and whether the turn
was a refusal are recorded as **metadata on the `rag-turn` span**, not on the
score. That is deliberate: SDK 4.15.1 accepts `comment` and `metadata` on a score
and stores neither — both read back as null. Span metadata persists.

`chat.py` tags every turn of a run with one `session_id`, so a conversation reads
as a conversation rather than a pile of unrelated traces.

Two things worth knowing:

- **Tracing never breaks a run.** With the host unreachable, the export errors go
  to stderr and stdout is untouched — answer, citations and grounding check all
  print normally. Verified by pointing `LANGFUSE_HOST` at a dead port.
- **The traces record the model actually served, not the one requested.** With
  `MODEL=gpt-4o-mini`, the class proxy reports back `gpt-5.6-terra-2026-07-09J`.
  Worth knowing before you attribute a behaviour change to your prompt.

Traces are batched on a background thread, so both scripts call `tracing.flush()`
before exiting — without it a short script can finish before anything is sent.

## Wiring the web app

`web/` deploys to Vercel from git, and `rag/.chroma` is 25 MB of git-ignored
SQLite plus HNSW segments — nothing the deployment can query. Rather than run a
vector database, the index ships as two flat files and the route brute-forces it:
1,173 dot products is under a millisecond, and exact search beats approximate
search at this size.

```bash
python rag/export_web.py     # -> web/data/chunks.json (1.4 MB) + vectors.bin (7.2 MB)
```

Unlike `rag/.chroma`, `web/data/` **is** committed — Vercel builds from the repo,
so an uncommitted index means a deployed chatbot with nothing to retrieve. It is
also read with `fs` rather than imported, so Next's dependency trace cannot see
it; `outputFileTracingIncludes` in `web/next.config.ts` is what puts it in the
function bundle.

Row *i* of `vectors.bin` is the embedding of chunk *i* of `chunks.json` and
nothing else ties them together, so **re-run `export_web.py` after every
`ingest.py`** or the web app answers from a stale index while the terminal
scripts use the new one. `web/lib/retrieval.ts` checks the lengths agree and
refuses to run if they do not, which catches a forgotten export but not an export
of the wrong corpus.

Two details worth knowing if you touch the retrieval port:

- Chroma's default space is **squared L2**, and the embeddings are unit length,
  so `2 - 2·dot` reproduces its distances exactly. That is what lets
  `MAX_DISTANCE = 1.2` mean the same thing in both languages.
- The Node OpenAI SDK defaults to `encoding_format: "base64"`. Decoded against
  the class proxy that yields 384 zeros instead of 1,536 floats, and every
  distance comes out `NaN`. `retrieval.ts` asks for `"float"` explicitly.

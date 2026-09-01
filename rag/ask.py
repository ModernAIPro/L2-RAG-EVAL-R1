"""Ask a question against the ingested filings, answering only from them.

    python rag/ask.py "how much did Apple spend on R&D in fiscal 2024?"

Run rag/ingest.py first.

The model has Apple's financials memorised, so a plausible-looking answer proves
nothing on its own. Three defences, weakest to strongest:

  1. a distance gate, which only catches wholly off-topic questions;
  2. a system prompt telling it to refuse — soft, and the model may ignore it;
  3. a check, after the fact, that every figure it stated actually appears in the
     retrieved text. That is the one that catches an answer from memory.
"""

import os
import pathlib
import sys

import chromadb
import tracing
from dotenv import load_dotenv
from grounding import report

# Plain openai.OpenAI unless Langfuse keys are set, in which case the traced
# drop-in. See rag/tracing.py.
from tracing import OpenAI

load_dotenv()

STORE = pathlib.Path(__file__).resolve().parent / ".chroma"
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
MODEL = os.getenv("MODEL", "gpt-4o-mini")
TOP_K = 5

# In-corpus questions land around 0.56-0.77; unrelated ones around 1.7. A cutoff
# between the two rejects nonsense, but note it cannot tell "right topic, absent
# fact" from a real hit — a question about a year we lack scores like a hit.
MAX_DISTANCE = 1.2

SYSTEM = (
    "You answer strictly from the numbered excerpts of Apple SEC filings given "
    "to you. Every factual claim must cite its excerpt like [1] or [2]. Figures "
    "differ between fiscal years, so always say which year a number comes from. "
    "You may not use anything you know about Apple from outside these excerpts, "
    "even if you are confident it is correct. If the excerpts do not contain the "
    "answer, reply exactly: NOT IN CORPUS — and nothing else."
)


question = " ".join(sys.argv[1:]).strip()
if not question:
    raise SystemExit('Ask something: python rag/ask.py "your question"')

client = OpenAI()
collection = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")

print(f"({tracing.banner()})")

# One trace per question. The embedding and completion calls below nest inside it
# on their own; only retrieval and the grade have to be reported by hand.
with tracing.turn(question) as turn:
    query_vector = client.embeddings.create(model=EMBED_MODEL, input=[question]).data[0].embedding
    hits = collection.query(query_embeddings=[query_vector], n_results=TOP_K)
    docs, metas = hits["documents"][0], hits["metadatas"][0]
    distances = hits["distances"][0]
    turn.retrieved(question, metas, distances)

    print(f"Retrieved {len(docs)} chunks:")
    for i, (meta, dist) in enumerate(zip(metas, distances), start=1):
        print(f"  [{i}] {meta['source']} page {meta['page']}  (distance {dist:.3f})")

    if not distances or distances[0] > MAX_DISTANCE:
        turn.graded("NOT IN CORPUS", docs)  # a refusal is a trace worth keeping
        tracing.flush()
        raise SystemExit(
            f"\nNOT IN CORPUS — nearest chunk is {distances[0]:.3f} away, past the "
            f"{MAX_DISTANCE} cutoff. Not asking the model, so it cannot answer from memory."
        )

    excerpts = [
        f"[{i}] {m['form']} {m['year']}, page {m['page']}\n{d}"
        for i, (d, m) in enumerate(zip(docs, metas), start=1)
    ]

    stream = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "\n\n".join(excerpts) + f"\n\nQuestion: {question}"},
        ],
        stream=True,
    )

    print("\nAnswer:")
    answer = ""
    for chunk in stream:
        if not chunk.choices:  # the proxy's final usage-only chunk
            continue
        piece = chunk.choices[0].delta.content or ""
        answer += piece
        print(piece, end="", flush=True)
    print()

    turn.graded(answer, docs)

print("\nGrounding check:")
report(answer, docs)
tracing.flush()  # the exporter batches; a script can exit before it sends

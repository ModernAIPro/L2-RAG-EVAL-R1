"""A conversation grounded in the ingested filings. Run: python rag/chat.py

Run rag/ingest.py first. Ctrl-C or 'exit' to quit, 'sources' to see the last
turn's excerpts in full.

chatbot.py holds a conversation with no retrieval, so it answers about Apple from
training data. ask.py retrieves, but answers one question and forgets it. Putting
the two together raises two problems neither one faces alone:

  1. follow-ups are not standalone. "and the year before?" embeds to nothing
     useful, so it is rewritten against the history before retrieval;
  2. history would otherwise accumulate excerpts, letting a chunk retrieved three
     turns ago silently ground today's answer. Only the current turn's excerpts
     are attached, and the check runs against those.
"""

import os
import pathlib
import sys
import uuid

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
MAX_DISTANCE = 1.2  # see ask.py — in-corpus lands near 0.6-0.8, unrelated near 1.7
HISTORY_TURNS = 6  # what the model sees; older turns still shaped the rewrite

SYSTEM = (
    "You answer strictly from the numbered excerpts of Apple SEC filings given "
    "to you. Every factual claim must cite its excerpt like [1] or [2]. Figures "
    "differ between fiscal years, so always say which year a number comes from. "
    "You may not use anything you know about Apple from outside these excerpts, "
    "even if you are confident it is correct. If the excerpts do not contain the "
    "answer, reply exactly: NOT IN CORPUS — and nothing else. Earlier turns are "
    "for context only; each answer must rest on the excerpts given with it."
)

CONDENSE = (
    "Rewrite the user's last message as a standalone question, resolving pronouns "
    "and anything left implicit from the conversation. Keep it short and keep any "
    "fiscal year explicit. Output only the question."
)

client = OpenAI()
try:
    collection = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")
except Exception:
    raise SystemExit(f"No collection at {STORE} — run python rag/ingest.py first.")


def standalone(question, history):
    """"and the year before?" retrieves noise on its own. Against the history it
    becomes a question with a year in it, which retrieves the right page. One
    extra model call per turn, and the reason follow-ups work at all."""
    if not history:
        return question
    transcript = "\n".join(f"{m['role']}: {m['content']}" for m in history[-4:])
    reply = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": CONDENSE},
            {"role": "user", "content": f"{transcript}\nuser: {question}"},
        ],
    )
    return (reply.choices[0].message.content or "").strip() or question


def retrieve(query):
    vector = client.embeddings.create(model=EMBED_MODEL, input=[query]).data[0].embedding
    hits = collection.query(query_embeddings=[vector], n_results=TOP_K)
    return hits["documents"][0], hits["metadatas"][0], hits["distances"][0]


def excerpts_for(docs, metas):
    return [
        f"[{i}] {m['form']} {m['year']}, page {m['page']}\n{d}"
        for i, (d, m) in enumerate(zip(docs, metas), start=1)
    ]


history = []  # plain turns only: the excerpts never enter it
last = None  # (docs, metas) of the most recent turn, for the 'sources' command
SESSION = f"chat-{uuid.uuid4().hex[:8]}"  # groups this run's traces in Langfuse

print(f"Grounded chat ({MODEL}, {collection.count()} chunks). 'sources', or 'exit'.")
print(f"({tracing.banner()})\n")

while True:
    try:
        question = input("you> ").strip()
    except (EOFError, KeyboardInterrupt):
        break
    if not question:
        continue
    if question.lower() in {"exit", "quit"}:
        break
    if question.lower() == "sources":
        if not last:
            print("  nothing retrieved yet\n")
            continue
        for i, (d, m) in enumerate(zip(*last), start=1):
            print(f"\n  [{i}] {m['source']} page {m['page']}\n  {d}")
        print()
        continue

    # One trace per turn, all of them grouped under SESSION so a conversation
    # reads as a conversation in the Langfuse UI.
    with tracing.turn(question, session=SESSION) as trace:
        query = standalone(question, history)
        if query != question:
            print(f"  rewritten: {query}")

        docs, metas, distances = retrieve(query)
        last = (docs, metas)
        nearest = distances[0] if distances else float("inf")
        trace.retrieved(query, metas, distances)
        cites = ", ".join(
            f"[{i}] {m['source']} p{m['page']}" for i, m in enumerate(metas, start=1)
        )
        print(f"  retrieved {len(docs)} chunks (nearest {nearest:.3f}): {cites}")

        # Off-topic questions never reach the model, so it cannot answer from memory.
        if nearest > MAX_DISTANCE:
            answer = "NOT IN CORPUS"
            print(f"bot> {answer} — nearest chunk {nearest:.3f}, past the {MAX_DISTANCE} cutoff.")
        else:
            prompt = "\n\n".join(excerpts_for(docs, metas)) + f"\n\nQuestion: {question}"
            print("bot> ", end="", flush=True)
            answer = ""
            for chunk in client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM},
                    *history[-HISTORY_TURNS:],
                    {"role": "user", "content": prompt},
                ],
                stream=True,
            ):
                if not chunk.choices:  # the proxy's final usage-only chunk
                    continue
                piece = chunk.choices[0].delta.content or ""
                answer += piece
                print(piece, end="", flush=True)
            print()

        trace.graded(answer, docs)

    report(answer, docs)
    print()

    history.append({"role": "user", "content": question})
    history.append({"role": "assistant", "content": answer})

tracing.flush()  # the exporter batches; send what this session produced
print("\nbye.")

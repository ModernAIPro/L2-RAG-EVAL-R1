"""Show what ingest.py actually put in the store.

    python rag/chunks.py                     # one line per chunk
    python rag/chunks.py --full              # every chunk in full
    python rag/chunks.py --source fy2024     # only filings matching that string
    python rag/chunks.py --grep "research and development"

Retrieval can only ever return what is in here, so when an answer looks wrong the
first question is whether the fact was chunked in the first place. A figure split
across a window boundary, or a table the PDF extractor flattened into noise, is
invisible to the embedder and so invisible to ask.py.
"""

import pathlib
import re
import sys

import chromadb

STORE = pathlib.Path(__file__).resolve().parent / ".chroma"

args = sys.argv[1:]


def option(name):
    """--name value, or None. Bare --full has no value, so it reads as a flag."""
    if name not in args:
        return None
    i = args.index(name)
    return args[i + 1] if i + 1 < len(args) else ""


full = "--full" in args
source = option("--source")
pattern = option("--grep")

collection = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")
data = collection.get(include=["documents", "metadatas"])

# Chroma returns insertion order per id, which is not page order; sort so the
# dump reads like the filings do.
rows = sorted(
    zip(data["ids"], data["documents"], data["metadatas"]),
    key=lambda r: (r[2]["source"], r[2]["page"], r[0]),
)

if source:
    rows = [r for r in rows if source.lower() in r[2]["source"].lower()]
if pattern:
    rows = [r for r in rows if re.search(pattern, r[1], re.I)]

try:
    for chunk_id, doc, meta in rows:
        head = f"{meta['form']:5} {meta['year']:7} p{meta['page']:<4} {chunk_id}"
        if full:
            print(f"\n=== {head} ({len(doc)} chars) ===\n{doc}")
        else:
            print(f"{head}  {doc[:90]}...")
except BrokenPipeError:  # piping into head/less closes the pipe early
    sys.stdout = None
else:
    print(f"\n{len(rows)} of {collection.count()} chunks", file=sys.stderr)

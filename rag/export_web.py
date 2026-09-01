"""Export the Chroma store into files the Next.js app can read.

    python rag/export_web.py        # after any rag/ingest.py run

Vercel deploys the repo, and rag/.chroma is 25 MB of gitignored SQLite plus HNSW
segments — nothing the web app can query. Rather than run a vector database, we
ship the index as two flat files and brute-force it: 1173 dot products is well
under a millisecond, and exact search beats approximate search at this size.

  web/data/chunks.json   text + metadata, in row order
  web/data/vectors.bin   float32 little-endian, count x dim, same row order

Row i of the binary is the embedding of chunk i of the JSON; nothing else ties
them together, so both must be regenerated as a pair.
"""

import json
import pathlib
import struct

import chromadb

HERE = pathlib.Path(__file__).resolve().parent
STORE = HERE / ".chroma"
OUT = HERE.parent / "web" / "data"

collection = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")
data = collection.get(include=["documents", "metadatas", "embeddings"])

# Same ordering as chunks.py, so a row here is the row you read there.
rows = sorted(
    zip(data["ids"], data["documents"], data["metadatas"], data["embeddings"]),
    key=lambda r: (r[2]["source"], r[2]["page"], r[0]),
)

dim = len(rows[0][3])
if any(len(r[3]) != dim for r in rows):
    raise SystemExit("Ragged embeddings — re-run rag/ingest.py to rebuild the store.")

OUT.mkdir(parents=True, exist_ok=True)

chunks = [
    {
        "id": chunk_id,
        "source": meta["source"],
        "page": meta["page"],
        "form": meta["form"],
        "year": meta["year"],
        "text": doc,
    }
    for chunk_id, doc, meta, _ in rows
]

(OUT / "chunks.json").write_text(
    json.dumps({"dim": dim, "count": len(chunks), "chunks": chunks}), encoding="utf-8"
)

with open(OUT / "vectors.bin", "wb") as handle:
    for *_, vector in rows:
        handle.write(struct.pack(f"<{dim}f", *vector))

json_mb = (OUT / "chunks.json").stat().st_size / 1e6
bin_mb = (OUT / "vectors.bin").stat().st_size / 1e6
print(f"Wrote {len(chunks)} chunks x {dim} dims to {OUT}")
print(f"  chunks.json  {json_mb:5.1f} MB")
print(f"  vectors.bin  {bin_mb:5.1f} MB")

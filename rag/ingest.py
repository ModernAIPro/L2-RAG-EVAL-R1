"""Chunk and embed corpus/*.pdf into a local Chroma collection.

    python rag/ingest.py
    CHUNK_CHARS=600 OVERLAP=100 python rag/ingest.py    # smaller windows

Re-running rebuilds the collection from scratch, so it is safe to repeat.
"""

import os
import pathlib
import re

import chromadb
from dotenv import load_dotenv
from openai import OpenAI
from pypdf import PdfReader

load_dotenv()

HERE = pathlib.Path(__file__).resolve().parent
CORPUS = HERE.parent / "corpus"
STORE = HERE / ".chroma"

EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
# Chunk size is the one dial worth turning here. Smaller windows retrieve a
# tighter passage but cut tables in half; larger ones keep a table whole and
# dilute it with surrounding prose. Re-run this script after changing either.
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", 1200))
OVERLAP = int(os.getenv("OVERLAP", 200))
BATCH = 64

if OVERLAP >= CHUNK_CHARS:  # step would be <= 0, so split() would never advance
    raise SystemExit(f"OVERLAP ({OVERLAP}) must be smaller than CHUNK_CHARS ({CHUNK_CHARS})")

client = OpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL from .env


def label(filename):
    """aapl-10k-fy2023.pdf -> ("10-K", "FY2023"). The year is what makes this
    corpus useful: the same fact carries a different value in each filing, so
    retrieval that ignores the year gets caught."""
    match = re.search(r"(10-[kq])-(fy\d{4})", filename, re.I)
    return (match.group(1).upper(), match.group(2).upper()) if match else ("?", "?")


def split(text):
    """Fixed character windows with overlap. Crude, but the overlap keeps a
    sentence straddling a boundary from being lost to both sides."""
    step = CHUNK_CHARS - OVERLAP
    for start in range(0, len(text), step):
        piece = text[start : start + CHUNK_CHARS].strip()
        if len(piece) > 100:  # skip page furniture and stray headers
            yield piece


def read_corpus():
    """One chunk per window, per page, so a hit can cite an exact page."""
    docs, metas, ids = [], [], []
    for pdf in sorted(CORPUS.glob("*.pdf")):
        form, year = label(pdf.name)
        pages = PdfReader(str(pdf)).pages
        before = len(docs)
        for page_no, page in enumerate(pages, start=1):
            text = re.sub(r"\s+", " ", page.extract_text() or "")
            for n, piece in enumerate(split(text)):
                docs.append(piece)
                metas.append(
                    {"source": pdf.name, "form": form, "year": year, "page": page_no}
                )
                ids.append(f"{pdf.stem}-p{page_no}-{n}")
        print(f"  {pdf.name:26} {len(pages):4} pages -> {len(docs) - before:5} chunks")
    return docs, metas, ids


def embed(texts):
    vectors = []
    for i in range(0, len(texts), BATCH):
        batch = texts[i : i + BATCH]
        response = client.embeddings.create(model=EMBED_MODEL, input=batch)
        vectors.extend(item.embedding for item in response.data)
        print(f"  embedded {len(vectors)}/{len(texts)}")
    return vectors


print(f"Reading {CORPUS}")
docs, metas, ids = read_corpus()
if not docs:
    raise SystemExit("No PDFs found in corpus/ — nothing to ingest.")

print(f"\nEmbedding {len(docs)} chunks with {EMBED_MODEL}")
vectors = embed(docs)

# Chroma never sees an embedding model of its own; we hand it vectors directly.
store = chromadb.PersistentClient(path=str(STORE))
if "filings" in [c.name for c in store.list_collections()]:
    store.delete_collection("filings")
collection = store.create_collection("filings")
collection.add(ids=ids, documents=docs, embeddings=vectors, metadatas=metas)

print(f"\nStored {collection.count()} chunks in {STORE}")

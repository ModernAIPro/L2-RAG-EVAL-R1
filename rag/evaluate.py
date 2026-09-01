"""Score the RAG system against rag/golden.jsonl.

    python rag/evaluate.py                  # everything: retrieval + model + grading
    python rag/evaluate.py --retrieval-only # no model calls, no cost, seconds not minutes
    python rag/evaluate.py --check          # verify the golden answers against the corpus
    python rag/evaluate.py --tag fy2025     # only questions carrying that tag
    python rag/evaluate.py --out run.json   # write per-question results

`verify()` in grounding.py is a tripwire on one answer: it says this reply looks
unsupported. It cannot say whether the system is getting better or worse, because
it has no expected answer and no fixed set of questions. That is what this adds.

Four question kinds, because "correct" means something different for each:

  answerable      the figure is in the corpus; the answer should state it
  derived         the answer must compute something no filing contains, so the
                  grounding check *should* fire — a pass here means the tripwire
                  works, not that the model misbehaved
  refuse_absent   on-topic but absent (a year we lack, another company). Retrieval
                  scores it like a real hit, so only the system prompt can refuse
  refuse_offtopic far enough away that the distance gate refuses before the model
                  is called at all

Metrics are reported per kind. A single headline number would hide the only
failure that matters: answering a question that should have been refused.
"""

import argparse
import collections
import json
import os
import pathlib
import sys

import chromadb
from dotenv import load_dotenv
from grounding import digits, verify
from openai import OpenAI

load_dotenv()

HERE = pathlib.Path(__file__).resolve().parent
STORE = HERE / ".chroma"
GOLDEN = HERE / "golden.jsonl"

EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
MODEL = os.getenv("MODEL", "gpt-4o-mini")
TOP_K = 5
MAX_DISTANCE = 1.2

# Identical to ask.py. If they drift, the eval stops measuring the real system.
SYSTEM = (
    "You answer strictly from the numbered excerpts of Apple SEC filings given "
    "to you. Every factual claim must cite its excerpt like [1] or [2]. Figures "
    "differ between fiscal years, so always say which year a number comes from. "
    "You may not use anything you know about Apple from outside these excerpts, "
    "even if you are confident it is correct. If the excerpts do not contain the "
    "answer, reply exactly: NOT IN CORPUS — and nothing else."
)

REFUSAL_KINDS = {"refuse_absent", "refuse_offtopic"}


def load_golden(tag=None):
    items = [json.loads(line) for line in GOLDEN.read_text().splitlines() if line.strip()]
    if tag:
        items = [q for q in items if tag in q.get("tags", [])]
    return items


def retrieve(client, collection, question):
    vector = client.embeddings.create(model=EMBED_MODEL, input=[question]).data[0].embedding
    hits = collection.query(query_embeddings=[vector], n_results=TOP_K)
    return hits["documents"][0], hits["metadatas"][0], hits["distances"][0]


def rank_of_expected(metas, expected):
    """1-based rank of the first retrieved chunk that is an acceptable source, or
    None. A figure often appears in several filings — FY2024 R&D is in the FY2024
    10-K and again as a comparative column in the FY2025 one — so any listed
    (source, page) counts."""
    wanted = {(s, p) for s, p in expected}
    for i, m in enumerate(metas, start=1):
        if (m["source"], m["page"]) in wanted:
            return i
    return None


def states_figures(answer, figures):
    """Every expected figure present, comparing digits only so that 31,370
    (millions, as filed) matches 31.370 billion (as answered)."""
    haystack = digits(answer)
    return all(digits(f) in haystack for f in figures)


def check_corpus(collection):
    """Guard against the golden file being wrong. Every expected figure must
    actually appear in one of its declared source pages, or the metrics below are
    measuring a typo."""
    data = collection.get(include=["documents", "metadatas"])
    pages = collections.defaultdict(str)
    for doc, m in zip(data["documents"], data["metadatas"]):
        pages[(m["source"], m["page"])] += " " + digits(doc)

    bad = 0
    for q in load_golden():
        for figure in q.get("figures", []):
            ok = any(digits(figure) in pages[(s, p)] for s, p in q.get("sources", []))
            if not ok:
                print(f"  MISSING  {q['id']}: {figure} not on any declared page")
                bad += 1
        for s, p in q.get("sources", []):
            if (s, p) not in pages:
                print(f"  NO SUCH PAGE  {q['id']}: {s} p{p}")
                bad += 1
    print(f"\n{'FAILED' if bad else 'OK'}: {bad} problem(s) in {GOLDEN.name}")
    return bad == 0


def answer_question(client, docs, metas, question):
    excerpts = [
        f"[{i}] {m['form']} {m['year']}, page {m['page']}\n{d}"
        for i, (d, m) in enumerate(zip(docs, metas), start=1)
    ]
    reply = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "\n\n".join(excerpts) + f"\n\nQuestion: {question}"},
        ],
    )
    return (reply.choices[0].message.content or "").strip()


def evaluate(items, retrieval_only):
    client = OpenAI()
    collection = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")
    results = []

    for q in items:
        docs, metas, distances = retrieve(client, collection, q["question"])
        nearest = distances[0] if distances else float("inf")
        rank = rank_of_expected(metas, q.get("sources", []))

        row = {
            "id": q["id"],
            "kind": q["kind"],
            "tags": q.get("tags", []),
            "nearest": round(nearest, 4),
            "retrieved_rank": rank,
            "retrieval_hit": rank is not None,
            "gated": nearest > MAX_DISTANCE,
        }

        if not retrieval_only:
            if row["gated"]:
                answer = "NOT IN CORPUS"
            else:
                answer = answer_question(client, docs, metas, q["question"])

            refused = answer.strip().startswith("NOT IN CORPUS")
            unsupported, bad_cites, cited = verify(answer, docs)

            row.update(
                {
                    "answer": answer,
                    "refused": refused,
                    "cited": cited,
                    "unsupported": unsupported,
                    "bad_citations": bad_cites,
                    "grounded": refused or (bool(cited) and not unsupported and not bad_cites),
                    "states_figures": states_figures(answer, q.get("figures", [])),
                }
            )

            if q["kind"] in REFUSAL_KINDS:
                row["correct"] = refused
            elif q["kind"] == "derived":
                # The tripwire firing is the pass condition here.
                row["correct"] = bool(unsupported) and not refused
            else:
                row["correct"] = (not refused) and row["states_figures"]

        results.append(row)
        mark = "" if retrieval_only else (" ok " if row["correct"] else "FAIL")
        print(
            f"  {mark} {q['id']:26} d={nearest:5.3f} "
            f"rank={rank if rank else '-':>2} "
            + ("" if retrieval_only else f"refused={row['refused']!s:5} grounded={row['grounded']!s:5}")
        )

    return results


def report(results, retrieval_only):
    def pct(n, d):
        return f"{100 * n / d:5.1f}%" if d else "    -"

    by_kind = collections.defaultdict(list)
    for r in results:
        by_kind[r["kind"]].append(r)

    print("\nRetrieval (is an acceptable source page in the top 5)")
    print(f"{'kind':16} {'n':>3} {'recall@5':>9} {'MRR':>6} {'mean dist':>10}")
    for kind, rows in sorted(by_kind.items()):
        scored = [r for r in rows if r["retrieval_hit"] is not None and kind not in REFUSAL_KINDS]
        if not scored:
            print(f"{kind:16} {len(rows):3}         -      -   {sum(r['nearest'] for r in rows)/len(rows):9.3f}")
            continue
        hits = sum(1 for r in scored if r["retrieval_hit"])
        mrr = sum(1 / r["retrieved_rank"] for r in scored if r["retrieved_rank"]) / len(scored)
        mean_d = sum(r["nearest"] for r in rows) / len(rows)
        print(f"{kind:16} {len(rows):3} {pct(hits, len(scored)):>9} {mrr:6.3f} {mean_d:10.3f}")

    if retrieval_only:
        print("\n(--retrieval-only: no model was called, so nothing below was measured)")
        return

    print("\nAnswers")
    print(f"{'kind':16} {'n':>3} {'correct':>9} {'refused':>9} {'grounded':>9}")
    for kind, rows in sorted(by_kind.items()):
        n = len(rows)
        print(
            f"{kind:16} {n:3} {pct(sum(r['correct'] for r in rows), n):>9} "
            f"{pct(sum(r['refused'] for r in rows), n):>9} "
            f"{pct(sum(r['grounded'] for r in rows), n):>9}"
        )

    answerable = [r for r in results if r["kind"] == "answerable"]
    should_refuse = [r for r in results if r["kind"] in REFUSAL_KINDS]

    print("\nThe two failures that matter")
    wrong_answers = [r for r in should_refuse if not r["refused"]]
    false_refusals = [r for r in answerable if r["refused"]]
    print(f"  answered when it should have refused : {len(wrong_answers)}/{len(should_refuse)}"
          + (f"  -> {', '.join(r['id'] for r in wrong_answers)}" if wrong_answers else ""))
    print(f"  refused when it should have answered : {len(false_refusals)}/{len(answerable)}"
          + (f"  -> {', '.join(r['id'] for r in false_refusals)}" if false_refusals else ""))

    failures = [r for r in results if not r["correct"]]
    print(f"\nOverall: {len(results) - len(failures)}/{len(results)} correct")
    if failures:
        print("Failed: " + ", ".join(r["id"] for r in failures))


def web_summary(results, model):
    """The compact shape web/ renders beside the chat. Written to web/data/ so the
    site shows a measured baseline rather than a claim about one."""
    by_kind = collections.defaultdict(list)
    for r in results:
        by_kind[r["kind"]].append(r)

    scored = [r for r in results if "correct" in r]
    answerable = by_kind.get("answerable", [])
    should_refuse = [r for r in results if r["kind"] in REFUSAL_KINDS]
    retrieval_scored = [r for r in answerable if r.get("sources") is not False]

    return {
        "generated": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model,
        "questions": len(results),
        "correct": sum(1 for r in scored if r["correct"]),
        "scored": len(scored),
        "recall_at_5": (
            round(sum(1 for r in retrieval_scored if r["retrieval_hit"]) / len(retrieval_scored), 4)
            if retrieval_scored else None
        ),
        "answered_when_should_refuse": sum(1 for r in should_refuse if not r.get("refused", False)),
        "should_refuse_total": len(should_refuse),
        "false_refusals": sum(1 for r in answerable if r.get("refused", False)),
        "answerable_total": len(answerable),
        "by_kind": [
            {
                "kind": kind,
                "n": len(rows),
                "correct": sum(1 for r in rows if r.get("correct")),
                "recall_at_5": (
                    round(sum(1 for r in rows if r["retrieval_hit"]) / len(rows), 4)
                    if kind not in REFUSAL_KINDS else None
                ),
            }
            for kind, rows in sorted(by_kind.items())
        ],
    }


parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--retrieval-only", action="store_true", help="skip the model; no cost")
parser.add_argument("--check", action="store_true", help="validate golden.jsonl against the corpus")
parser.add_argument("--tag", help="only questions with this tag")
parser.add_argument("--out", help="write per-question results as JSON")
parser.add_argument("--web", action="store_true", help="write the summary to web/data/eval.json")
args = parser.parse_args()

collection_for_check = chromadb.PersistentClient(path=str(STORE)).get_collection("filings")

if args.check:
    raise SystemExit(0 if check_corpus(collection_for_check) else 1)

items = load_golden(args.tag)
if not items:
    raise SystemExit(f"No questions{' with tag ' + args.tag if args.tag else ''}.")

print(f"{len(items)} questions | {MODEL} | top-{TOP_K} | cutoff {MAX_DISTANCE}\n")
results = evaluate(items, args.retrieval_only)
report(results, args.retrieval_only)

if args.out:
    pathlib.Path(args.out).write_text(json.dumps(results, indent=2))
    print(f"\nWrote {args.out}")

if args.web:
    if args.retrieval_only or args.tag:
        raise SystemExit("--web needs a full run over the whole set, so the site does not show a partial score.")
    target = HERE.parent / "web" / "data" / "eval.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(web_summary(results, MODEL), indent=2))
    print(f"Wrote {target}")

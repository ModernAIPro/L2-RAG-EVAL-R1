"""Optional Langfuse tracing for the RAG scripts.

Set three variables in .env and every question becomes a trace — what was
retrieved and how far away it was, what the model was actually given, what it
answered, and whether the grounding check passed:

    LANGFUSE_PUBLIC_KEY=pk-lf-...
    LANGFUSE_SECRET_KEY=sk-lf-...
    LANGFUSE_BASE_URL=https://us.cloud.langfuse.com    # eu. for the EU region

Leave any of them out and tracing is off: the scripts behave exactly as before,
print the same output, and never call Langfuse. That is the point of the no-op
below — nobody should need keys to run the labs.

Both keys are required. The public key alone cannot send traces.
"""

import os
from contextlib import contextmanager, nullcontext

from dotenv import load_dotenv
from grounding import verify

# The scripts call load_dotenv() after their imports, which would be too late:
# ENABLED is decided the moment this module is imported. Loading here as well
# makes the answer the same whatever the import order.
load_dotenv()

ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"))

if ENABLED:
    from langfuse import get_client, propagate_attributes

    # A drop-in replacement for openai.OpenAI: same API, but every completion and
    # embedding call is recorded with its model, token counts and latency. This
    # is why the scripts import OpenAI from here rather than from openai.
    from langfuse.openai import OpenAI  # noqa: F401  (re-exported)

    _client = get_client()
else:
    from openai import OpenAI  # noqa: F401  (re-exported)

    _client = None


class _Turn:
    """One question, from retrieval to grade."""

    def __init__(self, span):
        self._span = span

    def retrieved(self, query, metas, distances):
        """A retriever observation, so the UI shows what came back before the
        answer. Distances are the whole story when an answer is wrong."""
        self._span.start_observation(
            name="retrieve",
            as_type="retriever",
            input=query,
            output=[
                {"source": m["source"], "page": m["page"], "distance": round(d, 4)}
                for m, d in zip(metas, distances)
            ],
        ).end()

    def graded(self, answer, docs):
        """The grounding check as a score, which is the number worth watching:
        an answer can look perfect and still fail it."""
        unsupported, bad_cites, cited = verify(answer, docs)
        refused = answer.strip().startswith("NOT IN CORPUS")
        passed = refused or (bool(cited) and not unsupported and not bad_cites)

        # Why the detail rides on the span rather than the score: SDK 4.15.1
        # accepts `comment` and `metadata` on a score and then stores neither —
        # both come back null from the API. Span metadata does persist.
        self._span.update(
            output=answer,
            metadata={
                "cited": cited,
                "unsupported": unsupported,
                "bad_citations": bad_cites,
                "refused": refused,
            },
        )
        self._span.score_trace(
            name="grounded", value=1 if passed else 0, data_type="BOOLEAN"
        )


class _NoTurn:
    """Stand-in when tracing is off, so callers need no if-statements."""

    def retrieved(self, *args, **kwargs):
        pass

    def graded(self, *args, **kwargs):
        pass


@contextmanager
def turn(question, session=None):
    """Wrap one question. `session` groups a conversation's turns in the UI.

    The LLM and embedding calls inside nest under this span automatically —
    that is OpenTelemetry context, and the reason this is a `with` block rather
    than a pair of start/stop calls.
    """
    if not ENABLED:
        yield _NoTurn()
        return

    grouping = propagate_attributes(session_id=session) if session else nullcontext()
    with grouping:
        with _client.start_as_current_observation(
            name="rag-turn", as_type="chain", input=question
        ) as span:
            yield _Turn(span)


def flush():
    """Traces are batched on a background thread; a short script can exit before
    they are sent."""
    if ENABLED:
        _client.flush()


def banner():
    """One line at start-up, so it is never a mystery whether traces are on."""
    if not ENABLED:
        return "tracing off (no LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY)"
    # v4 reads LANGFUSE_BASE_URL; LANGFUSE_HOST from older versions is ignored.
    return f"tracing -> {os.getenv('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com')}"

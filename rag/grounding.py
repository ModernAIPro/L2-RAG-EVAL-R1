"""The after-the-fact check that an answer came from the excerpts, not memory.

Imported by ask.py (one question) and chat.py (a conversation). It lives on its
own because it is the part that actually catches a model answering from training
data, and two copies of it would drift.
"""

import re


def figures(text):
    """Numbers the answer asserts, minus the [n] citation markers. The decimal
    part only counts when digits follow it, so a sentence-ending full stop is not
    read as part of the number."""
    return set(re.findall(r"\d[\d,]*(?:\.\d+)?", re.sub(r"\[\d+\]", " ", text)))


def digits(text):
    """Filings report millions ("31,370"); answers restate them as billions
    ("31.370 billion"). Comparing digits alone sees through both separators."""
    return re.sub(r"[,.]", "", text)


def verify(answer, contexts):
    """Every figure stated should appear in the text we retrieved. Anything that
    does not is either derived (a difference, a percentage) or recalled from
    training — both worth surfacing rather than trusting."""
    haystack = digits(" ".join(contexts))
    unsupported = [n for n in figures(answer) if digits(n) not in haystack]

    cited = {int(n) for n in re.findall(r"\[(\d+)\]", answer)}
    bad_cites = sorted(c for c in cited if not 1 <= c <= len(contexts))

    return sorted(unsupported), bad_cites, sorted(cited)


def report(answer, docs, indent="  "):
    """Print the check. Shared so ask.py and chat.py phrase a failure the same way."""
    unsupported, bad_cites, cited = verify(answer, docs)

    if answer.strip().startswith("NOT IN CORPUS"):
        print(f"{indent}refused — nothing to verify")
        return

    print(f"{indent}cites: {cited or 'NONE — every claim should carry one'}")
    if bad_cites:
        print(f"{indent}invalid citations: {bad_cites} (only 1-{len(docs)} were retrieved)")
    if unsupported:
        print(f"{indent}figures not found in retrieved text: {', '.join(unsupported)}")
        print(f"{indent}-> derived from the excerpts, or recalled from training. Check it.")
    elif not bad_cites and cited:
        print(f"{indent}every figure appears in the retrieved text")

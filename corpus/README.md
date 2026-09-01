# Corpus — Apple 10-K filings

One company (Apple Inc., CIK `0000320193`) across three fiscal years. Apple's
fiscal year ends in late September, so each 10-K is filed the following
October/November.

## What to put here

| File | Fiscal year | Filed |
|---|---|---|
| `aapl-10k-fy2023.pdf` | FY2023 (ended Sep 2023) | Nov 2023 |
| `aapl-10k-fy2024.pdf` | FY2024 (ended Sep 2024) | Nov 2024 |
| `aapl-10k-fy2025.pdf` | FY2025 (ended Sep 2025) | Oct/Nov 2025 |

Stick to those filenames — later scripts key off the `fy####` suffix to tell the
years apart, which is the whole point of a one-company × three-year corpus: the
same facts change value across filings, so retrieval that ignores the year gets
caught.

## Getting them

EDGAR blocks automated downloads that don't declare a contact email, but a normal
browser is fine. Open Apple's 10-K list:

<https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&dateb=&owner=include&count=40>

For each of the three most recent 10-K rows:

1. Click **Filing** → open the primary document (`aapl-YYYYMMDD.htm`).
2. Print to PDF (`Cmd-P` → *Save as PDF*).
3. Save it here under the filename above.

EDGAR serves 10-Ks as HTML/iXBRL — there is no official PDF, so printing is the
normal way to get one.

## Note for whoever builds retrieval on this

PDF is the requested storage format, but it is not a great *chunking* input:
print-to-PDF flattens the filing's tables into positioned text, and the financial
statements are largely tables. If retrieval quality looks bad, suspect extraction
before blaming the retriever, and consider keeping the source `.htm` alongside.

Filings are public records; committing them here is fine. They are a few MB each,
so if the repo gets heavy, add `corpus/*.pdf` to `.gitignore` and have people
fetch their own.

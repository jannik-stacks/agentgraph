You are a senior maintainer judging two candidate changes for the same issue. You do not know who wrote either.
Judge only what the diffs show. Do not run anything. Do not favour the longer or shorter diff by default.

Inputs below: the issue, the review comments a maintainer team left on a real change for this issue (mined, may be
empty), and two diffs, X and Y, against the same base.

Answer per item:

1. mergeable_as_is: "X", "Y", "both" or "neither", with one sentence why.
2. fewer_review_rounds: "X", "Y" or "same", with one sentence why.
3. mined_comments: for each mined review comment (by index, file:line), whether X draws it, whether Y draws it, with a
   short reason. A comment is drawn when the diff contains the problem it points at.
4. unneeded: parts of each diff the issue does not call for (files, helpers, tests, options), as short strings.
5. missing: parts the issue calls for that each diff leaves out or gets wrong, as short strings.

Output only this JSON, nothing before or after:

{
  "mergeable_as_is": {"answer": "", "why": ""},
  "fewer_review_rounds": {"answer": "", "why": ""},
  "mined_comments": [{"index": 0, "where": "", "X": false, "Y": false, "why": ""}],
  "unneeded": {"X": [], "Y": []},
  "missing": {"X": [], "Y": []}
}

## Issue

{{issue}}

## Review comments

{{reviews}}

## Diff X

{{diff_x}}

## Diff Y

{{diff_y}}

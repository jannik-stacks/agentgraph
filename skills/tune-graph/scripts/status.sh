#!/bin/sh
# One-screen summary of a tune: the incumbent, the last 5 steps and the budget left.
# Usage: status.sh <tune dir> [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
set -eu

dir=${1:?usage: status.sh <tune dir> [--max-codex n] [--max-claude-5h n] [--max-claude-week n]}
shift
codex=25 c5h=40 cweek=12
while [ $# -gt 0 ]; do
  case $1 in
    --max-codex) codex=$2 ;;
    --max-claude-5h) c5h=$2 ;;
    --max-claude-week) cweek=$2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift 2
done

[ -f "$dir/tune.json" ] || { echo "no tune.json in $dir" >&2; exit 1; }
steps=$dir/iterations.jsonl
[ -f "$steps" ] || steps=/dev/null
budget=$dir/budget.json
[ -f "$budget" ] || budget=/dev/null

jq -r '"\(.repo)  point \(.point)  engine \(if (.engine | test("^[0-9a-f]{40}$")) then .engine[0:10] else .engine end)",
  "cases  " + ([.cases[]] | group_by(.) | map("\(.[0]) \(length)") | join("  "))' "$dir/tune.json"

jq -rs '
  def mean(es): (es | map(.quality * (.cases | length)) | add) / (es | map(.cases | length) | add);
  def q(es): if (es | length) == 0 then "-" else "\(mean(es) * 1000 | round / 1000) n=\(es | map(.cases | length) | add)" end;
  def num(x): if x == null then "-" else "\(x * 1000 | round / 1000)" end;
  def lastOf(es; f): es | map(f) | map(select(. != null)) | last;
  (map(select(.verdict == "kept")) | last) as $best
  | ((map(.iteration) | max) // 0) as $last
  | ($best.iteration // 0) as $kept
  | "",
    (if $best == null then "best   none kept yet" else
      "best   \($best.id)  select \(q([$best.evals[] | select(.split != "test")]))  validate \(q([$best.evals[] | select(.split == "validate")]))",
      ([$best.evals[] | select(.split == "test")] | last
        | if . == null then "test   no checkpoint yet"
          else "test   \(num(.quality)) ci \(num(.ci[0]))..\(num(.ci[1])) n=\(.cases | length)" end)
    end),
    "steps  \(length), kept \(map(select(.verdict == "kept")) | length), rounds since a keep \($last - $kept)",
    "",
    (.[-5:][] | "\(.id)  \(.verdict)  \(.proposer)  select \(q([.evals[] | select(.split != "test")]))  delta \(num(lastOf(.evals; .delta)))  pUp \(num(lastOf(.evals; .pUp)))",
      "    \(.why[0:110])")
' "$steps"

jq -rn --slurpfile b "$budget" --argjson codex "$codex" --argjson c5h "$c5h" --argjson cweek "$cweek" '
  def used(x): if (x | type) == "object" and x.start != null and x.now != null then x.now - x.start else null end;
  def line(name; x; max): used(x) as $u
    | if $u == null then "\(name) -" else "\(name) \($u) of \(max) used, \(max - $u) left" end;
  ($b[0] // {}) as $b
  | "", "budget",
    line("  codex      "; $b.codex; $codex),
    line("  claude 5h  "; $b.claude.fiveHour; $c5h),
    line("  claude week"; $b.claude.week; $cweek)'

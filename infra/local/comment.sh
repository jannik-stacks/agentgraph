#!/usr/bin/env bash
# Appends a comment to a local issue file, as a human would by editing it.
#
#   comment.sh <hub> <issue-number> <body> [author]
set -euo pipefail
hub="${1:?usage: comment.sh <hub> <issue> <body> [author]}"
issue="${2:?issue number}"
body="${3:?comment body}"
author="${4:-morgan}"
files=("$hub"/issues/"$issue"-*.md)
[[ -f "${files[0]}" ]] || { echo "no issue #$issue in $hub/issues" >&2; exit 1; }
printf '\n## @%s at %s\n\n%s\n' "$author" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$body" >>"${files[0]}"
echo "commented on ${files[0]}"

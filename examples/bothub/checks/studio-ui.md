---
type: script
description: Added studio TSX uses the shared primitives, explains icons with a tooltip, puts numbers first and loads without a flash.
run: node "$BOTHUB_HUB/scripts/studio-ui.mjs"
paths: [studio/src/**]
mode: block
human: mined from user dashboard feedback, feedback rules 6 7 8 11 15 16 17 18 19
---
Select instead of a native select, RemovableChip instead of a remove button beside a chip, Tooltip
instead of a native title, and Tooltip around a control that shows only an icon. A number comes
before its muted arrow, a cost has no tilde, spinners and pulses stay in the status icons, and
list rows animate only when they are new. No "Loading" fallback text and no lazily loaded
Markdown. Only lines the change adds count; `--all` audits every file.

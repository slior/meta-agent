# SVG diagram patterns

Use inline SVG only (no Mermaid, no external JS). Copy these patterns and fill labels from trace data.

## Conventions

- **Colors** (match template CSS): orchestrator `#58a6ff`, fetch `#3fb950`, llm `#bc8cff`, write `#d29922`, meta `#39c5cf`, composite `#e3b341`, error `#f85149`
- **Arrows**: define once per diagram with `<marker id="arrow">`
- **Ref labels** on edges: `.text`, `$ref`, param names
- One diagram minimum per user task; add ref dependency graph when multiple tasks or refs

## Manual pipeline (3+ atomic invoke_tool steps with $ref)

Horizontal chain: fetch → llm_generate → write-file-text → stop → synthesis

Label refs under each node: `r_0_…`, `r_1_…`, etc.

## Composite workflow expansion

When `workflow-start` appears, draw a dashed box containing:

`step_0 fetch` → `step_1 llm` → `step_2 write` → output path

Connect orchestrator `invoke_tool` node into the box.

## Error recovery branch

Vertical stack for failed task:

```
T0: invoke ✗ (schema_violation)
  ↓
T1: find_tool → schema discovered
  ↓
T2: invoke ✓ → workflow box
  ↓
T3: stop
```

Use red border on failure node, cyan on find_tool.

## Reference dependency graph (multi-task sessions)

Columns or swimlanes:

- Task 1: vertical ref chain r_0 → r_1 → r_2
- Lift arrow to composite tool box (if tool-created event)
- Task 2/3: composite output refs r_3, r_4

## Minimal arrow marker (paste in `<defs>`)

```svg
<defs>
  <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 Z" fill="#58a6ff"/>
  </marker>
</defs>
```

## Node rectangle template

```svg
<rect x="X" y="Y" width="W" height="H" rx="5" fill="#21262d" stroke="#3fb950" stroke-width="2"/>
<text x="CX" y="CY" text-anchor="middle" fill="#3fb950" font-family="monospace" font-size="10">label</text>
```

Adjust `stroke` color by node type. Keep font-size 8–11; truncate long tool names with `…` if needed.

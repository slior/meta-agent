# Step card HTML patterns

Reusable patterns for the **nested execution flow** — the primary report content. Tree rules: [nested-flow.md](nested-flow.md). Generator: [generate-trace-html.py](generate-trace-html.py).

## Step card (canonical)

```html
<article class="step nested" style="--accent:#39c5cf" data-kind="tool-dispatch-start">
  <header class="head">
    <span class="num">19</span>
    <span class="badge">tool-dispatch-start</span>
    <h3>Dispatch · invoke_tool</h3>
    <time>14:42:31.279</time>
  </header>
  <dl class="meta-grid">
    <dt>Args</dt><dd>{"name":"summarize_online_paper",…}</dd>
  </dl>
  <details class="raw">
    <summary>Raw event</summary>
    <pre>{ "name": "invoke_tool" }</pre>
  </details>
  <div class="children">
    <!-- nested workflow / tool-call steps -->
  </div>
</article>
```

- Add class `nested` when the step has `.children`
- Set `--accent` from the kind color table in [nested-flow.md](nested-flow.md)
- Sequential `.num` across the entire report (not per subtree)

## Meta grid

Use for scannable fields only — not full payloads:

```html
<dl class="meta-grid">
  <dt>Chosen</dt>
  <dd>invoke_tool({"args":{"outfile":"./tmp/out.md",…})</dd>
  <dt>Ref</dt><dd>r_0_summarize_online_paper</dd>
</dl>
```

## Raw event block

Always present; always collapsed by default:

```html
<details class="raw">
  <summary>Raw event</summary>
  <pre>{ compact JSON }</pre>
</details>
```

For `llm-call`, omit `request.messages`. Truncate `response.content` to 500 chars and tool `arguments` to 200 chars.

## Truncate helper

| Context | Limit |
|---------|-------|
| Titles, meta grid inline values | 60 chars |
| Tool arguments in raw JSON | 200 chars |
| LLM response content in raw JSON | 500 chars |
| Config table values | 80 chars |

Keep first N−1 chars + `…`.

## Optional sections (below flow)

These are **secondary** — never replace the nested tree:

- **Configuration** — table in hero; see [config-format.md](config-format.md)
- **Analysis** — `.finding` cards; see [analysis-heuristics.md](analysis-heuristics.md)
- **SVG diagrams** — optional ref/workflow graphs; see [diagrams.md](diagrams.md)

## Deprecated patterns

Do not use flat `.timeline-row` lists as the primary visualization. Do not use legacy `.turn` narrative cards without the nested tree. A flat timeline may appear only as an optional appendix, never instead of the nested flow.

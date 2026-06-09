# HTML snippets

Reusable patterns for report body content. Task-specific SVG diagrams: see [diagrams.md](diagrams.md).

Use unique `marker` ids (e.g. `arrow-task2`) when multiple SVGs appear on one page to avoid id collisions.

## Turn card HTML pattern

```html
<div class="turn">
  <div class="turn-header">
    <span class="turn-num">T0</span>
    <span class="tool-tag tool-fetch">fetch-webpage-text</span>
  </div>
  <p><strong>Reasoning:</strong> …</p>
  <p><strong>Args:</strong> <code>url: "https://…"</code></p>
  <details>
    <summary>Full tool result (ref r_0_fetch_webpage_text)</summary>
    <div class="detail-body"><pre>{ … json … }</pre></div>
  </details>
  <p class="result-ok">→ r_0_fetch_webpage_text</p>
</div>
```

## Timeline row pattern

```html
<div class="timeline-row">
  <span class="timeline-ts">14:40:31.584Z</span>
  <span class="timeline-kind">tool-call</span>
  <span>invoke_tool → fetch-webpage-text · ok</span>
</div>
```

## Truncate helper

For inline display, truncate strings longer than **20 characters**: keep first 17 chars + `…`.

For collapsible blocks, show truncated text in summary; full value in `<pre>`.

# Meta-agent configuration section

Optional input for [SKILL.md](SKILL.md). Sample shape: `config/meta-agent.example.json`.

## Expected top-level keys

| Key | Type | Notes |
|-----|------|-------|
| `$schema` | string | JSON Schema pointer; display as-is |
| `llm` | object | `baseURL`, `model`, `apiKeyEnv` (env var **name**, not secret value) |
| `workspace` | string | Path |
| `toolsDir` | string | Path |
| `tracesDir` | string | Path |
| `yolo` | boolean | Auto-approve tools when true |
| `maxTurns` | number | Orchestration turn limit |
| `sandbox` | object | `maxDepth`, `maxOutputBytes` |

Other keys in the file should still appear in the table — do not drop unknown keys.

## Flattening rules

Build table rows from a **depth-first flatten** of the JSON object:

- Nested objects → dot-separated keys: `llm.model`, `sandbox.maxDepth`
- Arrays → JSON-stringify the array for the value cell
- Primitives → display in `<code>`; booleans as `true` / `false`
- Skip flattening **into** `$schema` value beyond the single key `$schema`
- **Do not** read or display environment variables; only show `apiKeyEnv` as the configured env var name
- Truncate value display in the table at **80 characters** with `…`; if truncated, add a `<details>` row below the table with full JSON (optional, only when needed)

## When config path is omitted

Replace `{{CONFIG_SECTION_HTML}}` with:

```html
<h3>Configuration</h3>
<p class="config-unknown">Configuration unknown</p>
```

## When config path is provided and valid

```html
<h3>Configuration</h3>
<p class="config-source">Source: <code>{{CONFIG_BASENAME}}</code></p>
<table class="config-table">
  <thead>
    <tr><th>Key</th><th>Value</th></tr>
  </thead>
  <tbody>
    <tr><td>llm.model</td><td><code>gpt-4o-mini</code></td></tr>
    <tr><td>llm.baseURL</td><td><code>https://api.openai.com/v1</code></td></tr>
    <!-- one row per flattened key, sorted alphabetically by key -->
  </tbody>
</table>
```

Sort rows **alphabetically by key** for reproducibility.

## When config path is provided but unreadable

Do not fail the whole report. Use:

```html
<h3>Configuration</h3>
<p class="config-source">Source: <code>{{CONFIG_BASENAME}}</code></p>
<p class="config-error">Could not load configuration: {{ERROR_MESSAGE}}</p>
```

Add an **Info** finding in Analysis if parse failed.

## Table row template

```html
<tr><td>{{KEY}}</td><td><code>{{VALUE_ESCAPED}}</code></td></tr>
```

Escape HTML in values: `&`, `<`, `>`, `"` as entities. JSON `null` → `<code>null</code>`.

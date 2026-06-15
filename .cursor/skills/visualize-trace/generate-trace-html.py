#!/usr/bin/env python3
"""Generate a nested meta-agent trace HTML report.

Usage:
  python3 generate-trace-html.py TRACE.jsonl OUTPUT.html
  python3 generate-trace-html.py TRACE.jsonl OUTPUT.html --config meta-agent.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from html import escape
from pathlib import Path

KIND_COLORS = {
    "llm-turn-start": "#58a6ff",
    "llm-turn": "#58a6ff",
    "llm-call": "#bc8cff",
    "tool-dispatch-start": "#39c5cf",
    "tool-call": "#39c5cf",
    "tool-invoked": "#3fb950",
    "workflow-start": "#d29922",
    "workflow-step-start": "#e3b341",
    "workflow-step-end": "#e3b341",
    "workflow-end": "#d29922",
    "llm-synthesis-start": "#f85149",
    "llm-synthesis": "#f85149",
    "execution-denied": "#f85149",
    "tool-created": "#8b949e",
    "tool-rejected": "#f85149",
    "factory-gen-draft": "#8b949e",
    "factory-repair-llm": "#8b949e",
}


def trunc(text: str, n: int = 60) -> str:
    text = str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


def fmt_time(ts: str) -> str:
    try:
        if "." in ts:
            base, frac = ts.replace("Z", "").split(".", 1)
            dt = datetime.fromisoformat(base)
            ms = frac[:3]
            return dt.strftime("%H:%M:%S.") + ms
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%H:%M:%S")
    except ValueError:
        return ts


def load_events(path: Path) -> list[dict]:
    events = []
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
    if not events:
        raise ValueError(f"{path}: no events found")
    return events


def extract_user_task(events: list[dict]) -> str:
    for ev in events:
        if ev.get("kind") != "llm-call":
            continue
        if ev.get("data", {}).get("phase") != "orchestration":
            continue
        for msg in reversed(ev["data"].get("request", {}).get("messages", [])):
            content = msg.get("content") or ""
            if msg.get("role") == "user" and not str(content).startswith("invoke_tool_recovery"):
                return content
    return ""


def compact_data(ev: dict) -> dict:
    kind, data = ev["kind"], ev["data"]
    if kind != "llm-call":
        return data
    slim: dict = {
        "phase": data.get("phase"),
        "method": data.get("method"),
        "usage": data.get("usage"),
    }
    resp = data.get("response") or {}
    if resp.get("tool_calls"):
        slim["response"] = {
            "tool_calls": [
                {
                    "name": t.get("function", {}).get("name"),
                    "arguments": trunc(t.get("function", {}).get("arguments", ""), 200),
                }
                for t in resp["tool_calls"]
            ]
        }
    elif resp.get("content"):
        slim["response"] = {"content": trunc(resp["content"], 500)}
    return slim


def summary_fields(ev: dict) -> list[tuple[str, str]]:
    kind, data = ev["kind"], ev["data"]
    rows: list[tuple[str, str]] = []

    if kind == "llm-call" and data.get("phase") == "orchestration":
        for msg in reversed(data.get("request", {}).get("messages", [])):
            content = msg.get("content") or ""
            if msg.get("role") == "user" and not str(content).startswith("invoke_tool_recovery"):
                rows.append(("User", trunc(content, 120)))
                break
        tool_calls = data.get("response", {}).get("tool_calls") or []
        if tool_calls:
            fn = tool_calls[0].get("function", {})
            rows.append(
                (
                    "Chosen",
                    f"{fn.get('name')}({trunc(fn.get('arguments', ''), 80)})",
                )
            )

    if kind == "tool-call" and data.get("args"):
        rows.append(("Args", trunc(json.dumps(data["args"], ensure_ascii=False), 100)))

    if kind == "llm-call" and data.get("phase") == "capability":
        for msg in data.get("request", {}).get("messages", []):
            if msg.get("role") != "user":
                continue
            content = msg.get("content") or ""
            instr = content.split("--- INPUT ---")[0].strip() if "--- INPUT ---" in content else content[:200]
            rows.append(("Instructions", trunc(instr, 150)))
            rows.append(("Input size", f"{len(content)} chars"))
            break
        out = data.get("response", {}).get("content")
        if out:
            rows.append(("Output", trunc(out, 200)))

    if kind == "llm-call" and data.get("phase") == "synthesis":
        out = data.get("response", {}).get("content")
        if out:
            rows.append(("Answer", out))

    if kind == "tool-call" and data.get("name") == "find_tool":
        query = data.get("args", {}).get("query")
        if query:
            rows.append(("Query", query))

    ref = (data.get("result") or {}).get("ref")
    if ref:
        rows.append(("Ref", ref))

    return rows


def step_title(ev: dict) -> str:
    kind, data = ev["kind"], ev["data"]

    if kind == "llm-turn-start":
        return f"Turn {data.get('turn')} start"
    if kind == "llm-turn":
        usage = data.get("usage", {})
        return (
            f"Turn {data.get('turn')} end · "
            f"{usage.get('promptTokens')}/{usage.get('completionTokens')} tokens"
        )
    if kind == "llm-call":
        phase = data.get("phase", "?")
        usage = data.get("usage", {})
        extra = ""
        tool_calls = data.get("response", {}).get("tool_calls")
        if tool_calls:
            extra = " → " + ", ".join(t.get("function", {}).get("name", "?") for t in tool_calls)
        elif data.get("response", {}).get("content"):
            extra = " → response"
        return f"LLM ({phase}){extra} · {usage.get('promptTokens')}/{usage.get('completionTokens')} tok"
    if kind == "tool-dispatch-start":
        return f"Dispatch · {data.get('name')}"
    if kind == "tool-call":
        name = data.get("name")
        inner = data.get("args", {}).get("name") if name == "invoke_tool" else None
        label = f"{name} → {inner}" if inner else name
        if not data.get("ok"):
            err = ((data.get("result") or {}).get("error") or {}).get("message", "failed")
            return f"{label} ✗ · {trunc(err, 55)}"
        value = (data.get("result") or {}).get("value")
        ref = (data.get("result") or {}).get("ref")
        if isinstance(value, dict) and value.get("bytesWritten"):
            return (
                f"{label} ✓ · {value['bytesWritten']} bytes → "
                f"{trunc(value.get('path', ''), 45)}"
            )
        return f"{label} ✓" + (f" · ref {ref}" if ref else "")
    if kind == "tool-invoked":
        return f"{data.get('name')} · {data.get('duration')}ms · {'ok' if data.get('ok') else 'fail'}"
    if kind == "workflow-start":
        return f"Workflow · {data.get('name')} · depth {data.get('depth', 0)}"
    if kind == "workflow-step-start":
        return f"Step · {data.get('label')} · tool {data.get('tool')}"
    if kind == "workflow-step-end":
        return (
            f"Step end · {data.get('label')} · {data.get('durationMs')}ms · "
            f"{'ok' if data.get('ok') else 'fail'}"
        )
    if kind == "workflow-end":
        return (
            f"Workflow end · {data.get('name')} · {data.get('durationMs')}ms · "
            f"{'ok' if data.get('ok') else 'fail'}"
        )
    if kind == "llm-synthesis-start":
        return "Synthesis start"
    if kind == "llm-synthesis":
        usage = data.get("usage", {})
        return f"Synthesis end · {usage.get('promptTokens')}/{usage.get('completionTokens')} tok"
    if kind == "execution-denied":
        return f"Denied · {data.get('name')} · {trunc(data.get('reason', ''), 50)}"
    if kind == "tool-created":
        return f"Tool created · {data.get('name')}"
    if kind == "tool-rejected":
        return f"Tool rejected · {data.get('name')} · {trunc(data.get('reason', ''), 50)}"
    return kind


class Node:
    __slots__ = ("ev", "children", "depth")

    def __init__(self, ev: dict | None = None, depth: int = 0):
        self.ev = ev
        self.children: list[Node] = []
        self.depth = depth


def build_tree(events: list[dict]) -> list[Node]:
    """Build nested step tree. See nested-flow.md for rules."""
    roots: list[Node] = []
    current_turn: Node | None = None
    current_dispatch: Node | None = None
    current_workflow: Node | None = None
    current_step: Node | None = None

    i = 0
    while i < len(events):
        ev = events[i]
        kind = ev["kind"]

        if kind == "llm-turn-start":
            current_turn = Node(ev=ev, depth=0)
            current_dispatch = None
            current_workflow = None
            current_step = None
            roots.append(current_turn)
            i += 1
            continue

        if kind == "llm-synthesis-start":
            syn = Node(ev=ev, depth=0)
            roots.append(syn)
            i += 1
            while i < len(events):
                syn.children.append(Node(ev=events[i], depth=1))
                if events[i]["kind"] == "llm-synthesis":
                    i += 1
                    break
                i += 1
            continue

        if current_turn is None:
            orphan = Node(ev=ev, depth=0)
            roots.append(orphan)
            i += 1
            continue

        if kind == "tool-dispatch-start":
            disp = Node(ev=ev, depth=1)
            current_turn.children.append(disp)
            current_dispatch = disp
            current_workflow = None
            current_step = None
            i += 1
            continue

        if kind == "workflow-start":
            parent = current_dispatch or current_turn
            wf = Node(ev=ev, depth=parent.depth + 1)
            parent.children.append(wf)
            current_workflow = wf
            current_step = None
            i += 1
            continue

        if kind == "workflow-step-start":
            if current_workflow is None:
                i += 1
                continue
            step = Node(ev=ev, depth=current_workflow.depth + 1)
            current_workflow.children.append(step)
            current_step = step
            i += 1
            continue

        if kind == "workflow-step-end":
            if current_step is not None:
                current_step.children.append(Node(ev=ev, depth=current_step.depth + 1))
                current_step = None
            i += 1
            continue

        if kind == "workflow-end":
            if current_workflow is not None:
                current_workflow.children.append(Node(ev=ev, depth=current_workflow.depth + 1))
                current_workflow = None
                current_step = None
            i += 1
            continue

        target = current_step or current_workflow or current_dispatch or current_turn
        target.children.append(Node(ev=ev, depth=target.depth + 1))
        i += 1

    return roots


def render_flow(roots: list[Node]) -> tuple[str, int]:
    counter = 0

    def render_node(node: Node) -> str:
        nonlocal counter
        if node.ev is None:
            return "".join(render_node(child) for child in node.children)

        counter += 1
        idx = counter
        ev = node.ev
        kind = ev["kind"]
        color = KIND_COLORS.get(kind, "#8b949e")
        fields = summary_fields(ev)
        meta_html = ""
        if fields:
            meta_html = (
                '<dl class="meta-grid">'
                + "".join(f"<dt>{escape(k)}</dt><dd>{escape(str(v))}</dd>" for k, v in fields)
                + "</dl>"
            )
        raw = escape(json.dumps(compact_data(ev), indent=2))
        details = f'<details class="raw"><summary>Raw event</summary><pre>{raw}</pre></details>'
        child_html = "".join(render_node(child) for child in node.children)
        children_block = f'<div class="children">{child_html}</div>' if child_html else ""
        nested = " nested" if node.children else ""

        return f'''<article class="step{nested}" style="--accent:{color}" data-kind="{escape(kind)}">
  <header class="head">
    <span class="num">{idx}</span>
    <span class="badge">{escape(kind)}</span>
    <h3>{escape(step_title(ev))}</h3>
    <time>{escape(fmt_time(ev["ts"]))}</time>
  </header>
  {meta_html}
  {details}
  {children_block}
</article>'''

    html = "".join(render_node(root) for root in roots)
    return html, counter


def flatten_config(obj: dict, prefix: str = "") -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for key, value in obj.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            rows.extend(flatten_config(value, path))
        else:
            if isinstance(value, (list, dict)):
                display = json.dumps(value, ensure_ascii=False)
            else:
                display = str(value)
            rows.append((path, trunc(display, 80)))
    return rows


def render_config_section(config_path: Path | None) -> str:
    if config_path is None:
        return '<p class="config-unknown">Configuration unknown</p>'
    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return f'<p class="config-error">Could not read config: {escape(str(exc))}</p>'

    rows = flatten_config(config)
    body = "".join(
        f"<tr><td><code>{escape(k)}</code></td><td><code>{escape(v)}</code></td></tr>"
        for k, v in rows
    )
    return f'''<h3 class="section-label">Configuration</h3>
<p class="config-source">Source: <code>{escape(config_path.name)}</code></p>
<table class="config-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>{body}</tbody></table>'''


def render_analysis(events: list[dict]) -> str:
    findings: list[tuple[str, str, str]] = []

    failed_tools = [e for e in events if e.get("kind") == "tool-call" and not e.get("data", {}).get("ok")]
    for ev in failed_tools:
        err = (ev.get("data", {}).get("result") or {}).get("error") or {}
        findings.append(
            (
                "Warning",
                f"{ev['ts']} tool-call",
                f"{err.get('kind', 'error')}: {err.get('message', 'failed')}",
            )
        )

    recovery_after_fail = False
    for i, ev in enumerate(events):
        if ev.get("kind") != "tool-call" or ev.get("data", {}).get("ok"):
            continue
        if i + 1 < len(events):
            nxt = events[i + 1]
            if nxt.get("kind") == "llm-turn-start" and nxt.get("data", {}).get("turn", 0) > 0:
                for later in events[i + 1 :]:
                    if later.get("kind") == "tool-call" and later.get("data", {}).get("name") in {
                        "find_tool",
                        "list_tools",
                    }:
                        recovery_after_fail = True
                        findings.append(
                            (
                                "Info",
                                f"{later['ts']} recovery",
                                "Agent recovered from failed invoke_tool via catalog meta-tools",
                            )
                        )
                        break
    if failed_tools and not recovery_after_fail:
        findings.append(
            (
                "Critical",
                failed_tools[0]["ts"],
                "Failed tool call with no subsequent find_tool/list_tools recovery",
            )
        )

    if not findings:
        findings.append(("Info", events[0]["ts"], "No significant issues detected"))

    cards = ""
    for severity, evidence, message in findings:
        cls = severity.lower()
        cards += f'''<article class="finding finding-{cls}">
  <header><span class="severity">{escape(severity)}</span><span class="evidence">{escape(evidence)}</span></header>
  <p>{escape(message)}</p>
</article>'''

    return f'<section class="extra"><h2>Analysis</h2><div class="extra-body">{cards}</div></section>'


def fill_template(template: str, mapping: dict[str, str]) -> str:
    out = template
    for key, value in mapping.items():
        out = out.replace(f"{{{{{key}}}}}", value)
    if "{{" in out:
        missing = sorted({part.split("}")[0] for part in out.split("{{")[1:]})
        raise ValueError(f"Unresolved placeholders: {', '.join(missing)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate nested meta-agent trace HTML")
    parser.add_argument("trace", type=Path, help="Path to .jsonl trace file")
    parser.add_argument("output", type=Path, help="Output .html path")
    parser.add_argument("--config", type=Path, default=None, help="Optional meta-agent config JSON")
    parser.add_argument("--no-analysis", action="store_true", help="Omit analysis section")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent
    template_path = skill_dir / "report-template.html"

    events = load_events(args.trace)
    roots = build_tree(events)
    flow_html, step_count = render_flow(roots)

    user_task = extract_user_task(events)
    config_html = render_config_section(args.config)
    analysis_html = "" if args.no_analysis else render_analysis(events)

    mapping = {
        "SESSION_ID": escape(events[0]["sessionId"]),
        "TRACE_BASENAME": escape(args.trace.name),
        "START_TIME": escape(fmt_time(events[0]["ts"])),
        "END_TIME": escape(fmt_time(events[-1]["ts"])),
        "EVENT_COUNT": str(len(events)),
        "STEP_COUNT": str(step_count),
        "USER_TASK": escape(user_task),
        "FLOW_HTML": flow_html,
        "CONFIG_SECTION_HTML": config_html,
        "ANALYSIS_SECTION_HTML": analysis_html,
    }

    html = fill_template(template_path.read_text(), mapping)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html)
    print(f"Wrote {args.output} ({len(html):,} bytes, {step_count} steps, {len(events)} events)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

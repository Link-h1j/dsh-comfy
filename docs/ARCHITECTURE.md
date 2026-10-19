# dsh-comfy architecture

Two halves communicate over same-origin `fetch`; the browser half never talks to ComfyUI directly and the
host half never renders UI.

```
DSH Web GUI (right-sidebar tab)                     DSH Host (desktop profile)
┌───────────────────────────────┐  same-origin   ┌───────────────────────────────────┐
│ client.js                     │ ─────────────▶ │ /api/dsh-comfy/*  (loopback only) │
│  sidebarRightTabs registration│   fetch/img    │  sources · graph · convert ·      │
│  infinite canvas + run bar    │ ◀───────────── │  runner · start · output proxy    │
└───────────────────────────────┘                └───────────────┬───────────────────┘
                                                                 │ HTTP
                                                         ┌───────▼────────┐
                                                         │    ComfyUI     │ 127.0.0.1:8188/8189
                                                         └────────────────┘
```

## Host routes (`/api/dsh-comfy/*`, loopback-only, JSON)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/status` | – | `{ok, reachable, baseUrl, version?, python?, devices[], queue:{running,pending}, startScriptExists, error?}` |
| POST | `/start` | `{}` | `{ok, started, message}` — detached launch of the configured start script |
| GET | `/workflows` | – | `{ok, sources[], items[]}` |
| GET | `/workflow` | `?id=<WorkflowItem.id>` | `{ok, id, name, source, relPath, kind:'ui'\|'api', graph, warnings[]}` |
| POST | `/run` | `{id, overrides?: {"<nodeId>.<input>": value}}` | `{ok, promptId, number, warnings}` |
| GET | `/progress` | `?promptId=` | `{ok, state:'queued'\|'running'\|'done'\|'error'\|'unknown', elapsedMs, queuePosition?, outputs:OutputRef[], error?}` |
| POST | `/interrupt` | `{}` | `{ok}` |
| POST | `/clear-queue` | `{}` | `{ok}` |
| GET | `/history` | `?limit=10` | `{ok, runs:[{promptId, number, outputs[]}]}` newest-first |
| GET | `/view` | `?filename=&subfolder=&type=` | binary proxy to ComfyUI `/view` |

`WorkflowItem` — `{ id: "<source>::<relPath>", source: 'user'|'workspace'|'templates', relPath, name, kind, size, mtime }`.
`OutputRef` — `{ nodeId, nodeType, kind: 'image'|'video'|'audio'|'3d'|'text'|'file', filename, subfolder, type, url, label }`.

All handlers enforce loopback (`127.0.0.1`/`::1`), an 8 MiB JSON body cap, and path containment for workflow
files (allow-listed source id, no `..`/absolute segments, `realpath` must stay under the source root).

## Graph (the canvas payload)

```ts
type Graph = {
  nodes: Array<{
    id: string; type: string; title: string;
    x: number; y: number; w: number; h: number;      // canvas coordinates
    color?: string | null; mode?: number;             // 0 normal / 2 muted / 4 bypassed
    category?: string; missing?: boolean;             // object_info category / unknown node type
    widgets: Array<{ name: string; kind: 'text'|'number'|'bool'|'combo';
                     value: unknown; options?: unknown[]; min?: number; max?: number;
                     step?: number; multiline?: boolean }>;
    inputs: Array<{ name: string; type: string }>;
    outputs: Array<{ name: string; type: string }>;
  }>;
  edges: Array<{ from: { node: string; slot: number }; to: { node: string; slot: number }; type?: string }>;
  groups: Array<{ title: string; x: number; y: number; w: number; h: number; color?: string }>;
  stats: { nodeCount: number; edgeCount: number; missingTypes: string[]; mutedCount: number };
};
```

- UI workflows keep their stored positions/sizes/groups; widget metadata is joined from `/object_info`.
- API-format workflows are laid out by dependency depth (columns) and rendered with the same node cards.

## UI workflow → API prompt

`lib/convert.js` turns a saved UI graph into the `{class_type, inputs}` map ComfyUI accepts:

1. `widgets_values_named` (modern frontend) is authoritative; legacy files fall back to positional mapping
   guided by `/object_info` (`control_after_generate` and `image_upload` consume an extra slot).
2. Link inputs become `["<originNodeId>", slot]`; `PrimitiveNode` values inline their literal;
   `Reroute` is followed through; muted nodes are dropped; bypassed nodes pass their same-type input through.
3. `run`-time overrides (`"<nodeId>.<inputName>"`) are applied last.
4. Required inputs are validated with human-readable errors (`unknown-node`, `missing-required`, `subgraph-node`).

## Browser half

`client.body.js` is readable CJS source; `tools/build-client.mjs` wraps it as
`window.__ModuleLoader__.load({ id: 'dsh-comfy', factory })` and refuses to write `client.js` when the body
does not compile. The module:

- registers the `comfy` page tab type (`ctx.get('sidebarRightTabs').register`) with a guide entry,
- registers its body into the `sidebar.right.pane.tab` slot under key `dsh-comfy`,
- renders the infinite canvas, params drawer, run bar, results strip, preview overlay and context menus,
- requires only `react` from the module table; all colors come from DSH theme tokens mapped into `--cmf-*`.

Runtime state (open workflow, view transform, local node positions, overrides, results) lives in the tab's
React state and is intentionally memory-only.

## Security notes

- Host routes are loopback-only (`isLoopback`) — the browser UI is same-origin anyway.
- Workflow reads never leave the configured source roots (`realpath` containment).
- The plugin never stops or owns ComfyUI; `/start` only spawns the user's own script detached, idempotently.
- Parameters edited in the panel never rewrite workflow JSON files.

## Verification tooling

| tool | what it does |
|---|---|
| `tools/dev-server.mjs` | mounts `makeRoutes()` on plain `node:http` (8199) — no DSH needed |
| `tools/smoke.mjs` | 90 host assertions incl. a real 64×64 `EmptyImage → SaveImage` round-trip |
| `tools/validate.mjs` | converts every local workflow + all official templates, classifies failures |
| `tools/client-smoke.mjs` | 117 client assertions (fake ctx registration, SSR render, pure helpers, theme guards) |
| `tools/preview.mjs` + `tools/shot.mjs` | jsdom-rendered panel states → headless Edge screenshots |

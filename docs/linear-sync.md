# Linear synchronization

North is the source of truth. Linear is a projection for people who work from
Linear; this adapter does not turn Linear into a second task database and does
not use a model turn.

The transport is the authenticated Codex subscription surface. North opens an
ephemeral Codex app-server session and calls the configured Linear MCP server
directly. The internal capability gate permits only `list_issues`, `get_issue`,
`save_issue`, `list_comments`, and `save_comment`, with their expected schemas
and safety annotations. The same five-name allowlist is enforced again at the
runtime gateway boundary; an extra tool advertised by the server cannot be
called through TypeScript erasure or an untyped caller.

## Commands

```sh
north linear doctor
north linear get MSA-236
north linear import MSA-236 [--owner msa] [--thread <north-id>] [--dry-run]
north linear plan <north-id>
north linear sync <north-id>
north linear sync <north-id> --apply
```

`get`, `--dry-run`, `plan`, and `sync` without `--apply` are read-only. `doctor`
never writes Linear, but it deterministically seeds any missing adapter-owned
schema facts in North. Repeating it is a no-op; conflicting pre-existing schema
facts are reported and never overwritten. Only `sync --apply` writes Linear.
`--server <name>` may select a server during get/import; an existing link
remembers its server, so later plan/sync commands do not depend on ambiguous
auto-discovery.

The mechanical verification sequence is `doctor` → `get` → `import` → `plan` →
`sync --apply` → `plan`. The final plan must report `state: "in-sync"` with no
actions. Repeating `import` must return the same thread and integration-link
identity; if concurrent importers race, the identity lease serializes them and
the later caller reports that it reused the post-lease link. A second
`sync --apply` in that state performs zero Linear writes and zero graph writes.

Every transport-backed command returns a `transportReceipt`. It records the
selected Linear server, ephemeral app-server thread, exact outgoing method
counts, incoming notification counts, and each MCP server/tool/access tuple and
count, plus
`modelTurnsStarted: 0`, `usageEvents: 0`, and
`tokenTotalStatus: "exact-zero-protocol"`. The versioned
`codex-app-server-linear-v1` policy positively allows only `initialize`,
`initialized`, `thread/start`, `mcpServerStatus/list`, and
`mcpServer/tool/call`; its incoming side allows only explicitly reviewed benign
notifications (`mcpServer/startupStatus/updated`,
`remoteControl/status/changed`, and `thread/started`). Unknown methods or
notifications fail closed. Any terminal transport error invalidates the receipt,
including one observed after a successful tool response. This protocol
receipt—not a process-wide account usage sample—is the evidence that the command
used no model turn or model tokens.

The app-server transport parses newline-delimited JSON as raw bytes. UTF-8 is
decoded fatally only after a complete frame is present; a split multibyte
character is preserved, while invalid UTF-8, a line larger than 1 MiB, or any
partial frame at EOF invalidates the session. The byte limit is per line, not
per read buffer, so a large chunk containing many individually bounded frames
is valid. MCP inventory traversal stops at 20 pages or 100 servers and rejects
missing, empty, or repeated cursors.

Import creates one deterministic integration-link entity and either adopts the
explicit North thread or deterministically creates one. The thread retains a
`linear <KEY>` compatibility alias, but aliases are never used as identity or
auto-matched: duplicate historical aliases are common. The canonical reverse
handle is the ref-valued `linear_link @link:...`. Its target is the
fact-bearing integration-link entity, not a thread. Fram validates generic
refs against any fact-bearing entity; North alone applies thread-only rules to
its thread predicates. `north linear doctor` mechanically migrates the one
adapter-owned legacy workaround from `linear_link value_kind literal` to `ref`.

The current Linear MCP response omits native workspace and issue UUIDs. North
therefore records an honest `mcp-bootstrap-v1` connector fingerprint over the
MCP server name, the issue creation timestamp, and its initial key. The key,
team, and workspace slug remain mutable metadata. The first applied sync plants
a `north:thread` managed marker in the Linear description; that exact marker is
the durable backlink after a key, team, or workspace rename. Relocation searches
the visible `North thread @<id>` text, fetches every candidate in full, then
requires exactly one exact hidden marker plus matching creation evidence. The
binding write is mandatory even when an explicitly adopted North thread has no
ordinary field delta. Existing unmanaged description text is retained
byte-for-byte and the managed block is appended exactly once.
Linear issue/comment traversal is bounded independently: 20 pages, 5,000
comments, and 25 fully inspected backlink candidates. Pagination requires a
new non-empty cursor on every continued page.

## Projection policy

North owns the issue title and the marked description block: lifecycle, body,
done bars, evidence, and repositories. North `progress` and `outcome` facts
become marker-deduplicated Linear comments. `learning` remains private by
default. Linear status never invents a North outcome or bar evidence. Duplicate
managed comment markers, multiple markers in one comment, and malformed uses of
the reserved `north:comment` namespace stop both planning and pending-write
recovery before another mutation.

Current graph reads expose progress and learning values without stable fact
event IDs, so their comment identity uses a content-hash compatibility fallback.
Rewording such a fact therefore creates a new projected comment identity.
Supplying durable graph event IDs is a deliberate follow-up rather than being
inferred from list order or mutable content.

At first import, the issue title and description seed a newly created North
thread once. The exact description hash is recorded. The first apply consumes
that unchanged description into one managed block, rather than appending a
duplicate copy. If the description changed between import and first apply, or
already contains an unowned North marker, synchronization stops as a conflict.
After adoption, text outside the managed block is preserved byte-for-byte.

## Conflicts and recovery

Every apply acquires a coordinator lease for the immutable Linear identity.
Renewal is an atomic coordinator operation: it succeeds only for the exact
current holder and expected epoch while the lease remains unexpired, persists a
new expiry, and returns a globally fresh epoch. Any lapse, takeover, stale
epoch, or lost renewal response aborts the caller; it never silently reacquires
and continues. Reads that may paginate or inspect multiple backlink candidates
renew before each provider call.

The production lease TTL is 300 seconds and every app-server request has a hard
20-second timeout. Startup enforces at least a 10× lease-to-call margin (the
current margin is 15×), so one bounded provider call cannot ordinarily consume
the lease it just renewed. A lease cannot cancel an already in-flight external
call; suspension or an extreme clock jump can therefore still let Linear commit
after local expiry. The mandatory post-call renewal then fails, graph
finalization is fenced out, and the persisted intent is left for successor
reconciliation.

Graph assertions made while synchronizing are fenced inside the same
coordinator turn as the mutation. A stale holder therefore cannot publish a
pending intent, receipt, baseline, link fact, or synchronization timestamp
after losing the lease. The bridge also renews on both sides of each Linear
write and before final graph publication.

A local coordinator lease cannot be atomic with a call to an external Linear
server. North closes that unavoidable boundary with a durable protocol. Before
a non-idempotent call, it atomically writes a compact operation intent
containing hashes and operation IDs, never copied issue or comment bodies. If
the Linear call commits and the lease or transport is then lost, the intent
remains. North does not blindly retry an unknown write. A successor reads
Linear and reconciles the intent first:

- if the intended title/description or marked comment is observable, North
  records the receipt and continues;
- if it is not observable, the intent remains and the command refuses a retry;
- the next apply repeats the same reconciliation before doing anything else.

Linear's Markdown round-trip inserts blank lines at a small set of
HTML-comment/heading boundaries inside North's managed scaffold. Issue-write
receipts therefore retain the exact raw payload hash and add a second,
versioned hash that canonicalizes only those known bridge-owned boundaries.
Bytes outside the managed block and bytes inside every managed field remain
exactly hashed. A legacy pending write can be recovered only when the current
local baseline, a reconstruction of the original payload hash, and that same
narrow scaffold receipt all agree; arbitrary whitespace, body, or unmanaged
description drift still fails closed.

Import is crash-healable too. The prepared manifest—deterministic thread ID,
identity evidence, original hashes, and one stable import timestamp—lands before
the remaining link and thread facts. A repeated import fills any missing facts
without creating a second thread. Conflicting or malformed partial state fails
closed.

Remote edits inside North-owned fields are reported as drift/divergence; they
are never timestamp-resolved or overwritten partially. Inspect with `north
linear plan <thread>`. Resolve the conflict deliberately in North or Linear,
then plan again. `north linear doctor` reports OAuth/tool readiness and ensures
the graph's adapter-owned schema-as-facts metadata is seeded. This local
bootstrap is the only doctor mutation; it never writes Linear or starts a model
turn.

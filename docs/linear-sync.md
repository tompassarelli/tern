# Linear synchronization

North is the source of truth. Linear is a projection for people who work from
Linear; this adapter does not turn Linear into a second task database and does
not use a model turn.

The transport is the authenticated Codex subscription surface. North opens an
ephemeral Codex app-server session and calls the configured Linear MCP server
directly. The internal capability gate permits only `list_issues`, `get_issue`,
`save_issue`, `list_comments`, and `save_comment`, with their expected schemas
and safety annotations.

## Commands

```sh
north linear doctor
north linear get MSA-236
north linear import MSA-236 [--owner msa] [--thread <north-id>] [--dry-run]
north linear plan <north-id>
north linear sync <north-id>
north linear sync <north-id> --apply
```

`doctor`, `get`, `--dry-run`, `plan`, and `sync` without `--apply` are read-only.
Only `sync --apply` writes Linear. `--server <name>` may select a server during
get/import; an existing link remembers its server, so later plan/sync commands
do not depend on ambiguous auto-discovery.

Import creates one deterministic integration-link entity and either adopts the
explicit North thread or deterministically creates one. The thread retains a
`linear <KEY>` compatibility alias, but aliases are never used as identity or
auto-matched: duplicate historical aliases are common. The canonical edge is
`linear_link @link:...`.

The current Linear MCP response omits native workspace and issue UUIDs. North
therefore records an honest `mcp-bootstrap-v1` connector fingerprint over the
MCP server name, the issue creation timestamp, and its initial key. The key,
team, and workspace slug remain mutable metadata. The first applied sync plants
a `north:thread` managed marker in the Linear description; that exact marker is
the durable backlink after a key, team, or workspace rename. Relocation searches
the visible `North thread @<id>` text, fetches every candidate in full, then
requires exactly one exact hidden marker plus matching creation evidence.

## Projection policy

North owns the issue title and the marked description block: lifecycle, body,
done bars, evidence, and repositories. North `progress` and `outcome` facts
become marker-deduplicated Linear comments. `learning` remains private by
default. Linear status never invents a North outcome or bar evidence.

At first import, the issue title and description seed a newly created North
thread once. The exact description hash is recorded. The first apply consumes
that unchanged description into one managed block, rather than appending a
duplicate copy. If the description changed between import and first apply, or
already contains an unowned North marker, synchronization stops as a conflict.
After adoption, text outside the managed block is preserved byte-for-byte.

## Conflicts and recovery

Every apply acquires the coordinator's external-resource lease and fences
immediately before each remote call. Before a non-idempotent call, North writes a
compact operation intent containing hashes and operation IDs, never copied issue
or comment bodies. It does not blindly retry an unknown write. Instead it reads
Linear again:

- if the intended title/description or marked comment is observable, North
  records the receipt and continues;
- if it is not observable, the intent remains and the command refuses a retry;
- the next apply repeats the same reconciliation before doing anything else.

Import is crash-healable too. The prepared manifest—deterministic thread ID,
identity evidence, original hashes, and one stable import timestamp—lands before
the remaining link and thread facts. A repeated import fills any missing facts
without creating a second thread. Conflicting or malformed partial state fails
closed.

Remote edits inside North-owned fields are reported as drift/divergence; they
are never timestamp-resolved or overwritten partially. Inspect with `north
linear plan <thread>`. Resolve the conflict deliberately in North or Linear,
then plan again. `north linear doctor` reports OAuth/tool readiness and whether
the graph's schema-as-facts metadata has been seeded; it does not mutate either
store.

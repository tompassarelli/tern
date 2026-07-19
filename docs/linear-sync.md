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
north linear sync <north-id> --apply --expect-plan-hash <hash|none>
```

`get`, `--dry-run`, `plan`, and `sync` without `--apply` are read-only. `doctor`
never writes Linear, but it deterministically seeds any missing adapter-owned
schema facts in North. Repeating it is a no-op; conflicting pre-existing schema
facts are reported and never overwritten. Only `sync --apply` writes Linear.
Import dry-run performs the same read-only schema, identity, prepared-manifest,
requested-thread, and reverse-link preconditions as a real import. It reports
schema/link/thread healing and bounded-receipt compaction separately, and never
calls a partial or compaction-needing binding `reuse-link`.
`--server <name>` may select a server during get/import; an existing link
remembers its server, so later plan/sync commands do not depend on ambiguous
auto-discovery.

The mechanical verification sequence is `doctor` → `get` → `import` → `plan` →
guarded `sync --apply` → `plan`. Supply the exact lowercase SHA-256 hash from
`plan.actions.hash`, or `none` when the plan reports `actions: []`. The final
plan must report `state: "in-sync"` with no actions. Repeating `import` must
return the same thread and integration-link
identity. Import acquires the canonical identity endpoint and then the North
thread endpoint; concurrent callers for either endpoint serialize, and the
later caller either reuses the post-lease link or fails with the conflicting
canonical binding before creating another link. With a canonical bounded
manifest, a second `sync --apply` in that state performs zero Linear writes and
zero graph writes.

### Guarded compare-and-apply

`--expect-plan-hash` is valid only with `sync --apply`. It accepts one exact
64-character lowercase SHA-256 plan hash or the literal `none`; duplicate,
uppercase, shortened, extended, or otherwise malformed values fail before a
gateway opens. After acquiring the established bootstrap/identity/thread lease
scope, guarded apply freshly reads both North and Linear and compares
`planned.plan?.hash ?? "none"` with the caller's expectation before any
bridge-owned graph mutation or Linear write. A mismatch reports both values and
releases the leases without reserving, repairing, finalizing, or calling
`save_issue`/`save_comment`.

Guarded mode never recovers an existing pending intent: it refuses before the
fresh plan comparison or provider read. Run the ordinary recovery-aware
`sync --apply` deliberately, inspect a new plan, and only then return to guarded
apply. A matching nonempty hash retains the immediate remote issue/comment
preconditions and aggregate post-apply verification. Matching `none` requires
an in-sync reconciliation and returns `writes: 0`, `state: "in-sync"`, and
`planHash: null`; its transport calls are read-only and its receipt still proves
zero model turns, usage events, and tokens. Unguarded `sync --apply` remains the
backward-compatible recovery and one-shot surface.

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
Entering client cleanup is not itself shutdown evidence. A provider process
that exits after a valid tool response still invalidates the receipt; only a
signal delivered to a demonstrably live child makes termination
client-initiated. Cleanup drains stdout and escalates from SIGTERM to SIGKILL
within fixed bounds. A cleanup error is reported when the command otherwise
succeeded, but never replaces the command's primary failure.

The app-server transport parses newline-delimited JSON as raw bytes. UTF-8 is
decoded fatally only after a complete frame is present; a split multibyte
character is preserved, while invalid UTF-8, a line larger than 1 MiB, or any
partial frame at EOF invalidates the session. The byte limit is per line, not
per read buffer, so a large chunk containing many individually bounded frames
is valid. Every JSON authority boundary uses the same bounded strict parser:
duplicate object keys, ill-formed Unicode, excessive nesting, and excessive
node counts fail closed. This applies both to raw app-server frames and to JSON
embedded in MCP text results; a permissive second parse cannot reinterpret a
frame that passed the first boundary. `isError`, when present, must be a
boolean. Outgoing JSONL requests have the same 1 MiB ceiling and are fully
serialized before the provider call; an invalid or oversized request cannot
create a provider-side effect. MCP inventory traversal stops at 20 pages or 100
servers and rejects missing, empty, or repeated cursors. Issue and comment
pagination likewise rejects cursor loops, inconsistent continuation state, and
duplicate comment identities across pages.

Import creates one deterministic integration-link entity and either adopts the
explicit North thread or deterministically creates one. The thread retains a
`linear <KEY>` compatibility alias, but aliases are never used as identity or
auto-matched: duplicate historical aliases are common. The canonical reverse
handle is the ref-valued `linear_link @link:...`. Its target is the
fact-bearing integration-link entity, not a thread. Fram validates generic
refs against any fact-bearing entity; North alone applies thread-only rules to
its thread predicates. `north linear doctor` mechanically migrates the one
adapter-owned legacy workaround from `linear_link value_kind literal` to `ref`.

The identity lease key is the URI-component-encoded canonical identity key used
by `linkSubject`: native identity is exactly workspace UUID + issue UUID, with
both UUIDs validated and normalized to lowercase and no MCP server alias; the
bootstrap identity includes the connector because the connector is part of
that fallback identity. A fallback import first acquires the
connector-plus-canonical-creation-time bootstrap-evidence lease, then the
identity and thread leases. The thread lease key is the
URI-component-encoded normalized North thread ID. Every writer acquires them in
the fixed order `bootstrap evidence` (when needed), `identity`, then `thread`.
Opaque provider tokens are never whitespace-normalized: padded IDs, cursors,
keys, timestamps, owners, and workspace selectors are rejected rather than
silently changing identity or authority. UUID intake admits either hex case,
then stores the canonical lowercase spelling.
Authority duplicated by the live issue document must agree before a lease is
requested: a non-UUID `id` must equal `identifier`, top-level `teamId` must
equal nested `team.id`, and the issue identifier in a canonical Linear URL
must equal the chosen key. Linear URLs with credentials, non-default ports, or
malformed or percent-encoded workspace authority are rejected.

The current Linear MCP response omits native workspace and issue UUIDs. North
therefore creates `mcp-bootstrap-v2` identities from the connector and
canonical creation instant only. Before either a v1 or v2 identity can reserve
a thread, both versions contend for one durable
`@linear-bootstrap:<sha256(connector,createdAt)>` evidence entity. Its
canonical `bootstrap_election` literal atomically binds connector, creation
time, immutable initial key, canonical link, and linked thread in one
coordinator global-version compare-and-set. The individual facts are
query-friendly projections that only that exact election may heal. A crash
after any projection prefix therefore cannot let another key, thread, or
v1/v2 identity steal the winner. Legacy evidence without the atomic literal is
adopted only when all six old projection facts are already complete and
coherent; a partial legacy prefix fails closed. A second issue with the same
connector and creation instant fails closed; a changed key is accepted only
when the issue carries the exact structurally valid managed marker for the
already linked thread. Legacy
`mcp-bootstrap-v1` subjects (whose fingerprint also included the initial key)
remain canonical when the current key derives that exact subject or the exact
marker proves the old thread-to-link handle. North never creates a parallel v2
subject to “migrate” a proven v1 link. If native UUID evidence later appears,
the already proven bootstrap binding remains canonical instead of creating a
second UUID link.
Without the marker, a renamed v1 match on connector plus creation instant is an
ambiguity and fails closed. The key,
team, and workspace slug remain mutable metadata. The first applied sync plants
a `north:thread` managed marker in the Linear description; that exact marker is
the durable backlink after a key, team, or workspace rename. Relocation searches
the visible `North thread @<id>` text, fetches every candidate in full, then
requires exactly one exact hidden marker plus matching creation evidence. The
binding write is mandatory even when an explicitly adopted North thread has no
ordinary field delta. Existing unmanaged description text is retained
byte-for-byte and the managed block is appended exactly once.
Backlink search begins only after method-aware structural not-found evidence
from `get_issue`: either the reviewed typed error envelope or the connector's
exact four-field JSON error (`invalid_request`, status 400, bounded request ID,
and exact missing-issue message), or after a successful stored-key read proves
that identity/marker evidence
moved. Provider error prose is never classified. A timeout, outage, generic MCP
failure, or RPC failure therefore remains one failed stored-key read and cannot
fan out into a backlink search.
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
After adoption, a payload is constructed by preserving text outside the
managed block byte-for-byte from the remote snapshot. Immediately before
persisting write intent, apply re-reads the issue and refuses the prepared
payload if that normalized snapshot changed. Linear's `save_issue` surface does
not expose a version/`updatedAt` compare-and-set condition, so an edit arriving
after that final read but before the save can still race and be overwritten.
The bridge narrows and reports the detectable interval; it cannot claim
provider-side write exclusion that Linear does not supply.

## Conflicts and recovery

Every import/apply acquires coordinator leases for the immutable Linear
identity and canonical North thread, identity first. Bootstrap imports first
acquire the shared connector-plus-creation-time evidence lease, giving the
global order `bootstrap evidence` → `identity` → `thread`. After the applicable
leases are held, the bridge re-reads and exact-compares link subject, canonical
identity key, thread, stored server, and bootstrap evidence before pending
recovery, graph writes, or remote work. A changed observation aborts rather
than letting a lease for link A authorize work through link or gateway B.
Renewal is an atomic coordinator operation: it succeeds only for the exact
current holder and expected epoch while the lease remains unexpired, persists a
new expiry, and returns a globally fresh epoch. Any lapse, takeover, stale
epoch, or lost renewal response aborts the caller; it never silently reacquires
and continues. Both endpoint leases are renewed around load-bearing boundaries,
including every provider call. Cleanup releases thread then identity and never
the bootstrap-evidence lease when held, and never masks the operation's primary
failure; a cleanup failure still fails an otherwise successful operation.

Expiring leases alone would not make cross-endpoint facts invariant. Before any
import data/schema mutation, North therefore commits durable reservations by
coordinator global-version compare-and-set. Bootstrap identities first elect
the shared five-field evidence envelope described above. The winning identity
then commits
`@link:<canonical-identity> linked_thread @<thread>` while validating, from the
same graph version, every Linear-link claimant for that thread (including
partial links without `kind`) and the thread's `linear_link` pointer. The
commit is atomically fenced by the exact identity token. This enforces one
bootstrap evidence ↔ one canonical link and one identity ↔ one thread across
crashes. An implicitly minted thread may still be absent after a crash, but
its deterministic ID is already owned by the reservation; a later import heals
that same thread, while another identity is refused. Link facts fence on the
identity endpoint, bootstrap facts on the evidence endpoint, and thread/apply
transaction state on the thread endpoint. Every operation retains all
applicable leases until reverse-order release.

The durable reservation deliberately treats the identity fence as its ownership
authority; the thread lease provides transaction exclusion. In the narrow race
where the thread lease is taken after the final dual renewal but before the
identity-fenced compare-and-set, the reservation may win and then the mandatory
post-commit dual renewal aborts the stale caller. Nothing after the reservation
(schema, link/thread projection, pending state, or Linear mutation) may run.
That partial reservation is authoritative and healable only by the same
identity; a competing identity does not steal it merely because it won the
short-lived thread lease. This winner bias is intentional and deterministic.

The production lease TTL is 300 seconds and every app-server request has a hard
20-second timeout. Startup enforces at least a 10× lease-to-call margin (the
current margin is 15×), so one bounded provider call cannot ordinarily consume
the lease it just renewed. A lease cannot cancel an already in-flight external
call; suspension or an extreme clock jump can therefore still let Linear commit
after local expiry. The mandatory post-call renewal then fails, graph
finalization is fenced out, and the persisted intent is left for successor
reconciliation.

Graph assertions made while synchronizing are fenced inside the same
coordinator turn as the mutation. Together with the durable identity/thread
reservation, a stale holder therefore cannot publish a
pending intent, receipt, baseline, link fact, or synchronization timestamp
after losing the authorizing endpoint. The bridge also renews both endpoints on both sides of each Linear
write and before final graph publication.
Fenced values travel to the local lease helper over private stdin, never argv,
environment variables, or temporary files. Caller and helper both enforce one
160 KiB UTF-8 byte ceiling—above Linux's per-argument ceiling, while a
worst-case escaped EDN value plus bounded metadata remains under Fram's 1 MiB
request-line limit. The shared coordinator client also measures the actual
serialized request and rejects an oversized line before connecting. Helper stderr is drained
but never retained or surfaced, and helper failures use fixed diagnostics so
private thread or manifest content cannot escape through process errors.

A local coordinator lease cannot be atomic with a call to an external Linear
server. North closes that unavoidable boundary with a durable protocol. Before
a non-idempotent call, it first constructs and validates the complete provider
request, including live tool-schema validation and exact transport
serialization. At gateway discovery, North recursively audits the advertised
JSON Schema dialect; an assertion keyword it does not implement rejects the
gateway instead of being ignored. Every admitted constraint is then enforced
during preparation. Only a dispatchable prepared call may cause North to
atomically write an exact operation-specific intent. Deterministic
construction, validation, or serialization failure therefore leaves no pending
intent and makes no provider call. Once dispatch begins, any failure is
observationally unknown: the intent remains for successor reconciliation and is
never erased on the strength of a local exception. The intent contains
operation IDs and content hashes, never copied issue or comment bodies. An issue
intent also carries the complete expected baseline snapshot—identity, thread
ID, all per-field hashes, and its aggregate hash.
That full snapshot is recovery-critical because a successor must advance the
same baseline after observing the remote write; it is more than one hash while
still containing no raw North field content. A comment intent carries its body
hash plus kind/source identity, allowing the managed marker to be recomputed
against the linked thread rather than trusted from stored text. If the Linear
call commits and the lease or transport is then lost, the intent remains. North
does not blindly retry an unknown write. A successor reads Linear and reconciles
the intent first:

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

Confirmed operation receipts are diagnostic history, not a replay dependency.
The manifest retains the newest 32 by the deterministic
`(confirmedAt, operation-key)` order. Every legacy entry is validated before
compaction; malformed timestamps or shapes fail closed rather than disappearing.
This makes cumulative manifest serialization linear instead of quadratic.
`sync --apply` persists compaction under the dual-endpoint lease scope and
thread fence even when the remote plan is already a no-op; pending-write
recovery remains independent of evicted receipts.

Import is crash-healable too. Native imports begin with the atomic
`linked_thread` reservation. Both bootstrap versions begin with the shared
five-field evidence election and same-winner projection healing, then reserve
`linked_thread`. The prepared manifest records the deterministic thread ID,
exact identity evidence, original hashes, and one stable import timestamp
before the remaining link and thread facts. The manifest parser is recursively
exact: unknown, missing, or malformed baseline, identity, hash, evidence,
pending, or receipt fields fail closed. Stored bootstrap fingerprints are
recomputed from their evidence rather than trusted as an independent
authority. A repeated import fills any missing facts without creating a second
thread. Conflicting or malformed partial state fails closed.

Normal apply work reads the comment corpus once to plan. Before persisting each
comment intent, apply re-reads the full remote issue-and-comment view, confirms
that the issue key is unchanged, and checks the exact planned precondition:
the marker is still absent for a create, or the same comment id still carries
the planned normalized-body hash for an update. After dispatch, it re-reads the
full comment corpus again and accepts the mutation only when that observation
contains one exact managed marker and body. The `save_comment` response is never
commit proof, and a lost or malformed response follows the same observation
path without retrying a possibly committed write. Multi-comment applies
therefore trade additional deterministic reads for per-mutation stale-plan and
ambiguous-outcome protection.

Remote edits observed during planning or the immediate pre-write re-read are
reported as drift/divergence; they are never timestamp-resolved or partially
merged. Inspect with `north linear plan <thread>`. Resolve the conflict
deliberately in North or Linear, then plan again. Because Linear exposes no
conditional save, the final read-to-save interval remains an explicit residual
race: a remote edit after the precondition read can still be overwritten without
provider-side conflict evidence. If it lands after North's save, the post-write
read refuses confirmation but cannot undo either mutation.
After every individually confirmed write in a multi-operation apply, North
re-reads the complete issue, comment corpus, and North projection under the
endpoint leases. It advances the aggregate baseline and reports `in-sync` only
when that final observation has no conflicts and no remaining actions. A change
to an earlier confirmed field/comment, or to North itself, while a later write
is running therefore leaves the confirmed per-operation receipts intact but
fails the aggregate claim; the next plan shows the exact remaining drift.

`north linear doctor` reports OAuth/tool
readiness and ensures the graph's adapter-owned schema-as-facts metadata is
seeded. This local bootstrap is the only doctor mutation; it never writes
Linear or starts a model turn.

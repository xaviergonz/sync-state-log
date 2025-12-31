<p align="center">
  <img src="./logo.png" height="220" />
</p>
<p align="center">
  <i>State synchronization log for collaborative applications. <b>Validate every change before it happens.</b></i>
</p>

<p align="center">
  <a aria-label="NPM version" href="https://www.npmjs.com/package/state-sync-log">
    <img src="https://img.shields.io/npm/v/state-sync-log.svg?style=for-the-badge&logo=npm&labelColor=333" />
  </a>
  <a aria-label="License" href="./LICENSE">
    <img src="https://img.shields.io/npm/l/state-sync-log.svg?style=for-the-badge&labelColor=333" />
  </a>
  <a aria-label="Types" href="./packages/state-sync-log/tsconfig.json">
    <img src="https://img.shields.io/npm/types/state-sync-log.svg?style=for-the-badge&logo=typescript&labelColor=333" />
  </a>
  <br />
  <a aria-label="CI" href="https://github.com/xaviergonz/state-sync-log/actions/workflows/main.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/xaviergonz/state-sync-log/main.yml?branch=master&label=CI&logo=github&style=for-the-badge&labelColor=333" />
  </a>
  <a aria-label="Codecov" href="https://codecov.io/gh/xaviergonz/state-sync-log">
    <img src="https://img.shields.io/codecov/c/github/xaviergonz/state-sync-log?token=6MLRFUBK8V&label=codecov&logo=codecov&style=for-the-badge&labelColor=333" />
  </a>
</p>

## The Problem with Standard CRDTs

Tools like Yjs and Automerge are amazing for text editing because **they never reject a change**—they just merge everything.

But for **business applications**, most often than not we have rules where "merging everything" can result in a bug. For example, if you have a "WIP Limit" of 3 tasks in a Kanban board and users drag two tasks in at once, you end up with 4 tasks.

## The Solution: state-sync-log

`state-sync-log` is a **Validated Replicated State Machine**. It uses the same robust technology as Yjs in its core (networking, offline support), but it fundamentally changes the rules:

**Every transaction is validated against your business logic before it is applied.**

If a peer sends an invalid transaction your clients **reject it strictly and deterministically**, even when the change itself was made while offline.

### Comparison

| Feature | state-sync-log | Standard CRDTs (Yjs, Automerge) |
| :--- | :---: | :---: |
| **Conflict Strategy** | 🫸 **Reject Invalid Changes** | 🔀 **Merge Everything** |
| **Data Model** | Plain JSON | Specialized Types (Y.Map, Y.Array) |
| **Validation** | ✅ First-class citizen | ❌ Not possible (by design) |
| **Best For** | Business logic, Forms, Games, CRUD, Complex editors | Text editing, Drawing, Notes |

---

## Example: Kanban Board with WIP Limits

Imagine a Kanban board where you strictly enforce a limit of **3 tasks** in the "Doing" column.

```ts
import { createStateSyncLog } from "state-sync-log"
import * as Y from "yjs"

type Task = { id: string; title: string; status: "todo" | "doing" | "done" }
type State = { tasks: Task[] }

// 1. Define your business rules
const validate = (state: State) => {
  // RULE: Cannot have more than 3 tasks in 'doing'
  const doingCount = state.tasks.filter(t => t.status === "doing").length
  if (doingCount > 3) return false

  // RULE: Tasks must always have a title
  if (state.tasks.some(t => t.title.trim() === "")) return false

  return true
}

// 2. Initialize the log
const log = createStateSyncLog<State>({
  yDoc: new Y.Doc(),
  validate,
  // ... other options
})

// 3. Try to move a 4th task to "doing"
// If another user already filled the slot, this operation
// will be REJECTED on all clients (including this one).
log.emit([
  { kind: "set", path: ["tasks", 3], key: "status", value: "doing" }
])
```

## Features

- 🛡️ **Bulletproof Validation**: Define a single `(state) => boolean` function. If it returns false, the transaction never happened.
- ⏭️ **Replayable History**: Since it's an event log, you can replay history to see exactly *how* a state was reached (up to the nearest checkpoint).
- 🏎️ **Optimistic UI**: Changes apply instantly locally. If they are later rejected (due to a conflict with a remote peer), the state automatically rolls back.
- 📦 **Plain JSON**: Work with standard JS objects and arrays. No need to learn `ymap.get('foo')` syntax.
- 🔌 **Network Agnostic**: Works with any Yjs provider (WebSockets, WebRTC, IndexedDB).
- 💾 **Storage Efficient**: Built-in compaction and retention policies keep your data small and fast.

## Contents

- [Installation](#installation)
- [Quickstart](#quickstart)
- [API Reference](#api-reference)
- [Operations](#operations)
- [Gotchas & Limitations](#gotchas--limitations)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
npm install state-sync-log
# or
pnpm add state-sync-log
# or
yarn add state-sync-log
```

## Storage Efficiency

Since this is an append-only log, you might worry about it growing forever. We solved that.

### 🗜️ Automatic Compaction & Retention

`state-sync-log` can periodically be asked to compact the log into a **snapshot checkpoint**.

- **Checkpoints:** New peers just load the latest snapshot + recent ops. Fast load times!
- **Retention Window:** Old transaction history is automatically pruned after a set time (recommended: 2 weeks).
- **Result:** You get a full audit trail for recent history, without unboundedly growing storage.

## Integration with MobX, Signals, etc

You don't have to replace your existing state manager. `state-sync-log` is designed to drive them.

Using `applyOps`, you can surgically apply updates to **MobX**, **Preact Signals**, or any mutable store:

```ts
import { applyOps } from "state-sync-log"
import { observable } from "mobx"

// 1. Create your mutable MobX store (init with current state)
const store = observable(log.getState())

// 2. Sync it!
log.subscribe((newState, appliedOps) => {
  // Apply ONLY the changes (efficient!)
  applyOps(appliedOps, store)
})
```

## API Reference

### `createStateSyncLog(options)`

Initializes the synchronization log.

```ts
import { createStateSyncLog } from "state-sync-log"

const log = createStateSyncLog<State>({
  yDoc: new Y.Doc(),
  validate: (state) => state.inventory >= 0
})
```

**Options:**

| Option | Type | Description |
| --- | --- | --- |
| `yDoc` | `Y.Doc` | **Required.** The Yjs document instance. |
| `validate` | `(state: State) => boolean` | **Required.** The gatekeeper function. If it returns `false`, the transaction is dropped. |
| `clientId` | `string` | Optional unique ID. Auto-generated if omitted. |
| `retentionWindowMs` | `number` | Time to keep transaction history before pruning (recommended: 2 weeks). Helps keep storage small. |

### `StateSyncLogController`

The object returned by `createStateSyncLog`.

#### `getState(): State`

Returns the current, validated state. This is an immutable snapshot.

#### `emit(ops: Op[]): void`

Propose a change. The change applies optimistically but may be reverted if it conflicts with a remote change that renders it invalid.

#### `subscribe(callback): UnsubscribeFn`

Listen for state changes.

```ts
log.subscribe((newState, appliedOps) => {
  render(newState)
})
```

#### `reconcileState(targetState: State): void`

Automatically calculates the operations needed to turn the current state into `targetState` and emits them. Great for "Reset to Default" features.

#### `compact(): void`

Manually triggers a checkpoint. This compresses the history into a single snapshot to save memory and load time.

#### `dispose(): void`

Stop listening and cleanup.

## Operations

These are the atomic building blocks of your transactions.

### `set` (Objects)

Sets a property on an object.

```ts
{ kind: "set", path: ["users", "u1"], key: "name", value: "Alice" }
```

### `delete` (Objects)

Removes a property (equivalent of setting a property to `undefined`).

```ts
{ kind: "delete", path: ["users", "u1"], key: "avatarUrl" }
```

### `splice` (Arrays)

Insert, remove, or replace items in an array.

```ts
// Remove 1 item at index 0, insert "New Item"
{ kind: "splice", path: ["todoList"], index: 0, deleteCount: 1, inserts: ["New Item"] }
```

### `addToSet` (Arrays)

Adds an item only if it doesn't exist (like a Set).

```ts
{ kind: "addToSet", path: ["tags"], value: "urgent" }
```

### `deleteFromSet` (Arrays)

Removes an item if it exists.

```ts
{ kind: "deleteFromSet", path: ["tags"], value: "deprecated" }
```

## Gotchas & Limitations

1. **Validation must be deterministic:** Your `validate` function must return the same result for the same state input (deterministic). Don't check `Date.now()` or make API calls inside it.
2. **Not for Text:** Do not use this for collaborative text editing (Google Docs style). Use standard Y.Text for that; you can mix standard Yjs and `state-sync-log` in the same application!

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).

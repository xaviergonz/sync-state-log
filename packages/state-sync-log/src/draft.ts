import { failure } from "./error"
import type { JSONObject, JSONRecord, JSONValue, Path } from "./json"
import type { Op, ValidateFn } from "./operations"
import { deepEqual, isObject } from "./utils"

/**
 * A draft context for copy-on-write immutable updates.
 *
 * This provides Immer/Mutative-like semantics without the proxy overhead:
 * - The original base state is never mutated
 * - Objects are cloned lazily on first mutation (copy-on-write)
 * - Once an object is cloned ("owned"), it can be mutated directly
 * - If no changes are made, the original reference is preserved (structural sharing)
 */
export interface DraftContext<T extends JSONObject> {
  /** The current root (may be the original base or a cloned version) */
  root: T
  /** The original base state (never mutated) */
  base: T
  /** Set of objects that have been cloned and are safe to mutate */
  ownedObjects: WeakSet<object>
  /** Optimization: fast check if root is already owned */
  isRootOwned: boolean
}

/**
 * Creates a new draft context from a base state.
 * The base state will never be mutated.
 */
export function createDraft<T extends JSONObject>(base: T): DraftContext<T> {
  return {
    root: base,
    base,
    ownedObjects: new Set(),
    isRootOwned: false,
  }
}

/**
 * Checks if the draft was modified (root !== base).
 */
export function isDraftModified<T extends JSONObject>(ctx: DraftContext<T>): boolean {
  return ctx.root !== ctx.base
}

function shallowClone<T extends object>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.slice() as unknown as T
  }
  const clone = {} as T
  const keys = Object.keys(obj)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    ;(clone as any)[key] = (obj as any)[key]
  }
  return clone
}

/**
 * Ensures an object is owned (cloned if necessary) and returns the owned version.
 * Also updates the parent to point to the cloned child.
 */
function ensureOwned<T extends JSONObject>(
  ctx: DraftContext<T>,
  parent: JSONObject,
  key: string | number,
  child: JSONRecord | JSONValue[]
): JSONRecord | JSONValue[] {
  if (ctx.ownedObjects.has(child)) {
    return child
  }
  const cloned = shallowClone(child)
  ;(parent as any)[key] = cloned
  ctx.ownedObjects.add(cloned)
  return cloned
}

/**
 * Ensures all objects along the path are owned (cloned if necessary).
 * Returns the container at the end of the path.
 * Throws if the path is invalid.
 */
function ensureOwnedPath<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path
): JSONRecord | JSONValue[] {
  // Ensure root is owned first
  if (!ctx.isRootOwned) {
    ctx.root = shallowClone(ctx.root as unknown as object) as T
    ctx.ownedObjects.add(ctx.root)
    ctx.isRootOwned = true
  }

  if (path.length === 0) {
    return ctx.root
  }

  let current: JSONRecord | JSONValue[] = ctx.root

  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    const isArrayIndex = typeof segment === "number"

    // Validate container type
    if (isArrayIndex) {
      if (!Array.isArray(current)) {
        failure(`Expected array at path segment ${segment}`)
      }
      if (segment < 0 || segment >= current.length) {
        failure(`Index ${segment} out of bounds`)
      }
    } else {
      if (!isObject(current) || Array.isArray(current)) {
        failure(`Expected object at path segment "${segment}"`)
      }
      if (!(segment in current)) {
        failure(`Property "${segment}" does not exist`)
      }
    }

    const child: JSONValue = (current as any)[segment]

    // Validate child is traversable
    if (child === null || typeof child !== "object") {
      failure(`Cannot traverse through primitive at path segment ${segment}`)
    }

    // Ensure child is owned and continue
    current = ensureOwned(ctx, current, segment, child as JSONRecord | JSONValue[])
  }

  return current
}

/**
 * Applies a single "set" operation to the draft with copy-on-write.
 */
export function draftSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  key: string,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (Array.isArray(container)) {
    failure("set requires object container")
  }
  ;(container as JSONRecord)[key] = value
}

/**
 * Applies a single "delete" operation to the draft with copy-on-write.
 */
export function draftDelete<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  key: string
): void {
  const container = ensureOwnedPath(ctx, path)
  if (Array.isArray(container)) {
    failure("delete requires object container")
  }
  delete (container as JSONRecord)[key]
}

/**
 * Applies a single "splice" operation to the draft with copy-on-write.
 */
export function draftSplice<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  index: number,
  deleteCount: number,
  inserts: readonly JSONValue[]
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("splice requires array container")
  }
  const safeIndex = Math.min(index, container.length)
  if (inserts.length === 0) {
    container.splice(safeIndex, deleteCount)
  } else if (inserts.length === 1) {
    container.splice(safeIndex, deleteCount, inserts[0])
  } else {
    container.splice(safeIndex, deleteCount, ...inserts)
  }
}

/**
 * Applies a single "addToSet" operation to the draft with copy-on-write.
 */
export function draftAddToSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("addToSet requires array container")
  }
  if (!container.some((item) => deepEqual(item, value))) {
    container.push(value)
  }
}

/**
 * Applies a single "deleteFromSet" operation to the draft with copy-on-write.
 */
export function draftDeleteFromSet<T extends JSONObject>(
  ctx: DraftContext<T>,
  path: Path,
  value: JSONValue
): void {
  const container = ensureOwnedPath(ctx, path)
  if (!Array.isArray(container)) {
    failure("deleteFromSet requires array container")
  }
  // Remove all matching items (iterate backwards to avoid index shifting)
  for (let i = container.length - 1; i >= 0; i--) {
    if (deepEqual(container[i], value)) {
      container.splice(i, 1)
    }
  }
}

/**
 * Applies a single operation to the draft with copy-on-write.
 */
export function applyOpToDraft<T extends JSONObject>(ctx: DraftContext<T>, op: Op): void {
  switch (op.kind) {
    case "set":
      draftSet(ctx, op.path, op.key, op.value)
      break
    case "delete":
      draftDelete(ctx, op.path, op.key)
      break
    case "splice":
      draftSplice(ctx, op.path, op.index, op.deleteCount, op.inserts)
      break
    case "addToSet":
      draftAddToSet(ctx, op.path, op.value)
      break
    case "deleteFromSet":
      draftDeleteFromSet(ctx, op.path, op.value)
      break
    default:
      throw failure(`Unknown operation kind: ${(op as any).kind}`)
  }
}

/**
 * Applies one or more transactions to a base state immutably.
 *
 * Key benefits over Mutative/Immer:
 * - No proxy overhead - direct object access and copy-on-write cloning
 * - Structural sharing - unchanged subtrees keep their references
 * - Zero-copy on failure - if validation fails, returns original base unchanged
 * - Efficient batch processing - reuses draft context across transactions
 *
 * @param base - The base state (never mutated)
 * @param txs - Array of transactions (each tx is a list of operations)
 * @param validateFn - Optional validation function (applied per-tx)
 * @returns The final state after all valid transactions are applied
 */
export function applyTxsImmutable<T extends JSONObject>(
  base: T,
  txs: readonly { ops: readonly Op[] }[],
  validateFn?: ValidateFn<T>
): T {
  if (txs.length === 0) return base

  // Create a single draft context for all transactions
  const ctx = createDraft(base)
  let anyTxApplied = false

  for (const tx of txs) {
    // Save current root in case we need to revert this tx
    const rootBeforeTx = ctx.root

    try {
      // Apply all ops in this tx
      for (const op of tx.ops) {
        applyOpToDraft(ctx, op)
      }

      // Validate if needed
      if (validateFn && !validateFn(ctx.root)) {
        // Validation failed - revert to state before this tx
        // Since we use COW, rootBeforeTx still has the old state
        ctx.root = rootBeforeTx
      } else {
        // Transaction succeeded (validation passed or not needed)
        anyTxApplied = true
      }
    } catch {
      // Operation failed - revert to state before this tx
      ctx.root = rootBeforeTx
    }
  }

  // If no transactions were applied, return the original base unchanged
  // This preserves reference identity when all txs fail validation
  return anyTxApplied ? ctx.root : base
}

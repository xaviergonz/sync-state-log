import { create } from "mutative"
import { failure } from "./error"
import { JSONObject, JSONValue, Path } from "./json"
import { deepClone, deepEqual, isObject } from "./utils"

/**
 * Supported operations.
 * Applied sequentially within a tx.
 */
export type Op =
  | { kind: "set"; path: Path; key: string; value: JSONValue }
  | { kind: "delete"; path: Path; key: string }
  | { kind: "splice"; path: Path; index: number; deleteCount: number; inserts: JSONValue[] }
  | { kind: "addToSet"; path: Path; value: JSONValue }
  | { kind: "deleteFromSet"; path: Path; value: JSONValue }

/**
 * Validation function type.
 *
 * Rules:
 * - Validation MUST depend only on candidateState (and deterministic code).
 * - Validation runs once per tx, after all ops apply.
 * - If validation fails, the x is rejected (state reverts to previous).
 * - If no validator is provided, validation defaults to true.
 *
 * IMPORTANT: Validation outcome is **derived local state** and MUST NOT be replicated.
 * All clients MUST use the same validation logic to ensure consistency.
 */
export type ValidateFn<State extends JSONObject> = (candidateState: State) => boolean

/**
 * Resolves a path within the state.
 * Throws if any segment is missing or has wrong type.
 */
function resolvePath(state: JSONObject, path: Path): JSONValue {
  let current: JSONValue = state
  for (const segment of path) {
    if (typeof segment === "string") {
      if (!isObject(current) || Array.isArray(current)) {
        failure(`Expected object at path segment "${segment}"`)
      }
      if (!(segment in current)) {
        failure(`Property "${segment}" does not exist`)
      }
      current = current[segment]
    } else {
      if (!Array.isArray(current)) {
        failure(`Expected array at path segment ${segment}`)
      }
      if (segment < 0 || segment >= current.length) {
        failure(`Index ${segment} out of bounds`)
      }
      current = current[segment]
    }
  }
  return current
}

/**
 * Applies a single operation.
 * (Reference implementation for standard JSON-patch behavior)
 */
function applyOp(state: JSONObject, op: Op): void {
  // Special case: if path is empty, we can't resolve "container".
  // The caller must handle root-level replacement if necessary, but
  // standard Ops usually act ON a container.
  // Exception: if we act on root, handle explicitly or assume path length > 0.
  // For this spec, Ops modify *fields* or *indices*.
  // If path is empty, it means we are acting ON the root object itself?
  // The spec's "set" example: container[op.key] = op.value.
  // This implies we resolve path to get the PARENT container.

  const container = resolvePath(state, op.path)

  switch (op.kind) {
    case "set":
      if (!isObject(container) || Array.isArray(container)) {
        failure("set requires object container")
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(container as any)[op.key] = deepClone(op.value)
      break

    case "delete":
      if (!isObject(container) || Array.isArray(container)) {
        failure("delete requires object container")
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (container as any)[op.key]
      break

    case "splice": {
      if (!Array.isArray(container)) {
        failure("splice requires array container")
      }
      const safeIndex = Math.min(op.index, container.length)
      container.splice(safeIndex, op.deleteCount, ...op.inserts.map((v) => deepClone(v)))
      break
    }

    case "addToSet":
      if (!Array.isArray(container)) {
        failure("addToSet requires array container")
      }
      if (!container.some((item) => deepEqual(item, op.value))) {
        container.push(deepClone(op.value))
      }
      break

    case "deleteFromSet":
      if (!Array.isArray(container)) {
        failure("deleteFromSet requires array container")
      }
      // Remove all matching items using splice (from end to avoid index shifting)
      for (let i = container.length - 1; i >= 0; i--) {
        if (deepEqual(container[i], op.value)) {
          container.splice(i, 1)
        }
      }
      break
  }
}

/**
 * Apply a tx.
 *
 * @param state - The current state object (immutable or mutable).
 * @param ops - Operations to apply.
 * @param validateFn - Optional validation function.
 * @param immutable - If true, use immutable updates (Mutative). If false, mutate in-place (with undo/rollback).
 * @returns The new state if changed (immutable) or mutated (mutable), or null if validation failed or no changes occurred.
 */
export function applyTx(
  state: JSONObject,
  ops: readonly Op[],
  validateFn?: ValidateFn<JSONObject>,
  immutable = false
): JSONObject | null {
  if (immutable) {
    const newState = applyTxImmutable(state, ops, validateFn)
    return newState === state ? null : newState
  } else {
    const success = applyTxMutable(state, ops, validateFn)
    return success ? state : null
  }
}

/**
 * Immutable implementation using Mutative.
 */
function applyTxImmutable(
  state: JSONObject,
  ops: readonly Op[],
  validateFn?: ValidateFn<JSONObject>
): JSONObject {
  try {
    const newState = create<any>(state, (draft) => {
      applyOps(ops, draft)
    })

    // Validate if a validator is configured
    if (validateFn && !validateFn(newState)) {
      return state // Validation failed, reject tx
    }

    return newState
  } catch (_error) {
    // Op application failed, reject tx
    return state
  }
}

/**
 * Mutable implementation with Undo Stack for rollback.
 * Returns true if successful, false if rolled back.
 */
function applyTxMutable(
  state: JSONObject,
  ops: readonly Op[],
  validateFn?: ValidateFn<JSONObject>
): boolean {
  const undoStack: (() => void)[] = []

  try {
    for (const op of ops) {
      applyOpMutable(state, op, undoStack)
    }

    // Validate if a validator is configured
    if (validateFn && !validateFn(state)) {
      throw new Error("Validation failed")
    }

    return true
  } catch (_error) {
    // Rollback changes
    for (let i = undoStack.length - 1; i >= 0; i--) {
      undoStack[i]()
    }
    return false
  }
}

/**
 * Applies a list of operations to a mutable target object.
 * Use this to synchronize an external mutable state (e.g., MobX store)
 * with the operations received via subscribe().
 *
 * @param ops - The list of operations to apply.
 * @param target - The mutable object to modify.
 */
export function applyOps(ops: readonly Op[], target: JSONObject): void {
  for (const op of ops) {
    applyOp(target, op)
  }
}

/**
 * Applies a single operation to a mutable target, pushing the inverse op to the undo stack.
 */
function applyOpMutable(state: JSONObject, op: Op, undoStack: (() => void)[]): void {
  const container = resolvePath(state, op.path)

  switch (op.kind) {
    case "set": {
      if (!isObject(container) || Array.isArray(container)) {
        failure("set requires object container")
      }
      const key = op.key
      const target = container as any
      // Check if key exists for undo logic
      if (Object.hasOwn(target, key)) {
        const oldValue = target[key]
        undoStack.push(() => {
          target[key] = oldValue
        })
      } else {
        undoStack.push(() => {
          delete target[key]
        })
      }
      target[key] = deepClone(op.value)
      break
    }

    case "delete": {
      if (!isObject(container) || Array.isArray(container)) {
        failure("delete requires object container")
      }
      const key = op.key
      const target = container as any
      if (Object.hasOwn(target, key)) {
        const oldValue = target[key]
        undoStack.push(() => {
          target[key] = oldValue
        })
        delete target[key]
      }
      break
    }

    case "splice": {
      if (!Array.isArray(container)) {
        failure("splice requires array container")
      }
      const safeIndex = Math.min(op.index, container.length)
      // Capture deleted items for undo
      const clonedInserts = op.inserts.map((v) => deepClone(v))
      const deletedItems = container.splice(safeIndex, op.deleteCount, ...clonedInserts)

      undoStack.push(() => {
        // Undo: delete the inserted items, and re-insert the deleted items
        // We inserted op.inserts.length items at safeIndex
        container.splice(safeIndex, clonedInserts.length, ...deletedItems)
      })
      break
    }

    case "addToSet": {
      if (!Array.isArray(container)) {
        failure("addToSet requires array container")
      }
      const exists = container.some((item) => deepEqual(item, op.value))
      if (!exists) {
        const clonedValue = deepClone(op.value)
        container.push(clonedValue)
        undoStack.push(() => {
          // Optimization: Since we just pushed it to the end, and we revert in reverse order,
          // the item MUST be at the end of the array.
          container.pop()
        })
      }
      break
    }

    case "deleteFromSet": {
      if (!Array.isArray(container)) {
        failure("deleteFromSet requires array container")
      }
      // We might remove multiple items if duplicates exist (though it should be a set)
      // spec says: "Remove all matching items"
      const indicesRemoved: { index: number; value: JSONValue }[] = []

      // Iterate backwards to safe delete
      for (let i = container.length - 1; i >= 0; i--) {
        if (deepEqual(container[i], op.value)) {
          const [removed] = container.splice(i, 1)
          indicesRemoved.push({ index: i, value: removed })
        }
      }

      if (indicesRemoved.length > 0) {
        undoStack.push(() => {
          // Re-insert removed items at their original indices.
          // We re-insert in REVERSE order of removal (ascending index order) to reconstruct correctly.
          for (let i = indicesRemoved.length - 1; i >= 0; i--) {
            const { index, value } = indicesRemoved[i]
            container.splice(index, 0, value)
          }
        })
      }
      break
    }
  }
}

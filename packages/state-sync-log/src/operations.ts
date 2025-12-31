import { produce } from "immer"
import { failure } from "./error"
import { JSONObject, JSONValue, Path } from "./json"
import { deepEqual, isObject } from "./utils"

/**
 * Supported operations.
 * Applied sequentially within a transaction.
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
 * - Validation runs once per transaction, after all ops apply.
 * - If validation fails, the transaction is rejected (state reverts to previous).
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
      ;(container as any)[op.key] = op.value
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
      container.splice(safeIndex, op.deleteCount, ...op.inserts)
      break
    }

    case "addToSet":
      if (!Array.isArray(container)) {
        failure("addToSet requires array container")
      }
      if (!container.some((item) => deepEqual(item, op.value))) {
        container.push(op.value)
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
 * Apply a transaction using Immer for immutable updates.
 * Runs validation after applying ops; reverts on failure.
 *
 * @returns The new state if valid, or the previous state if validation fails.
 */
export function applyTransaction(
  state: JSONObject,
  ops: readonly Op[],
  validateFn?: ValidateFn<JSONObject>
): JSONObject {
  try {
    const newState = produce(state, (draft) => {
      applyOps(ops, draft)
    })

    // Validate if a validator is configured
    if (validateFn && !validateFn(newState)) {
      return state // Validation failed, reject transaction
    }

    return newState
  } catch (_error) {
    // Op application failed, reject transaction
    return state
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

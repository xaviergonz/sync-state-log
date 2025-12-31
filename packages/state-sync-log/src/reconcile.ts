import { failure } from "./error"
import { JSONRecord, JSONValue, Path } from "./json"
import { Op } from "./operations"

/**
 * Reconciles the current state with the target state by computing and emitting
 * the minimal set of operations needed to transform currentState into targetState.
 */
export function computeReconcileOps(currentState: JSONValue, targetState: JSONValue): Op[] {
  const ops: Op[] = []
  diffValue(currentState, targetState, [], ops)
  return ops
}

function diffValue(current: JSONValue, target: JSONValue, path: Path, ops: Op[]): void {
  // 1. Reference equality (structural sharing)
  if (current === target) return

  // 2. Handle primitives and null quickly
  const currentType = typeof current
  const targetType = typeof target

  if (current === null || target === null || currentType !== "object" || targetType !== "object") {
    // At least one is primitive/null, or types don't match
    emitReplace(path, target, ops)
    return
  }

  // Both are objects (object or array)
  const currentIsArray = Array.isArray(current)
  const targetIsArray = Array.isArray(target)

  if (currentIsArray !== targetIsArray) {
    // Type mismatch (one array, one object)
    emitReplace(path, target, ops)
    return
  }

  if (currentIsArray) {
    diffArray(current, target as JSONValue[], path, ops)
  } else {
    diffObject(current as JSONRecord, target as JSONRecord, path, ops)
  }
}

function diffObject(current: JSONRecord, target: JSONRecord, path: Path, ops: Op[]): void {
  // 1. Delete keys in current but not in target
  for (const key in current) {
    if (Object.hasOwn(current, key) && !Object.hasOwn(target, key)) {
      ops.push({ kind: "delete", path, key })
    }
  }

  // 2. Add/Update keys in target
  for (const key in target) {
    if (Object.hasOwn(target, key)) {
      const targetVal = target[key]
      if (!Object.hasOwn(current, key)) {
        ops.push({ kind: "set", path, key, value: targetVal })
      } else if (current[key] !== targetVal) {
        // Only recurse if values differ (reference check first)
        diffValue(current[key], targetVal, [...path, key], ops)
      }
    }
  }
}

function diffArray(current: JSONValue[], target: JSONValue[], path: Path, ops: Op[]): void {
  const currentLen = current.length
  const targetLen = target.length
  const minLen = currentLen < targetLen ? currentLen : targetLen

  // Diff common elements
  for (let i = 0; i < minLen; i++) {
    if (current[i] !== target[i]) {
      diffValue(current[i], target[i], [...path, i], ops)
    }
  }

  // Handle length difference
  if (targetLen > currentLen) {
    ops.push({
      kind: "splice",
      path,
      index: currentLen,
      deleteCount: 0,
      inserts: target.slice(currentLen),
    })
  } else if (currentLen > targetLen) {
    ops.push({
      kind: "splice",
      path,
      index: targetLen,
      deleteCount: currentLen - targetLen,
      inserts: [],
    })
  }
}

function emitReplace(path: Path, value: JSONValue, ops: Op[]): void {
  if (path.length === 0) {
    // Cannot replace root directly via Ops (unless we define a 'root' op, which we don't)
    // We expect root to be handled by diffObject usually.
    // If we land here, it means root types mismatched (e.g. Obj -> Array).
    failure("StateSyncLog: Cannot replace root state directly via Ops.")
  }

  const parentPath = path.slice(0, -1)
  const keyToCheck = path[path.length - 1]

  if (typeof keyToCheck === "string") {
    // Parent is Object
    ops.push({ kind: "set", path: parentPath, key: keyToCheck, value })
  } else {
    // Parent is Array
    ops.push({
      kind: "splice",
      path: parentPath,
      index: keyToCheck,
      deleteCount: 1,
      inserts: [value],
    })
  }
}

/**
 * Helper functions for set-like array operations.
 * Uses eager op logging - ops are pushed immediately when mutations happen.
 */

import type { JSONValue } from "../json"
import { deepClone, deepEqual } from "../utils"
import { pushOp } from "./pushOp"
import { ensureShallowCopy, getPathOrThrow, getProxyDraft, markChanged } from "./utils"

/**
 * Add a value to an array if it doesn't already exist (set semantics).
 * Generates an `addToSet` operation.
 *
 * @example
 * ```ts
 * createOps(state, (draft) => {
 *   addToSet(draft.tags, 'newTag'); // Only adds if not present
 * });
 * ```
 */
export function addToSet<T extends JSONValue>(draft: T[], value: T): void {
  const proxyDraft = getProxyDraft(draft)
  if (!proxyDraft) {
    throw new Error(`addToSet() can only be used on draft arrays`)
  }

  // Mark as changed
  ensureShallowCopy(proxyDraft)
  markChanged(proxyDraft)

  // Check if value already exists
  const arr = proxyDraft.copy as T[]
  if (arr.some((item) => item === value || deepEqual(item, value))) {
    // Value already exists - no op needed
    return
  }

  // Add the value
  arr.push(value)

  // Eager op logging
  pushOp(proxyDraft, {
    kind: "addToSet",
    path: getPathOrThrow(proxyDraft),
    value: deepClone(value) as JSONValue,
  })
}

/**
 * Remove a value from an array (set semantics).
 * Generates a `deleteFromSet` operation.
 *
 * @example
 * ```ts
 * createOps(state, (draft) => {
 *   deleteFromSet(draft.tags, 'oldTag'); // Removes all matching items
 * });
 * ```
 */
export function deleteFromSet<T extends JSONValue>(draft: T[], value: T): void {
  const proxyDraft = getProxyDraft(draft)
  if (!proxyDraft) {
    throw new Error(`deleteFromSet() can only be used on draft arrays`)
  }

  // Mark as changed
  ensureShallowCopy(proxyDraft)
  markChanged(proxyDraft)

  // Check if value exists
  const arr = proxyDraft.copy as T[]
  const hasValue = arr.some((item) => item === value || deepEqual(item, value))

  if (!hasValue) {
    // Value doesn't exist - no op needed
    return
  }

  // Remove all matching items (by value equality)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === value || deepEqual(arr[i], value)) {
      arr.splice(i, 1)
    }
  }

  // Eager op logging
  pushOp(proxyDraft, {
    kind: "deleteFromSet",
    path: getPathOrThrow(proxyDraft),
    value: deepClone(value) as JSONValue,
  })
}

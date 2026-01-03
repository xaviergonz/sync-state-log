/**
 * Get the current value from a draft (snapshot).
 * Adapted from mutative - simplified for plain objects/arrays only.
 */

import type { Draft } from "./interface"
import {
  forEach,
  get,
  getProxyDraft,
  isDraft,
  isDraftable,
  isEqual,
  set,
  shallowCopy,
} from "./utils"

/**
 * Get current state from a value (handles nested drafts)
 */
function getCurrent<T>(target: T): T {
  const proxyDraft = getProxyDraft(target)

  // Not draftable - return as-is
  if (!isDraftable(target)) return target

  // Draft that hasn't been modified - return original
  if (proxyDraft && !proxyDraft.operated) {
    return proxyDraft.original as T
  }

  let currentValue: T | undefined

  function ensureShallowCopyLocal() {
    currentValue = shallowCopy(target)
  }

  if (proxyDraft) {
    // It's a draft - create a shallow copy eagerly
    proxyDraft.finalized = true
    try {
      ensureShallowCopyLocal()
    } finally {
      proxyDraft.finalized = false
    }
  } else {
    // Not a draft - use target directly, copy lazily if needed
    currentValue = target
  }

  // Recursively process children
  forEach(currentValue as object, (key, value) => {
    if (proxyDraft && isEqual(get(proxyDraft.original as object, key), value)) {
      return
    }
    const newValue = getCurrent(value)
    if (newValue !== value) {
      if (currentValue === target) {
        ensureShallowCopyLocal()
      }
      set(currentValue as object, key, newValue)
    }
  })

  return currentValue as T
}

/**
 * `current(draft)` to get current state in the draft mutation function.
 *
 * @example
 * ```ts
 * const { nextState, ops } = createOps(baseState, (draft) => {
 *   draft.foo.bar = 'new value';
 *   console.log(current(draft.foo)); // { bar: 'new value' }
 * });
 * ```
 */
export function current<T extends object>(target: Draft<T>): T
export function current<T extends object>(target: T | Draft<T>): T {
  if (!isDraft(target)) {
    throw new Error(`current() is only used for Draft, parameter: ${target}`)
  }
  return getCurrent(target) as T
}

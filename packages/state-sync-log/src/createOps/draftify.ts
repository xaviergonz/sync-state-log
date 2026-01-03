/**
 * Create a draft from a base state.
 * Simplified from mutative - removed patches/freeze/mark support.
 */

import { createDraft, finalizeDraft } from "./draft"
import type { Finalities, Op } from "./interface"
import { getProxyDraft, isDraftable } from "./utils"

/**
 * Create a draft and return a finalize function
 */
export function draftify<T extends object>(
  baseState: T
): [T, (returnedValue: [T] | []) => [T, Op[]]] {
  const finalities: Finalities = {
    draft: [],
    revoke: [],
    handledSet: new WeakSet<object>(),
    draftsCache: new WeakSet<object>(),
    ops: [],
    rootDraft: null, // Will be set by createDraft
  }

  // Check if state is draftable
  if (!isDraftable(baseState)) {
    throw new Error(`createOps() only supports plain objects and arrays.`)
  }

  const draft = createDraft({
    original: baseState,
    parentDraft: null,
    finalities,
  })

  // Set the root draft for multi-path detection
  finalities.rootDraft = getProxyDraft(draft)

  return [
    draft,
    (returnedValue: [T] | [] = []) => {
      return finalizeDraft(draft, returnedValue)
    },
  ]
}

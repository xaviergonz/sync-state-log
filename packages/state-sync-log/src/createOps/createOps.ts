/**
 * createOps - Main API for generating operations from mutable-style mutations.
 *
 * Forked from mutative (https://github.com/unadlib/mutative)
 * MIT License
 */

import { current } from "./current"
import { draftify } from "./draftify"
import type { CreateOpsResult, Draft } from "./interface"
import { getProxyDraft, isDraft, isDraftable, isEqual, revokeProxy } from "./utils"

/**
 * Create operations from mutable-style mutations.
 *
 * @param base - The base state (will not be mutated)
 * @param mutate - A function that mutates the draft
 * @returns An object containing the next state and the operations performed
 *
 * @example
 * ```ts
 * const state = { list: [{ text: 'Learn', done: false }] };
 *
 * const { nextState, ops } = createOps(state, (draft) => {
 *   draft.list[0].done = true;
 *   draft.list.push({ text: 'Practice', done: false });
 * });
 *
 * // ops contains the operations that were performed:
 * // [
 * //   { kind: 'set', path: ['list', 0], key: 'done', value: true },
 * //   { kind: 'splice', path: ['list'], index: 1, deleteCount: 0, inserts: [{ text: 'Practice', done: false }] }
 * // ]
 * ```
 */
export function createOps<T extends object>(
  base: T,
  mutate: (draft: Draft<T>) => void
): CreateOpsResult<T> {
  // Handle case where base is already a draft
  const state = isDraft(base) ? current(base as Draft<T>) : base

  // Validate that state is draftable
  if (!isDraftable(state)) {
    throw new Error(`createOps() only supports plain objects and arrays.`)
  }

  // Create draft
  const [draft, finalize] = draftify(state)

  // Run mutation
  let result: unknown
  try {
    result = mutate(draft as Draft<T>)
  } catch (error) {
    revokeProxy(getProxyDraft(draft))
    throw error
  }

  // Handle return value
  const proxyDraft = getProxyDraft(draft)!

  // Check for invalid return values
  if (result !== undefined && !isDraft(result)) {
    if (!isEqual(result, draft) && proxyDraft.operated) {
      throw new Error(
        `Either the value is returned as a new non-draft value, or only the draft is modified without returning any value.`
      )
    }
    // User returned a new value - use it as the next state
    // Note: We don't support rawReturn, so returning a non-draft value replaces the state
    // but we can't generate meaningful ops for this case
    if (result !== undefined) {
      const [, ops] = finalize([])
      return { nextState: result as T, ops }
    }
  }

  // Standard flow - finalize the draft
  if (result === draft || result === undefined) {
    const [nextState, ops] = finalize([])
    return { nextState, ops }
  }

  // Returned a different draft (child)
  const returnedProxyDraft = getProxyDraft(result)
  if (returnedProxyDraft) {
    if (returnedProxyDraft.operated) {
      throw new Error(`Cannot return a modified child draft.`)
    }
    const [, ops] = finalize([])
    return { nextState: current(result as object) as T, ops }
  }

  const [nextState, ops] = finalize([])
  return { nextState, ops }
}

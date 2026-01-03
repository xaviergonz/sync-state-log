/**
 * Get the original value from a draft.
 */

import { getProxyDraft } from "./utils"

/**
 * `original(draft)` to get original state in the draft mutation function.
 *
 * @example
 * ```ts
 * const { nextState, ops } = createOps(baseState, (draft) => {
 *   draft.foo.bar = 'new value';
 *   console.log(original(draft.foo)); // { bar: 'old value' }
 * });
 * ```
 */
export function original<T>(target: T): T {
  const proxyDraft = getProxyDraft(target)
  if (!proxyDraft) {
    throw new Error(`original() is only used for a draft, parameter: ${target}`)
  }
  return proxyDraft.original as T
}

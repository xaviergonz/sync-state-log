/**
 * Eager op generation - ops are pushed immediately when mutations happen.
 *
 * This module provides the pushOp function that records operations at mutation time,
 * rather than diffing at finalization time.
 */

import type { Op, ProxyDraft } from "./interface"

/**
 * Push an operation to the ops log.
 * Values should already be cloned by the caller to avoid aliasing issues.
 */
export function pushOp(proxyDraft: ProxyDraft, op: Op): void {
  proxyDraft.finalities.ops.push(op)
}

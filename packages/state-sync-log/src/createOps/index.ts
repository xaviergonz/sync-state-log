/**
 * createOps - Proxy-based mutable-style API for generating operations.
 *
 * Forked from mutative (https://github.com/unadlib/mutative)
 * MIT License
 */

// Main API
export { createOps } from "./createOps"
export { current } from "./current"
// Types
export type { CreateOpsResult, Draft, Immutable, Op, Path } from "./interface"
// Utilities
export { original } from "./original"

// Set-like helpers
export { addToSet, deleteFromSet } from "./setHelpers"
export { isDraft, isDraftable } from "./utils"

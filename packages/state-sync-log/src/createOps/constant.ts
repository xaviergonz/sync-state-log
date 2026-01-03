/**
 * Constants for createOps.
 * Simplified from original source - removed dataTypes (mark feature).
 */

// Symbol to identify proxy drafts - accessible for 3rd party
export const PROXY_DRAFT = Symbol.for("__CREATEOPS_PROXY_DRAFT__")

// Symbol iterator
export const iteratorSymbol: typeof Symbol.iterator = Symbol.iterator

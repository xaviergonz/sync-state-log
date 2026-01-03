/**
 * createOps interface types.
 * Simplified from mutative - removed patches, autoFreeze, strict mode, mark, Map/Set support.
 */

import type { JSONPrimitive, JSONValue, Path } from "../json"
import type { Op } from "../operations"

export type { Op, Path, JSONValue }

export enum DraftType {
  Object = 0,
  Array = 1,
}

/**
 * Finalities - shared state for the draft tree
 */
export interface Finalities {
  /** Finalization callbacks (for unwrapping child drafts) */
  draft: (() => void)[]
  /** Revoke functions for all proxies */
  revoke: (() => void)[]
  /** Set of handled objects (for cycle detection) */
  handledSet: WeakSet<object>
  /** Cache of created drafts */
  draftsCache: WeakSet<object>
  /** List of operations performed in this draft session (eager logging) */
  ops: Op[]
  /** Root draft of the tree (set when creating the root draft) */
  rootDraft: ProxyDraft | null
}

/**
 * Internal proxy draft state
 */
export interface ProxyDraft<T = any> {
  /** Type of the draft (Object or Array) */
  type: DraftType
  /** Whether this draft has been mutated */
  operated?: boolean
  /** Whether finalization has been completed */
  finalized: boolean
  /** The original (unmodified) value */
  original: T
  /** The shallow copy (created on first mutation) */
  copy: T | null
  /** The proxy instance */
  proxy: T | null
  /** Finalities container (shared across draft tree) */
  finalities: Finalities
  /** Parent draft (for path tracking) */
  parent?: ProxyDraft | null
  /** Key in parent */
  key?: string | number
  /** Track which keys have been assigned (key -> true=assigned, false=deleted) */
  assignedMap?: Map<PropertyKey, boolean>
  /** Count of positions this draft exists at (for aliasing optimization) */
  aliasCount: number
}

/**
 * Result of createOps
 */
export interface CreateOpsResult<T> {
  /** The new immutable state */
  nextState: T
  /** The operations that were performed */
  ops: Op[]
}

// ============================================================================
// Type Utilities
// ============================================================================

/** Primitive types that don't need drafting */
type Primitive = JSONPrimitive

/**
 * Draft type - makes all properties mutable for editing
 */
export type Draft<T> = T extends Primitive
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: Draft<T[K]> }
    : T

/**
 * Immutable type - makes all properties readonly
 */
export type Immutable<T> = T extends Primitive
  ? T
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T

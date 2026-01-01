import equal from "fast-deep-equal"
import { nanoid } from "nanoid"
import rfdc from "rfdc"
import type { JSONValue } from "./json"

const clone = rfdc({ proto: true })

/**
 * Deep equality check for JSONValues.
 * Used for addToSet / deleteFromSet operations.
 */
export function deepEqual(a: JSONValue, b: JSONValue): boolean {
  return equal(a, b)
}

/**
 * Generates a unique ID using nanoid.
 */
export function generateID(): string {
  return nanoid()
}

/**
 * Checks if a value is an object (typeof === "object" && !== null).
 */
export function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

/**
 * Deep clones a JSON-serializable value.
 * Optimized: primitives are returned as-is.
 */
export function deepClone<T>(value: T): T {
  // Primitives don't need cloning
  if (value === null || typeof value !== "object") {
    return value
  }
  return clone(value)
}

/**
 * Creates a lazy memoized getter.
 */
export function lazy<T>(fn: () => T): () => T {
  let computed = false
  let value: T
  return () => {
    if (!computed) {
      value = fn()
      computed = true
    }
    return value
  }
}

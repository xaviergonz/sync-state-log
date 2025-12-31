import equal from "fast-deep-equal"
import { nanoid } from "nanoid"
import type { JSONValue } from "./json"

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

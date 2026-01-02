import { describe, expect, it } from "vitest"
import { applyOpToDraft, applyTxImmutable, createDraft, isDraftModified } from "../src/draft"
import type { Op } from "../src/operations"

describe("draft", () => {
  describe("basics", () => {
    it("tracks modifications correctly", () => {
      const base = { a: 1 }
      const ctx = createDraft(base)
      expect(ctx.root).toBe(base)
      expect(isDraftModified(ctx)).toBe(false)

      applyOpToDraft(ctx, { kind: "set", path: [], key: "b", value: 2 })
      expect(ctx.root).not.toBe(base)
      expect(isDraftModified(ctx)).toBe(true)
      expect(ctx.root).toStrictEqual({ a: 1, b: 2 })
    })

    it("uses value directly without cloning for performance", () => {
      const base = {}
      const valueToSet = { nested: { deep: 1 } }
      const result = applyTxImmutable(base, {
        ops: [{ kind: "set", path: [], key: "x", value: valueToSet }],
      }) as any

      // Value is used directly (no cloning) - safe since immutable mode never mutates
      expect(result.x).toBe(valueToSet)
    })
  })

  describe("ops", () => {
    it.each([
      // Set
      {
        desc: "sets a new key at root",
        base: { a: 1 },
        ops: [{ kind: "set", path: [], key: "b", value: 2 }],
        expected: { a: 1, b: 2 },
      },
      {
        desc: "updates an existing key",
        base: { a: 1 },
        ops: [{ kind: "set", path: [], key: "a", value: 999 }],
        expected: { a: 999 },
      },
      {
        desc: "sets a key in nested object",
        base: { outer: { inner: 1 } },
        ops: [{ kind: "set", path: ["outer"], key: "inner", value: 2 }],
        expected: { outer: { inner: 2 } },
      },
      // Delete
      {
        desc: "deletes a key",
        base: { a: 1, b: 2 },
        ops: [{ kind: "delete", path: [], key: "a" }],
        expected: { b: 2 },
      },
      // Splice
      {
        desc: "inserts into array (splice)",
        base: { arr: [1, 2] },
        ops: [{ kind: "splice", path: ["arr"], index: 1, deleteCount: 0, inserts: [1.5] }],
        expected: { arr: [1, 1.5, 2] },
      },
      {
        desc: "removes from array (splice)",
        base: { arr: [1, 2, 3] },
        ops: [{ kind: "splice", path: ["arr"], index: 1, deleteCount: 1, inserts: [] }],
        expected: { arr: [1, 3] },
      },
      // Set operations (addToSet, deleteFromSet)
      {
        desc: "adds to set",
        base: { set: [1] },
        ops: [{ kind: "addToSet", path: ["set"], value: 2 }],
        expected: { set: [1, 2] },
      },
      {
        desc: "adds object to set (deep equality check)",
        base: { set: [{ id: 1 }] },
        // Deep equality check handles objects
        ops: [{ kind: "addToSet", path: ["set"], value: { id: 1 } }],
        expected: { set: [{ id: 1 }] },
      },
      {
        desc: "removes from set",
        base: { set: [1, 2] },
        ops: [{ kind: "deleteFromSet", path: ["set"], value: 1 }],
        expected: { set: [2] },
      },
    ] as { desc: string; base: any; ops: Op[]; expected: any }[])("$desc", ({
      base,
      ops,
      expected,
    }) => {
      const result = applyTxImmutable(base, { ops })
      expect(result).toStrictEqual(expected)

      // In all these cases, we expect a new reference because `ensureOwnedPath`
      // clones the path eagerly, even if the final operation effectively does nothing
      // to the content (like adding a duplicate).
      expect(result).not.toBe(base)
    })
  })

  describe("structural sharing", () => {
    it("preserves structural sharing for unchanged branches", () => {
      const base = { a: { x: 1 }, b: { y: 2 } }
      const result = applyTxImmutable(base, {
        ops: [{ kind: "set", path: ["a"], key: "x", value: 999 }],
      })

      // Root and 'a' should be new
      expect(result).not.toBe(base)
      expect(result.a).not.toBe(base.a)

      // 'b' should be the same reference
      expect(result.b).toBe(base.b)
    })

    it("preserves array elements when splicing", () => {
      const obj1 = { id: 1 }
      const obj2 = { id: 2 }
      const base = { items: [obj1, obj2] }

      const result = applyTxImmutable(base, {
        ops: [
          { kind: "splice", path: ["items"], index: 1, deleteCount: 0, inserts: [{ id: 1.5 }] },
        ],
      }) as any

      expect(result.items).not.toBe(base.items)
      expect(result.items[0]).toBe(obj1)
      expect(result.items[2]).toBe(obj2)
    })
  })

  describe("error handling & validation", () => {
    it.each([
      {
        name: "invalid path (missing)",
        ops: [{ kind: "set", path: ["missing"], key: "x", value: 1 }],
      },
      {
        name: "invalid path (traversing primitive)",
        ops: [{ kind: "set", path: ["a", "b"], key: "x", value: 1 }],
        base: { a: 1 },
      },
      {
        name: "splice on non-array",
        ops: [{ kind: "splice", path: ["obj"], index: 0, deleteCount: 0, inserts: [] }],
        base: { obj: {} },
      },
      {
        name: "transaction failure",
        ops: [
          { kind: "set", path: [], key: "x", value: 1 },
          { kind: "set", path: ["missing"], key: "y", value: 2 },
        ],
      },
    ] as { name: string; ops: Op[]; base?: any }[])("returns base on $name", ({ ops, base }) => {
      const b = base || { a: 1 }
      const result = applyTxImmutable(b, { ops })
      expect(result).toBe(b)
    })

    it("applies multiple ops atomically", () => {
      const base = { a: 1 }
      const result = applyTxImmutable(base, {
        ops: [
          { kind: "set", path: [], key: "b", value: 2 },
          { kind: "set", path: [], key: "c", value: 3 },
        ],
      })
      expect(result).toStrictEqual({ a: 1, b: 2, c: 3 })
    })

    it("rolls back if validation fails", () => {
      const base = { count: 1 }
      const result = applyTxImmutable(
        base,
        { ops: [{ kind: "set", path: [], key: "count", value: 10 }] },
        (state: any) => state.count < 5 // Validation: must be < 5
      )
      expect(result).toBe(base)
    })

    it("returns base for empty op list", () => {
      const base = { a: 1 }
      const result = applyTxImmutable(base, { ops: [] })
      expect(result).toBe(base)
    })
  })
})

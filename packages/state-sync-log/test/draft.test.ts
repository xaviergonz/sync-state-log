import { describe, expect, it } from "vitest"
import { applyOpToDraft, applyTxsImmutable, createDraft, isDraftModified } from "../src/draft"

describe("draft", () => {
  describe("createDraft / finishDraft", () => {
    it("returns the same base when no changes are made", () => {
      const base = { a: 1, b: { c: 2 } }
      const ctx = createDraft(base)
      const result = ctx.root
      expect(result).toBe(base)
    })

    it("isDraftModified returns false when unchanged", () => {
      const base = { a: 1 }
      const ctx = createDraft(base)
      expect(isDraftModified(ctx)).toBe(false)
    })

    it("isDraftModified returns true after modification", () => {
      const base = { a: 1 }
      const ctx = createDraft(base)
      applyOpToDraft(ctx, { kind: "set", path: [], key: "b", value: 2 })
      expect(isDraftModified(ctx)).toBe(true)
    })
  })

  describe("set operation", () => {
    it("sets a new key at root", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: [], key: "b", value: 2 }] },
      ])
      expect(result).toStrictEqual({ a: 1, b: 2 })
      expect(base).toStrictEqual({ a: 1 }) // base unchanged
    })

    it("updates an existing key at root", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: [], key: "a", value: 999 }] },
      ])
      expect(result).toStrictEqual({ a: 999 })
      expect(base).toStrictEqual({ a: 1 }) // base unchanged
    })

    it("sets a key in nested object", () => {
      const base = { outer: { inner: 1 } }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["outer"], key: "inner", value: 2 }] },
      ])
      expect(result).toStrictEqual({ outer: { inner: 2 } })
      expect(base).toStrictEqual({ outer: { inner: 1 } }) // base unchanged
    })

    it("preserves structural sharing for unchanged branches", () => {
      const base = { a: { x: 1 }, b: { y: 2 } }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["a"], key: "x", value: 999 }] },
      ])

      // Root and 'a' should be new
      expect(result).not.toBe(base)
      expect(result.a).not.toBe(base.a)

      // 'b' should be the same reference (structural sharing)
      expect(result.b).toBe(base.b)
    })

    it("uses value directly without cloning for performance", () => {
      const base = {}
      const valueToSet = { nested: { deep: 1 } }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: [], key: "x", value: valueToSet }] },
      ]) as any

      // Value is used directly (no cloning) - safe since immutable mode never mutates
      // and Yjs clones values when storing ops
      expect(result.x).toBe(valueToSet)
      expect(result.x.nested).toBe(valueToSet.nested)
      expect(result.x).toStrictEqual(valueToSet)
    })

    it("sets key inside array element", () => {
      const base = { items: [{ id: 1 }, { id: 2 }] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["items", 0], key: "name", value: "first" }] },
      ]) as any
      expect(result.items[0]).toStrictEqual({ id: 1, name: "first" })
      expect(base.items[0]).toStrictEqual({ id: 1 }) // base unchanged
    })
  })

  describe("delete operation", () => {
    it("deletes a key at root", () => {
      const base = { a: 1, b: 2 }
      const result = applyTxsImmutable(base, [{ ops: [{ kind: "delete", path: [], key: "a" }] }])
      expect(result).toStrictEqual({ b: 2 })
      expect(base).toStrictEqual({ a: 1, b: 2 }) // base unchanged
    })

    it("deletes a key in nested object", () => {
      const base = { outer: { a: 1, b: 2 } }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "delete", path: ["outer"], key: "a" }] },
      ])
      expect(result).toStrictEqual({ outer: { b: 2 } })
      expect(base).toStrictEqual({ outer: { a: 1, b: 2 } }) // base unchanged
    })

    it("preserves structural sharing when deleting", () => {
      const base = { a: { x: 1 }, b: { y: 2 } }
      const result = applyTxsImmutable(base, [{ ops: [{ kind: "delete", path: ["a"], key: "x" }] }])

      expect(result.a).not.toBe(base.a)
      expect(result.b).toBe(base.b) // unchanged branch preserved
    })
  })

  describe("splice operation", () => {
    it("inserts elements into array", () => {
      const base = { arr: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "splice", path: ["arr"], index: 1, deleteCount: 0, inserts: [10, 20] }] },
      ]) as any
      expect(result.arr).toStrictEqual([1, 10, 20, 2, 3])
      expect(base.arr).toStrictEqual([1, 2, 3]) // base unchanged
    })

    it("removes elements from array", () => {
      const base = { arr: [1, 2, 3, 4] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "splice", path: ["arr"], index: 1, deleteCount: 2, inserts: [] }] },
      ]) as any
      expect(result.arr).toStrictEqual([1, 4])
    })

    it("replaces elements in array", () => {
      const base = { arr: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "splice", path: ["arr"], index: 1, deleteCount: 1, inserts: [99] }] },
      ]) as any
      expect(result.arr).toStrictEqual([1, 99, 3])
    })

    it("clamps index to array length", () => {
      const base = { arr: [1, 2] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "splice", path: ["arr"], index: 100, deleteCount: 0, inserts: [99] }] },
      ]) as any
      expect(result.arr).toStrictEqual([1, 2, 99])
    })

    it("uses inserted values directly without cloning for performance", () => {
      const base = { arr: [] as any[] }
      const objToInsert = { nested: { value: 1 } }
      const result = applyTxsImmutable(base, [
        {
          ops: [
            { kind: "splice", path: ["arr"], index: 0, deleteCount: 0, inserts: [objToInsert] },
          ],
        },
      ]) as any

      // Value is used directly - safe since immutable mode never mutates
      expect(result.arr[0]).toBe(objToInsert)
      expect(result.arr[0]).toStrictEqual(objToInsert)
    })
  })

  describe("addToSet operation", () => {
    it("adds value to empty array", () => {
      const base = { set: [] as number[] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "addToSet", path: ["set"], value: 1 }] },
      ]) as any
      expect(result.set).toStrictEqual([1])
    })

    it("adds value if not already present", () => {
      const base = { set: [1, 2] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "addToSet", path: ["set"], value: 3 }] },
      ]) as any
      expect(result.set).toStrictEqual([1, 2, 3])
    })

    it("does not add duplicate primitive value", () => {
      const base = { set: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "addToSet", path: ["set"], value: 2 }] },
      ]) as any
      expect(result.set).toStrictEqual([1, 2, 3])
      // Since no change was made (structurally), root may or may not change
      // depending on whether path was traversed; but content should be same
    })

    it("does not add duplicate object value (deep equality)", () => {
      const base = { set: [{ id: 1 }, { id: 2 }] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "addToSet", path: ["set"], value: { id: 1 } }] },
      ]) as any
      expect(result.set).toHaveLength(2)
    })

    it("uses added value directly without cloning for performance", () => {
      const base = { set: [] as any[] }
      const objToAdd = { nested: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "addToSet", path: ["set"], value: objToAdd }] },
      ]) as any
      // Value is used directly - safe since immutable mode never mutates
      expect(result.set[0]).toBe(objToAdd)
      expect(result.set[0]).toStrictEqual(objToAdd)
    })
  })

  describe("deleteFromSet operation", () => {
    it("removes matching primitive value", () => {
      const base = { set: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "deleteFromSet", path: ["set"], value: 2 }] },
      ]) as any
      expect(result.set).toStrictEqual([1, 3])
    })

    it("removes matching object value (deep equality)", () => {
      const base = { set: [{ id: 1 }, { id: 2 }, { id: 3 }] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "deleteFromSet", path: ["set"], value: { id: 2 } }] },
      ]) as any
      expect(result.set).toStrictEqual([{ id: 1 }, { id: 3 }])
    })

    it("removes all duplicates", () => {
      const base = { set: [1, 2, 2, 3, 2] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "deleteFromSet", path: ["set"], value: 2 }] },
      ]) as any
      expect(result.set).toStrictEqual([1, 3])
    })

    it("does nothing if value not found", () => {
      const base = { set: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "deleteFromSet", path: ["set"], value: 99 }] },
      ]) as any
      expect(result.set).toStrictEqual([1, 2, 3])
    })
  })

  describe("error handling", () => {
    it("returns base on invalid path (missing property)", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["nonexistent"], key: "x", value: 1 }] },
      ])
      expect(result).toBe(base)
    })

    it("returns base on invalid path (traversing primitive)", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["a", "b"], key: "x", value: 1 }] },
      ])
      expect(result).toBe(base)
    })

    it("returns base on array index out of bounds", () => {
      const base = { arr: [1, 2] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["arr", 10], key: "x", value: 1 }] },
      ])
      expect(result).toBe(base)
    })

    it("returns base on set to non-object container", () => {
      const base = { arr: [1, 2, 3] }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["arr"], key: "x", value: 1 }] },
      ])
      expect(result).toBe(base)
    })

    it("returns base on splice to non-array", () => {
      const base = { obj: { a: 1 } }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "splice", path: ["obj"], index: 0, deleteCount: 0, inserts: [1] }] },
      ])
      expect(result).toBe(base)
    })
  })

  describe("validation", () => {
    it("returns base when validation fails", () => {
      const base = { count: 5 }
      const validate = (state: any) => state.count < 10
      const result = applyTxsImmutable(
        base,
        [{ ops: [{ kind: "set", path: [], key: "count", value: 100 }] }],
        validate
      )
      expect(result).toBe(base)
    })

    it("returns new state when validation passes", () => {
      const base = { count: 5 }
      const validate = (state: any) => state.count < 10
      const result = applyTxsImmutable(
        base,
        [{ ops: [{ kind: "set", path: [], key: "count", value: 7 }] }],
        validate
      )
      expect(result).toStrictEqual({ count: 7 })
      expect(result).not.toBe(base)
    })

    it("preserves structural sharing on validation failure", () => {
      const base = { a: { deep: 1 }, b: { other: 2 } }
      const validate = () => false // always fail
      const result = applyTxsImmutable(
        base,
        [{ ops: [{ kind: "set", path: ["a"], key: "deep", value: 999 }] }],
        validate
      )

      expect(result).toBe(base)
      expect(result.a).toBe(base.a)
      expect(result.b).toBe(base.b)
    })
  })

  describe("applyTxsImmutable", () => {
    it("applies multiple transactions", () => {
      const base = { a: 1, b: 2 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: [], key: "a", value: 10 }] },
        { ops: [{ kind: "set", path: [], key: "b", value: 20 }] },
      ])
      expect(result).toStrictEqual({ a: 10, b: 20 })
    })

    it("returns base for empty tx list", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [])
      expect(result).toBe(base)
    })

    it("skips transactions that fail validation", () => {
      const base = { count: 0 }
      const validate = (state: any) => state.count < 10

      const result = applyTxsImmutable(
        base,
        [
          { ops: [{ kind: "set", path: [], key: "count", value: 5 }] }, // valid
          { ops: [{ kind: "set", path: [], key: "count", value: 100 }] }, // invalid, skipped
          { ops: [{ kind: "set", path: [], key: "count", value: 7 }] }, // valid
        ],
        validate
      )

      expect(result).toStrictEqual({ count: 7 })
    })

    it("skips transactions with invalid operations", () => {
      const base = { a: 1 }
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: [], key: "b", value: 2 }] }, // valid
        { ops: [{ kind: "set", path: ["nonexistent"], key: "x", value: 1 }] }, // error, skipped
        { ops: [{ kind: "set", path: [], key: "c", value: 3 }] }, // valid
      ])
      expect(result).toStrictEqual({ a: 1, b: 2, c: 3 })
    })

    it("returns base if all transactions fail", () => {
      const base = { a: 1 }
      const validate = () => false // always fail

      const result = applyTxsImmutable(
        base,
        [
          { ops: [{ kind: "set", path: [], key: "b", value: 2 }] },
          { ops: [{ kind: "set", path: [], key: "c", value: 3 }] },
        ],
        validate
      )

      expect(result).toBe(base)
    })

    it("reuses owned objects across transactions (efficiency)", () => {
      const base = { nested: { value: 0 } }

      // These two txs modify the same nested object
      const result = applyTxsImmutable(base, [
        { ops: [{ kind: "set", path: ["nested"], key: "value", value: 1 }] },
        { ops: [{ kind: "set", path: ["nested"], key: "value", value: 2 }] },
      ]) as any

      expect(result.nested.value).toBe(2)
      expect(result).not.toBe(base)
      expect(result.nested).not.toBe(base.nested)
    })
  })

  describe("multiple ops in single tx", () => {
    it("applies multiple ops atomically", () => {
      const base = { a: 1, b: 2 }
      const result = applyTxsImmutable(base, [
        {
          ops: [
            { kind: "set", path: [], key: "a", value: 10 },
            { kind: "set", path: [], key: "b", value: 20 },
            { kind: "set", path: [], key: "c", value: 30 },
          ],
        },
      ])
      expect(result).toStrictEqual({ a: 10, b: 20, c: 30 })
    })

    it("rolls back all ops if validation fails", () => {
      const base = { a: 1, b: 2 }
      const validate = () => false

      const result = applyTxsImmutable(
        base,
        [
          {
            ops: [
              { kind: "set", path: [], key: "a", value: 10 },
              { kind: "set", path: [], key: "b", value: 20 },
            ],
          },
        ],
        validate
      )

      expect(result).toBe(base)
    })

    it("rolls back all ops if any op fails", () => {
      const base = { a: 1 }

      const result = applyTxsImmutable(base, [
        {
          ops: [
            { kind: "set", path: [], key: "b", value: 2 }, // valid
            { kind: "set", path: ["nonexistent"], key: "x", value: 1 }, // error
            { kind: "set", path: [], key: "c", value: 3 }, // never reached
          ],
        },
      ])

      expect(result).toBe(base)
    })
  })

  describe("array operations preserve structural sharing", () => {
    it("preserves other array elements when splicing", () => {
      const obj1 = { id: 1, data: "one" }
      const obj2 = { id: 2, data: "two" }
      const obj3 = { id: 3, data: "three" }
      const base = { items: [obj1, obj2, obj3] }

      const result = applyTxsImmutable(base, [
        {
          ops: [
            {
              kind: "splice",
              path: ["items"],
              index: 1,
              deleteCount: 1,
              inserts: [{ id: 99, data: "new" }],
            },
          ],
        },
      ]) as any

      // Array is new, root is new
      expect(result).not.toBe(base)
      expect(result.items).not.toBe(base.items)

      // Untouched elements preserved
      expect(result.items[0]).toBe(obj1)
      expect(result.items[2]).toBe(obj3)
    })
  })
})

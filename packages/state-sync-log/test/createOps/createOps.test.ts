/**
 * Tests specific to createOps API features - ops generation, helpers, etc.
 * Basic object/array mutation tests are in mutative-create.test.ts
 */

import { describe, expect, test } from "vitest"
import {
  addToSet,
  createOps,
  current,
  deleteFromSet,
  isDraft,
  isDraftable,
  original,
} from "../../src/createOps"
import { getProxyDraft } from "../../src/createOps/utils"
import { applyOps } from "../../src/operations"

describe("createOps - ops generation", () => {
  test("object set generates set op", () => {
    const state = { foo: "bar", count: 0 }
    const { nextState, ops } = createOps(state, (draft) => {
      draft.foo = "baz"
    })

    expect(nextState).toEqual({ foo: "baz", count: 0 })
    expect(ops).toEqual([{ kind: "set", path: [], key: "foo", value: "baz" }])
  })

  test("object delete generates delete op", () => {
    const state = { foo: "bar", baz: 42 } as { foo: string; baz?: number }
    const { ops } = createOps(state, (draft) => {
      delete draft.baz
    })

    expect(ops).toEqual([{ kind: "delete", path: [], key: "baz" }])
  })

  test("nested object generates op with path", () => {
    const state = { a: { b: { c: 1 } } }
    const { ops } = createOps(state, (draft) => {
      draft.a.b.c = 2
    })

    expect(ops).toEqual([{ kind: "set", path: ["a", "b"], key: "c", value: 2 }])
  })

  test("array push generates splice op", () => {
    const state = { list: [1, 2] }
    const { ops } = createOps(state, (draft) => {
      draft.list.push(3, 4)
    })

    expect(ops).toEqual([
      { kind: "splice", path: ["list"], index: 2, deleteCount: 0, inserts: [3, 4] },
    ])
  })

  test("array pop generates splice op", () => {
    const state = { list: [1, 2, 3] }
    const { ops } = createOps(state, (draft) => {
      draft.list.pop()
    })

    expect(ops).toEqual([{ kind: "splice", path: ["list"], index: 2, deleteCount: 1, inserts: [] }])
  })

  test("array in-bounds modification generates set op", () => {
    const state = { list: ["a", "b", "c"] }
    const { ops } = createOps(state, (draft) => {
      draft.list[1] = "B"
    })

    expect(ops).toEqual([{ kind: "set", path: ["list"], key: 1, value: "B" }])
  })

  test("array push-like at length generates splice op", () => {
    const state = { list: [1, 2] }
    const { ops } = createOps(state, (draft) => {
      draft.list[2] = 3
    })

    expect(ops).toEqual([{ kind: "set", path: ["list"], key: 2, value: 3 }])
  })

  test("sparse array throws", () => {
    const state = { list: [1, 2] }
    expect(() => {
      createOps(state, (draft) => {
        draft.list[10] = 100 // This would create a sparse array
      })
    }).toThrow(/sparse/i)
  })

  test("setting array length truncates with set op", () => {
    const state = { list: [1, 2, 3, 4] }
    const { ops } = createOps(state, (draft) => {
      draft.list.length = 2
    })

    expect(ops).toEqual([{ kind: "set", path: ["list"], key: "length", value: 2 }])
  })

  test("setting array length expands with set op", () => {
    const state = { list: [1, 2] }
    const { ops } = createOps(state, (draft) => {
      draft.list.length = 4
    })

    expect(ops).toEqual([{ kind: "set", path: ["list"], key: "length", value: 4 }])
  })

  test("fill generates splice op", () => {
    const state = { list: [1, 2, 3] }
    const { ops } = createOps(state, (draft) => {
      draft.list.fill(0)
    })
    // Expect splice replacement of whole array
    expect(ops).toEqual([
      { kind: "splice", path: ["list"], index: 0, deleteCount: 3, inserts: [0, 0, 0] },
    ])
  })

  describe("splice preserves original intent (no normalization)", () => {
    test("negative start index is preserved", () => {
      const state = { list: [1, 2, 3, 4, 5] }
      const { ops } = createOps(state, (draft) => {
        draft.list.splice(-2, 1) // Remove second-to-last element
      })
      // Original intent: start at -2, deleteCount 1
      expect(ops).toEqual([
        { kind: "splice", path: ["list"], index: -2, deleteCount: 1, inserts: [] },
      ])
    })

    test("out of range start is preserved", () => {
      const state = { list: [1, 2, 3] }
      const { ops } = createOps(state, (draft) => {
        draft.list.splice(100, 1, 4) // Start beyond array length
      })
      // Original intent preserved
      expect(ops).toEqual([
        { kind: "splice", path: ["list"], index: 100, deleteCount: 1, inserts: [4] },
      ])
    })

    test("negative start beyond array is preserved", () => {
      const state = { list: [1, 2, 3] }
      const { ops } = createOps(state, (draft) => {
        draft.list.splice(-100, 2, 4, 5) // Start way before array
      })
      // Original intent preserved
      expect(ops).toEqual([
        { kind: "splice", path: ["list"], index: -100, deleteCount: 2, inserts: [4, 5] },
      ])
    })

    test("deleteCount exceeding remaining elements is preserved", () => {
      const state = { list: [1, 2, 3] }
      const { ops } = createOps(state, (draft) => {
        draft.list.splice(1, 100) // Delete more than available
      })
      // Original intent preserved
      expect(ops).toEqual([
        { kind: "splice", path: ["list"], index: 1, deleteCount: 100, inserts: [] },
      ])
    })

    test("undefined deleteCount uses array length", () => {
      const state = { list: [1, 2, 3, 4, 5] }
      const { ops } = createOps(state, (draft) => {
        draft.list.splice(2) // No deleteCount means delete to end
      })
      // deleteCount defaults to original array length
      expect(ops).toEqual([
        { kind: "splice", path: ["list"], index: 2, deleteCount: 5, inserts: [] },
      ])
    })
  })

  test("no changes returns empty ops", () => {
    const state = { foo: "bar" }
    const { nextState, ops } = createOps(state, (_draft) => {
      // No mutations
    })

    expect(nextState).toBe(state)
    expect(ops).toEqual([])
  })

  test("ops can be applied with applyOps", () => {
    const state = { a: 1, b: { c: 2 } }
    const { nextState, ops } = createOps(state, (draft) => {
      draft.a = 10
      draft.b.c = 20
    })

    // applyOps mutates in place, so clone first
    const cloned = JSON.parse(JSON.stringify(state))
    applyOps(ops, cloned)
    expect(cloned).toEqual(nextState)
  })
})

describe("original()", () => {
  test("returns original value from draft", () => {
    const state = { foo: "bar" }
    createOps(state, (draft) => {
      draft.foo = "baz"
      expect(original(draft)).toBe(state)
      expect(original(draft).foo).toBe("bar")
    })
  })

  test("throws for non-draft values", () => {
    expect(() => original({ foo: "bar" })).toThrow()
  })
})

describe("current()", () => {
  test("returns current snapshot from draft", () => {
    const state = { foo: "bar", count: 0 }
    createOps(state, (draft) => {
      draft.foo = "baz"
      draft.count = 10

      const snapshot = current(draft)
      expect(snapshot).toEqual({ foo: "baz", count: 10 })
      expect(snapshot).not.toBe(draft)
    })
  })

  test("throws for non-draft values", () => {
    expect(() => current({ foo: "bar" })).toThrow()
  })
})

describe("isDraft()", () => {
  test("returns true for drafts", () => {
    const state = { foo: "bar" }
    createOps(state, (draft) => {
      expect(isDraft(draft)).toBe(true)
      expect(isDraft(draft.foo)).toBe(false) // primitives are not drafts
    })
  })

  test("returns false for non-drafts", () => {
    expect(isDraft({ foo: "bar" })).toBe(false)
    expect(isDraft(null)).toBe(false)
    expect(isDraft(undefined)).toBe(false)
    expect(isDraft(42)).toBe(false)
  })
})

describe("isDraftable()", () => {
  test("plain objects are draftable", () => {
    expect(isDraftable({ foo: "bar" })).toBe(true)
    expect(isDraftable({})).toBe(true)
  })

  test("arrays are draftable", () => {
    expect(isDraftable([1, 2, 3])).toBe(true)
    expect(isDraftable([])).toBe(true)
  })

  test("primitives are not draftable", () => {
    expect(isDraftable(null)).toBe(false)
    expect(isDraftable(undefined)).toBe(false)
    expect(isDraftable(42)).toBe(false)
    expect(isDraftable("string")).toBe(false)
    expect(isDraftable(true)).toBe(false)
  })

  test("class instances are not draftable", () => {
    class Foo {}
    expect(isDraftable(new Foo())).toBe(false)
    expect(isDraftable(new Date())).toBe(false)
    expect(isDraftable(new Map())).toBe(false)
    expect(isDraftable(new Set())).toBe(false)
  })
})

describe("addToSet()", () => {
  test("adds unique value to array", () => {
    const state = { tags: ["a", "b"] }
    const { nextState } = createOps(state, (draft) => {
      addToSet(draft.tags, "c")
    })

    expect(nextState.tags).toEqual(["a", "b", "c"])
  })

  test("does not add duplicate value", () => {
    const state = { tags: ["a", "b"] }
    const { nextState } = createOps(state, (draft) => {
      addToSet(draft.tags, "b") // Already exists
    })

    expect(nextState.tags).toEqual(["a", "b"])
  })

  test("generates addToSet op", () => {
    const state = { tags: ["a"] }
    const { ops } = createOps(state, (draft) => {
      addToSet(draft.tags, "b")
    })

    expect(ops).toEqual([{ kind: "addToSet", path: ["tags"], value: "b" }])
  })
})

describe("deleteFromSet()", () => {
  test("removes value from array", () => {
    const state = { tags: ["a", "b", "c"] }
    const { nextState } = createOps(state, (draft) => {
      deleteFromSet(draft.tags, "b")
    })

    expect(nextState.tags).toEqual(["a", "c"])
  })

  test("handles non-existent value", () => {
    const state = { tags: ["a", "b"] }
    const { nextState } = createOps(state, (draft) => {
      deleteFromSet(draft.tags, "z") // Doesn't exist
    })

    expect(nextState.tags).toEqual(["a", "b"])
  })

  test("generates deleteFromSet op", () => {
    const state = { tags: ["a", "b"] }
    const { ops } = createOps(state, (draft) => {
      deleteFromSet(draft.tags, "b")
    })

    expect(ops).toEqual([{ kind: "deleteFromSet", path: ["tags"], value: "b" }])
  })
})

describe("createOps - deep cloning of values", () => {
  test("assigning nested object and then mutating it captures value at assignment time in ops", () => {
    const state = { data: null as { nested: { value: number } } | null }
    const { ops } = createOps(state, (draft) => {
      // Assign a nested object
      const obj = { nested: { value: 1 } }
      draft.data = obj

      // Mutate the object after assignment
      obj.nested.value = 999
    })

    // The op should have captured the value at assignment time (value: 1), not after mutation
    expect(ops).toEqual([{ kind: "set", path: [], key: "data", value: { nested: { value: 1 } } }])
  })

  test("assigning array and then mutating it captures value at assignment time in ops", () => {
    const state = { items: [] as number[][] }
    const { ops } = createOps(state, (draft) => {
      const arr = [1, 2, 3]
      draft.items.push(arr)

      // Mutate the array after push
      arr.push(999)
    })

    // The splice op should have captured [1, 2, 3], not [1, 2, 3, 999]
    expect(ops).toEqual([
      { kind: "splice", path: ["items"], index: 0, deleteCount: 0, inserts: [[1, 2, 3]] },
    ])
  })

  test("mutating deeply nested assigned object does not affect op value", () => {
    const state = { root: {} as Record<string, unknown> }
    const { ops } = createOps(state, (draft) => {
      const deep = { level1: { level2: { level3: { data: "original" } } } }
      draft.root.deep = deep

      // Mutate at multiple levels
      deep.level1.level2.level3.data = "mutated"
    })

    expect(ops).toEqual([
      {
        kind: "set",
        path: ["root"],
        key: "deep",
        value: { level1: { level2: { level3: { data: "original" } } } },
      },
    ])
  })

  test("ops are independent - applying them produces correct state", () => {
    const state = { data: null as { x: number; y: number } | null }
    const { ops } = createOps(state, (draft) => {
      const point = { x: 10, y: 20 }
      draft.data = point
      point.x = 9999 // Mutate after assignment
    })

    // Apply ops to a fresh state
    const target = { data: null as { x: number; y: number } | null }
    applyOps(ops, target)

    // Should have the original values, not mutated ones
    expect(target.data).toEqual({ x: 10, y: 20 })
  })

  test("multiple assignments capture each value independently", () => {
    const state = { a: null as object | null, b: null as object | null }
    const { ops } = createOps(state, (draft) => {
      const shared = { value: 1 }
      draft.a = shared
      shared.value = 2
      draft.b = shared
      shared.value = 3
    })

    // Each assignment should capture the value at that moment
    expect(ops).toEqual([
      { kind: "set", path: [], key: "a", value: { value: 1 } },
      { kind: "set", path: [], key: "b", value: { value: 2 } },
    ])
  })

  test("splice with existing element reference, mutation, and pop produces consistent state", () => {
    const initial = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const { ops, nextState } = createOps(initial, (draft) => {
      draft.splice(0, 1, draft[2]) // insert an existing element by reference/alias
      // After splice: draft = [{a:3}, {a:2}, {a:3}] with [0] and [2] being the same object
      draft[2].a = 4 // mutates both [0] and [2] because they're the same object
      draft.pop()
    })

    // Apply ops to a fresh copy of the initial state
    const target = [{ a: 1 }, { a: 2 }, { a: 3 }]
    applyOps(ops, target)

    // Both should produce the same result
    // Aliasing is preserved: mutation affects all positions, ops are emitted for all paths
    expect(target).toEqual(nextState)
    expect(nextState).toEqual([{ a: 4 }, { a: 2 }])
  })

  test("push existing element and mutate emits ops for all paths", () => {
    const initial = [{ a: 1 }]
    const { ops, nextState } = createOps(initial, (draft) => {
      draft.push(draft[0]) // d[0] and d[1] are now the same object
      draft[0].a++ // emits ops for both [0].a and [1].a
    })

    // Apply ops to a fresh copy
    const target = [{ a: 1 }]
    applyOps(ops, target)

    // Both positions should have a: 2
    expect(target).toEqual(nextState)
    expect(nextState).toEqual([{ a: 2 }, { a: 2 }])
  })

  test("nested aliasing with push and mutation", () => {
    const initial = { items: [[]] as number[][] }
    const { ops, nextState } = createOps(initial, (draft) => {
      draft.items.push(draft.items[0]) // items[0] and items[1] are same array
      draft.items[1].push(1) // emits splice for both items[0] and items[1]
    })

    // Apply ops
    const target = { items: [[]] as number[][] }
    applyOps(ops, target)

    // Both arrays should have [1]
    expect(target).toEqual(nextState)
    expect(nextState).toEqual({ items: [[1], [1]] })
  })
})

describe("aliasCount tracking", () => {
  test("newly created draft starts with aliasCount = 1", () => {
    const state = { nested: { value: 1 } }
    createOps(state, (draft) => {
      const nestedDraft = getProxyDraft(draft.nested)
      expect(nestedDraft).not.toBeNull()
      expect(nestedDraft!.aliasCount).toBe(1)
    })
  })

  test("pushing a draft increments its aliasCount", () => {
    const state = { arr: [] as object[], obj: { value: 1 } }
    createOps(state, (draft) => {
      const objDraft = getProxyDraft(draft.obj)
      expect(objDraft!.aliasCount).toBe(1)

      draft.arr.push(draft.obj)
      expect(objDraft!.aliasCount).toBe(2)
    })
  })

  test("assigning a draft to new property increments aliasCount", () => {
    const state = { a: { value: 1 }, b: null as object | null }
    createOps(state, (draft) => {
      const aDraft = getProxyDraft(draft.a)
      expect(aDraft!.aliasCount).toBe(1)

      draft.b = draft.a
      expect(aDraft!.aliasCount).toBe(2)
    })
  })

  test("pop decrements aliasCount of removed element", () => {
    const state = { arr: [{ value: 1 }] }
    createOps(state, (draft) => {
      const elemDraft = getProxyDraft(draft.arr[0])
      expect(elemDraft!.aliasCount).toBe(1)

      draft.arr.pop()
      expect(elemDraft!.aliasCount).toBe(0)
    })
  })

  test("shift decrements aliasCount of removed element", () => {
    const state = { arr: [{ value: 1 }, { value: 2 }] }
    createOps(state, (draft) => {
      const firstDraft = getProxyDraft(draft.arr[0])
      expect(firstDraft!.aliasCount).toBe(1)

      draft.arr.shift()
      expect(firstDraft!.aliasCount).toBe(0)
    })
  })

  test("splice removes and adds track aliasCount correctly", () => {
    const state = { arr: [{ a: 1 }, { a: 2 }, { a: 3 }], extra: { a: 4 } }
    createOps(state, (draft) => {
      const elem0 = getProxyDraft(draft.arr[0])
      const elem1 = getProxyDraft(draft.arr[1])
      const extra = getProxyDraft(draft.extra)

      expect(elem0!.aliasCount).toBe(1)
      expect(elem1!.aliasCount).toBe(1)
      expect(extra!.aliasCount).toBe(1)

      // Remove elem0 and elem1, insert extra
      draft.arr.splice(0, 2, draft.extra)

      expect(elem0!.aliasCount).toBe(0) // removed
      expect(elem1!.aliasCount).toBe(0) // removed
      expect(extra!.aliasCount).toBe(2) // now at extra AND arr[0]
    })
  })

  test("delete decrements aliasCount", () => {
    const state = { a: { value: 1 } } as { a?: { value: number } }
    createOps(state, (draft) => {
      const aDraft = getProxyDraft(draft.a)
      expect(aDraft!.aliasCount).toBe(1)

      delete draft.a
      expect(aDraft!.aliasCount).toBe(0)
    })
  })

  test("replacing a property decrements old and increments new aliasCount", () => {
    const state = { prop: { old: true }, other: { new: true } }
    createOps(state, (draft) => {
      const oldDraft = getProxyDraft(draft.prop)
      const newDraft = getProxyDraft(draft.other)

      expect(oldDraft!.aliasCount).toBe(1)
      expect(newDraft!.aliasCount).toBe(1)

      ;(draft as Record<string, unknown>).prop = draft.other

      expect(oldDraft!.aliasCount).toBe(0)
      expect(newDraft!.aliasCount).toBe(2)
    })
  })

  test("multiple aliasing tracks correctly", () => {
    const state = { arr: [] as object[], obj: { x: 1 } }
    createOps(state, (draft) => {
      const objDraft = getProxyDraft(draft.obj)

      draft.arr.push(draft.obj) // aliasCount = 2
      draft.arr.push(draft.obj) // aliasCount = 3
      draft.arr.push(draft.obj) // aliasCount = 4

      expect(objDraft!.aliasCount).toBe(4)

      draft.arr.pop() // aliasCount = 3
      expect(objDraft!.aliasCount).toBe(3)
    })
  })
})

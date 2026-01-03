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

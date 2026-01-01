import { describe, expect, it } from "vitest"
import { applyTx, Op } from "../src/operations"

describe("Mutable Mode & Rollback", () => {
  it("modifies state in-place when immutable=false", () => {
    const state = { count: 0 }
    const ops: Op[] = [{ kind: "set", path: [], key: "count", value: 1 }]

    const newState = applyTx(state, ops, undefined, false)

    expect(newState).toBe(state) // Same reference
    expect(state).toEqual({ count: 1 })
  })

  it("creates new state reference when immutable=true", () => {
    const state = { count: 0 }
    const ops: Op[] = [{ kind: "set", path: [], key: "count", value: 1 }]

    const newState = applyTx(state, ops, undefined, true)

    expect(newState).not.toBe(state) // New reference
    expect(newState).toEqual({ count: 1 })
    expect(state).toEqual({ count: 0 }) // Original untouched
  })

  describe("Rollback Mechanism", () => {
    const alwaysFail = () => false

    it("rolls back 'set' operations", () => {
      const state = { a: 1, b: 2 }
      const ops: Op[] = [
        { kind: "set", path: [], key: "a", value: 10 },
        { kind: "set", path: [], key: "b", value: 20 },
        { kind: "set", path: [], key: "c", value: 30 }, // new property
      ]

      applyTx(state, ops, alwaysFail, false)

      expect(state).toEqual({ a: 1, b: 2 })
      expect("c" in state).toBe(false)
    })

    it("rolls back 'delete' operations", () => {
      const state = { a: 1, b: 2 }
      const ops: Op[] = [{ kind: "delete", path: [], key: "a" }]

      applyTx(state, ops, alwaysFail, false)

      expect(state).toEqual({ a: 1, b: 2 })
    })

    it("rolls back 'splice' operations (insert & delete)", () => {
      const state = { list: [1, 2, 3] }
      // Remove 2 (index 1), Insert 99, 100
      const ops: Op[] = [
        { kind: "splice", path: ["list"], index: 1, deleteCount: 1, inserts: [99, 100] },
      ]

      applyTx(state, ops, alwaysFail, false)

      expect(state).toEqual({ list: [1, 2, 3] })
    })

    it("rolls back 'addToSet' operations (including optimized pop path)", () => {
      const state = { tags: ["a", "b"] }
      const ops: Op[] = [
        { kind: "addToSet", path: ["tags"], value: "c" }, // Should be popped
        { kind: "addToSet", path: ["tags"], value: "a" }, // No-op, should do nothing on undo
      ]

      applyTx(state, ops, alwaysFail, false)

      expect(state.tags).toEqual(["a", "b"])
    })

    it("rolls back 'deleteFromSet' operations", () => {
      const state = { tags: ["a", "b", "c", "b"] }
      const ops: Op[] = [
        { kind: "deleteFromSet", path: ["tags"], value: "b" }, // Removes both 'b's
      ]

      applyTx(state, ops, alwaysFail, false)

      expect(state.tags).toEqual(["a", "b", "c", "b"])
    })

    it("rolls back complex mixed txs", () => {
      const state = {
        users: [{ id: 1, name: "Alice" }],
        config: { theme: "dark" },
        metrics: [10, 20],
      }

      const ops: Op[] = [
        { kind: "set", path: ["config"], key: "theme", value: "light" },
        {
          kind: "splice",
          path: ["users"],
          index: 0,
          deleteCount: 0,
          inserts: [{ id: 2, name: "Bob" }],
        },
        { kind: "addToSet", path: ["metrics"], value: 30 },
        { kind: "delete", path: ["config"], key: "unknown" }, // no-op delete
      ]

      applyTx(state, ops, alwaysFail, false)

      expect(state).toEqual({
        users: [{ id: 1, name: "Alice" }],
        config: { theme: "dark" },
        metrics: [10, 20],
      })
    })

    it("rolls back 'set' on non-existent parent throws but is safe?", () => {
      // Technically this should throw validation error before mutation if path is invalid?
      // But applyOp checks resolvePath.
      // If resolvePath fails, it throws 'failure'.
      // applyTx catches error and returns null.
      // The undo stack should rollback any applied ops before the error.
      const state = { a: 1 }
      const ops: Op[] = [
        { kind: "set", path: [], key: "a", value: 2 },
        { kind: "set", path: ["missing"], key: "x", value: 1 }, // Will throw
      ]

      // This implicitly tests that if an error occurs mid-tx, rollback happens
      const res = applyTx(state, ops, undefined, false)

      expect(res).toBeNull() // Failed tx returns null
      expect(state).toEqual({ a: 1 }) // Should have rolled back the first op
    })
  })
})

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import * as Y from "yjs"
import {
  createStateSyncLog,
  getSortedTxsSymbol,
  type StateSyncLogController,
} from "../src/createStateSyncLog"

import type { JSONObject, JSONRecord, JSONValue, Path } from "../src/json"
import type { Op } from "../src/operations"

/**
 * Random helpers using Math.random()
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)]
}

/**
 * Gets the value at a path in a JSON object.
 */
function getAtPath(obj: JSONValue, path: Path): JSONValue | undefined {
  let current: JSONValue = obj
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || segment < 0 || segment >= current.length) {
        return undefined
      }
      current = current[segment]
    } else {
      if (typeof segment !== "string") return undefined
      current = (current as JSONRecord)[segment]
    }
  }
  return current
}

/**
 * Selects a random path that points to an object (for set/delete operations).
 * At each level, 50% chance to go deeper.
 */
function selectRandomObjectPath(obj: JSONObject): Path {
  const path: (string | number)[] = []
  let current: JSONValue = obj
  let depth = 0
  const maxDepth = 8

  while (depth < maxDepth) {
    // Check if current is an object (not array, not primitive)
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      if (path.length > 0) path.pop()
      break
    }

    // 30% chance to stop at current level (more likely to go deeper)
    if (Math.random() < 0.2) break

    const keys: string[] = Object.keys(current)
    if (keys.length === 0) break

    const key: string = keys[randomInt(0, keys.length - 1)]
    const next: JSONValue = (current as JSONRecord)[key]

    // Only go deeper if next is also an object
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      path.push(key)
      current = next
      depth++
    } else {
      break
    }
  }

  return path
}

/**
 * Selects a random path that points to an array (for splice/addToSet operations).
 * At each level, 50% chance to go deeper.
 */
function selectRandomArrayPath(obj: JSONObject): Path | null {
  const path: (string | number)[] = []
  let current: JSONValue = obj
  let depth = 0
  const maxDepth = 8
  let foundArray = false

  while (depth < maxDepth) {
    if (Array.isArray(current)) {
      foundArray = true
      // 30% chance to stop here (more likely to go deeper into array element)
      if (Math.random() < 0.2 || current.length === 0) break

      const index = randomInt(0, current.length - 1)
      const next: JSONValue = current[index]
      if (Array.isArray(next)) {
        path.push(index)
        current = next
        depth++
      } else {
        break
      }
    } else if (current !== null && typeof current === "object") {
      const keys: string[] = Object.keys(current)
      if (keys.length === 0) break

      const key: string = keys[randomInt(0, keys.length - 1)]
      const next: JSONValue = (current as JSONRecord)[key]
      path.push(key)
      current = next
      depth++
    } else {
      break
    }
  }

  return foundArray || Array.isArray(current) ? path : null
}

/**
 * Generates a random primitive value.
 */
function randomPrimitive(): JSONValue {
  const type = randomInt(0, 5)
  switch (type) {
    case 0:
      return randomInt(-100, 100)
    case 1:
      return `str_${randomInt(0, 1000)}`
    case 2:
      return Math.random() > 0.5
    case 3:
      return null
    default:
      return randomInt(0, 1000)
  }
}

/**
 * Generates a random value (primitive, object, or array).
 */
function randomValue(depth = 0): JSONValue {
  // Allow deeper nesting (up to 6 levels) with 50% chance to create complex values
  if (depth > 6 || Math.random() < 0.5) {
    return randomPrimitive()
  }

  if (Math.random() < 0.5) {
    const obj: JSONObject = {}
    const numKeys = randomInt(1, 4) // More keys
    for (let i = 0; i < numKeys; i++) {
      obj[`k${randomInt(0, 50)}`] = randomValue(depth + 1)
    }
    return obj
  } else {
    const arr: JSONValue[] = []
    const numItems = randomInt(1, 4) // More items
    for (let i = 0; i < numItems; i++) {
      arr.push(randomValue(depth + 1))
    }
    return arr
  }
}

/**
 * Generates a random key name.
 */
function randomKey(): string {
  return `key_${randomInt(0, 20)}`
}

/**
 * Generates a valid random operation for the current state.
 */
function generateRandomOp(state: JSONObject): Op | null {
  const opType = randomInt(0, 6) // All 7 operation types

  switch (opType) {
    case 0: {
      // SET on object
      const path = selectRandomObjectPath(state)
      return {
        kind: "set",
        path,
        key: randomKey(),
        value: randomValue(),
      }
    }

    case 1: {
      // DELETE from object
      const path = selectRandomObjectPath(state)
      const obj = getAtPath(state, path)
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
      const keys = Object.keys(obj)
      if (keys.length === 0) return null
      return {
        kind: "delete",
        path,
        key: pick(keys),
      }
    }

    case 2: {
      // SPLICE on array (insert)
      const path = selectRandomArrayPath(state)
      if (!path) {
        // Create an array first
        const objPath = selectRandomObjectPath(state)
        return {
          kind: "set",
          path: objPath,
          key: randomKey(),
          value: [randomPrimitive()],
        }
      }
      const arr = getAtPath(state, path)
      if (!Array.isArray(arr)) return null
      const index = randomInt(0, arr.length)
      return {
        kind: "splice",
        path,
        index,
        deleteCount: 0,
        inserts: [randomValue()],
      }
    }

    case 3: {
      // SPLICE on array (delete)
      const path = selectRandomArrayPath(state)
      if (!path) return null
      const arr = getAtPath(state, path)
      if (!Array.isArray(arr) || arr.length === 0) return null
      const index = randomInt(0, arr.length - 1)
      const deleteCount = randomInt(1, Math.min(3, arr.length - index))
      return {
        kind: "splice",
        path,
        index,
        deleteCount,
        inserts: [],
      }
    }

    case 4: {
      // SPLICE on array (replace)
      const path = selectRandomArrayPath(state)
      if (!path) return null
      const arr = getAtPath(state, path)
      if (!Array.isArray(arr) || arr.length === 0) return null
      const index = randomInt(0, arr.length - 1)
      return {
        kind: "splice",
        path,
        index,
        deleteCount: 1,
        inserts: [randomValue()],
      }
    }

    case 5: {
      // ADD_TO_SET
      const path = selectRandomArrayPath(state)
      if (!path) {
        // Create an array first
        const objPath = selectRandomObjectPath(state)
        return {
          kind: "set",
          path: objPath,
          key: randomKey(),
          value: [],
        }
      }
      return {
        kind: "addToSet",
        path,
        value: randomPrimitive(),
      }
    }

    case 6: {
      // DELETE_FROM_SET
      const path = selectRandomArrayPath(state)
      if (!path) return null
      const arr = getAtPath(state, path)
      if (!Array.isArray(arr) || arr.length === 0) return null
      // Pick a random value from the array to delete
      const value = arr[randomInt(0, arr.length - 1)]
      return {
        kind: "deleteFromSet",
        path,
        value,
      }
    }

    default:
      return null
  }
}

function syncConnectedClients(docs: Y.Doc[], connected: boolean[]): void {
  const connectedDocs = docs.filter((_, i) => connected[i])
  if (connectedDocs.length < 2) return

  // Sync until convergence - processing updates can trigger new updates (re-emits)
  let changed = true
  while (changed) {
    changed = false
    const updates = connectedDocs.map((doc) => Y.encodeStateAsUpdate(doc))
    for (let i = 0; i < connectedDocs.length; i++) {
      for (let j = 0; j < updates.length; j++) {
        if (i !== j) {
          const stateBefore = Y.encodeStateVector(connectedDocs[i])
          Y.applyUpdate(connectedDocs[i], updates[j])
          const stateAfter = Y.encodeStateVector(connectedDocs[i])
          // Check if state vector changed
          if (!arraysEqual(stateBefore, stateAfter)) {
            changed = true
          }
        }
      }
    }
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Ensures all connected clients have the same state.
 */
function expectConnectedToSync(logs: StateSyncLogController<JSONObject>[], connected: boolean[]) {
  const connectedIndices = connected.map((c, i) => (c ? i : -1)).filter((i) => i !== -1)

  if (connectedIndices.length < 2) return

  const firstState = logs[connectedIndices[0]].getState()
  for (let i = 1; i < connectedIndices.length; i++) {
    const idx = connectedIndices[i]
    try {
      expect(logs[idx].getState()).toStrictEqual(firstState)
    } catch (e) {
      console.error(`Divergence detected between client ${connectedIndices[0]} and ${idx}!`)
      throw e
    }
  }
}

type FuzzyAction =
  | { type: "init"; clientIndex: number; ops: Op[] }
  | { type: "network"; connected: boolean[] }
  | { type: "compact"; clientIndex: number }
  | { type: "emit"; clientIndex: number; op: Op }

describe("Fuzzy Sync", () => {
  it("three clients with random operations, connectivity, and compaction converge", () => {
    // Standardize logPath to the project package root
    const logPath = path.resolve(__dirname, "../fuzzy_failure.json")
    const isReplay = fs.existsSync(logPath)
    const currentRunActions: FuzzyAction[] = []

    const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()]
    const clientIds = ["A", "B", "C"]

    const logs: StateSyncLogController<JSONObject>[] = docs.map((doc, i) =>
      createStateSyncLog<JSONObject>({
        yDoc: doc,
        clientId: clientIds[i],
        retentionWindowMs: undefined,
      })
    )

    const connected = [false, false, false]

    try {
      if (isReplay) {
        console.log(`Replaying from ${logPath}...`)

        const actionsToReplay: FuzzyAction[] = JSON.parse(fs.readFileSync(logPath, "utf8"))
        let actionIdx = 0
        for (const action of actionsToReplay) {
          console.log(`Action ${actionIdx}: ${action.type}`)
          currentRunActions.push(action)
          switch (action.type) {
            case "init":
              logs[action.clientIndex].emit(action.ops)
              break
            case "network":
              for (let i = 0; i < connected.length; i++) {
                connected[i] = action.connected[i]
              }
              break
            case "compact":
              logs[action.clientIndex].compact()
              break
            case "emit":
              try {
                logs[action.clientIndex].emit([action.op])
              } catch {
                // Operation might fail due to validation
              }
              break
          }

          syncConnectedClients(docs, connected)

          if (connected.every(Boolean)) {
            try {
              const s0 = logs[0].getState()
              const s1 = logs[1].getState()
              const s2 = logs[2].getState()
              expect(s0).toStrictEqual(s1)
              expect(s1).toStrictEqual(s2)
            } catch (e) {
              console.error(`Divergence detected WHILE CONNECTED at Action ${actionIdx}!`)
              const getInfo = (idx: number) => {
                const log = logs[idx]
                const sortedTxs = log[getSortedTxsSymbol]()
                return {
                  clientId: clientIds[idx],
                  activeEpoch: log.getActiveEpoch(),
                  txKeysCount: sortedTxs.length,
                  firstTx: sortedTxs[0]?.txTimestampKey,
                  lastTx: sortedTxs.slice(-1)[0]?.txTimestampKey,
                  // Show the full set of canonical keys applied to see which ones are missing/extra
                  canonicalKeys: sortedTxs.map((t) => t.dedupTxTimestampKey),
                }
              }
              const infoA = getInfo(0)
              const infoB = getInfo(1)
              const infoC = getInfo(2)
              console.error(
                "Client A Info:",
                JSON.stringify({ ...infoA, canonicalKeys: undefined }, null, 2)
              )
              console.error(
                "Client B Info:",
                JSON.stringify({ ...infoB, canonicalKeys: undefined }, null, 2)
              )
              console.error(
                "Client C Info:",
                JSON.stringify({ ...infoC, canonicalKeys: undefined }, null, 2)
              )

              // Compare canonical keys
              const keysA = new Set(infoA.canonicalKeys)
              const keysB = new Set(infoB.canonicalKeys)
              const keysC = new Set(infoC.canonicalKeys)

              const onlyA = infoA.canonicalKeys.filter((k) => !keysB.has(k) || !keysC.has(k))
              const onlyB = infoB.canonicalKeys.filter((k) => !keysA.has(k) || !keysC.has(k))
              const onlyC = infoC.canonicalKeys.filter((k) => !keysA.has(k) || !keysB.has(k))

              if (onlyA.length > 0) console.error("Keys only on A:", onlyA)
              if (onlyB.length > 0) console.error("Keys only on B:", onlyB)
              if (onlyC.length > 0) console.error("Keys only on C:", onlyC)

              throw e
            }
          }

          actionIdx++
        }
      } else {
        const OPS_PER_CLIENT = 1000
        const CONNECT_DISCONNECT_RATIO = 100
        const COMPACT_RATIO = 300

        // Initialize each client with a more complex base state
        for (let i = 0; i < 3; i++) {
          const ops: Op[] = [
            {
              kind: "set",
              path: [],
              key: "users",
              value: { active: {}, archived: {} },
            },
            {
              kind: "set",
              path: [],
              key: "posts",
              value: [],
            },
            {
              kind: "set",
              path: [],
              key: "config",
              value: { settings: { theme: {}, notifications: {} }, metadata: {} },
            },
            {
              kind: "set",
              path: [],
              key: "cache",
              value: { items: [], lookup: {} },
            },
          ]
          logs[i].emit(ops)
          currentRunActions.push({ type: "init", clientIndex: i, ops })
        }

        const totalOps = OPS_PER_CLIENT * 3
        let opCount = 0

        while (opCount < totalOps) {
          const clientIndex = opCount % 3

          if (Math.random() < 1 / CONNECT_DISCONNECT_RATIO) {
            const targetClient = randomInt(0, 2)
            connected[targetClient] = !connected[targetClient]
            syncConnectedClients(docs, connected)
            currentRunActions.push({ type: "network", connected: [...connected] })
          }

          if (Math.random() < 1 / COMPACT_RATIO) {
            logs[clientIndex].compact()
            expectConnectedToSync(logs, connected)
            currentRunActions.push({ type: "compact", clientIndex })
          }

          const state = logs[clientIndex].getState()
          const op = generateRandomOp(state)

          if (op) {
            try {
              logs[clientIndex].emit([op])
              currentRunActions.push({ type: "emit", clientIndex, op })
            } catch {
              // Operation might fail due to validation
            }
          }

          syncConnectedClients(docs, connected)
          opCount++
        }

        connected[0] = true
        connected[1] = true
        connected[2] = true
        syncConnectedClients(docs, connected)
        currentRunActions.push({ type: "network", connected: [...connected] })
      }

      // Final synchronization rounds (common to both paths)
      // Ensure ALL clients are connected before final sync
      connected[0] = true
      connected[1] = true
      connected[2] = true
      for (let round = 0; round < 10; round++) {
        syncConnectedClients(docs, connected)
      }

      const stateA = logs[0].getState()
      const stateB = logs[1].getState()
      const stateC = logs[2].getState()

      expect(stateA).toStrictEqual(stateB)
      expect(stateB).toStrictEqual(stateC)

      // If we reach here, the test passed. Cleanup the failure log if it exists.
      if (isReplay && fs.existsSync(logPath)) {
        fs.unlinkSync(logPath)
        console.log(`Fuzzy test passed. Deleted ${logPath}.`)
      }
    } catch (e) {
      // Only write failure log if one doesn't already exist (preserve original failure)
      if (!isReplay && !fs.existsSync(logPath)) {
        console.error(`Fuzzy test failed! Writing actions log to ${logPath}`)
        fs.writeFileSync(logPath, JSON.stringify(currentRunActions, null, 2))
      } else {
        console.error(`Fuzzy test failed! Preserving existing failure log at ${logPath}`)
      }
      throw e
    }
  }, 120_000)
})

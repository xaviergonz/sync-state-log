/**
 * Proxy draft implementation.
 * Adapted from mutative - removed Map/Set/unsafe/mark support.
 * Modified to use eager op logging - ops are pushed immediately when mutations happen.
 */

import { parseArrayIndex } from "../utils"
import { PROXY_DRAFT } from "./constant"
import { DraftType, type Finalities, type JSONValue, type Op, type ProxyDraft } from "./interface"
import { pushOp } from "./pushOp"
import {
  deepClone,
  ensureShallowCopy,
  get,
  getDescriptor,
  getPathOrThrow,
  getProxyDraft,
  getType,
  getValue,
  handleValue,
  has,
  isDraft,
  isDraftable,
  isEqual,
  latest,
  markChanged,
  peek,
  revokeProxy,
  set,
} from "./utils"

// Note: getValue is used in finalizeDraft, deepClone uses it internally for drafts

/**
 * Increment aliasCount for a draft (if the value is a draft).
 */
function incAliasCount(value: unknown): void {
  const draft = getProxyDraft(value)
  if (draft) draft.aliasCount++
}

/**
 * Decrement aliasCount for a draft (if the value is a draft).
 */
function decAliasCount(value: unknown): void {
  const draft = getProxyDraft(value)
  if (draft) draft.aliasCount--
}

/**
 * Normalize an array index like native array methods do.
 * Handles negative indices and clamps to [0, len].
 * @param index - The index to normalize (can be negative or undefined)
 * @param len - The array length
 * @param defaultValue - Value to use if index is undefined (typically 0 or len)
 */
function normalizeIndex(index: number | undefined, len: number, defaultValue: number): number {
  if (index === undefined) return defaultValue
  return index < 0 ? Math.max(len + index, 0) : Math.min(index, len)
}

/**
 * Array methods that mutate the array and need to be intercepted for eager op logging.
 */
const MUTATING_ARRAY_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
])

/**
 * Create a wrapped array method that logs ops eagerly.
 * @param proxyDraft - The ProxyDraft for the array (used for ops and state)
 * @param proxyRef - The actual proxy (used to access elements as drafts)
 * @param method - The method name being wrapped
 */
function createArrayMethodWrapper(
  proxyDraft: ProxyDraft,
  proxyRef: unknown,
  method: string
): (...args: unknown[]) => unknown {
  return function (this: unknown[], ...args: unknown[]): unknown {
    ensureShallowCopy(proxyDraft)
    markChanged(proxyDraft)

    const arr = proxyDraft.copy as unknown[]
    const originalLength = arr.length
    const proxy = proxyRef as unknown[]

    switch (method) {
      case "push": {
        // push(items...) -> splice at end
        // Track aliasCount for drafts being inserted
        for (const arg of args) {
          incAliasCount(arg)
        }
        // Store raw values in array (preserving aliasing in the draft)
        const result = arr.push(...args)
        // Clone for the op (capture value at this moment)
        pushOp(proxyDraft, {
          kind: "splice",
          path: getPathOrThrow(proxyDraft),
          index: originalLength,
          deleteCount: 0,
          inserts: args.map(deepClone) as JSONValue[],
        })
        return result
      }

      case "pop": {
        if (originalLength === 0) {
          return arr.pop()
        }
        // Get the element through the proxy to ensure it's a draft if draftable
        const returnValue = proxy[originalLength - 1]
        // Track aliasCount for draft being removed
        decAliasCount(arr[originalLength - 1])
        // Now perform the actual mutation
        arr.pop()
        pushOp(proxyDraft, {
          kind: "splice",
          path: getPathOrThrow(proxyDraft),
          index: originalLength - 1,
          deleteCount: 1,
          inserts: [],
        })
        return returnValue
      }

      case "shift": {
        if (originalLength === 0) {
          return arr.shift()
        }
        // Get the element through the proxy to ensure it's a draft if draftable
        const returnValue = proxy[0]
        // Track aliasCount for draft being removed
        decAliasCount(arr[0])
        // Now perform the actual mutation
        arr.shift()
        pushOp(proxyDraft, {
          kind: "splice",
          path: getPathOrThrow(proxyDraft),
          index: 0,
          deleteCount: 1,
          inserts: [],
        })
        return returnValue
      }

      case "unshift": {
        // Track aliasCount for drafts being inserted
        for (const arg of args) {
          incAliasCount(arg)
        }
        // Store raw values in array (preserving aliasing in the draft)
        const result = arr.unshift(...args)
        // Clone for the op (capture value at this moment)
        pushOp(proxyDraft, {
          kind: "splice",
          path: getPathOrThrow(proxyDraft),
          index: 0,
          deleteCount: 0,
          inserts: args.map(deepClone) as JSONValue[],
        })
        return result
      }

      case "splice": {
        const start = args[0] as number | undefined
        const deleteCountArg = args[1] as number | undefined
        const inserts = args.slice(2)

        // Normalize start index to get elements through proxy
        const index =
          start === undefined ? 0 : start < 0 ? Math.max(originalLength + start, 0) : start
        const deleteCount = deleteCountArg ?? originalLength - index

        // Get elements through proxy to ensure they're drafts if draftable
        const returnValues: unknown[] = []
        for (let i = 0; i < deleteCount && index + i < originalLength; i++) {
          returnValues.push(proxy[index + i])
          // Track aliasCount for drafts being removed
          decAliasCount(arr[index + i])
        }

        // Track aliasCount for drafts being inserted
        for (const insert of inserts) {
          incAliasCount(insert)
        }
        // Store raw values in array (preserving aliasing in the draft)
        ;(arr.splice as (...args: unknown[]) => unknown[])(...args)

        // Clone for the op (capture value at this moment)
        pushOp(proxyDraft, {
          kind: "splice",
          path: getPathOrThrow(proxyDraft),
          index: start ?? 0,
          deleteCount: deleteCountArg ?? originalLength,
          inserts: inserts.map(deepClone) as JSONValue[],
        })
        return returnValues
      }

      case "fill": {
        const fillValue = args[0]
        const startArg = args[1] as number | undefined
        const endArg = args[2] as number | undefined

        const len = originalLength
        const start = normalizeIndex(startArg, len, 0)
        const end = normalizeIndex(endArg, len, len)

        // Use proxy splice to replace the range (handles aliasCount and generates splice op)
        const fillCount = end - start
        if (fillCount > 0) {
          const fillValues = Array(fillCount).fill(fillValue)
          proxy.splice(start, fillCount, ...fillValues)
        }

        return proxy
      }

      case "sort": {
        const compareFn = args[0] as ((a: unknown, b: unknown) => number) | undefined
        // Sort a copy to get the sorted order, then use proxy splice
        const sorted = [...arr].sort(compareFn)
        if (originalLength > 0) {
          proxy.splice(0, originalLength, ...sorted)
        }
        return proxy
      }

      case "reverse": {
        // Reverse a copy to get the reversed order, then use proxy splice
        const reversed = [...arr].reverse()
        if (originalLength > 0) {
          proxy.splice(0, originalLength, ...reversed)
        }
        return proxy
      }

      case "copyWithin": {
        const targetArg = args[0] as number
        const startArg = args[1] as number | undefined
        const endArg = args[2] as number | undefined

        const len = originalLength
        const targetIdx = normalizeIndex(targetArg, len, 0)
        const startIdx = normalizeIndex(startArg, len, 0)
        const endIdx = normalizeIndex(endArg, len, len)

        // Calculate how many elements will be copied
        const copyCount = Math.min(endIdx - startIdx, len - targetIdx)

        if (copyCount > 0) {
          // Get the elements that will be copied (from the source range)
          const elementsToCopy = arr.slice(startIdx, startIdx + copyCount)
          // Use proxy splice to replace just the affected range
          proxy.splice(targetIdx, copyCount, ...elementsToCopy)
        }

        return proxy
      }

      default:
        return (arr as unknown as Record<string, (...args: unknown[]) => unknown>)[method](...args)
    }
  }
}

/**
 * Proxy handler for drafts
 */
const proxyHandler: ProxyHandler<ProxyDraft> = {
  get(target: ProxyDraft, key: PropertyKey, receiver: unknown) {
    // Return cached draft if available
    const copy = target.copy?.[key as keyof typeof target.copy]
    if (copy && target.finalities.draftsCache.has(copy as object)) {
      return copy
    }

    // Return the ProxyDraft itself when accessing the symbol
    if (key === PROXY_DRAFT) return target

    const source = latest(target)

    // Intercept mutating array methods for eager op logging
    if (
      target.type === DraftType.Array &&
      typeof key === "string" &&
      MUTATING_ARRAY_METHODS.has(key)
    ) {
      const originalMethod = (source as unknown[])[key as keyof unknown[]]
      if (typeof originalMethod === "function") {
        return createArrayMethodWrapper(target, receiver, key)
      }
    }

    // Property doesn't exist - check prototype chain
    if (!has(source, key)) {
      const desc = getDescriptor(source, key)
      return desc ? ("value" in desc ? desc.value : desc.get?.call(target.proxy)) : undefined
    }

    const value = (source as Record<PropertyKey, unknown>)[key]

    // Already finalized or not draftable - return as-is
    if (target.finalized || !isDraftable(value)) {
      return value
    }

    // If value is same as original, create a nested draft
    if (value === peek(target.original, key)) {
      ensureShallowCopy(target)
      const nestedKey = target.type === DraftType.Array ? Number(key) : key
      ;(target.copy as Record<PropertyKey, unknown>)[key] = createDraft({
        original: (target.original as Record<PropertyKey, unknown>)[key] as object,
        parentDraft: target,
        key: nestedKey as string | number,
        finalities: target.finalities,
      })
      return (target.copy as Record<PropertyKey, unknown>)[key]
    }

    // Cache drafts that were assigned
    if (isDraft(value)) {
      target.finalities.draftsCache.add(value as object)
    }

    return value
  },

  set(target: ProxyDraft, key: PropertyKey, value: unknown) {
    if (typeof key === "symbol") {
      throw new Error(`Cannot set symbol properties on drafts`)
    }

    // For arrays, convert and validate the key
    let opKey: string | number = key as string | number
    if (target.type === DraftType.Array) {
      if (key === "length") {
        opKey = "length"
      } else {
        const numKey = typeof key === "number" ? key : parseArrayIndex(key as string)
        if (numKey === null) {
          throw new Error(`Only supports setting array indices and the 'length' property.`)
        }
        opKey = numKey

        // Check for sparse array creation
        const source = latest(target) as unknown[]
        if (numKey > source.length) {
          throw new Error(
            `Cannot create sparse array. Index ${numKey} is out of bounds for array of length ${source.length}.`
          )
        }
      }
    }

    // Handle setter from prototype
    const desc = getDescriptor(latest(target), key)
    if (desc?.set) {
      desc.set.call(target.proxy, value)
      return true
    }

    const current = peek(latest(target), key)
    const currentProxyDraft = getProxyDraft(current)

    // If assigning original draftable value back to its draft, just mark as not assigned
    if (currentProxyDraft && isEqual(currentProxyDraft.original, value)) {
      ;(target.copy as Record<PropertyKey, unknown>)[key] = value
      target.assignedMap = target.assignedMap ?? new Map()
      target.assignedMap.set(key, false)
      return true
    }

    // No change - skip
    if (isEqual(value, current) && (value !== undefined || has(target.original, key))) {
      return true
    }

    ensureShallowCopy(target)
    markChanged(target)

    // Track assignment (still needed for finalization to know what changed)
    if (
      has(target.original, key) &&
      isEqual(value, (target.original as Record<PropertyKey, unknown>)[key])
    ) {
      // Reverting to original value - still log the op since we're doing eager logging
      target.assignedMap!.delete(key)
    } else {
      target.assignedMap!.set(key, true)
    }

    // Track aliasCount and update copy
    const copy = target.copy as Record<PropertyKey, unknown>
    decAliasCount(copy[key])
    incAliasCount(value)
    copy[key] = value

    // Eager op logging for set operations
    if (target.type === DraftType.Array && opKey === "length") {
      const oldLength = (target.original as unknown[]).length
      const newLength = value as number
      if (newLength !== oldLength) {
        // Length change - always use set op to capture intent
        pushOp(target, {
          kind: "set",
          path: getPathOrThrow(target),
          key: "length",
          value: newLength,
        })
      }
    } else {
      // Regular property set - use opKey (numeric for arrays)
      pushOp(target, {
        kind: "set",
        path: getPathOrThrow(target),
        key: opKey,
        value: deepClone(value) as JSONValue,
      })
    }

    return true
  },

  has(target: ProxyDraft, key: PropertyKey) {
    return key in latest(target)
  },

  ownKeys(target: ProxyDraft) {
    return Reflect.ownKeys(latest(target))
  },

  getOwnPropertyDescriptor(target: ProxyDraft, key: PropertyKey) {
    const source = latest(target)
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key)
    if (!descriptor) return descriptor
    return {
      writable: true,
      configurable: target.type !== DraftType.Array || key !== "length",
      enumerable: descriptor.enumerable,
      value: (source as Record<PropertyKey, unknown>)[key],
    }
  },

  getPrototypeOf(target: ProxyDraft) {
    return Reflect.getPrototypeOf(target.original as object)
  },

  setPrototypeOf() {
    throw new Error(`Cannot call 'setPrototypeOf()' on drafts`)
  },

  defineProperty() {
    throw new Error(`Cannot call 'defineProperty()' on drafts`)
  },

  deleteProperty(target: ProxyDraft, key: PropertyKey) {
    if (typeof key === "symbol") {
      throw new Error(`Cannot delete symbol properties from drafts`)
    }

    if (target.type === DraftType.Array) {
      // For arrays, deleting a property sets it to undefined
      return proxyHandler.set!.call(this, target, key as string | symbol, undefined, target.proxy)
    }

    // Check if property exists and get its current value
    const current = peek(latest(target), key)
    const existed = current !== undefined || key in (target.original as object)

    // For objects, track deletion
    if (existed) {
      ensureShallowCopy(target)
      markChanged(target)
      target.assignedMap!.set(key, false)

      // Eager op logging for delete
      pushOp(target, {
        kind: "delete",
        path: getPathOrThrow(target),
        key: key,
      })

      // Track aliasCount and delete from copy
      const copy = target.copy as Record<PropertyKey, unknown>
      decAliasCount(copy[key])
      delete copy[key]
    } else {
      target.assignedMap = target.assignedMap ?? new Map()
      target.assignedMap.delete(key)
    }
    return true
  },
}

/**
 * Create a draft proxy for a value
 */
export function createDraft<T extends object>(options: {
  original: T
  parentDraft?: ProxyDraft | null
  key?: string | number
  finalities: Finalities
}): T {
  const { original, parentDraft, key, finalities } = options
  const type = getType(original)

  const proxyDraft: ProxyDraft<T> = {
    type,
    finalized: false,
    parent: parentDraft ?? null,
    original,
    copy: null,
    proxy: null,
    finalities,
    aliasCount: 1,
  }

  // Set key if provided
  if (key !== undefined || "key" in options) {
    proxyDraft.key = key
  }

  // Create revocable proxy
  const { proxy, revoke } = Proxy.revocable<T>(
    (type === DraftType.Array ? Object.assign([], proxyDraft) : proxyDraft) as T,
    proxyHandler as ProxyHandler<T>
  )

  finalities.revoke.push(revoke)
  proxyDraft.proxy = proxy

  // Set up finalization callback to unwrap child drafts in parent copy
  if (parentDraft) {
    parentDraft.finalities.draft.push(() => {
      const copy = parentDraft.copy
      if (!copy) return

      const draft = get(copy as object, key!)
      const childProxyDraft = getProxyDraft(draft)

      if (childProxyDraft) {
        // Get the updated value
        let updatedValue = childProxyDraft.original
        if (childProxyDraft.operated) {
          updatedValue = getValue(draft as object)
        }
        childProxyDraft.finalized = true
        set(copy as object, key!, updatedValue)
      }
    })
  }

  return proxy
}

/**
 * Finalize a draft and return the result with ops
 */
export function finalizeDraft<T>(result: T, returnedValue: [T] | []): [T, Op[]] {
  const proxyDraft = getProxyDraft<T>(result)
  const hasReturnedValue = returnedValue.length > 0

  // Run finalization callbacks to unwrap child drafts
  if (proxyDraft?.operated) {
    while (proxyDraft.finalities.draft.length > 0) {
      const finalize = proxyDraft.finalities.draft.pop()!
      finalize()
    }
    proxyDraft.finalized = true
  }

  // Determine final state
  const state = hasReturnedValue
    ? returnedValue[0]
    : proxyDraft
      ? proxyDraft.operated
        ? (proxyDraft.copy as T)
        : proxyDraft.original
      : result

  // Handle any remaining nested drafts in the state (e.g., from assignments like draft.a = draft.b)
  if (proxyDraft && state && typeof state === "object") {
    handleValue(state, proxyDraft.finalities.handledSet)
  }

  // Get ops from finalities (eager logging)
  const ops = proxyDraft?.finalities.ops ?? []

  // Revoke all proxies
  if (proxyDraft) {
    revokeProxy(proxyDraft)
  }

  return [state as T, ops]
}

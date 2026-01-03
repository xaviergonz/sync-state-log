/**
 * Proxy draft implementation.
 * Adapted from mutative - removed Map/Set/unsafe/mark support.
 */

import { PROXY_DRAFT } from "./constant"
import { generateOps } from "./generateOps"
import { DraftType, type Finalities, type Op, type ProxyDraft } from "./interface"
import {
  ensureShallowCopy,
  finalizeOps,
  get,
  getDescriptor,
  getProxyDraft,
  getType,
  getValue,
  has,
  isDraft,
  isDraftable,
  isEqual,
  latest,
  markChanged,
  markFinalization,
  peek,
  revokeProxy,
  set,
} from "./utils"

/**
 * Proxy handler for drafts
 */
const proxyHandler: ProxyHandler<ProxyDraft> = {
  get(target: ProxyDraft, key: PropertyKey, _receiver: unknown) {
    // Return cached draft if available
    const copy = target.copy?.[key as keyof typeof target.copy]
    if (copy && target.finalities.draftsCache.has(copy as object)) {
      return copy
    }

    // Return the ProxyDraft itself when accessing the symbol
    if (key === PROXY_DRAFT) return target

    const source = latest(target)

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
    // Validate array assignments
    if (target.type === DraftType.Array) {
      const numKey = Number(key)
      if (
        key !== "length" &&
        !(Number.isInteger(numKey) && numKey >= 0 && String(numKey) === String(key))
      ) {
        throw new Error(`Only supports setting array indices and the 'length' property.`)
      }

      // Check for sparse array creation
      const source = latest(target) as unknown[]
      if (key !== "length" && numKey > source.length) {
        throw new Error(
          `Cannot create sparse array. Index ${numKey} is out of bounds for array of length ${source.length}.`
        )
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

    // Track assignment
    if (
      has(target.original, key) &&
      isEqual(value, (target.original as Record<PropertyKey, unknown>)[key])
    ) {
      // Reverting to original value
      target.assignedMap!.delete(key)
    } else {
      target.assignedMap!.set(key, true)
    }

    ;(target.copy as Record<PropertyKey, unknown>)[key] = value
    markFinalization(target, key, value, generateOps)
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
    if (target.type === DraftType.Array) {
      // For arrays, deleting a property sets it to undefined
      return proxyHandler.set!.call(this, target, key as string | symbol, undefined, target.proxy)
    }

    // For objects, track deletion
    if (peek(target.original, key) !== undefined || key in (target.original as object)) {
      ensureShallowCopy(target)
      markChanged(target)
      target.assignedMap!.set(key, false)
    } else {
      target.assignedMap = target.assignedMap ?? new Map()
      target.assignedMap.delete(key)
    }

    if (target.copy) {
      delete (target.copy as Record<PropertyKey, unknown>)[key]
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

  // Set up finalization callback
  if (parentDraft) {
    parentDraft.finalities.draft.push((ops) => {
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
        finalizeOps(childProxyDraft, generateOps, ops)
        set(copy as object, key!, updatedValue)
      }

      // Handle callbacks from assigned drafts
      const oldProxyDraft = getProxyDraft(proxy)
      oldProxyDraft?.callbacks?.forEach((callback) => {
        callback(ops)
      })
    })
  } else {
    // Root draft
    const rootDraft = getProxyDraft(proxy)!
    rootDraft.finalities.draft.push((ops) => {
      finalizeOps(rootDraft, generateOps, ops)
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
  const ops: Op[] = []

  // Run finalization callbacks
  if (proxyDraft?.operated) {
    while (proxyDraft.finalities.draft.length > 0) {
      const finalize = proxyDraft.finalities.draft.pop()!
      finalize(ops)
    }
  }

  // Determine final state
  const state = hasReturnedValue
    ? returnedValue[0]
    : proxyDraft
      ? proxyDraft.operated
        ? (proxyDraft.copy as T)
        : proxyDraft.original
      : result

  // Revoke all proxies
  if (proxyDraft) {
    revokeProxy(proxyDraft)
  }

  return [state as T, ops]
}

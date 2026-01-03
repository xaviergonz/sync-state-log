/**
 * A unique path to a value within the JSON document.
 * Resolution fails if any segment is missing or type mismatch occurs.
 */
export type Path = readonly (string | number)[]

/**
 * A JSON primitive.
 * Note: `undefined` is supported for object properties only. Arrays cannot contain undefined
 * due to Yjs limitations (Y.Array throws on undefined values).
 */
export type JSONPrimitive = undefined | null | boolean | number | string

/**
 * A JSON record.
 */
export type JSONRecord = { [k: string]: JSONValue }

/**
 * A JSON object.
 */
export type JSONObject = JSONRecord | JSONValue[]

/**
 * A JSON value.
 */
export type JSONValue = JSONPrimitive | JSONObject

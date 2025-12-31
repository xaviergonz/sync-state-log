export class StateSyncLogError extends Error {
  constructor(msg: string) {
    super(msg)

    // Set the prototype explicitly for better instanceof support
    Object.setPrototypeOf(this, StateSyncLogError.prototype)
  }
}

export function failure(message: string): never {
  throw new StateSyncLogError(message)
}

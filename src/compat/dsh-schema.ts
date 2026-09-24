/**
 * Adapt schemastery schema methods that exist only on some supported DSH releases.
 *
 * DSH 0.1.5-rc.2 through 0.1.6-alpha.2 ship schemastery 3.18.2, which has no
 * `volatile`. DSH 0.1.7-alpha.1 ships 3.18.3, and 0.1.7-alpha.2 / 0.1.7-rc.1
 * ship 3.18.4; both use `volatile` to project plugin Config into the settings
 * form. Calling the method unconditionally
 * throws while the host entry is still evaluating, so the plugin never loads
 * on the older releases. The probe follows the method, not the version string.
 */

interface VolatileSchema<S> {
  volatile?: () => S
}

/** Mark a field volatile when this schemastery copy provides the method. */
export function markVolatile<S>(schema: S): S {
  const candidate = schema as S & VolatileSchema<S>
  if (typeof candidate.volatile !== 'function') return schema
  return candidate.volatile()
}

/**
 * Identity of a schemastery 3.18.3 volatile reference.
 * Cosmokit's `isVolatile` checks this same symbol, so the probe works across
 * package copies without taking a dependency on cosmokit.
 */
const volatileWrite = Symbol.for('cosmokit.volatile.write')

/**
 * Read one config field from either host shape.
 * DSH 0.1.7 parses `.volatile()` fields into stable references: even an absent
 * string is an object with `get()`, not `undefined`. Calling string methods on
 * that object throws. Older hosts still store plain strings and numbers.
 * @param value - A plain config value, or a volatile reference.
 * @returns The current snapshot, or the value itself when it is not a reference.
 */
export function readVolatile(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && volatileWrite in value) {
    const read = (value as { get?: unknown }).get
    if (typeof read === 'function') return read.call(value)
  }
  return value
}

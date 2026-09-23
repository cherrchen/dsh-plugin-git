/**
 * Adapt schemastery schema methods that exist only on some supported DSH releases.
 *
 * DSH 0.1.5-rc.2 through 0.1.6-alpha.2 ship schemastery 3.18.2, which has no
 * `volatile`. DSH 0.1.7-alpha.1 ships 3.18.3, which uses `volatile` to project
 * plugin Config into the settings form. Calling the method unconditionally
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

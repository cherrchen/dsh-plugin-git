/** Exact DSH releases verified for this plugin. */
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'] as const

export type SupportedDshRelease = typeof SUPPORTED_DSH_RELEASES[number]

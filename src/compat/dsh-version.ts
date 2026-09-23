/** Exact DSH releases verified for this plugin. */
export const SUPPORTED_DSH_RELEASES = ['0.1.5-rc.2', '0.1.6-alpha.1'] as const

export type SupportedDshRelease = typeof SUPPORTED_DSH_RELEASES[number]

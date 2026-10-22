/** Local structural contract for an optional seam. Published declarations must also work on hosts where its package does not exist. */
declare const CREDENTIAL_BRAND: unique symbol
export type CredentialKey = string & { readonly [CREDENTIAL_BRAND]: 'key' }
export type CredentialRef = string & { readonly [CREDENTIAL_BRAND]: 'ref' }
export type CredentialRecord = { readonly kind: 'grant'; readonly payload: unknown } | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
export interface ResolvedCredential { readonly value: string; readonly source: string }
export interface CredentialInfo { readonly configured: boolean; readonly writable: boolean; readonly source?: string }
export interface CredentialRecordInfo { readonly configured: boolean; readonly writable: boolean; readonly kind?: CredentialRecord['kind'] }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'credentials/reference-updated'(ref: CredentialRef): void
    'credentials/record-updated'(key: CredentialKey): void
  }
}

export interface SidecarInfo {
  port: number
  pid: number
}

export interface CookiesStatus {
  logged_in: boolean
  sec_uid?: string
}

export interface ExposedApi {
  getSidecarInfo(): Promise<SidecarInfo>
  openLoginWindow(): Promise<void>
  onCookiesChanged(callback: () => void): () => void
  chooseDirectory(): Promise<string | null>
  getAppVersion(): Promise<string>
}

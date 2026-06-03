/** A Syphon server as reported by the system server directory. */
export interface SyphonServerInfo {
  /** Human-readable server name (may be empty). */
  name: string
  /** The app hosting the server (e.g. "Resolume Arena"). */
  appName: string
  /** Stable unique id for the server instance. */
  uuid: string
}

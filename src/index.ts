// electron-syphon — publish an Electron app's GPU frames to Syphon (macOS),
// zero-copy, from the main process.

export { SyphonOutput } from './output'
export { SyphonServer, SyphonClient, listServers } from './native'
export type { NativeSyphonServer, NativeSyphonClient, ReceivedFrame, ReceivedFramePixels } from './native'
export type { SyphonServerInfo } from './types'

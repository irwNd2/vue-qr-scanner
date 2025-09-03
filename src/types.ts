export type CornerPoint = { x: number; y: number }
export type DetectedCode = {
  rawValue: string
  format?: string
  corners?: CornerPoint[]
}


export type QrScannerEvents = {
  /** Fired whenever one or more barcodes are detected on a frame */
  detect: DetectedCode[]
  /** Fired when a fatal error occurs (camera/permission/decoder) */
  error: Error
}


export type ScannerState = {
  running: boolean
  usingBack: boolean
  torch: boolean
}


export type ScannerOptions = {
  /** Prefered formats; used for BarcodeDetector if available. */
  formats?: string[]
  /** Process every Nth frame (throttle). Default: 1 (every frame). */
  frameInterval?: number
  /** Set true to mirror overlay when using front camera. */
  mirrorWhenUser?: boolean
}

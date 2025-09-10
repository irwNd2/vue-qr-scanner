<template>
  <div class="vsqs-wrapper" style="position:relative">
    <video
      ref="video"
      playsinline
      autoplay
      class="vsqs-video"
      :height="videoHeight"
      :width="videoWidth"
    ></video>

    <canvas
      ref="overlay"
      class="vsqs-overlay"
      style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2"
      aria-hidden="true"
    ></canvas>

    <slot name="controls" :state="state" :toggleTorch="toggleTorch" :switchCamera="switchCamera" />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, reactive, onMounted, onBeforeUnmount, watchEffect, PropType } from 'vue'
import type { DetectedCode, ScannerOptions, ScannerState } from './types'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

type TorchConstraint = MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }
type Pt = { x:number; y:number }
type RoiShape = 'square' | 'rect'

type LocalProps = {
  // bawaan
  formats: string[]
  frameInterval: number
  mirrorWhenUser: boolean

  // ROI tunggal
  roiShape: RoiShape
  roiAspect: number
  roiSizeRatio: number
  roiPadding: number
  roiRadius: number
  roiBorderColorIdle: string
  roiBorderColorActive: string
  roiBorderWidth: number
  showMask: boolean
  useRoi: boolean
  filterInsideRoi: boolean

  // ukuran video
  videoWidth: number | string
  videoHeight: number | string
}

export default defineComponent({
  name: 'QrScanner',
  props: {
    // ==== bawaan scanner ====
    /** Daftar format untuk BarcodeDetector (abaikan di WASM). Default: ['qr_code'] */
    formats: { type: Array as () => string[], default: () => ['qr_code'] },
    /** Proses setiap N frame (throttle). Default: 1 (tiap frame) */
    frameInterval: { type: Number, default: 1 },
    /** Mirror overlay ketika kamera depan. Default: true */
    mirrorWhenUser: { type: Boolean, default: true },

    // ==== ROI tunggal (sekaligus border dan mask) ====
    /** Bentuk ROI/border: 'square' (persegi) atau 'rect' (persegi panjang) */
    roiShape: { type: String as PropType<RoiShape>, default: 'square' },
    /** Untuk roiShape='rect': aspek width/height (mis. 1.7778 = 16:9, 2 = “panjang”) */
    roiAspect: { type: Number, default: 1.6 },
    /** Ukuran ROI relatif sisi pendek video (0..1). Default: 0.6 */
    roiSizeRatio: { type: Number, default: 0.6 },
    /** Padding (px) di dalam ROI (mengecilkan border/area scan). Default: 0 */
    roiPadding: { type: Number, default: 0 },
    /** Radius sudut border ROI (px). Default: 12 */
    roiRadius: { type: Number, default: 12 },
    /** Warna border ROI. Default: #ffffff (atau #22c55e saat aktif) */
    roiBorderColorIdle: { type: String, default: '#ffffff' },
    /** Warna border saat ada deteksi. Default: #22c55e */
    roiBorderColorActive: { type: String, default: '#22c55e' },
    /** Ketebalan border ROI (px). Default: 3 */
    roiBorderWidth: { type: Number, default: 3 },
    /** Tampilkan masker gelap di luar ROI. Default: true */
    showMask: { type: Boolean, default: true },
    /** Gunakan ROI sebagai area decode (crop). Default: true */
    useRoi: { type: Boolean, default: true },
    /** Hanya emit @detect jika centroid QR berada di dalam ROI. Default: false */
    filterInsideRoi: { type: Boolean, default: false },

    // ==== ukuran video ====
    /** Lebar video: number (px) atau string ('100%', '500px'). Default: '100%' */
    videoWidth: { type: [String, Number], default: '100%' },
    /** Tinggi video: number (px) atau string ('auto', '500px'). Default: 'auto' */
    videoHeight: { type: [String, Number], default: 'auto' }
  },
  emits: ['detect', 'error'],
  setup(props: LocalProps, { emit }) {
    const video = ref<HTMLVideoElement | null>(null)
    const overlay = ref<HTMLCanvasElement | null>(null)
    const state = reactive<ScannerState>({ running: false, usingBack: true, torch: false })

    let stream: MediaStream | undefined
    let raf = 0
    let detector: any // BarcodeDetector | null
    let usingBarcodeAPI = false
    let frameCount = 0
    let smoothCorners: Pt[] | null = null
    const SMOOTH_ALPHA = 0.35

    // ===== util =====
    function emaCorners(prev: Pt[] | null, next: Pt[]): Pt[] {
      if (!prev || prev.length !== next.length) return next.map(p => ({ x: p.x, y: p.y }))
      return next.map((p, i) => ({
        x: prev[i].x + SMOOTH_ALPHA * (p.x - prev[i].x),
        y: prev[i].y + SMOOTH_ALPHA * (p.y - prev[i].y),
      }))
    }
    function centroid(pts: Pt[]): Pt {
      return { x: pts.reduce((s,p)=>s+p.x,0)/pts.length, y: pts.reduce((s,p)=>s+p.y,0)/pts.length }
    }

    /** Hitung rect ROI (x,y,w,h) berdasarkan props + ukuran video */
    function roiRect(cvs: HTMLCanvasElement) {
      const shortSide = Math.min(cvs.width, cvs.height)
      const base = Math.max(0, Math.floor(shortSide * props.roiSizeRatio)) // sisi persegi dasar
      let w = base, h = base

      if (props.roiShape === 'rect') {
        const aspect = Math.max(0.01, props.roiAspect) // w/h
        if (aspect >= 1) {
          // lebar lebih besar → tinggi mengecil
          w = base
          h = Math.floor(base / aspect)
        } else {
          // tinggi lebih besar → lebar mengecil
          w = Math.floor(base * aspect)
          h = base
        }
      }
      // center-kan
      let x = Math.floor((cvs.width  - w) / 2)
      let y = Math.floor((cvs.height - h) / 2)

      // padding ke dalam
      const pad = Math.max(0, props.roiPadding)
      x += pad; y += pad; w = Math.max(0, w - 2 * pad); h = Math.max(0, h - 2 * pad)
      return { x, y, w, h }
    }
    // ===== init / camera =====
    async function initDetector() {
      // @ts-ignore
      if (globalThis.BarcodeDetector) {
        // @ts-ignore
        detector = new BarcodeDetector({ formats: (props as any).formats })
        usingBarcodeAPI = true
        return
      }
      usingBarcodeAPI = false // fallback: WASM readBarcodes
    }

    async function start() {
      state.running = true
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.usingBack ? 'environment' : 'user' },
        audio: false
      })
      if (!video.value) return
      video.value.srcObject = stream
      await video.value.play()
      loop()
    }
    function stop() {
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
      state.running = false
    }

    // ===== overlay drawing =====
    function drawOverlay(results: DetectedCode[]) {
      const vid = video.value!, cvs = overlay.value!
      const ctx = cvs.getContext('2d')!
      // sync canvas ke pixel video
      cvs.width = vid.videoWidth
      cvs.height = vid.videoHeight
      ctx.clearRect(0, 0, cvs.width, cvs.height)

      const { x, y, w, h } = roiRect(cvs)
      const active = !!(results[0]?.corners?.length)

      const roundRect = (rx:number, ry:number, rw:number, rh:number, r:number) => {
        const rr = Math.min(r, rw/2, rh/2)
        ctx.beginPath()
        ctx.moveTo(rx+rr, ry)
        ctx.arcTo(rx+rw, ry,   rx+rw, ry+rh, rr)
        ctx.arcTo(rx+rw, ry+rh, rx,   ry+rh, rr)
        ctx.arcTo(rx,    ry+rh, rx,   ry,    rr)
        ctx.arcTo(rx,    ry,    rx+rw,ry,    rr)
        ctx.closePath()
      }

      // Mask di luar ROI
      if (props.showMask) {
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(0, 0, cvs.width, cvs.height)
        ctx.globalCompositeOperation = 'destination-out'
        roundRect(x, y, w, h, props.roiRadius)
        ctx.fill()
        ctx.restore()
      }

      // Border ROI (satu-satunya border)
      ctx.lineWidth = props.roiBorderWidth
      ctx.strokeStyle = active ? props.roiBorderColorActive : props.roiBorderColorIdle
      roundRect(x, y, w, h, props.roiRadius)
      ctx.stroke()

      // Bounding box deteksi (smoothed)
      if (active) {
        const shouldMirror = (props as any).mirrorWhenUser && !state.usingBack
        const corners = results[0]!.corners!
        smoothCorners = emaCorners(smoothCorners, corners)

        ctx.save()
        if (shouldMirror) { ctx.scale(-1, 1); ctx.translate(-cvs.width, 0) }
        ctx.lineWidth = 3
        ctx.strokeStyle = props.roiBorderColorActive
        ctx.beginPath()
        ctx.moveTo(smoothCorners![0].x, smoothCorners![0].y)
        for (let i = 1; i < smoothCorners!.length; i++) ctx.lineTo(smoothCorners![i].x, smoothCorners![i].y)
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }
    }

    // ===== decoding =====
    async function readFrame(): Promise<DetectedCode[]> {
      frameCount = (frameCount + 1) % ((props as any).frameInterval ?? 1)
      if (frameCount !== 0) return []

      if (usingBarcodeAPI) {
        const nativeResults: any[] = await detector.detect(video.value!)
        return nativeResults.map(r => ({
          rawValue: r.rawValue,
          format: r.format,
          corners: r.cornerPoints?.map((p: any) => ({ x: p.x, y: p.y }))
        }))
      }

      const vid = video.value!, cvs = overlay.value!, ctx = cvs.getContext('2d')!
      cvs.width = vid.videoWidth
      cvs.height = vid.videoHeight
      ctx.drawImage(vid, 0, 0, cvs.width, cvs.height)

      let sx = 0, sy = 0, sw = cvs.width, sh = cvs.height
      if (props.useRoi) {
        const r = roiRect(cvs)
        sx = r.x; sy = r.y; sw = r.w; sh = r.h
      }

      const img = ctx.getImageData(sx, sy, sw, sh)
      const opts: ReaderOptions = { tryHarder: true, maxNumberOfSymbols: 4 }
      const results = await readBarcodes(img, opts)

      return results.map((b: any) => ({
        rawValue: b.text,
        format: b.format || 'qr_code',
        corners: b.cornerPoints?.map((p: any) => ({ x: p.x + sx, y: p.y + sy }))
      }))
    }

    async function loop() {
      if (!video.value) return
      try {
        let results = await readFrame()

        if (props.filterInsideRoi && results[0]?.corners && overlay.value) {
          const r = roiRect(overlay.value)
          const c = centroid(results[0].corners!)
          const inside = (c.x >= r.x && c.x <= r.x+r.w && c.y >= r.y && c.y <= r.y+r.h)
          results = inside ? results : []
        }

        if (results.length) emit('detect', results)
        drawOverlay(results)
      } catch (e: any) {
        emit('error', e)
      }
      raf = requestAnimationFrame(loop)
    }

    // ===== controls =====
    async function toggleTorch() {
      const track = stream?.getVideoTracks()[0]
      const caps: any = track?.getCapabilities?.()
      if (!track || !caps?.torch) return
      state.torch = !state.torch
      await track.applyConstraints({ advanced: [{ torch: state.torch }] } as TorchConstraint)
    }
    async function switchCamera() {
      state.usingBack = !state.usingBack
      const wasRunning = state.running
      stop()
      await initDetector()
      if (wasRunning) await start()
    }

    // ===== lifecycle =====
    onMounted(async () => {
      try { await initDetector(); await start() } catch (e:any) { emit('error', e) }
    })
    onBeforeUnmount(() => stop())

    // sync canvas size ke video frame
    watchEffect(() => {
      const vid = video.value, cvs = overlay.value
      if (!vid || !cvs) return
      const ro = new ResizeObserver(() => {
        cvs.width = vid.videoWidth
        cvs.height = vid.videoHeight
      })
      ro.observe(vid)
    })

    return { video, overlay, state, toggleTorch, switchCamera }
  }
})
</script>

<style scoped>
.vsqs-wrapper { position: relative; width: 100%; height: auto; display: block; }
.vsqs-video { width: 100%; height: auto; display: block; position: relative; z-index: 0; object-fit: cover; }
.vsqs-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; display: block; }
</style>


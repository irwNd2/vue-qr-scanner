<template>
  <div class="vsqs-wrapper" style="position:relative">
    <video
      ref="video"
      playsinline
      autoplay
      class="vsqs-video"
      :width="videoWidth"
      :height="videoHeight"
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
import { defineComponent, ref, reactive, onMounted, watch, onBeforeUnmount, watchEffect, PropType } from 'vue'
import type { DetectedCode, ScannerOptions, ScannerState } from './types'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

type TorchConstraint = MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }
type Pt = { x:number; y:number }
type RoiShape = 'square' | 'rect'
type RoiBorderStyle = 'full' | 'corner'

/** Props lokal lengkap (superset dari ScannerOptions) */
type LocalProps = ScannerOptions & {
  roiShape: RoiShape
  roiAspect: number
  roiSizeRatio: number
  roiPadding: number
  roiRadius: number
  roiBorderColorIdle: string
  roiBorderColorActive: string
  roiBorderWidth: number
  roiBorderStyle: RoiBorderStyle
  roiCornerLength: number
  roiCornerWidth: number
  roiInnerFillOpacity: number
  showMask: boolean
  useRoi: boolean
  filterInsideRoi: boolean

  videoWidth: number | string
  videoHeight: number | string

  preferWasm: boolean
  bdTimeoutMs: number
  bdMaxZeroFrames: number
  debug: boolean

  paused: boolean
  releaseOnPause: boolean
  detectEnabled: boolean
  scanOnce: boolean
}

export default defineComponent({
  name: 'QrScanner',
  props: {
    // ===== props bawaan =====
    /** Daftar format untuk BarcodeDetector (abaikan di WASM). Default: ['qr_code'] */
    formats: { type: Array as () => string[], default: () => ['qr_code'] },
    /** Proses setiap N frame (throttle). Default: 1 (tiap frame) */
    frameInterval: { type: Number, default: 1 },
    /** Mirror overlay ketika kamera depan. Default: true */
    mirrorWhenUser: { type: Boolean, default: true },

    // ===== ROI tunggal (border + mask) =====
    /** Bentuk ROI/border: 'square' (persegi) atau 'rect' (persegi panjang) */
    roiShape: { type: String as PropType<RoiShape>, default: 'square' },
    /** Untuk roiShape='rect': rasio width/height (contoh 1.7778=16:9, 2=panjang) */
    roiAspect: { type: Number, default: 1.6 },
    /** Ukuran ROI relatif sisi pendek video (0..1). Default: 0.6 */
    roiSizeRatio: { type: Number, default: 0.6 },
    /** Padding (px) di dalam ROI (mengecilkan area border/scan). Default: 0 */
    roiPadding: { type: Number, default: 0 },
    /** Radius sudut ROI (px). Default: 12 */
    roiRadius: { type: Number, default: 12 },
    /** Warna border idle */
    roiBorderColorIdle: { type: String, default: '#ffffff' },
    /** Warna border saat ada deteksi */
    roiBorderColorActive: { type: String, default: '#22c55e' },
    /** Ketebalan border (px) untuk style 'full' / default corner width */
    roiBorderWidth: { type: Number, default: 3 },
    /** Gaya border: 'full' (garis utuh) atau 'corner' (bracket sudut) */
    roiBorderStyle: { type: String as PropType<RoiBorderStyle>, default: 'corner' },
    /** Panjang bracket tiap sudut (px) untuk style 'corner' */
    roiCornerLength: { type: Number, default: 28 },
    /** Ketebalan garis bracket (0=pakai roiBorderWidth) */
    roiCornerWidth: { type: Number, default: 0 },
    /** Opasitas fill tipis di dalam ROI (0..1), 0=tanpa fill */
    roiInnerFillOpacity: { type: Number, default: 0.12 },
    /** Tampilkan masker gelap di luar ROI */
    showMask: { type: Boolean, default: true },
    /** Gunakan ROI sebagai area decode (crop) */
    useRoi: { type: Boolean, default: true },
    /** Hanya emit @detect jika centroid QR berada di dalam ROI */
    filterInsideRoi: { type: Boolean, default: false },

    // ===== ukuran video =====
    /** Lebar video: number (px) atau string ('100%', '500px') */
    videoWidth: { type: [String, Number], default: '100%' },
    /** Tinggi video: number (px) atau string ('auto', '500px') */
    videoHeight: { type: [String, Number], default: 'auto' },

    // ===== engine control =====
    /** Paksa ZXing WASM (abaikan BarcodeDetector) */
    preferWasm: { type: Boolean, default: false },
    /** Auto fallback ke WASM jika BD kosong terlalu lama (ms). 0=nonaktif */
    bdTimeoutMs: { type: Number, default: 2500 },
    /** Auto fallback ke WASM jika BD kosong N frame berturut-turut. 0=nonaktif */
    bdMaxZeroFrames: { type: Number, default: 30 },
    /** Log ringan ke console */
    debug: { type: Boolean, default: false },

    // ===== playback & detection control =====
    /** Pause camera preview & scanning from outside */
    paused: { type: Boolean, default: false },
    /** When pausing, also stop camera tracks (saves battery/permission). Will reacquire on resume */
    releaseOnPause: { type: Boolean, default: false },
    /** If false, do not emit @detect (overlay still updates) */
    detectEnabled: { type: Boolean, default: true },
    /** Stop scanning after first successful detection */
    scanOnce: { type: Boolean, default: false },
  },
  emits: ['detect', 'error', 'engine-change'],
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
    let zeroFrameStreak = 0
    let bdStartTs = 0

    const SMOOTH_ALPHA = 0.35

    // ===== utils =====
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
    /** Hitung rect ROI (x,y,w,h) di koordinat piksel video */
    function roiRect(cvs: HTMLCanvasElement) {
      const shortSide = Math.min(cvs.width, cvs.height)
      const base = Math.max(0, Math.floor(shortSide * props.roiSizeRatio)) // sisi persegi dasar
      let w = base, h = base
      if (props.roiShape === 'rect') {
        const aspect = Math.max(0.01, props.roiAspect) // w/h
        if (aspect >= 1) { w = base; h = Math.floor(base / aspect) }
        else { w = Math.floor(base * aspect); h = base }
      }
      let x = Math.floor((cvs.width  - w) / 2)
      let y = Math.floor((cvs.height - h) / 2)
      const pad = Math.max(0, props.roiPadding)
      x += pad; y += pad; w = Math.max(0, w - 2 * pad); h = Math.max(0, h - 2 * pad)
      return { x, y, w, h }
    }
    /** Rounded-rect path helper */
    function roundRect(ctx:CanvasRenderingContext2D, rx:number, ry:number, rw:number, rh:number, r:number) {
      const rr = Math.min(Math.max(0, r), rw/2, rh/2)
      ctx.beginPath()
      ctx.moveTo(rx+rr, ry)
      ctx.arcTo(rx+rw, ry,   rx+rw, ry+rh, rr)
      ctx.arcTo(rx+rw, ry+rh, rx,   ry+rh, rr)
      ctx.arcTo(rx,    ry+rh, rx,   ry,    rr)
      ctx.arcTo(rx,    ry,    rx+rw,ry,    rr)
      ctx.closePath()
    }

    /** Corner/bracket border yang “masuk” ke radius (no gap) */
    function drawCornerBorder(
      ctx: CanvasRenderingContext2D,
      x: number, y: number, w: number, h: number,
      r: number,
      color: string,
      width: number,
      len: number
    ) {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      
      const L = Math.max(2, Math.min(len, Math.floor(Math.min(w, h) / 2)))
      const rr = Math.max(0, Math.min(r, w/2, h/2))
      
      // Helper clamp function
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
      
      // Top-Left Corner
      ctx.beginPath()
      if (rr > 0) {
        // Horizontal line (mengikuti curve)
        ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false)
        ctx.moveTo(x + rr, y)
        ctx.lineTo(clamp(x + rr + L, x, x + w), y)
        
        // Vertical line (mengikuti curve)
        ctx.moveTo(x, y + rr)
        ctx.lineTo(x, clamp(y + rr + L, y, y + h))
      } else {
        // No radius, draw straight lines
        ctx.moveTo(x, y)
        ctx.lineTo(clamp(x + L, x, x + w), y)
        ctx.moveTo(x, y)
        ctx.lineTo(x, clamp(y + L, y, y + h))
      }
      ctx.stroke()
      
      // Top-Right Corner
      ctx.beginPath()
      if (rr > 0) {
        // Horizontal line (mengikuti curve)
        ctx.moveTo(clamp(x + w - rr - L, x, x + w), y)
        ctx.lineTo(x + w - rr, y)
        ctx.arc(x + w - rr, y + rr, rr, Math.PI * 1.5, 0, false)
        
        // Vertical line (mengikuti curve)
        ctx.moveTo(x + w, y + rr)
        ctx.lineTo(x + w, clamp(y + rr + L, y, y + h))
      } else {
        ctx.moveTo(clamp(x + w - L, x, x + w), y)
        ctx.lineTo(x + w, y)
        ctx.moveTo(x + w, y)
        ctx.lineTo(x + w, clamp(y + L, y, y + h))
      }
      ctx.stroke()
      
      // Bottom-Right Corner
      ctx.beginPath()
      if (rr > 0) {
        // Horizontal line (mengikuti curve)
        ctx.moveTo(clamp(x + w - rr - L, x, x + w), y + h)
        ctx.lineTo(x + w - rr, y + h)
        ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI * 0.5, false)
        
        // Vertical line (mengikuti curve)
        ctx.moveTo(x + w, clamp(y + h - rr - L, y, y + h))
        ctx.lineTo(x + w, y + h - rr)
      } else {
        ctx.moveTo(clamp(x + w - L, x, x + w), y + h)
        ctx.lineTo(x + w, y + h)
        ctx.moveTo(x + w, clamp(y + h - L, y, y + h))
        ctx.lineTo(x + w, y + h)
      }
      ctx.stroke()
      
      // Bottom-Left Corner
      ctx.beginPath()
      if (rr > 0) {
        // Horizontal line (mengikuti curve)
        ctx.moveTo(x + rr, y + h)
        ctx.lineTo(clamp(x + rr + L, x, x + w), y + h)
        ctx.arc(x + rr, y + h - rr, rr, Math.PI * 0.5, Math.PI, false)
        
        // Vertical line (mengikuti curve)
        ctx.moveTo(x, clamp(y + h - rr - L, y, y + h))
        ctx.lineTo(x, y + h - rr)
      } else {
        ctx.moveTo(x, y + h)
        ctx.lineTo(clamp(x + L, x, x + w), y + h)
        ctx.moveTo(x, clamp(y + h - L, y, y + h))
        ctx.lineTo(x, y + h)
      }
      ctx.stroke()
      
      ctx.restore()
    }

    async function pauseInternal() {
      cancelAnimationFrame(raf)
      if (video.value && !video.value.paused) {
        try { await video.value.pause() } catch {}
      }
      if (props.releaseOnPause) {
        stream?.getTracks().forEach(t => t.stop())
        stream = undefined
      }
      state.running = false
    }

    async function resumeInternal() {
      if (props.releaseOnPause || !stream) {
        await initDetector()
        await start()
        return
      }
      // stream masih ada: lanjutkan
      if (video.value?.paused) {
        try { await video.value.play() } catch {}
      }
      state.running = true
      loop()
    }


    // ===== engine init =====
    async function initDetector() {
      usingBarcodeAPI = false
      zeroFrameStreak = 0
      bdStartTs = 0
      detector = null

      if (!props.preferWasm) {
        try {
          // @ts-ignore
          if (globalThis.BarcodeDetector) {
            // @ts-ignore
            detector = new BarcodeDetector({ formats: props.formats })
            usingBarcodeAPI = true
            bdStartTs = performance.now()
            props.debug && console.log('[engine] BarcodeDetector')
            emit('engine-change', 'barcode-detector')
            return
          }
        } catch (e) {
          props.debug && console.warn('[engine] BD init failed → WASM', e)
        }
      }
      usingBarcodeAPI = false
      detector = null
      props.debug && console.log('[engine] WASM')
      emit('engine-change', 'wasm')
    }

    // ===== camera =====
    async function start() {
      state.running = true
      const videoConstraints: MediaTrackConstraints = {
        facingMode: state.usingBack ? 'environment' : 'user',
        // width:  { ideal: 1280 },
        // height: { ideal: 720 },
        // advanced: [{ focusMode: 'continuous' as any }]
      }
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
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

      // Mask di luar ROI
      if (props.showMask) {
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(0, 0, cvs.width, cvs.height)
        ctx.globalCompositeOperation = 'destination-out'
        roundRect(ctx, x, y, w, h, props.roiRadius)
        ctx.fill()
        ctx.restore()
      }
      // Fill tipis di dalam ROI (opsional)
      if (props.roiInnerFillOpacity > 0) {
        ctx.save()
        roundRect(ctx, x, y, w, h, props.roiRadius)
        ctx.clip()
        ctx.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, props.roiInnerFillOpacity))})`
        ctx.fillRect(x, y, w, h)
        ctx.restore()
      }

      // Border ROI (full/corner)
      const color = active ? props.roiBorderColorActive : props.roiBorderColorIdle
      if (props.roiBorderStyle === 'corner') {
        const lw = props.roiCornerWidth > 0 ? props.roiCornerWidth : props.roiBorderWidth
        drawCornerBorder(ctx, x, y, w, h, props.roiRadius, color, lw, props.roiCornerLength)
      } else {
        ctx.lineWidth = props.roiBorderWidth
        ctx.strokeStyle = color
        roundRect(ctx, x, y, w, h, props.roiRadius)
        ctx.stroke()
      }

      // Bounding box deteksi (smoothed)
      if (active) {
        const shouldMirror = props.mirrorWhenUser && !state.usingBack
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
      // throttle
      frameCount = (frameCount + 1) % (props.frameInterval ?? 1)
      if (frameCount !== 0) return []

      // helper fallback rules
      const maybeFallbackToWasm = () => {
        if (!usingBarcodeAPI) return false
        const byTime = props.bdTimeoutMs > 0 && performance.now() - bdStartTs >= props.bdTimeoutMs
        const byStreak = props.bdMaxZeroFrames > 0 && zeroFrameStreak >= props.bdMaxZeroFrames
        if (byTime || byStreak) {
          usingBarcodeAPI = false
          detector = null
          props.debug && console.warn('[engine] fallback → WASM (time:', byTime, 'streak:', zeroFrameStreak, ')')
          emit('engine-change', 'wasm')
          return true
        }
        return false
      }

      // BarcodeDetector path
      if (usingBarcodeAPI) {
        try {
          const nativeResults: any[] = await detector.detect(video.value!)
          zeroFrameStreak = nativeResults.length ? 0 : (zeroFrameStreak + 1)
          props.debug && console.log('[BD] results=', nativeResults.length, 'streak=', zeroFrameStreak)
          if (!nativeResults.length && maybeFallbackToWasm()) {
            // jatuh ke WASM di frame yg sama (lanjut di bawah)
          } else {
            return nativeResults.map(r => ({
              rawValue: r.rawValue,
              format: r.format,
              corners: r.cornerPoints?.map((p: any) => ({ x: p.x, y: p.y }))
            }))
          }
        } catch (e) {
          props.debug && console.warn('[BD] detect error → WASM', e)
          usingBarcodeAPI = false
          detector = null
          emit('engine-change', 'wasm')
          // lanjut ke WASM
        }
      }

      // WASM path
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
      props.debug && console.log('[WASM] results=', results.length)
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

        // emit detect kalau diizinkan
        if (results.length) {
          if (props.detectEnabled) emit('detect', results)

          if (props.scanOnce) {
            // hentikan scanning; kalau mau juga hentikan preview, set releaseOnPause sesuai kebutuhan
            await pauseInternal()
            // (opsional) bisa emit event khusus kalau mau, mis. emit('stopped-after-detect')
            drawOverlay(results) // gambar terakhir
            return // stop loop
          }
        }

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

    watch(() => props.paused, async (isPaused) => {
      if (isPaused) await pauseInternal()
      else await resumeInternal()
    })
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

    // bisa ekspose fungsi ini nanti (nanti ajaa)
    function pause()  { return pauseInternal() }
    function resume() { return resumeInternal() }
    function togglePause() { return props.paused ? resumeInternal() : pauseInternal() }

    return { video, overlay, state, toggleTorch, switchCamera }
  }
})
</script>

<style scoped>
.vsqs-wrapper { position: relative; width: 100%; height: auto; display: block; }
.vsqs-video   { width: 100%; height: auto; display: block; position: relative; z-index: 0; object-fit: cover; }
.vsqs-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; display: block; }
</style>


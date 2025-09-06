<template>
  <div class="vsqs-wrapper">
    <video ref="video" playsinline autoplay class="vsqs-video"></video>
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
import { defineComponent, ref, reactive, onMounted, onBeforeUnmount, watchEffect } from 'vue'
import type { DetectedCode, ScannerOptions, ScannerState } from './types'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

type TorchConstraint = MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }
type Pt = { x:number; y:number }

export default defineComponent({
  name: 'QrScanner',
  props: {
    formats: {
      type: Array as () => string[],
      default: () => ['qr_code']
    },
    frameInterval: {
      type: Number,
      default: 1
    },
    mirrorWhenUser: {
      type: Boolean,
      default: true
    },
    /** aktifkan pemindaian hanya di area kotak panduan (ROI) */
    useRoi: {
      type: Boolean,
      default: true
    },
    /** ukuran kotak panduan relatif sisi pendek video (0..1) */
    roiSizeRatio: {
      type: Number,
      default: 0.6
    },
    /** hanya emit detect jika centroid QR benar2 di dalam ROI */
    filterInsideRoi: {
      type: Boolean,
      default: false
    },
    /** tampilkan masker gelap di luar ROI */
    showMask: {
      type: Boolean,
      default: true
    }
  },
  emits: ['detect', 'error'],
  setup(props: ScannerOptions & {
    useRoi: boolean; roiSizeRatio: number; filterInsideRoi: boolean; showMask: boolean
  }, { emit }) {
    const video = ref<HTMLVideoElement | null>(null)
    const overlay = ref<HTMLCanvasElement | null>(null)
    const state = reactive<ScannerState>({ running: false, usingBack: true, torch: false })

    let stream: MediaStream | undefined
    let raf = 0
    let detector: any // BarcodeDetector | null
    let usingBarcodeAPI = false
    let frameCount = 0

    // ---------- GUIDE / ROI CONFIG + SMOOTHING ----------
    const guide = reactive({
      enabled: true,
      sizeRatio: props.roiSizeRatio,
      borderWidth: 3,
      colorIdle: '#ffffff',
      colorActive: '#22c55e',
      cornerRadius: 12
    })

    let smoothCorners: Pt[] | null = null
    const SMOOTH_ALPHA = 0.35 // 0..1; makin kecil makin halus

    function emaCorners(prev: Pt[] | null, next: Pt[]): Pt[] {
      if (!prev || prev.length !== next.length) return next.map(p => ({ x: p.x, y: p.y }))
      return next.map((p, i) => ({
        x: prev[i].x + SMOOTH_ALPHA * (p.x - prev[i].x),
        y: prev[i].y + SMOOTH_ALPHA * (p.y - prev[i].y),
      }))
    }

    function roiRect(cvs: HTMLCanvasElement) {
      const shortSide = Math.min(cvs.width, cvs.height)
      const boxSize = Math.floor(shortSide * guide.sizeRatio)
      const gx = Math.floor((cvs.width - boxSize) / 2)
      const gy = Math.floor((cvs.height - boxSize) / 2)
      return { gx, gy, gw: boxSize, gh: boxSize }
    }

    function centroid(pts: Pt[]): Pt {
      const x = pts.reduce((s,p)=>s+p.x,0) / pts.length
      const y = pts.reduce((s,p)=>s+p.y,0) / pts.length
      return { x, y }
    }

    function isInsideRoi(pts?: Pt[]): boolean {
      if (!pts?.length || !overlay.value) return false
      const { gx, gy, gw, gh } = roiRect(overlay.value)
      const c = centroid(pts)
      return (c.x >= gx && c.x <= gx+gw && c.y >= gy && c.y <= gy+gh)
    }

    // ---------- INIT / CAMERA ----------
    async function initDetector() {
      // @ts-ignore
      if (globalThis.BarcodeDetector) {
        // @ts-ignore
        detector = new BarcodeDetector({ formats: (props as any).formats })
        usingBarcodeAPI = true
        return
      }
      usingBarcodeAPI = false // fallback to WASM readBarcodes
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

    // ---------- DRAW OVERLAY (GUIDE + DETECTIONS) ----------
    function drawGuideAndDetections(results: DetectedCode[]) {
      const vid = video.value!, cvs = overlay.value!
      const ctx = cvs.getContext('2d')!
      // sync canvas size with video
      cvs.width = vid.videoWidth
      cvs.height = vid.videoHeight
      ctx.clearRect(0, 0, cvs.width, cvs.height)

      const { gx, gy, gw, gh } = roiRect(cvs)

      // Rounded rect
      const roundRect = (x:number, y:number, w:number, h:number, r:number) => {
        const rr = Math.min(r, w/2, h/2)
        ctx.beginPath()
        ctx.moveTo(x+rr, y)
        ctx.arcTo(x+w, y,   x+w, y+h, rr)
        ctx.arcTo(x+w, y+h, x,   y+h, rr)
        ctx.arcTo(x,   y+h, x,   y,   rr)
        ctx.arcTo(x,   y,   x+w, y,   rr)
        ctx.closePath()
      }

      // Mask gelap di luar ROI
      if (guide.enabled && props.showMask) {
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(0, 0, cvs.width, cvs.height)
        ctx.globalCompositeOperation = 'destination-out'
        roundRect(gx, gy, gw, gh, guide.cornerRadius)
        ctx.fill()
        ctx.restore()
      }

      // Gambar kotak panduan
      ctx.lineWidth = guide.borderWidth
      const active = !!(results[0]?.corners?.length)
      ctx.strokeStyle = active ? guide.colorActive : guide.colorIdle
      roundRect(gx, gy, gw, gh, guide.cornerRadius)
      ctx.stroke()

      // Gambar bounding box deteksi (halus)
      if (active) {
        const shouldMirror = (props as any).mirrorWhenUser && !state.usingBack
        const corners = results[0]!.corners!
        smoothCorners = emaCorners(smoothCorners, corners)

        ctx.save()
        if (shouldMirror) { ctx.scale(-1, 1); ctx.translate(-cvs.width, 0) }
        ctx.lineWidth = 3
        ctx.strokeStyle = guide.colorActive
        ctx.beginPath()
        ctx.moveTo(smoothCorners![0].x, smoothCorners![0].y)
        for (let i = 1; i < smoothCorners!.length; i++) ctx.lineTo(smoothCorners![i].x, smoothCorners![i].y)
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }
    }

    // ---------- DECODE ----------
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

      // WASM path with readBarcodes()
      const vid = video.value!, cvs = overlay.value!, ctx = cvs.getContext('2d')!
      cvs.width = vid.videoWidth
      cvs.height = vid.videoHeight
      ctx.drawImage(vid, 0, 0, cvs.width, cvs.height)

      let img: ImageData
      let offsetX = 0, offsetY = 0

      if ((props as any).useRoi) {
        const { gx, gy, gw, gh } = roiRect(cvs)
        img = ctx.getImageData(gx, gy, gw, gh)
        offsetX = gx; offsetY = gy
      } else {
        img = ctx.getImageData(0, 0, cvs.width, cvs.height)
      }

      const opts: ReaderOptions = { tryHarder: true, maxNumberOfSymbols: 4 }
      const results = await readBarcodes(img, opts)
      return results.map((b: any) => ({
        rawValue: b.text,
        format: b.format || 'qr_code',
        corners: b.cornerPoints?.map((p: any) => ({ x: p.x + offsetX, y: p.y + offsetY }))
      }))
    }

    async function loop() {
      if (!video.value) return
      try {
        let results = await readFrame()

        // filter hanya jika diminta
        if ((props as any).filterInsideRoi && results[0]?.corners) {
          results = isInsideRoi(results[0].corners!) ? results : []
        }

        // emit + gambar overlay (selalu gambar guide; bounding box jika ada)
        if (results.length) emit('detect', results)
        drawGuideAndDetections(results)
      } catch (e: any) {
        emit('error', e)
      }
      raf = requestAnimationFrame(loop)
    }

    // ---------- CONTROLS ----------
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

    // ---------- LIFECYCLE ----------
    onMounted(async () => {
      try {
        await initDetector()
        await start()
      } catch (e: any) {
        emit('error', e)
      }
    })

    onBeforeUnmount(() => stop())

    // keep overlay size synced
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
/* pastikan wrapper membuat konteks posisi */
.vsqs-wrapper { position: relative; width: 100%; height: auto; display: block; }

/* video di bawah */
.vsqs-video { width: 100%; height: auto; display: block; position: relative; z-index: 0; object-fit: cover; }

/* overlay harus absolute + di atas */
.vsqs-overlay {
  position: absolute !important;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
  display: block;
}
</style>


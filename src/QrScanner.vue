<template>
  <div class="vsqs-wrapper">
    <video ref="video" playsinline autoplay class="vsqs-video"></video>
    <canvas ref="overlay" class="vsqs-overlay" aria-hidden="true"></canvas>
    <slot name="controls" :state="state" :toggleTorch="toggleTorch" :switchCamera="switchCamera" />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, reactive, onMounted, onBeforeUnmount, watchEffect } from 'vue'
import type { DetectedCode, ScannerOptions, ScannerState } from './types'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

type TorchConstraint = MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }

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
    }
  },
  emits: ['detect', 'error'],
  setup(props: ScannerOptions, { emit }) {
    const video = ref<HTMLVideoElement | null>(null)
    const overlay = ref<HTMLCanvasElement | null>(null)
    const state = reactive<ScannerState>({ running: false, usingBack: true, torch: false })

    let stream: MediaStream | undefined
    let raf = 0
    let detector: any // BarcodeDetector | null
    let usingBarcodeAPI = false
    let frameCount = 0

    async function initDetector() {
      // @ts-ignore
      if (globalThis.BarcodeDetector) {
        // @ts-ignore
        detector = new BarcodeDetector({ formats: props.formats })
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

    function drawBoxes(results: DetectedCode[]) {
      const vid = video.value!, cvs = overlay.value!
      const ctx = cvs.getContext('2d')!
      cvs.width = vid.videoWidth
      cvs.height = vid.videoHeight
      ctx.clearRect(0, 0, cvs.width, cvs.height)
      ctx.lineWidth = 3
      ctx.strokeStyle = '#22c55e'

      const shouldMirror = props.mirrorWhenUser && !state.usingBack
      if (shouldMirror) {
        ctx.save()
        ctx.scale(-1, 1)
        ctx.translate(-cvs.width, 0)
      }

      for (const r of results) {
        const c = r.corners
        if (!c || c.length < 4) continue
        ctx.beginPath()
        ctx.moveTo(c[0].x, c[0].y)
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i].x, c[i].y)
        ctx.closePath()
        ctx.stroke()
      }

      if (shouldMirror) ctx.restore()
    }

    async function readFrame(): Promise<DetectedCode[]> {
      frameCount = (frameCount + 1) % (props.frameInterval ?? 1)
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
      const img = ctx.getImageData(0, 0, cvs.width, cvs.height)

      const opts: ReaderOptions = { tryHarder: true, maxNumberOfSymbols: 4 }
      const results = await readBarcodes(img, opts)
      return results.map((b: any) => ({
        rawValue: b.text,
        format: b.format || 'qr_code',
        corners: b.cornerPoints?.map((p: any) => ({ x: p.x, y: p.y }))
      }))
    }

    async function loop() {
      if (!video.value) return
      try {
        const results = await readFrame()
        if (results.length) {
          emit('detect', results)
          drawBoxes(results)
        } else {
          const ctx = overlay.value?.getContext('2d')
          if (ctx && overlay.value) ctx.clearRect(0, 0, overlay.value.width, overlay.value.height)
        }
      } catch (e: any) {
        emit('error', e)
      }
      raf = requestAnimationFrame(loop)
    }

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

    onMounted(async () => {
      try {
        await initDetector()
        await start()
      } catch (e: any) {
        emit('error', e)
      }
    })

    onBeforeUnmount(() => stop())

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
.vsqs-video { width: 100%; height: auto; display: block; }
.vsqs-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style>


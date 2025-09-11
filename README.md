# vue-qr-scanner

📷 A modern **Vue 3 QR/Barcode scanner component** with an overlay ROI (Region of Interest), auto–fallback between **BarcodeDetector API → ZXing WASM**, and customizable UI.

---

## ✨ Features

- 🚀 **Vue 3 Component** — drop straight into your Vite/Nuxt projects.
- 🖼️ **Overlay ROI** (Region of Interest) with dark mask outside the scan area.
- 🔲 **Border styles**: full box or corner/bracket style (like native scanner apps).
- 🔄 **Auto fallback** from [BarcodeDetector API](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector) to [ZXing WASM](https://github.com/zxing-js/wasm).
- 💡 **Torch & Camera Switch** controls exposed via slot.
- 📐 **Square / Rectangle ROI** with adjustable aspect ratio.
- 🛡️ **ROI filtering** (only emit detections inside the ROI).
- 🖥️ **Custom video size** (`videoWidth` & `videoHeight`).
- ⚡ **Debug mode** for engine logs and detection streaks.

---

## Install

```bash
npm install vue-qr-scanner
# or
yarn add vue-qr-scanner
```

# Usage

### Basic Example
```vue
<template>
    <QrScanner 
        roi-shape="rect" 
        :roi-aspect="2" 
        :roi-size-ratio="0.7"
        @detect="onDetect"
        @engine-change="onEngineChange"
    />
</template>

<script setup lang="ts">
import { QrScanner } from 'vue-qr-scanner'

function onDetect(codes) {
  console.log('Detected:', codes[0]?.rawValue)
}
function onEngineChange(engine) {
  console.log('Engine switched to:', engine)
}
</script>
```

or
```vue
<template>
  <QrScanner v-slot:controls="{ state, toggleTorch, switchCamera }"
             :video-width="400"
             :video-height="400"
             :prefer-wasm="true"
             @detect="onDetect">
    <div class="controls">
      <button @click="toggleTorch">
        🔦 Torch: {{ state.torch ? 'ON' : 'OFF' }}
      </button>
      <button @click="switchCamera">
        🔄 Switch to {{ state.usingBack ? 'Front' : 'Back' }} Camera
      </button>
    </div>
  </QrScanner>
</template>

<script setup lang="ts">
import { QrScanner } from 'vue-qr-scanner'

function onDetect(codes) {
  console.log('Detected code:', codes[0]?.rawValue)
}
</script>
```

## Props
Scanner Control
| Prop             | Type       | Default       | Description                                                                           |
| ---------------- | ---------- | ------------- | ------------------------------------------------------------------------------------- |
| `formats`        | `string[]` | `['qr_code']` | List of formats for `BarcodeDetector`. ZXing WASM will attempt all supported formats. |
| `frameInterval`  | `number`   | `1`           | Process every Nth frame (throttle).                                                   |
| `mirrorWhenUser` | `boolean`  | `true`        | Mirror overlay when using the front-facing camera.                                    |


ROI (Region of Interest)
| Prop                   | Type                 | Default     | Description                                                   |
| ---------------------- | -------------------- | ----------- | ------------------------------------------------------------- |
| `roiShape`             | `'square' \| 'rect'` | `'square'`  | Shape of the ROI.                                             |
| `roiAspect`            | `number`             | `1.6`       | Aspect ratio (width/height) when `roiShape="rect"`.           |
| `roiSizeRatio`         | `number`             | `0.6`       | ROI size relative to the short side of the video (0–1).       |
| `roiPadding`           | `number`             | `0`         | Extra padding inside the ROI (shrinks scan area).             |
| `roiRadius`            | `number`             | `12`        | Corner radius of the ROI border.                              |
| `roiBorderStyle`       | `'full' \| 'corner'` | `'corner'`  | Border style: full box or corner brackets.                    |
| `roiBorderWidth`       | `number`             | `3`         | Border width for `'full'` style (or fallback for `'corner'`). |
| `roiCornerLength`      | `number`             | `28`        | Corner bracket length for `'corner'` style.                   |
| `roiCornerWidth`       | `number`             | `0`         | Corner bracket width (0 = use `roiBorderWidth`).              |
| `roiBorderColorIdle`   | `string`             | `'#ffffff'` | Border color when idle.                                       |
| `roiBorderColorActive` | `string`             | `'#22c55e'` | Border color when a code is detected.                         |
| `roiInnerFillOpacity`  | `number`             | `0.12`      | Light fill inside ROI (0–1). Set `0` to disable.              |
| `showMask`             | `boolean`            | `true`      | Show dark mask outside ROI.                                   |
| `useRoi`               | `boolean`            | `true`      | Crop detection to ROI area.                                   |
| `filterInsideRoi`      | `boolean`            | `false`     | Only emit detection if the code’s centroid lies inside ROI.   |


Video
| Prop          | Type               | Default  | Description                      |
| ------------- | ------------------ | -------- | -------------------------------- |
| `videoWidth`  | `number \| string` | `'100%'` | Video width (px or CSS string).  |
| `videoHeight` | `number \| string` | `'auto'` | Video height (px or CSS string). |


Playback & Detection Control
| Prop              | Type      | Default | Description                                                                           |
| ----------------- | --------- | ------- | ------------------------------------------------------------------------------------- |
| `paused`      | `boolean` | `false` | Pause camera preview & scanning from outside.                                          |
| `releaseOnPause`     | `boolean`  | `false`  | When pausing, also stop camera tracks (saves battery/permission). Will reacquire on resume.               |
| `detectEnabled` | `boolean`  | `true`    | If false, do not emit `@detect` (overlay still updates). |
| `scanOnce`           | `boolean` | `false` | Stop scanning after first successful detection.                                      |

Engine & Debug
| Prop              | Type      | Default | Description                                                                           |
| ----------------- | --------- | ------- | ------------------------------------------------------------------------------------- |
| `preferWasm`      | `boolean` | `false` | Force ZXing WASM instead of BarcodeDetector.                                          |
| `bdTimeoutMs`     | `number`  | `2500`  | Auto–fallback to WASM if BarcodeDetector returns no results after N ms.               |
| `bdMaxZeroFrames` | `number`  | `30`    | Auto–fallback to WASM if BarcodeDetector returns no results for N consecutive frames. |
| `debug`           | `boolean` | `false` | Log engine info and detection counts to console.                                      |

WASM File
| Prop              | Type      | Default | Description                                                                           |
| ----------------- | --------- | ------- | ------------------------------------------------------------------------------------- |
| `wasmUrl`      | `string` | `''` | Override .wasm file URL. If empty, uses zxing-wasm default..                                          |


## License

MIT

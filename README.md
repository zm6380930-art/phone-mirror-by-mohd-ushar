# 📱 Phone Mirror

Mirror and control your **Android phone** from your PC over a USB-C cable, in your browser.

- Live phone screen on your PC
- FPS counters: phone stream FPS, PC render FPS, and the phone's display refresh rate (Hz)
- Press **F11** for a fullscreen phone view
- Control the phone with your mouse and keyboard
- No npm packages needed: just Node.js and ADB

> Android only. iPhone is not supported.

## How it works

A web page can't read a USB cable by itself, so a tiny local Node server (`server.js`) talks to your phone through **ADB**:

- the phone screen is streamed as H.264 video (`adb exec-out screenrecord`) and decoded in the browser with WebCodecs
- your clicks, scrolls and typing are sent back to the phone with `adb shell input`

The server only listens on `127.0.0.1` (your own PC), and rejects requests from other websites.

## Requirements

- **Node.js 18 or newer**: https://nodejs.org (LTS)
- **ADB** (Android SDK Platform-Tools): https://developer.android.com/tools/releases/platform-tools
- **Chrome or Edge** (needs WebCodecs)
- A **data-capable** USB-C cable (a charge-only cable won't work)

## Setup

### 1. Phone (once)

1. Settings → About phone → tap **Software version number / Build number** 7 times.
2. Settings → System management → **Developer options** → turn on **USB debugging**.
3. Turn on **Stay awake** (optional, keeps the screen on while charging).
4. If you see **USB debugging (Security settings)** or **Disable permission monitoring**, turn it on. Without it you can see the screen but taps and typing may not work. This is common on Xiaomi, Vivo, Oppo, Realme and OnePlus phones.
5. Plug in the cable and choose **File transfer** as the USB mode.
6. Tap **Allow** on the "Allow USB debugging?" popup (tick "Always allow").

### 2. PC

1. Download this repo (green **Code** button → **Download ZIP**) and extract it.
2. Put `server.js` and `index.html` in the same folder as `adb` (the `platform-tools` folder), **or** add platform-tools to your PATH.
3. Open a terminal in that folder. On Windows: open the folder, type `cmd` in the address bar and press Enter.
4. Run:

   ```bash
   node server.js
   ```

5. Open **http://localhost:8080** in Chrome or Edge.

To use a different port: `PORT=8090 node server.js` (on Windows cmd: `set PORT=8090 && node server.js`).

## Controls

| Action | What it does |
| --- | --- |
| Left click | Tap |
| Click and drag | Swipe |
| Hold | Long-press |
| Mouse wheel | Scroll |
| Right click | Back |
| Middle click | Home |
| Keyboard | Types on the phone (Enter, Backspace, arrows work) |
| `Esc` | Back |
| `F11` | Fullscreen phone view |

The side panel also has Home, Back, Recents, Power, Volume and Notifications buttons.

## Recommended settings

| Situation | Quality | Bitrate |
| --- | --- | --- |
| Default | 1280 px | 8 Mbps |
| Laggy or choppy | 960 px | 4 Mbps (use a USB 3 port) |
| Sharper picture | 1920 px | 16 Mbps |

After rotating the phone, click **Restart stream**.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Cannot find module 'server.js'` | Your terminal is in the wrong folder. Run `dir` (Windows) or `ls` and check that `server.js` is listed. |
| `node is not recognized` | Install Node.js, then reopen the terminal. |
| "ADB not found" on the page | Put the files in the `platform-tools` folder, or add it to PATH. |
| No phone detected | Try another cable or port, re-plug, check USB debugging is on. |
| "unauthorized" | Unlock the phone and tap **Allow** on the popup. |
| Screen shows but taps do nothing | Turn on **USB debugging (Security settings)** in Developer options. |
| Black screen in some apps | Banking and DRM apps block screen capture on purpose. |
| Phone FPS shows about 0 | The phone only sends frames when the screen changes. Scroll something to see the real number. |
| Typing doesn't work for some characters | Only plain English letters, numbers and symbols are supported. |

## Limitations

- Android only
- A small delay on taps is normal. For the lowest latency, see [scrcpy](https://github.com/Genymobile/scrcpy).
- No audio

## License

Add a license of your choice (for example MIT) before sharing publicly.

Selfie Cam Launcher — QR share helper

What I changed

- Added a small floating "QR" button to the root `index.html`, `camera/index.html` and `remote/index.html`.
- The button opens a simple modal that shows QR codes for the page(s). QR images are created via the Google Chart API (no local dependencies).

How to use

1. Serve the folder with a lightweight static server (recommended) so `location.origin` is available and the QR codes point to an absolute URL the phone can open. From PowerShell run:

   python -m http.server 8000

   Then open http://localhost:8000 in your desktop browser. Click the "🔗 QR" button and scan with your phone.

2. If you open the files directly via file:// URLs, QR generation will still work but the encoded URL will be a file path which most phones can't open. Serving over HTTP is recommended.

Notes and edge cases

- The QR generator uses `https://chart.googleapis.com/chart` which requires an internet connection. If you need fully offline QR generation, I can add a small local `qrcode.min.js` and reference it locally.
- If your phone and desktop are on different networks, scanning `http://localhost:8000` won't work — make sure both devices are on the same LAN and use a reachable IP (e.g., `http://192.168.1.42:8000`) when serving.
- The root launcher shows separate QR codes for the `camera` and `remote` pages.

Next steps (optional)

- Add a local copy of a QR generator (e.g., `qrcodejs`) so QR works fully offline.
- Add short integration tests or a small script to print the server IP automatically when you run the static server.

If you want offline QR generation, tell me and I'll add a small library and update the pages to use it.
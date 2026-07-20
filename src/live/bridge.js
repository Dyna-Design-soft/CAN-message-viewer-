// WebView2 transport.
//
// The host Windows application hosts this page in a WebView2 control and pushes
// CAN frames via `window.chrome.webview.postMessage(obj)`. We receive them
// through the 'message' event. Messages we send back reach the host's
// CoreWebView2.WebMessageReceived handler.
//
// Protocol (see sim-source.js for the mirror implementation and README):
//   Host -> Web:  hello | frames | busStatus | error
//   Web  -> Host: ready | control{action:start|stop|pause} | saveFile
//
// This class exposes the same surface as SimSource so the live panel treats
// them interchangeably.

export class WebView2Bridge {
  constructor() {
    this.onMessage = null;
    this.running = false;
    this.available = !!(window.chrome && window.chrome.webview);
    this.#handler = (e) => {
      // e.data is the parsed object (WebView2 delivers postMessage payloads as-is)
      const msg = typeof e.data === 'string' ? safeParse(e.data) : e.data;
      if (msg) this.onMessage?.(msg);
    };
  }

  #handler;

  get name() {
    return 'Host application (WebView2)';
  }

  start() {
    if (!this.available) {
      this.onMessage?.({
        type: 'error',
        message:
          'WebView2 host bridge not detected (window.chrome.webview missing). ' +
          'Run inside the host application, or choose the Simulated bus source.',
      });
      return;
    }
    if (this.running) return;
    this.running = true;
    window.chrome.webview.addEventListener('message', this.#handler);
    this.#send({ type: 'ready', protocolVersion: 1 });
    this.#send({ type: 'control', action: 'start' });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.#send({ type: 'control', action: 'stop' });
    if (this.available) window.chrome.webview.removeEventListener('message', this.#handler);
  }

  /** Send a control/save message to the host. */
  post(msg) {
    this.#send(msg);
  }

  #send(msg) {
    if (this.available) {
      try {
        window.chrome.webview.postMessage(msg);
      } catch {
        // some hosts only accept strings
        window.chrome.webview.postMessage(JSON.stringify(msg));
      }
    }
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

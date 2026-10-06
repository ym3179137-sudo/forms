export async function hardenPage(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };

    const fakePlugins = [
      { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" }
    ];
    Object.defineProperty(navigator, "plugins", { get: () => fakePlugins });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [{ type: "application/pdf" }] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

    const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (origQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : origQuery(params);
    }

    const glPatch = function (param) {
      if (param === 37445) return "Google Inc. (NVIDIA)";
      if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
      return this.__origGetParameter(param);
    };
    if (window.WebGLRenderingContext) {
      const proto = WebGLRenderingContext.prototype;
      proto.__origGetParameter = proto.getParameter;
      proto.getParameter = glPatch;
    }
    if (window.WebGL2RenderingContext) {
      const proto2 = WebGL2RenderingContext.prototype;
      proto2.__origGetParameter = proto2.getParameter;
      proto2.getParameter = glPatch;
    }

    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext("2d");
      if (ctx) {
        try {
          const img = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < img.data.length; i += 400) img.data[i] ^= 1;
          ctx.putImageData(img, 0, 0);
        } catch (_) {}
      }
      return toDataURL.apply(this, args);
    };

    if (window.AudioBuffer) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (...args) {
        const data = origGetChannelData.apply(this, args);
        for (let i = 0; i < data.length; i += 1000) data[i] += (Math.random() - 0.5) * 1e-7;
        return data;
      };
    }

    Object.defineProperty(navigator, "getBattery", {
      get: () => () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 })
    });
  });
}

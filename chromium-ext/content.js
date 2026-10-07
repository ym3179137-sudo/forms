// IXL Solver content script
// stealth patches
(function stealth() {
    try {
        // hide webdriver
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });

        // fake plugins (real Chrome has these)
        Object.defineProperty(navigator, "plugins", {
            get: () => {
                const arr = [
                    { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                    { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                    { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                    { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                    { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" }
                ];
                arr.item = (i) => arr[i];
                arr.namedItem = (n) => arr.find(p => p.name === n);
                arr.refresh = () => { };
                return arr;
            }
        });

        Object.defineProperty(navigator, "mimeTypes", {
            get: () => {
                const arr = [
                    { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
                    { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" }
                ];
                arr.item = (i) => arr[i];
                arr.namedItem = (n) => arr.find(m => m.type === n);
                return arr;
            }
        });

        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "language", { get: () => "en-US" });
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
        Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
        Object.defineProperty(navigator, "platform", { get: () => "Win32" });
        Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });

        // chrome runtime presence
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = {};
        if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({
            requestTime: 0, startLoadTime: 0, commitLoadTime: 0,
            finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
            firstPaintAfterLoadTime: 0, navigationType: "Other",
            wasFetchedViaSpdy: false, wasNpnNegotiated: false,
            npnNegotiatedProtocol: "unknown", wasAlternateProtocolAvailable: false,
            connectionInfo: "http/1.1"
        });
        if (!window.chrome.csi) window.chrome.csi = () => ({
            startE: 0, onloadT: 0, pageT: 0, tran: 15
        });
        if (!window.chrome.app) window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }
        };

        // permissions notification state
        const origQuery = window.navigator.permissions && window.navigator.permissions.query;
        if (origQuery) {
            window.navigator.permissions.query = (params) =>
                params.name === "notifications"
                    ? Promise.resolve({ state: Notification.permission, onchange: null })
                    : origQuery(params);
        }

        // webgl vendor/renderer — hide SwiftShader
        const getParamProto = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return "Google Inc. (NVIDIA)";
            if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
            return getParamProto.apply(this, arguments);
        };
        if (typeof WebGL2RenderingContext !== "undefined") {
            const getParamProto2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (param) {
                if (param === 37445) return "Google Inc. (NVIDIA)";
                if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
                return getParamProto2.apply(this, arguments);
            };
        }

        // canvas noise (subtle fingerprint scrambler)
        const toDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
            const ctx = this.getContext("2d");
            if (ctx) {
                try {
                    const img = ctx.getImageData(0, 0, this.width, this.height);
                    for (let i = 0; i < img.data.length; i += 400) img.data[i] ^= 1;
                    ctx.putImageData(img, 0, 0);
                } catch (_) { }
            }
            return toDataURL.apply(this, args);
        };

        // audio context noise
        if (window.AudioBuffer) {
            const origGetChannelData = AudioBuffer.prototype.getChannelData;
            AudioBuffer.prototype.getChannelData = function (...args) {
                const data = origGetChannelData.apply(this, args);
                for (let i = 0; i < data.length; i += 1000) data[i] += (Math.random() - 0.5) * 1e-7;
                return data;
            };
        }

        // battery api
        Object.defineProperty(navigator, "getBattery", {
            get: () => () => Promise.resolve({
                charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1
            })
        });
    } catch (_) { }
})();

const API_BASE = window.__IXL_SOLVER_API__ || "https://ixl-solver-production.up.railway.app";
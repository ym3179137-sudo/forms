export async function injectPanel(page, panelCfg = { title: "notes", defaultHidden: false }) {
    await page.evaluate((cfg) => {
        if (window.__ixlCtl) return;

        window.__ixlCtl = {
            auto: false,
            hidden: !!cfg.defaultHidden,
            status: "idle",
            log: []
        };

        const panel = document.createElement("div");
        panel.id = "__ixl_panel";
        panel.innerHTML =
            '<div class="__ixl_header">' +
            '<span class="__ixl_title">' + cfg.title + '</span>' +
            '<button class="__ixl_min" title="Ctrl+M to hide">-</button>' +
            '</div>' +
            '<button class="__ixl_toggle">Start Auto</button>' +
            '<div class="__ixl_status">status: idle</div>' +
            '<div class="__ixl_log"></div>';

        const style = document.createElement("style");
        style.textContent =
            "#__ixl_panel { position: fixed; bottom: 16px; right: 16px; width: 270px; max-height: 340px; background: rgba(18,22,34,0.94); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; backdrop-filter: blur(8px); box-shadow: 0 8px 32px rgba(0,0,0,0.45); user-select: none; }" +
            "#__ixl_panel.__hidden { display: none !important; }" +
            "#__ixl_panel .__ixl_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }" +
            "#__ixl_panel .__ixl_title { font-weight: 600; color: #8ab4ff; letter-spacing: 0.5px; }" +
            "#__ixl_panel .__ixl_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1; }" +
            "#__ixl_panel .__ixl_toggle { width: 100%; background: linear-gradient(180deg,#2a6eff,#1d54d6); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }" +
            "#__ixl_panel .__ixl_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); }" +
            "#__ixl_panel .__ixl_status { margin-top: 8px; color: #aab; font-size: 11px; }" +
            "#__ixl_panel .__ixl_log { margin-top: 6px; max-height: 150px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }" +
            "#__ixl_panel .__ixl_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }";

        document.documentElement.appendChild(style);
        document.documentElement.appendChild(panel);

        const toggleBtn = panel.querySelector(".__ixl_toggle");
        const statusEl = panel.querySelector(".__ixl_status");
        const logEl = panel.querySelector(".__ixl_log");
        const minBtn = panel.querySelector(".__ixl_min");

        function render() {
            if (window.__ixlCtl.auto) {
                toggleBtn.textContent = "Stop Auto";
                toggleBtn.classList.add("__on");
            } else {
                toggleBtn.textContent = "Start Auto";
                toggleBtn.classList.remove("__on");
            }
            statusEl.textContent = "status: " + window.__ixlCtl.status;
            if (window.__ixlCtl.hidden) panel.classList.add("__hidden");
            else panel.classList.remove("__hidden");
            logEl.innerHTML = window.__ixlCtl.log.slice(-10).map(l => "<div>" + l + "</div>").join("");
        }

        toggleBtn.addEventListener("click", () => {
            window.__ixlCtl.auto = !window.__ixlCtl.auto;
            window.__ixlCtl.status = window.__ixlCtl.auto ? "solving" : "paused";
            window.__ixlCtl.log.push(window.__ixlCtl.auto ? "auto started" : "auto paused");
            render();
        });

        minBtn.addEventListener("click", () => {
            window.__ixlCtl.hidden = true;
            render();
        });

        window.addEventListener("keydown", (e) => {
            if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
                e.preventDefault();
                e.stopPropagation();
                window.__ixlCtl.hidden = !window.__ixlCtl.hidden;
                render();
            }
        }, true);

        window.__ixlRender = render;
        render();
    }, panelCfg);
}

export async function updatePanel(page, status, logLine) {
    await page.evaluate((s, l) => {
        if (!window.__ixlCtl) return;
        if (s) window.__ixlCtl.status = s;
        if (l) {
            window.__ixlCtl.log.push(l);
            if (window.__ixlCtl.log.length > 30) window.__ixlCtl.log.shift();
        }
        if (window.__ixlRender) window.__ixlRender();
    }, status || null, logLine || null).catch(() => { });
}

export async function getAutoState(page) {
    return await page.evaluate(() => (window.__ixlCtl ? window.__ixlCtl.auto : false)).catch(() => false);
}
(() => {
    if (!window.location.hostname.includes("blooket.com")) return;
    if (window.__blooket_injected) return;
    window.__blooket_injected = true;

    // 1. Block Anti-Cheat Telemetry
    if (window.fetch && window.fetch.call.toString().includes("[native code]")) {
        const origCall = window.fetch.call;
        window.fetch.call = function () {
            const url = arguments[0] || "";
            if (typeof url === "string" && url.includes("s.blooket.com/rc")) {
                console.log("[cheat] Blocked Blooket report");
                return Promise.resolve(new Response(JSON.stringify({ success: true })));
            }
            return origCall.apply(this, arguments);
        };
    }

    // 2. Safe React State Node Extractor
    function getStateNode() {
        try {
            const root = document.querySelector("#app > div > div") || document.querySelector("body > div");
            if (!root) return null;
            const fiberKey = Object.keys(root).find(k => k.startsWith("__reactFiber$"));
            if (!fiberKey) return null;
            
            let fiber = root[fiberKey];
            while (fiber) {
                if (fiber.stateNode && fiber.stateNode.props && fiber.stateNode.props.liveGameController) {
                    return fiber.stateNode;
                }
                fiber = fiber.child || fiber.sibling;
            }
        } catch (e) { return null; }
        return null;
    }

    // 3. Build the UI
    const panel = document.createElement("div");
    panel.id = "__bk_panel";
    panel.style = `
        position: fixed; top: 20px; right: 20px; width: 300px; 
        background: rgba(15, 23, 42, 0.95); color: #fff; 
        border: 2px solid #3b82f6; border-radius: 12px; 
        font-family: 'Nunito', sans-serif; z-index: 999999; 
        box-shadow: 0 10px 25px rgba(0,0,0,0.5); padding: 15px;
    `;
    
    let html = `<h2 style="margin: 0 0 10px 0; text-align: center; color: #60a5fa; font-size: 18px;">Blooket Cheats</h2>`;
    
    const cheats = [
        { name: "Set Gold", id: "gold", input: true },
        { name: "Set Crypto", id: "crypto", input: true },
        { name: "Set Doubloons", id: "doubloons", input: true },
        { name: "Auto Answer", id: "autoanswer" },
        { name: "Highlight Answers", id: "highlight" },
        { name: "Get Daily Rewards", id: "rewards" },
        { name: "Flood Lobby", id: "flood", input: true },
        { name: "Crash Host", id: "crash" }
    ];

    cheats.forEach(c => {
        if (c.input) {
            html += `<div style="display: flex; gap: 5px; margin-bottom: 8px;">
                <input id="bk-input-${c.id}" type="text" placeholder="${c.name}" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #475569; background: #1e293b; color: #fff; outline: none;">
                <button id="bk-btn-${c.id}" style="padding: 8px 12px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Set</button>
            </div>`;
        } else {
            html += `<button id="bk-btn-${c.id}" style="width: 100%; padding: 10px; margin-bottom: 8px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">${c.name}</button>`;
        }
    });

    html += `<button id="bk-btn-close" style="width: 100%; padding: 8px; margin-top: 10px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Close</button>`;
    panel.innerHTML = html;
    document.body.appendChild(panel);

    document.getElementById("bk-btn-close").onclick = () => panel.remove();

    // 4. Cheat Implementations

    function handleInput(id, callback) {
        document.getElementById(`bk-btn-${id}`).onclick = () => {
            const val = document.getElementById(`bk-input-${id}`).value;
            if (val) callback(val);
        };
    }

    handleInput("gold", (val) => {
        const sn = getStateNode();
        if (sn) { sn.setState({ gold: parseInt(val) }); sn.props.liveGameController.setVal({ path: `c/${sn.props.client.name}/g`, val: parseInt(val) }); }
    });

    handleInput("crypto", (val) => {
        const sn = getStateNode();
        if (sn) { sn.setState({ crypto: parseInt(val) }); sn.props.liveGameController.setVal({ path: `c/${sn.props.client.name}/cr`, val: parseInt(val) }); }
    });

    handleInput("doubloons", (val) => {
        const sn = getStateNode();
        if (sn) { sn.setState({ doubloons: parseInt(val) }); sn.props.liveGameController.setVal({ path: `c/${sn.props.client.name}/d`, val: parseInt(val) }); }
    });

    document.getElementById("bk-btn-autoanswer").onclick = () => {
        if (window.__bk_autoanswer) {
            clearInterval(window.__bk_autoanswer);
            window.__bk_autoanswer = null;
            alert("Auto Answer disabled");
        } else {
            window.__bk_autoanswer = setInterval(() => {
                const sn = getStateNode();
                if (!sn || !sn.state || !sn.state.question) return;
                const q = sn.state.question;
                if (q.qType === "typing") {
                    const input = document.querySelector("[class*='typingAnswerWrapper'] input");
                    if (input) { input.value = q.answers[0]; input.dispatchEvent(new Event('input', { bubbles: true })); }
                } else {
                    const answers = document.querySelectorAll("[class*='answerContainer']");
                    answers.forEach((el, i) => { if (q.correctAnswers.includes(q.answers[i])) el.click(); });
                }
            }, 500);
            alert("Auto Answer enabled");
        }
    };

    document.getElementById("bk-btn-highlight").onclick = () => {
        const sn = getStateNode();
        if (!sn || !sn.state || !sn.state.question) return;
        const q = sn.state.question;
        document.querySelectorAll("[class*='answerContainer']").forEach((el, i) => {
            el.style.backgroundColor = q.correctAnswers.includes(q.answers[i]) ? "#22c55e" : "#ef4444";
        });
    };

    document.getElementById("bk-btn-rewards").onclick = async () => {
        try {
            const res = await fetch("https://play.blooket.com/api/playersessions/solo", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gameMode: "Factory", questionSetId: "5fac96fe2ca0da00042b018f" })
            }).then(r => r.json());
            await fetch("https://play.blooket.com/api/users/add-rewards", {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ t: res.t, addedTokens: 500, addedXp: 300 })
            });
            alert("Daily rewards claimed!");
        } catch (e) { alert("Error claiming rewards"); }
    };

    handleInput("flood", (val) => {
        const sn = getStateNode();
        if (!sn || !sn.props.liveGameController) return;
        const gameId = sn.props.client.hostId;
        const name = val;
        fetch("https://fb.blooket.com/c/firebase/join", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: gameId, name: name })
        }).then(r => r.json()).then(data => {
            if (data.success) {
                const fb = sn.props.liveGameController._liveApp;
                fb.auth().signInWithCustomToken(data.fbToken).then(() => {
                    fb.database().ref(`${gameId}/c/${name}`).set({ b: "Chick", bg: "starter" });
                });
            }
        });
    });

    document.getElementById("bk-btn-crash").onclick = () => {
        const sn = getStateNode();
        if (sn) sn.props.liveGameController.setVal({ path: `c/${sn.props.client.name}/b/toString`, val: "Crashed" });
    };

    console.log("[cheat] Blooket injected and ready");
})();
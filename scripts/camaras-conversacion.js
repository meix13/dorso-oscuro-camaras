/**
 * Dorso Oscuro - Modo Conversación de Cámaras (Foundry VTT v12 / v13 / v14)
 *
 * Permite al Máster alternar las cámaras (#camera-views) entre su barra normal
 * y el Centro de la pantalla (tapando la escena actual, pero dejando visibles
 * fichas de personaje, diarios y chat), eligiendo entre:
 *  - Modo Cuadrícula (todas las cámaras grandes del mismo tamaño)
 *  - Modo Destacar Orador (quien habla se muestra en grande arriba sin tirones)
 * Incluye un botón para que cualquier jugador pueda ver la escena cuando quiera.
 */

const MODULE_ID = "dorso-oscuro-camaras";
const SOCKET_NAME = `module.${MODULE_ID}`;

const DEFAULT_CONFIG = {
    active: false,                      // true = Cámaras en el centro (Modo Conversación) | false = Barra normal
    layout: "grid",                     // "grid" (Cuadrícula) | "spotlight" (Destacar Orador)
    pinnedUserId: "",                   // userId fijado manualmente por el GM en Spotlight ("" = automático por voz)
    backgroundStyle: "blur",            // "blur" | "dark" | "dim"
    aspectRatio: "4/3",                 // "4/3" | "16/9"
    allowPlayerPeek: true,              // Permitir que cada jugador pulse "Ver Escena" localmente
    pauseDialogosCentrales: true,       // Ocultar los bocadillos inferiores de Diálogos Centrales mientras las cámaras están en el centro
    useCharacterPortraitFallback: true, // Si un jugador no tiene vídeo y usa mystery-man, mostrar el retrato de su PJ
    holdDelayMs: 1400,                  // Retardo (ms) antes de dejar de considerar a alguien hablando en Spotlight
    forceSyncNonce: 1                   // Se incrementa al activar desde el GM para traer a todos al centro
};

// Estado local de cada cliente
let localPlayerPeek = false;     // true si el jugador ha pulsado "Ver Escena"
let localFullscreen = false;     // true si el usuario ha pulsado "Ancho Completo"
let lastSeenNonce = null;

// Estado de voz en tiempo real para el modo Destacar Orador
// userId -> { speaking: boolean, lastSpokeAt: number, hideTimeout: number|null }
const speakerMap = new Map();
let lastActiveSpeakerId = null;
let voiceHooksInstalled = false;

/**
 * Obtiene la configuración global guardada en el mundo
 */
function getConfig() {
    let raw = {};
    try {
        raw = game.settings.get(MODULE_ID, "config") || {};
    } catch {
        raw = {};
    }
    return {
        active: raw.active !== undefined ? Boolean(raw.active) : DEFAULT_CONFIG.active,
        layout: raw.layout === "spotlight" ? "spotlight" : "grid",
        pinnedUserId: typeof raw.pinnedUserId === "string" ? raw.pinnedUserId : "",
        backgroundStyle: ["blur", "dark", "dim"].includes(raw.backgroundStyle) ? raw.backgroundStyle : DEFAULT_CONFIG.backgroundStyle,
        aspectRatio: raw.aspectRatio === "16/9" ? "16/9" : "4/3",
        allowPlayerPeek: raw.allowPlayerPeek !== undefined ? Boolean(raw.allowPlayerPeek) : DEFAULT_CONFIG.allowPlayerPeek,
        pauseDialogosCentrales: raw.pauseDialogosCentrales !== undefined ? Boolean(raw.pauseDialogosCentrales) : DEFAULT_CONFIG.pauseDialogosCentrales,
        useCharacterPortraitFallback: raw.useCharacterPortraitFallback !== undefined ? Boolean(raw.useCharacterPortraitFallback) : DEFAULT_CONFIG.useCharacterPortraitFallback,
        holdDelayMs: Number(raw.holdDelayMs) || DEFAULT_CONFIG.holdDelayMs,
        forceSyncNonce: Number(raw.forceSyncNonce) || 1
    };
}

/**
 * Guarda la configuración en el mundo (solo GM)
 */
async function saveConfig(newConf) {
    if (!game.user?.isGM) return;
    await game.settings.set(MODULE_ID, "config", newConf);
}

/**
 * Actualiza parcialmente la configuración del mundo (solo GM)
 */
async function updateConfig(partial, forceBringAllToCenter = false) {
    if (!game.user?.isGM) return;
    const current = getConfig();
    const next = {
        ...current,
        ...partial
    };
    if (forceBringAllToCenter) {
        next.forceSyncNonce = (current.forceSyncNonce || 1) + 1;
    }
    await saveConfig(next);
}

/* ==========================================================================
   1. SINCRONIZACIÓN VISUAL DEL ESCENARIO Y LAS CÁMARAS (#camera-views)
   ========================================================================== */

function getCameraViewsElement() {
    return document.getElementById("camera-views");
}

function getVisibleCameraElements() {
    const camViews = getCameraViewsElement();
    if (!camViews) return [];
    return Array.from(camViews.querySelectorAll(".camera-container .camera-view")).filter(el => {
        if (el.classList.contains("hidden")) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none";
    });
}

/**
 * Si el usuario no tiene avatar configurado (mystery-man) pero tiene PJ asignado,
 * mejora la imagen .user-avatar dentro de su caja de cámara.
 */
function enhanceCharacterPortraitsIfNeeded(conf) {
    if (!conf.useCharacterPortraitFallback) return;
    const camViews = getCameraViewsElement();
    if (!camViews) return;

    camViews.querySelectorAll(".camera-view[data-user]").forEach(viewEl => {
        const userId = viewEl.dataset.user;
        const user = game.users?.get(userId);
        if (!user) return;

        const imgEl = viewEl.querySelector(".user-avatar");
        if (!imgEl) return;

        const currentSrc = imgEl.getAttribute("src") || "";
        const isDefaultMystery = !currentSrc || currentSrc.includes("mystery-man");

        if (isDefaultMystery) {
            const charImg = user.character?.img ||
                game.actors?.find(a => a.name.toLowerCase() !== "grupo" && a.ownership?.[userId] === 3)?.img;
            if (charImg && !charImg.includes("mystery-man")) {
                imgEl.setAttribute("src", charImg);
            }
        }
    });
}

/**
 * Inserta el salto de línea flexible (.do-cam-flex-break) dentro de .camera-container
 * y los botones de fijar (Pin) para el GM sobre cada cámara, sin mover ningún .camera-view
 */
function ensureCameraContainerHelpers(conf) {
    const camViews = getCameraViewsElement();
    if (!camViews) return;

    const container = camViews.querySelector(".camera-container");
    if (!container) return;

    // 1. Elemento separador para el modo Destacar Orador (Spotlight)
    let flexBreak = container.querySelector(".do-cam-flex-break");
    if (!flexBreak) {
        flexBreak = document.createElement("div");
        flexBreak.className = "do-cam-flex-break";
        container.appendChild(flexBreak);
    }

    // 2. Botón de chincheta (Pin) en cada cámara (solo para el GM)
    if (game.user?.isGM) {
        container.querySelectorAll(".camera-view[data-user]").forEach(viewEl => {
            const userId = viewEl.dataset.user;
            let pinBtn = viewEl.querySelector(".do-cam-pin-btn");
            if (!pinBtn) {
                pinBtn = document.createElement("button");
                pinBtn.type = "button";
                pinBtn.className = "do-cam-pin-btn";
                pinBtn.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
                pinBtn.addEventListener("click", async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const cur = getConfig();
                    const isAlreadyPinned = cur.pinnedUserId === userId && cur.layout === "spotlight";
                    await updateConfig({
                        layout: "spotlight",
                        pinnedUserId: isAlreadyPinned ? "" : userId
                    });
                    const uName = game.users?.get(userId)?.name || "Jugador";
                    if (isAlreadyPinned) {
                        ui.notifications?.info("Orador desbloqueado: Selección automática por voz activa.");
                    } else {
                        ui.notifications?.info(`Fijado en escenario principal: ${uName}`);
                    }
                });
                viewEl.appendChild(pinBtn);
            }

            const isPinned = conf.pinnedUserId === userId;
            pinBtn.classList.toggle("is-pinned", isPinned);
            pinBtn.title = isPinned
                ? "Quitar fijación (volver a detección automática por voz)"
                : "Fijar esta cámara en grande en Modo Destacar Orador";
        });
    }
}

/**
 * Calcula qué cámara(s) deben ocupar el escenario principal en el modo Destacar Orador
 * y actualiza los atributos data-cam-count y data-spotlight-count.
 */
function updateCameraLayoutAndSpotlight() {
    const conf = getConfig();
    const camViews = getCameraViewsElement();
    if (!camViews) return;

    const visibleCams = getVisibleCameraElements();
    const count = Math.max(1, Math.min(8, visibleCams.length));
    camViews.setAttribute("data-cam-count", String(count));
    camViews.style.setProperty("--do-cam-aspect", conf.aspectRatio === "16/9" ? "16 / 9" : "4 / 3");

    ensureCameraContainerHelpers(conf);
    enhanceCharacterPortraitsIfNeeded(conf);

    if (!conf.active || conf.layout !== "spotlight" || visibleCams.length <= 1) {
        visibleCams.forEach(el => el.classList.remove("do-spotlight-main"));
        camViews.setAttribute("data-spotlight-count", "1");
        return;
    }

    const visibleIds = new Set(visibleCams.map(el => el.dataset.user).filter(Boolean));
    const spotlightUserIds = [];

    // Prioridad 1: ¿El Máster ha fijado manualmente a un usuario?
    if (conf.pinnedUserId && visibleIds.has(conf.pinnedUserId)) {
        spotlightUserIds.push(conf.pinnedUserId);
    } else {
        // Prioridad 2: Usuarios que están hablando activamente ahora mismo (ordenados por más reciente)
        const activeTalking = [];
        for (const [uid, info] of speakerMap.entries()) {
            if (info.speaking && visibleIds.has(uid)) {
                activeTalking.push({ uid, lastSpokeAt: info.lastSpokeAt || 0 });
            }
        }
        activeTalking.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);

        // Permitimos hasta 2 oradores simultáneos en el escenario principal para diálogos cruzados
        for (const item of activeTalking.slice(0, 2)) {
            spotlightUserIds.push(item.uid);
        }

        // Prioridad 3: Si nadie habla en este instante, mantenemos al último que habló para evitar saltos
        if (spotlightUserIds.length === 0) {
            if (lastActiveSpeakerId && visibleIds.has(lastActiveSpeakerId)) {
                spotlightUserIds.push(lastActiveSpeakerId);
            } else {
                // Fallback inicial: la cámara del GM o la primera cámara visible
                const gmCam = visibleCams.find(el => {
                    const u = game.users?.get(el.dataset.user);
                    return u?.isGM;
                });
                const fallbackId = gmCam?.dataset.user || visibleCams[0]?.dataset.user;
                if (fallbackId) spotlightUserIds.push(fallbackId);
            }
        }
    }

    const spotlightSet = new Set(spotlightUserIds);
    visibleCams.forEach(el => {
        const uid = el.dataset.user;
        el.classList.toggle("do-spotlight-main", Boolean(uid && spotlightSet.has(uid)));
    });

    camViews.setAttribute("data-spotlight-count", String(Math.max(1, Math.min(2, spotlightSet.size))));
}

/**
 * Aplica todas las clases al body y sincroniza la barra superior y el panel del GM
 */
function syncConversationModeState() {
    if (!game.ready) return;

    const conf = getConfig();

    // Si el GM acaba de activar el modo o forzar sincronización, desactivar el "Ver Escena" local
    if (lastSeenNonce !== conf.forceSyncNonce) {
        if (lastSeenNonce !== null && conf.active) {
            localPlayerPeek = false;
        }
        lastSeenNonce = conf.forceSyncNonce;
    }

    if (!conf.active) {
        localPlayerPeek = false;
        localFullscreen = false;
    }

    // Si el GM desactiva el permiso de "Ver Escena", aseguramos que nadie quede en peek
    const effectivePeek = conf.active && localPlayerPeek && (conf.allowPlayerPeek || game.user?.isGM);

    const body = document.body;
    body.classList.toggle("do-cam-center-active", conf.active);
    body.classList.toggle("do-cam-player-peek", effectivePeek);
    body.classList.toggle("do-cam-fullscreen", conf.active && localFullscreen && !effectivePeek);

    body.classList.toggle("do-cam-layout-grid", conf.active && conf.layout === "grid");
    body.classList.toggle("do-cam-layout-spotlight", conf.active && conf.layout === "spotlight");

    body.classList.toggle("do-cam-bg-blur", conf.backgroundStyle === "blur");
    body.classList.toggle("do-cam-bg-dark", conf.backgroundStyle === "dark");
    body.classList.toggle("do-cam-bg-dim", conf.backgroundStyle === "dim");

    body.classList.toggle("do-cam-pause-dc", conf.active && conf.pauseDialogosCentrales);

    // Si algún jugador tenía #camera-views plegado/minimizado en Foundry y entra en modo conversación,
    // nos aseguramos de que los vídeos sean visibles
    updateCameraLayoutAndSpotlight();
    renderOrUpdateTopBar(conf, effectivePeek);
    renderOrUpdateGmFab(conf);
    refreshGmModalIfOpen(conf);
}

/* ==========================================================================
   2. DETECCIÓN DE VOZ (COMPATIBLE CON LIVEKIT Y WEBRTC NATIVO)
   ========================================================================== */

function handleSpeakingEvent(userId, isSpeaking, fromSocket = false) {
    if (!game.ready || !userId) return;

    // Emitir nuestro propio estado de voz por socket por si algún cliente no lo recibe de WebRTC
    if (!fromSocket && userId === game.user?.id && game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "speaking",
            userId,
            isSpeaking: Boolean(isSpeaking)
        });
    }

    const conf = getConfig();
    let entry = speakerMap.get(userId);
    if (!entry) {
        entry = { speaking: false, lastSpokeAt: 0, hideTimeout: null };
        speakerMap.set(userId, entry);
    }

    const camEl = document.querySelector(`#camera-views .camera-view[data-user="${userId}"]`);

    if (isSpeaking) {
        if (entry.hideTimeout) {
            clearTimeout(entry.hideTimeout);
            entry.hideTimeout = null;
        }
        const wasSpeaking = entry.speaking;
        entry.speaking = true;
        entry.lastSpokeAt = Date.now();
        lastActiveSpeakerId = userId;

        if (camEl) camEl.classList.add("do-is-speaking");

        if (!wasSpeaking && conf.active && conf.layout === "spotlight") {
            updateCameraLayoutAndSpotlight();
        }
    } else {
        if (entry.hideTimeout) clearTimeout(entry.hideTimeout);
        const holdMs = Math.max(300, conf.holdDelayMs || 1400);
        entry.hideTimeout = setTimeout(() => {
            entry.speaking = false;
            entry.hideTimeout = null;
            if (camEl) camEl.classList.remove("do-is-speaking");
            if (getConfig().active && getConfig().layout === "spotlight") {
                updateCameraLayoutAndSpotlight();
            }
        }, holdMs);
    }
}

function installVoiceHooks() {
    if (voiceHooksInstalled) return;
    voiceHooksInstalled = true;

    // 1. Envolver ui.webrtc.setUserIsSpeaking (estándar en Foundry VTT y avclient-livekit)
    const wrapWebRtc = () => {
        if (ui.webrtc && typeof ui.webrtc.setUserIsSpeaking === "function" && !ui.webrtc._doCamWrapped) {
            const orig = ui.webrtc.setUserIsSpeaking.bind(ui.webrtc);
            ui.webrtc.setUserIsSpeaking = function (userId, speaking) {
                try {
                    handleSpeakingEvent(userId, Boolean(speaking));
                } catch (e) {}
                return orig(userId, speaking);
            };
            ui.webrtc._doCamWrapped = true;
        }
    };

    wrapWebRtc();
    Hooks.on("renderCameraViews", () => {
        wrapWebRtc();
        setTimeout(() => {
            syncConversationModeState();
        }, 50);
    });

    // 2. Envolver directamente _liveKitClient.onIsSpeakingChanged si está presente
    const wrapLiveKit = () => {
        const lkClient = game.webrtc?.client?._liveKitClient;
        if (lkClient && typeof lkClient.onIsSpeakingChanged === "function" && !lkClient._doCamWrapped) {
            const origLk = lkClient.onIsSpeakingChanged.bind(lkClient);
            lkClient.onIsSpeakingChanged = function (userId, speaking) {
                try {
                    handleSpeakingEvent(userId, Boolean(speaking));
                } catch (e) {}
                return origLk(userId, speaking);
            };
            lkClient._doCamWrapped = true;
        }
    };

    wrapLiveKit();
    setTimeout(wrapLiveKit, 3000);

    // 3. MutationObserver sobre #camera-views para detectar cambios en la clase .speaking o nuevas cámaras
    const observer = new MutationObserver((mutations) => {
        let shouldRecount = false;
        for (const m of mutations) {
            if (m.type === "attributes" && m.attributeName === "class") {
                const el = m.target;
                if (el instanceof HTMLElement && el.classList.contains("camera-view") && el.dataset.user) {
                    const isSpk = el.classList.contains("speaking");
                    handleSpeakingEvent(el.dataset.user, isSpk);
                }
            } else if (m.type === "childList") {
                const target = m.target;
                if (target instanceof HTMLElement && (target.id === "camera-views" || target.closest("#camera-views"))) {
                    shouldRecount = true;
                }
            }
        }
        if (shouldRecount && getConfig().active) {
            updateCameraLayoutAndSpotlight();
        }
    });

    observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"]
    });
}

/* ==========================================================================
   3. BARRA SUPERIOR FLOTANTE (PARA JUGADORES Y MÁSTER)
   ========================================================================== */

function renderOrUpdateTopBar(conf, effectivePeek) {
    let topbar = document.getElementById("do-cam-topbar");

    if (!conf.active) {
        if (topbar) topbar.remove();
        return;
    }

    if (!topbar) {
        topbar = document.createElement("div");
        topbar.id = "do-cam-topbar";
        document.body.appendChild(topbar);
    }

    const isGM = Boolean(game.user?.isGM);
    const canPeek = conf.allowPlayerPeek || isGM;
    const pinnedUser = conf.pinnedUserId ? game.users?.get(conf.pinnedUserId) : null;

    const modeBadgeText = effectivePeek
        ? "VIENDO ESCENA"
        : (conf.layout === "spotlight" ? "MODO CONVERSACIÓN · ORADOR" : "MODO CONVERSACIÓN");

    topbar.innerHTML = `
        <div class="do-cam-topbar-left">
            <span class="do-cam-dot"></span>
            <span class="do-cam-badge">
                <i class="fa-solid ${conf.layout === "spotlight" ? "fa-person-rays" : "fa-users-viewfinder"}"></i>
                ${modeBadgeText}
            </span>
        </div>

        <div class="do-cam-topbar-actions">
            ${canPeek ? `
            <button type="button" class="do-cam-btn" id="do-cam-peek-btn" title="${effectivePeek ? "Volver a poner las cámaras en grande en el centro" : "Pasar las cámaras a la barra normal temporalmente para ver la escena"}">
                <i class="fa-solid ${effectivePeek ? "fa-users-viewfinder" : "fa-map"}"></i>
                <span>${effectivePeek ? "Volver a Cámaras" : "Ver Escena"}</span>
            </button>
            ` : ""}

            ${!effectivePeek ? `
            <button type="button" class="do-cam-btn ${localFullscreen ? "is-active" : ""}" id="do-cam-fs-btn" title="Ocultar o mostrar la barra lateral derecha para aprovechar todo el ancho">
                <i class="fa-solid ${localFullscreen ? "fa-compress" : "fa-expand"}"></i>
                <span>Ancho Completo</span>
            </button>
            ` : ""}

            ${isGM ? `
            <span style="width:1px; height:18px; background:#1e293b; margin:0 2px;"></span>

            <button type="button" class="do-cam-btn ${conf.layout === "grid" ? "is-active" : ""}" id="do-cam-top-grid-btn" title="Modo Cuadrícula: Todas las cámaras grandes del mismo tamaño">
                <i class="fa-solid fa-table-cells-large"></i> Cuadrícula
            </button>

            <button type="button" class="do-cam-btn ${conf.layout === "spotlight" ? "is-active" : ""}" id="do-cam-top-spot-btn" title="Modo Destacar Orador: Quien habla se ve más grande en el escenario principal">
                <i class="fa-solid fa-person-rays"></i> Destacar Orador
            </button>

            ${conf.layout === "spotlight" && pinnedUser ? `
            <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-unpin-btn" title="Quitar fijación de ${pinnedUser.name} y volver a detección automática por voz">
                <i class="fa-solid fa-thumbtack-slash"></i> Fijo: ${pinnedUser.name}
            </button>
            ` : ""}

            <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-top-gm-btn" title="Abrir panel de configuración de Modo Conversación">
                <i class="fa-solid fa-sliders"></i>
            </button>

            <button type="button" class="do-cam-btn do-cam-btn-danger" id="do-cam-top-off-btn" title="Desactivar Modo Conversación y devolver las cámaras de todos a la barra normal">
                <i class="fa-solid fa-xmark"></i> Barra Normal
            </button>
            ` : ""}
        </div>
    `;

    topbar.querySelector("#do-cam-peek-btn")?.addEventListener("click", () => {
        localPlayerPeek = !localPlayerPeek;
        syncConversationModeState();
    });

    topbar.querySelector("#do-cam-fs-btn")?.addEventListener("click", () => {
        localFullscreen = !localFullscreen;
        syncConversationModeState();
    });

    if (isGM) {
        topbar.querySelector("#do-cam-top-grid-btn")?.addEventListener("click", async () => {
            await updateConfig({ layout: "grid" });
        });

        topbar.querySelector("#do-cam-top-spot-btn")?.addEventListener("click", async () => {
            await updateConfig({ layout: "spotlight" });
        });

        topbar.querySelector("#do-cam-unpin-btn")?.addEventListener("click", async () => {
            await updateConfig({ pinnedUserId: "" });
            ui.notifications?.info("Detección automática de orador por voz activada.");
        });

        topbar.querySelector("#do-cam-top-gm-btn")?.addEventListener("click", () => {
            openGmModal();
        });

        topbar.querySelector("#do-cam-top-off-btn")?.addEventListener("click", async () => {
            await updateConfig({ active: false });
            ui.notifications?.info("Cámaras devueltas a la barra normal para todos.");
        });
    }
}

/* ==========================================================================
   4. BOTÓN RÁPIDO FLOTANTE DEL MÁSTER Y PANEL DE CONFIGURACIÓN GM
   ========================================================================== */

function renderOrUpdateGmFab(conf) {
    if (!game.user?.isGM) return;

    let fab = document.getElementById("do-cam-gm-fab");
    if (!fab) {
        fab = document.createElement("div");
        fab.id = "do-cam-gm-fab";
        document.body.appendChild(fab);
    }

    fab.classList.toggle("is-center-active", conf.active);

    fab.innerHTML = `
        <button type="button" class="do-cam-btn ${conf.active ? "do-cam-btn-success" : ""}" id="do-cam-fab-toggle" title="${conf.active ? "Devolver cámaras a la barra normal (Alt+C)" : "Activar Modo Conversación en el centro para todos (Alt+C)"}">
            <i class="fa-solid ${conf.active ? "fa-users-viewfinder" : "fa-video"}"></i>
            <span>${conf.active ? "Cámaras: CENTRO" : "Modo Conversación"}</span>
        </button>
        <button type="button" class="do-cam-btn" id="do-cam-fab-settings" title="Abrir ajustes de Modo Conversación y Destacar Orador">
            <i class="fa-solid fa-sliders"></i>
        </button>
    `;

    fab.querySelector("#do-cam-fab-toggle")?.addEventListener("click", async () => {
        const cur = getConfig();
        const nextActive = !cur.active;
        await updateConfig({ active: nextActive }, nextActive);
        ui.notifications?.info(
            nextActive
                ? "Modo Conversación ACTIVADO: Cámaras en el centro."
                : "Modo Conversación DESACTIVADO: Cámaras en la barra normal."
        );
    });

    fab.querySelector("#do-cam-fab-settings")?.addEventListener("click", () => {
        openGmModal();
    });
}

function openGmModal() {
    if (!game.user?.isGM) return;

    let backdrop = document.getElementById("do-cam-gm-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "do-cam-gm-backdrop";
        backdrop.className = "do-cam-gm-backdrop";
        backdrop.addEventListener("click", (ev) => {
            if (ev.target === backdrop) backdrop.remove();
        });
        document.body.appendChild(backdrop);
    }

    renderGmModalContent(backdrop, getConfig());
}

function refreshGmModalIfOpen(conf) {
    const backdrop = document.getElementById("do-cam-gm-backdrop");
    if (backdrop) {
        renderGmModalContent(backdrop, conf || getConfig());
    }
}

function renderGmModalContent(backdrop, conf) {
    const users = Array.from(game.users || []);
    const pinOptionsHtml = [
        `<option value="" ${!conf.pinnedUserId ? "selected" : ""}>🎙️ Automático por voz (con retención del último orador)</option>`,
        ...users.map(u => {
            const charLabel = u.character?.name ? ` (${u.character.name})` : (u.isGM ? " (Máster)" : "");
            return `<option value="${u.id}" ${conf.pinnedUserId === u.id ? "selected" : ""}>📌 Fijar a: ${u.name}${charLabel}</option>`;
        })
    ].join("");

    backdrop.innerHTML = `
        <div class="do-cam-gm-modal">
            <div class="do-cam-gm-header">
                <div class="do-cam-gm-title">
                    <i class="fa-solid fa-users-viewfinder"></i>
                    <span>DORSO OSCURO // MODO CONVERSACIÓN DE CÁMARAS</span>
                </div>
                <button type="button" class="do-cam-btn" id="do-cam-modal-close">
                    <i class="fa-solid fa-xmark"></i> Cerrar
                </button>
            </div>

            <div class="do-cam-gm-body">
                <!-- 1. Conmutador Principal: Barra Normal vs Centro -->
                <div class="do-cam-gm-card" style="border-color: ${conf.active ? "#10b981" : "#334155"};">
                    <div class="do-cam-gm-row">
                        <div>
                            <strong style="color:#f8fafc; font-size:14px;">Posición Global de las Cámaras</strong>
                            <div style="color:#94a3b8; font-size:12px;">
                                ${conf.active
                                    ? "Actualmente en el CENTRO tapando la escena (fichas y diarios siguen encima)"
                                    : "Actualmente en la BARRA NORMAL de Foundry"}
                            </div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            ${conf.active ? `
                            <button type="button" class="do-cam-btn" id="do-cam-force-sync-btn" title="Si algún jugador pulsó 'Ver Escena', vuelve a ponerle las cámaras en el centro">
                                <i class="fa-solid fa-arrows-to-circle"></i> Traer todos al centro
                            </button>
                            ` : ""}
                            <button type="button" id="do-cam-modal-toggle-active" class="do-cam-btn ${conf.active ? "do-cam-btn-danger" : "do-cam-btn-success"}" style="padding: 7px 14px; font-size: 12px;">
                                <i class="fa-solid ${conf.active ? "fa-down-left-and-up-right-to-center" : "fa-up-right-and-down-left-from-center"}"></i>
                                ${conf.active ? "Volver a Barra Normal" : "Poner en el Centro"}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 2. Elección de Diseño en el Centro: Cuadrícula vs Destacar Orador -->
                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-table-columns"></i> DISEÑO EN MODO CONVERSACIÓN</span>
                        <span>Se puede cambiar en vivo</span>
                    </div>
                    <div class="do-cam-mode-grid">
                        <button type="button" class="do-cam-mode-option ${conf.layout === "grid" ? "is-selected" : ""}" data-layout="grid">
                            <strong><i class="fa-solid fa-table-cells-large"></i> Modo Cuadrícula (Normal)</strong>
                            <span>Todas las cámaras se ven grandes y del mismo tamaño en el centro. Quien habla se ilumina con borde brillante.</span>
                        </button>
                        <button type="button" class="do-cam-mode-option ${conf.layout === "spotlight" ? "is-selected" : ""}" data-layout="spotlight">
                            <strong><i class="fa-solid fa-person-rays"></i> Destacar Orador (Escenario)</strong>
                            <span>Quien habla (o hasta 2 en diálogo) se muestra en grande arriba y el resto debajo, sin saltos bruscos al callar.</span>
                        </button>
                    </div>

                    ${conf.layout === "spotlight" ? `
                    <div class="do-cam-gm-row" style="margin-top: 6px; padding-top: 8px; border-top: 1px solid #1e293b;">
                        <label for="do-cam-pin-select">Protagonista en Escenario:</label>
                        <select id="do-cam-pin-select" class="do-cam-select" style="width: 280px;">
                            ${pinOptionsHtml}
                        </select>
                    </div>
                    <div class="do-cam-gm-row">
                        <label title="Evita que la cámara cambie si alguien hace una pausa breve al hablar">Estabilidad de voz (retardo al callar): <strong id="do-cam-hold-val" style="color:#38bdf8;">${conf.holdDelayMs}ms</strong></label>
                        <input type="range" id="do-cam-hold-slider" min="500" max="3000" step="100" value="${conf.holdDelayMs}" style="width:180px;" />
                    </div>
                    ` : ""}
                </div>

                <!-- 3. Opciones Visuales y Permisos del Jugador -->
                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-sliders"></i> OPCIONES DE ESCENA Y JUGADORES</span>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-allow-peek-cb" style="cursor:pointer;">
                            Mostrar botón <strong>"Ver Escena"</strong> a los jugadores para que puedan mirar el mapa
                        </label>
                        <input type="checkbox" id="do-cam-allow-peek-cb" ${conf.allowPlayerPeek ? "checked" : ""} />
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-bg-select">Fondo sobre la escena actual:</label>
                        <select id="do-cam-bg-select" class="do-cam-select" style="width: 230px;">
                            <option value="blur" ${conf.backgroundStyle === "blur" ? "selected" : ""}>🌫️ Cristal Oscuro Desenfocado (Blur)</option>
                            <option value="dark" ${conf.backgroundStyle === "dark" ? "selected" : ""}>🌑 Oscuro Opaco (Oculta el mapa al 100%)</option>
                            <option value="dim" ${conf.backgroundStyle === "dim" ? "selected" : ""}>🌓 Semitransparente Suave</option>
                        </select>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-aspect-select">Proporción de las cámaras:</label>
                        <select id="do-cam-aspect-select" class="do-cam-select" style="width: 230px;">
                            <option value="4/3" ${conf.aspectRatio === "4/3" ? "selected" : ""}>📺 Estándar (4:3)</option>
                            <option value="16/9" ${conf.aspectRatio === "16/9" ? "selected" : ""}>🎬 Panorámico (16:9)</option>
                        </select>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-pause-dc-cb" style="cursor:pointer;">
                            Pausar bocadillos inferiores de <em>Diálogos Centrales</em> mientras las cámaras están en el centro
                        </label>
                        <input type="checkbox" id="do-cam-pause-dc-cb" ${conf.pauseDialogosCentrales ? "checked" : ""} />
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-portrait-cb" style="cursor:pointer;">
                            Usar retrato del PJ automáticamente si un jugador no tiene avatar configurado
                        </label>
                        <input type="checkbox" id="do-cam-portrait-cb" ${conf.useCharacterPortraitFallback ? "checked" : ""} />
                    </div>
                </div>
            </div>
        </div>
    `;

    backdrop.querySelector("#do-cam-modal-close")?.addEventListener("click", () => backdrop.remove());

    backdrop.querySelector("#do-cam-modal-toggle-active")?.addEventListener("click", async () => {
        const nextActive = !conf.active;
        await updateConfig({ active: nextActive }, nextActive);
    });

    backdrop.querySelector("#do-cam-force-sync-btn")?.addEventListener("click", async () => {
        await updateConfig({ active: true }, true);
        ui.notifications?.info("Todos los jugadores han vuelto a la vista central de cámaras.");
    });

    backdrop.querySelectorAll(".do-cam-mode-option").forEach(btn => {
        btn.addEventListener("click", async () => {
            const chosenLayout = btn.dataset.layout;
            await updateConfig({ layout: chosenLayout });
        });
    });

    backdrop.querySelector("#do-cam-pin-select")?.addEventListener("change", async (ev) => {
        await updateConfig({ pinnedUserId: ev.target.value });
    });

    const holdSlider = backdrop.querySelector("#do-cam-hold-slider");
    const holdVal = backdrop.querySelector("#do-cam-hold-val");
    holdSlider?.addEventListener("input", (ev) => {
        if (holdVal) holdVal.textContent = `${ev.target.value}ms`;
    });
    holdSlider?.addEventListener("change", async (ev) => {
        await updateConfig({ holdDelayMs: Number(ev.target.value) });
    });

    backdrop.querySelector("#do-cam-allow-peek-cb")?.addEventListener("change", async (ev) => {
        await updateConfig({ allowPlayerPeek: ev.target.checked });
    });

    backdrop.querySelector("#do-cam-bg-select")?.addEventListener("change", async (ev) => {
        await updateConfig({ backgroundStyle: ev.target.value });
    });

    backdrop.querySelector("#do-cam-aspect-select")?.addEventListener("change", async (ev) => {
        await updateConfig({ aspectRatio: ev.target.value });
    });

    backdrop.querySelector("#do-cam-pause-dc-cb")?.addEventListener("change", async (ev) => {
        await updateConfig({ pauseDialogosCentrales: ev.target.checked });
    });

    backdrop.querySelector("#do-cam-portrait-cb")?.addEventListener("change", async (ev) => {
        await updateConfig({ useCharacterPortraitFallback: ev.target.checked });
    });
}

/* ==========================================================================
   5. HOOKS DE FOUNDRY VTT (INIT, READY, CONTROLES DE ESCENA, ATAJOS, API)
   ========================================================================== */

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Inicializando Modo Conversación de Cámaras...`);

    game.settings.register(MODULE_ID, "config", {
        name: "Configuración de Modo Conversación de Cámaras",
        scope: "world",
        config: false,
        type: Object,
        default: DEFAULT_CONFIG,
        onChange: () => {
            syncConversationModeState();
        }
    });

    if (game.keybindings) {
        game.keybindings.register(MODULE_ID, "toggleConversationMode", {
            name: "Alternar Modo Conversación (Cámaras al Centro / Barra Normal)",
            hint: "Pasa todas las cámaras al centro de la pantalla o las devuelve a su barra normal.",
            editable: [{ key: "KeyC", modifiers: ["Alt"] }],
            restricted: true,
            onDown: () => {
                if (game.user?.isGM) {
                    const cur = getConfig();
                    updateConfig({ active: !cur.active }, !cur.active);
                }
                return true;
            }
        });
    }

    // API pública para macros o integración con otros módulos
    window.DorsoCamaras = {
        openConfig: () => openGmModal(),
        activateCenter: (layout = null) => {
            const patch = { active: true };
            if (layout === "grid" || layout === "spotlight") patch.layout = layout;
            return updateConfig(patch, true);
        },
        deactivateCenter: () => updateConfig({ active: false }),
        toggleCenter: () => {
            const cur = getConfig();
            return updateConfig({ active: !cur.active }, !cur.active);
        },
        setLayout: (layout) => updateConfig({ layout: layout === "spotlight" ? "spotlight" : "grid" }),
        pinSpeaker: (userId = "") => updateConfig({ layout: "spotlight", pinnedUserId: userId })
    };
});

Hooks.on("getSceneControlButtons", (controls) => {
    const toolData = {
        name: "dorso-camaras-conversacion",
        title: "Modo Conversación de Cámaras (Centro / Barra Normal)",
        icon: "fa-solid fa-users-viewfinder",
        visible: game.user?.isGM,
        button: true,
        onClick: () => openGmModal(),
        onChange: () => openGmModal()
    };

    if (Array.isArray(controls)) {
        const tokenControl = controls.find(c => c.name === "token" || c.name === "tokens");
        if (tokenControl && Array.isArray(tokenControl.tools)) {
            tokenControl.tools.push(toolData);
        }
    } else if (controls && typeof controls === "object") {
        const tokenControl = controls.tokens || controls.token;
        if (tokenControl && tokenControl.tools) {
            if (Array.isArray(tokenControl.tools)) {
                tokenControl.tools.push(toolData);
            } else {
                tokenControl.tools["dorso-camaras-conversacion"] = toolData;
            }
        }
    }
});

Hooks.once("ready", () => {
    installVoiceHooks();

    if (game.socket) {
        game.socket.on(SOCKET_NAME, (payload) => {
            if (!payload || typeof payload !== "object") return;
            if (payload.action === "speaking" && payload.userId) {
                handleSpeakingEvent(payload.userId, Boolean(payload.isSpeaking), true);
            }
        });
    }

    syncConversationModeState();
});

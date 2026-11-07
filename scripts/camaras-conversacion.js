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
// userId -> { rawSpeaking: boolean, speaking: boolean, lastSpokeAt: number, hideTimeout: number|null }
const speakerMap = new Map();
let lastActiveSpeakerId = null;
let voiceHooksInstalled = false;

/**
 * Helper seguro para cambiar clases sin provocar mutaciones innecesarias del DOM
 */
function setClass(el, className, active) {
    if (!el || !className) return;
    const has = el.classList.contains(className);
    if (active && !has) {
        el.classList.add(className);
    } else if (!active && has) {
        el.classList.remove(className);
    }
}

/**
 * Helper seguro para atributos sin provocar mutaciones innecesarias del DOM
 */
function setAttr(el, attrName, value) {
    if (!el) return;
    const strVal = String(value);
    if (el.getAttribute(attrName) !== strVal) {
        el.setAttribute(attrName, strVal);
    }
}

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
        if (el.classList.contains("hidden") || el.hidden) return false;
        return true;
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
                setAttr(imgEl, "src", charImg);
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
            setClass(pinBtn, "is-pinned", isPinned);
            const expectedTitle = isPinned
                ? "Quitar fijación (volver a detección automática por voz)"
                : "Fijar esta cámara en grande en Modo Destacar Orador";
            if (pinBtn.title !== expectedTitle) pinBtn.title = expectedTitle;
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
    setAttr(camViews, "data-cam-count", count);

    const desiredAspect = conf.aspectRatio === "16/9" ? "16 / 9" : "4 / 3";
    if (camViews.style.getPropertyValue("--do-cam-aspect") !== desiredAspect) {
        camViews.style.setProperty("--do-cam-aspect", desiredAspect);
    }

    ensureCameraContainerHelpers(conf);
    enhanceCharacterPortraitsIfNeeded(conf);

    if (!conf.active || conf.layout !== "spotlight" || visibleCams.length <= 1) {
        visibleCams.forEach(el => setClass(el, "do-spotlight-main", false));
        setAttr(camViews, "data-spotlight-count", "1");
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
        setClass(el, "do-spotlight-main", Boolean(uid && spotlightSet.has(uid)));
    });

    setAttr(camViews, "data-spotlight-count", Math.max(1, Math.min(2, spotlightSet.size)));
}

/**
 * Aplica todas las clases al body y sincroniza la barra superior y la barra inferior del GM
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
    setClass(body, "do-cam-center-active", conf.active);
    setClass(body, "do-cam-player-peek", effectivePeek);
    setClass(body, "do-cam-fullscreen", conf.active && localFullscreen && !effectivePeek);

    setClass(body, "do-cam-layout-grid", conf.active && conf.layout === "grid");
    setClass(body, "do-cam-layout-spotlight", conf.active && conf.layout === "spotlight");

    setClass(body, "do-cam-bg-blur", conf.backgroundStyle === "blur");
    setClass(body, "do-cam-bg-dark", conf.backgroundStyle === "dark");
    setClass(body, "do-cam-bg-dim", conf.backgroundStyle === "dim");

    setClass(body, "do-cam-pause-dc", conf.active && conf.pauseDialogosCentrales);

    updateCameraLayoutAndSpotlight();
    renderOrUpdateTopBar(conf, effectivePeek);
    renderOrUpdateGmBar(conf);
    refreshGmModalIfOpen(conf);
}

/* ==========================================================================
   2. DETECCIÓN DE VOZ SIN BUCLES DE MUTACIÓN (LIVEKIT Y WEBRTC NATIVO)
   ========================================================================== */

function handleSpeakingEvent(userId, isSpeaking, fromSocket = false) {
    if (!game.ready || !userId) return;
    const speakingBool = Boolean(isSpeaking);

    let entry = speakerMap.get(userId);
    if (!entry) {
        entry = { rawSpeaking: false, speaking: false, lastSpokeAt: 0, hideTimeout: null };
        speakerMap.set(userId, entry);
    }

    // Evitar procesar eventos repetidos con el mismo estado (previene bucles e inundación de sockets)
    if (entry.rawSpeaking === speakingBool) {
        return;
    }
    entry.rawSpeaking = speakingBool;

    // Emitir nuestro propio cambio de voz por socket por si algún cliente no lo recibe de WebRTC
    if (!fromSocket && userId === game.user?.id && game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "speaking",
            userId,
            isSpeaking: speakingBool
        });
    }

    const conf = getConfig();
    const camEl = document.querySelector(`#camera-views .camera-view[data-user="${userId}"]`);

    if (speakingBool) {
        if (entry.hideTimeout) {
            clearTimeout(entry.hideTimeout);
            entry.hideTimeout = null;
        }
        const wasSpeaking = entry.speaking;
        entry.speaking = true;
        entry.lastSpokeAt = Date.now();
        lastActiveSpeakerId = userId;

        if (camEl) setClass(camEl, "do-is-speaking", true);

        if (!wasSpeaking && conf.active && conf.layout === "spotlight") {
            updateCameraLayoutAndSpotlight();
        }
    } else {
        if (entry.hideTimeout) clearTimeout(entry.hideTimeout);
        const holdMs = Math.max(300, conf.holdDelayMs || 1400);
        entry.hideTimeout = setTimeout(() => {
            entry.speaking = false;
            entry.hideTimeout = null;
            const currentCamEl = document.querySelector(`#camera-views .camera-view[data-user="${userId}"]`);
            if (currentCamEl) setClass(currentCamEl, "do-is-speaking", false);
            const curConf = getConfig();
            if (curConf.active && curConf.layout === "spotlight") {
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

    // 2. Envolver directamente _liveKitClient.onIsSpeakingChanged si está presente
    const wrapLiveKit = (lkInstance) => {
        const lkClient = lkInstance || game.webrtc?.client?._liveKitClient;
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

    wrapWebRtc();
    wrapLiveKit();
    setTimeout(wrapLiveKit, 2500);

    Hooks.on("liveKitClientAvailable", (lkClient) => wrapLiveKit(lkClient));
    Hooks.on("liveKitClientInitialized", (lkClient) => wrapLiveKit(lkClient));

    Hooks.on("renderCameraViews", () => {
        wrapWebRtc();
        wrapLiveKit();
        syncConversationModeState();
    });
}

/* ==========================================================================
   3. BARRA SUPERIOR FLOTANTE (CUANDO MODO CONVERSACIÓN ESTÁ ACTIVO)
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
        : (conf.layout === "spotlight" ? "CONVERSACIÓN · ORADOR" : "CONVERSACIÓN");

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
            </button>
            ` : ""}

            ${isGM ? `
            <span class="do-cam-sep"></span>

            <button type="button" class="do-cam-btn ${conf.layout === "grid" ? "is-active" : ""}" id="do-cam-top-grid-btn" title="Modo Cuadrícula: Todas las cámaras del mismo tamaño">
                <i class="fa-solid fa-table-cells-large"></i>
                <span>Cuadrícula</span>
            </button>

            <button type="button" class="do-cam-btn ${conf.layout === "spotlight" ? "is-active" : ""}" id="do-cam-top-spot-btn" title="Modo Destacar Orador: Quien habla se ve en grande arriba">
                <i class="fa-solid fa-person-rays"></i>
                <span>Orador</span>
            </button>

            ${conf.layout === "spotlight" && pinnedUser ? `
            <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-unpin-btn" title="Quitar fijación de ${pinnedUser.name} y volver a detección automática por voz">
                <i class="fa-solid fa-thumbtack-slash"></i>
                <span>${pinnedUser.name}</span>
            </button>
            ` : ""}

            <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-top-gm-btn" title="Abrir ajustes de Modo Conversación">
                <i class="fa-solid fa-sliders"></i>
            </button>

            <button type="button" class="do-cam-btn do-cam-btn-danger" id="do-cam-top-off-btn" title="Desactivar Modo Conversación y devolver las cámaras de todos a la barra normal">
                <i class="fa-solid fa-xmark"></i>
                <span>Barra Normal</span>
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
   4. BARRA DEL MÁSTER FIJA ENCIMA DE LOS CONTROLES DE CÁMARA/MICRÓFONO
   ========================================================================== */

function renderOrUpdateGmBar(conf) {
    if (!game.user?.isGM) return;

    const camViews = getCameraViewsElement();
    const userControls = camViews?.querySelector(":scope > .user-controls");

    let bar = document.getElementById("do-cam-gm-bar");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "do-cam-gm-bar";
    }

    // Colocar la barra justo encima de .user-controls dentro de #camera-views (o en body como respaldo)
    if (userControls && bar.nextElementSibling !== userControls) {
        userControls.before(bar);
    } else if (!userControls && !bar.parentElement) {
        document.body.appendChild(bar);
    }

    setClass(bar, "is-center-active", conf.active);

    bar.innerHTML = `
        <button type="button" class="do-cam-btn do-cam-gm-bar-main ${conf.active ? "do-cam-btn-success" : ""}" id="do-cam-bar-toggle" title="${conf.active ? "Devolver cámaras a la barra normal (Alt+C)" : "Activar Modo Conversación en el centro para todos (Alt+C)"}">
            <i class="fa-solid ${conf.active ? "fa-users-viewfinder" : "fa-video"}"></i>
            <span>${conf.active ? "Cámaras: CENTRO" : "Modo Conversación"}</span>
        </button>
        <button type="button" class="do-cam-btn do-cam-gm-bar-cfg" id="do-cam-bar-settings" title="Configurar Modo Conversación y Destacar Orador">
            <i class="fa-solid fa-sliders"></i>
        </button>
    `;

    bar.querySelector("#do-cam-bar-toggle")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cur = getConfig();
        const nextActive = !cur.active;
        await updateConfig({ active: nextActive }, nextActive);
        ui.notifications?.info(
            nextActive
                ? "Modo Conversación ACTIVADO: Cámaras en el centro."
                : "Modo Conversación DESACTIVADO: Cámaras en la barra normal."
        );
    });

    bar.querySelector("#do-cam-bar-settings")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
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
        `<option value="" ${!conf.pinnedUserId ? "selected" : ""}>🎙️ Automático por voz (retiene último orador)</option>`,
        ...users.map(u => {
            const charLabel = u.character?.name ? ` (${u.character.name})` : (u.isGM ? " (Máster)" : "");
            return `<option value="${u.id}" ${conf.pinnedUserId === u.id ? "selected" : ""}>📌 Fijar: ${u.name}${charLabel}</option>`;
        })
    ].join("");

    backdrop.innerHTML = `
        <div class="do-cam-gm-modal">
            <div class="do-cam-gm-header">
                <div class="do-cam-gm-title">
                    <i class="fa-solid fa-users-viewfinder"></i>
                    <span>MODO CONVERSACIÓN DE CÁMARAS</span>
                </div>
                <button type="button" class="do-cam-btn" id="do-cam-modal-close">
                    <i class="fa-solid fa-xmark"></i>
                    <span>Cerrar</span>
                </button>
            </div>

            <div class="do-cam-gm-body">
                <!-- 1. Conmutador Principal: Barra Normal vs Centro -->
                <div class="do-cam-gm-card" style="border-color: ${conf.active ? "#10b981" : "#334155"};">
                    <div class="do-cam-gm-row">
                        <div class="do-cam-gm-row-text">
                            <strong>Posición de las Cámaras</strong>
                            <span>${conf.active ? "En el CENTRO (tapando la escena)" : "En la BARRA NORMAL de Foundry"}</span>
                        </div>
                        <div class="do-cam-gm-row-actions">
                            ${conf.active ? `
                            <button type="button" class="do-cam-btn" id="do-cam-force-sync-btn" title="Si algún jugador pulsó 'Ver Escena', vuelve a ponerle las cámaras en el centro">
                                <i class="fa-solid fa-arrows-to-circle"></i>
                                <span>Sincronizar</span>
                            </button>
                            ` : ""}
                            <button type="button" id="do-cam-modal-toggle-active" class="do-cam-btn ${conf.active ? "do-cam-btn-danger" : "do-cam-btn-success"}">
                                <i class="fa-solid ${conf.active ? "fa-down-left-and-up-right-to-center" : "fa-up-right-and-down-left-from-center"}"></i>
                                <span>${conf.active ? "Pasar a Barra Normal" : "Poner en el Centro"}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 2. Elección de Diseño en el Centro: Cuadrícula vs Destacar Orador -->
                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-table-columns"></i> DISEÑO EN EL CENTRO</span>
                    </div>
                    <div class="do-cam-mode-grid">
                        <div class="do-cam-mode-option ${conf.layout === "grid" ? "is-selected" : ""}" data-layout="grid" role="button" tabindex="0">
                            <div class="do-cam-mode-title">
                                <i class="fa-solid fa-table-cells-large"></i>
                                <span>Cuadrícula</span>
                            </div>
                            <div class="do-cam-mode-desc">
                                Todas las cámaras iguales en el centro.
                            </div>
                        </div>
                        <div class="do-cam-mode-option ${conf.layout === "spotlight" ? "is-selected" : ""}" data-layout="spotlight" role="button" tabindex="0">
                            <div class="do-cam-mode-title">
                                <i class="fa-solid fa-person-rays"></i>
                                <span>Destacar Orador</span>
                            </div>
                            <div class="do-cam-mode-desc">
                                Quien habla se muestra en grande arriba.
                            </div>
                        </div>
                    </div>

                    ${conf.layout === "spotlight" ? `
                    <div class="do-cam-gm-row" style="margin-top: 4px; padding-top: 8px; border-top: 1px solid #1e293b;">
                        <label for="do-cam-pin-select">Orador principal:</label>
                        <select id="do-cam-pin-select" class="do-cam-select">
                            ${pinOptionsHtml}
                        </select>
                    </div>
                    <div class="do-cam-gm-row">
                        <label title="Evita que la cámara cambie si alguien hace una pausa breve al hablar">Retardo al callar: <strong id="do-cam-hold-val" style="color:#38bdf8;">${conf.holdDelayMs}ms</strong></label>
                        <input type="range" id="do-cam-hold-slider" min="500" max="3000" step="100" value="${conf.holdDelayMs}" style="width:160px;" />
                    </div>
                    ` : ""}
                </div>

                <!-- 3. Opciones Visuales y Permisos del Jugador -->
                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-sliders"></i> OPCIONES</span>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-allow-peek-cb" style="cursor:pointer;">
                            Permitir botón <strong>"Ver Escena"</strong> a los jugadores
                        </label>
                        <input type="checkbox" id="do-cam-allow-peek-cb" ${conf.allowPlayerPeek ? "checked" : ""} />
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-bg-select">Fondo sobre la escena:</label>
                        <select id="do-cam-bg-select" class="do-cam-select">
                            <option value="blur" ${conf.backgroundStyle === "blur" ? "selected" : ""}>🌫️ Cristal Oscuro (Blur)</option>
                            <option value="dark" ${conf.backgroundStyle === "dark" ? "selected" : ""}>🌑 Oscuro Opaco (100%)</option>
                            <option value="dim" ${conf.backgroundStyle === "dim" ? "selected" : ""}>🌓 Semitransparente</option>
                        </select>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-aspect-select">Proporción de cámaras:</label>
                        <select id="do-cam-aspect-select" class="do-cam-select">
                            <option value="4/3" ${conf.aspectRatio === "4/3" ? "selected" : ""}>📺 Estándar (4:3)</option>
                            <option value="16/9" ${conf.aspectRatio === "16/9" ? "selected" : ""}>🎬 Panorámico (16:9)</option>
                        </select>
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-pause-dc-cb" style="cursor:pointer;">
                            Ocultar <em>Diálogos Centrales</em> con cámaras en el centro
                        </label>
                        <input type="checkbox" id="do-cam-pause-dc-cb" ${conf.pauseDialogosCentrales ? "checked" : ""} />
                    </div>

                    <div class="do-cam-gm-row">
                        <label for="do-cam-portrait-cb" style="cursor:pointer;">
                            Usar retrato del PJ si un jugador no tiene avatar
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

    backdrop.querySelectorAll(".do-cam-mode-option").forEach(card => {
        card.addEventListener("click", async () => {
            const chosenLayout = card.dataset.layout;
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

/**
 * Dorso Oscuro - Modo Conversación de Cámaras y Salas Privadas (Foundry VTT v12 / v13 / v14)
 *
 * Permite al Máster:
 *  - Alternar las cámaras (#camera-views) entre su barra normal y el Centro de la pantalla
 *    (con Pantalla Completa por defecto plegando el sidebar derecho, permitiendo desplegarlo encima).
 *  - Elegir entre Modo Cuadrícula y Modo Destacar Orador (controlado manualmente por el Máster
 *    para elegir 1 o 2 protagonistas sin saltos caóticos, o con modo voz con retardo de entrada/salida).
 *  - Crear Salas Privadas instantáneas (Máster + X jugadores) sin desconectar LiveKit,
 *    dejando que los jugadores que quedan fuera sigan viéndose y hablando entre ellos.
 *  - Redimensionar libremente el ancho de la barra izquierda de cámaras en Modo Normal.
 */

const MODULE_ID = "dorso-oscuro-camaras";
const SOCKET_NAME = `module.${MODULE_ID}`;
const LOCAL_WIDTH_STORAGE_KEY = "dorso-oscuro-camaras.normalWidth";

const DEFAULT_CONFIG = {
    active: false,                      // true = Cámaras en el centro (Modo Conversación) | false = Barra normal
    layout: "grid",                     // "grid" (Cuadrícula) | "spotlight" (Destacar Orador)
    spotlightAutoVoice: false,          // false = El Máster elige quién está en grande (por defecto) | true = Automático por voz con retardo
    pinnedUserId: "",                   // (Legacy) userId principal fijado por el GM
    pinnedUserIds: [],                  // Hasta 2 userIds destacados manualmente por el GM en el escenario principal
    backgroundStyle: "blur",            // "blur" | "dark" | "dim"
    aspectRatio: "4/3",                 // "4/3" | "16/9"
    allowPlayerPeek: true,              // Permitir que cada jugador pulse "Ver Escena" localmente
    pauseDialogosCentrales: true,       // Ocultar los bocadillos inferiores de Diálogos Centrales mientras las cámaras están en el centro
    useCharacterPortraitFallback: true, // Si un jugador no tiene vídeo y usa mystery-man, mostrar el retrato de su PJ
    voiceActivateDelayMs: 1200,         // Retardo (ms) hablando seguido antes de subir al escenario en modo voz automático
    holdDelayMs: 2400,                  // Retardo (ms) al callar antes de bajar del escenario en modo voz automático
    forceSyncNonce: 1,                  // Se incrementa al activar desde el GM para traer a todos al centro
    privateActive: false,               // true = Hay una Sala Privada activa (GM + privateUserIds)
    privateUserIds: []                  // IDs de los jugadores convocados al privado con el GM
};

// Estado local de cada cliente
let localPlayerPeek = false;            // true si el jugador ha pulsado "Ver Escena"
let localFullscreen = true;             // true por defecto al entrar en Modo Centro (oculta barra derecha plegándola)
let lastSeenNonce = null;
let wasCenterActive = false;
let wasSidebarCollapsedBeforeCenter = null;

// Estado de voz en tiempo real
// userId -> { rawSpeaking: boolean, speaking: boolean, lastSpokeAt: number, activateTimeout: number|null, hideTimeout: number|null }
const speakerMap = new Map();
let lastActiveSpeakerId = null;
let voiceHooksInstalled = false;
let privateIsolationInterval = null;
let resizeListenersInstalled = false;

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

    let pinnedList = [];
    if (Array.isArray(raw.pinnedUserIds) && raw.pinnedUserIds.length > 0) {
        pinnedList = raw.pinnedUserIds.filter(id => typeof id === "string" && id);
    } else if (typeof raw.pinnedUserId === "string" && raw.pinnedUserId) {
        pinnedList = [raw.pinnedUserId];
    }

    return {
        active: raw.active !== undefined ? Boolean(raw.active) : DEFAULT_CONFIG.active,
        layout: raw.layout === "spotlight" ? "spotlight" : "grid",
        spotlightAutoVoice: raw.spotlightAutoVoice !== undefined ? Boolean(raw.spotlightAutoVoice) : DEFAULT_CONFIG.spotlightAutoVoice,
        pinnedUserId: pinnedList[0] || "",
        pinnedUserIds: pinnedList.slice(0, 2),
        backgroundStyle: ["blur", "dark", "dim"].includes(raw.backgroundStyle) ? raw.backgroundStyle : DEFAULT_CONFIG.backgroundStyle,
        aspectRatio: raw.aspectRatio === "16/9" ? "16/9" : "4/3",
        allowPlayerPeek: raw.allowPlayerPeek !== undefined ? Boolean(raw.allowPlayerPeek) : DEFAULT_CONFIG.allowPlayerPeek,
        pauseDialogosCentrales: raw.pauseDialogosCentrales !== undefined ? Boolean(raw.pauseDialogosCentrales) : DEFAULT_CONFIG.pauseDialogosCentrales,
        useCharacterPortraitFallback: raw.useCharacterPortraitFallback !== undefined ? Boolean(raw.useCharacterPortraitFallback) : DEFAULT_CONFIG.useCharacterPortraitFallback,
        voiceActivateDelayMs: Number(raw.voiceActivateDelayMs) >= 200 ? Number(raw.voiceActivateDelayMs) : DEFAULT_CONFIG.voiceActivateDelayMs,
        holdDelayMs: Number(raw.holdDelayMs) >= 400 ? Number(raw.holdDelayMs) : DEFAULT_CONFIG.holdDelayMs,
        forceSyncNonce: Number(raw.forceSyncNonce) || 1,
        privateActive: Boolean(raw.privateActive),
        privateUserIds: Array.isArray(raw.privateUserIds) ? raw.privateUserIds.filter(id => typeof id === "string" && id) : []
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
    if (partial.pinnedUserIds !== undefined) {
        next.pinnedUserIds = Array.from(new Set((partial.pinnedUserIds || []).filter(Boolean))).slice(0, 2);
        next.pinnedUserId = next.pinnedUserIds[0] || "";
    } else if (partial.pinnedUserId !== undefined) {
        next.pinnedUserId = partial.pinnedUserId || "";
        next.pinnedUserIds = next.pinnedUserId ? [next.pinnedUserId] : [];
    }
    if (forceBringAllToCenter) {
        next.forceSyncNonce = (current.forceSyncNonce || 1) + 1;
    }
    await saveConfig(next);
}

/**
 * Permite al GM elegir qué usuario(s) destacar en Modo Orador.
 * Si additive === true (Ctrl/Shift o segundo pin), añade/quita hasta un máximo de 2 usuarios en escena.
 */
async function selectSpotlightSpeaker(userId, additive = false) {
    if (!game.user?.isGM || !userId) return;
    const cur = getConfig();
    let list = [...(cur.pinnedUserIds || [])];

    if (additive) {
        if (list.includes(userId)) {
            list = list.filter(id => id !== userId);
        } else {
            if (list.length >= 2) list.shift();
            list.push(userId);
        }
    } else {
        list = [userId];
    }

    await updateConfig({
        layout: "spotlight",
        spotlightAutoVoice: false,
        pinnedUserIds: list
    });
}

/* ==========================================================================
   0. CONTROL DEL SIDEBAR DERECHO DE FOUNDRY Y REDIMENSIONADO BARRA IZQUIERDA
   ========================================================================== */

function isSidebarCollapsed() {
    if (!ui?.sidebar) return false;
    if (typeof ui.sidebar.collapsed === "boolean") return ui.sidebar.collapsed;
    if (typeof ui.sidebar._collapsed === "boolean") return ui.sidebar._collapsed;
    const el = document.getElementById("sidebar");
    return Boolean(el?.classList.contains("collapsed"));
}

function setSidebarCollapsed(shouldCollapse) {
    if (!ui?.sidebar) return;
    try {
        const currentlyCollapsed = isSidebarCollapsed();
        if (shouldCollapse && !currentlyCollapsed) {
            if (typeof ui.sidebar.collapse === "function") {
                ui.sidebar.collapse();
            } else if (typeof ui.sidebar.toggleExpanded === "function") {
                ui.sidebar.toggleExpanded(false);
            }
        } else if (!shouldCollapse && currentlyCollapsed) {
            if (typeof ui.sidebar.expand === "function") {
                ui.sidebar.expand();
            } else if (typeof ui.sidebar.toggleExpanded === "function") {
                ui.sidebar.toggleExpanded(true);
            }
        }
    } catch (e) {
        console.warn(`${MODULE_ID} | No se pudo alternar el sidebar derecho:`, e);
    }
}

function getNormalSidebarWidth() {
    try {
        const fromSetting = Number(game.settings.get(MODULE_ID, "normalSidebarWidth"));
        if (fromSetting >= 150 && fromSetting <= 620) return fromSetting;
    } catch {}
    try {
        const fromLocal = Number(localStorage.getItem(LOCAL_WIDTH_STORAGE_KEY));
        if (fromLocal >= 150 && fromLocal <= 620) return fromLocal;
    } catch {}
    return 250;
}

function applyNormalSidebarWidth(widthPx, persist = false) {
    const clamped = Math.max(160, Math.min(580, Math.round(Number(widthPx) || 250)));
    document.body.style.setProperty("--do-normal-av-width", `${clamped}px`);
    const camViews = document.getElementById("camera-views");
    if (camViews) {
        camViews.style.setProperty("--do-normal-av-width", `${clamped}px`);
    }
    if (persist) {
        try {
            localStorage.setItem(LOCAL_WIDTH_STORAGE_KEY, String(clamped));
        } catch {}
        try {
            game.settings.set(MODULE_ID, "normalSidebarWidth", clamped);
        } catch {}
    }
    return clamped;
}

function ensureNormalSidebarResizeHandle() {
    const camViews = document.getElementById("camera-views");
    if (!camViews) return;

    let handle = camViews.querySelector("#do-cam-resize-handle");
    if (!handle) {
        handle = document.createElement("div");
        handle.id = "do-cam-resize-handle";
        handle.title = "Arrastra a izquierda/derecha para cambiar el tamaño de las cámaras (Doble clic para restablecer)";
        handle.innerHTML = `<span class="do-cam-resize-grip"></span>`;
        camViews.appendChild(handle);

        let isDragging = false;
        let startX = 0;
        let startWidth = 250;

        handle.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            isDragging = true;
            startX = ev.clientX;
            startWidth = camViews.getBoundingClientRect().width || getNormalSidebarWidth();
            handle.setPointerCapture(ev.pointerId);
            document.body.classList.add("do-cam-is-resizing-bar");
        });

        handle.addEventListener("pointermove", (ev) => {
            if (!isDragging) return;
            ev.preventDefault();
            const delta = ev.clientX - startX;
            applyNormalSidebarWidth(startWidth + delta, false);
        });

        const finishDrag = (ev) => {
            if (!isDragging) return;
            isDragging = false;
            try {
                if (ev?.pointerId !== undefined) handle.releasePointerCapture(ev.pointerId);
            } catch {}
            document.body.classList.remove("do-cam-is-resizing-bar");
            const currentW = camViews.getBoundingClientRect().width || getNormalSidebarWidth();
            applyNormalSidebarWidth(currentW, true);
        };

        handle.addEventListener("pointerup", finishDrag);
        handle.addEventListener("pointercancel", finishDrag);

        handle.addEventListener("dblclick", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            applyNormalSidebarWidth(250, true);
            ui.notifications?.info("Ancho de barra de cámaras restablecido (250px).");
        });
    }

    if (!resizeListenersInstalled) {
        resizeListenersInstalled = true;
        applyNormalSidebarWidth(getNormalSidebarWidth(), false);
    }
}

/* ==========================================================================
   1. SISTEMA DE SALAS PRIVADAS (AISLAMIENTO DE AUDIO Y VÍDEO EN CLIENTE)
   ========================================================================== */

function isUserInPrivateRoom(userId, conf) {
    if (!conf?.privateActive || !userId) return false;
    const u = game.users?.get(userId);
    if (u?.isGM) return true;
    return conf.privateUserIds.includes(userId);
}

function areUsersInSameRoom(userIdA, userIdB, conf) {
    if (!conf?.privateActive) return true;
    if (!userIdA || !userIdB) return true;
    if (userIdA === userIdB) return true;
    return isUserInPrivateRoom(userIdA, conf) === isUserInPrivateRoom(userIdB, conf);
}

function canLocalUserCommunicateWith(otherUserId, conf) {
    const myId = game.user?.id;
    if (!myId || !otherUserId || myId === otherUserId) return true;
    return areUsersInSameRoom(myId, otherUserId, conf || getConfig());
}

function resolveUserIdFromLiveKitParticipant(participant, lkClient) {
    if (!participant) return null;
    const identity = String(participant.identity || "");
    const name = String(participant.name || "");

    if (lkClient) {
        try {
            if (typeof lkClient.getUserId === "function") {
                const resolved = lkClient.getUserId(identity);
                if (resolved && game.users?.has(resolved)) return resolved;
            }
        } catch {}
    }

    if (identity && game.users?.has(identity)) return identity;

    for (const u of (game.users || [])) {
        if (identity && (identity === u.id || identity.includes(u.id) || identity === u.name)) {
            return u.id;
        }
        if (name && name === u.name) {
            return u.id;
        }
    }
    return null;
}

function enforcePrivateRoomIsolation(conf) {
    const activeConf = conf || getConfig();
    const camViews = getCameraViewsElement();

    if (camViews) {
        camViews.querySelectorAll(".camera-view[data-user]").forEach(viewEl => {
            const uid = viewEl.dataset.user;
            if (!uid) return;
            const isSelf = uid === game.user?.id;
            const allowed = isSelf || canLocalUserCommunicateWith(uid, activeConf);

            setClass(viewEl, "do-cam-private-isolated", !allowed);

            viewEl.querySelectorAll("video, audio").forEach(mediaEl => {
                applyMediaElementIsolation(mediaEl, allowed, isSelf);
            });
        });
    }

    document.querySelectorAll("audio[data-user], video[data-user]").forEach(mediaEl => {
        const uid = mediaEl.dataset.user;
        if (!uid) return;
        const isSelf = uid === game.user?.id;
        const allowed = isSelf || canLocalUserCommunicateWith(uid, activeConf);
        applyMediaElementIsolation(mediaEl, allowed, isSelf);
    });

    try {
        const client = game.webrtc?.client;
        const lkClient = client?._liveKitClient || client;
        const room = lkClient?._liveKitRoom || lkClient?.room;
        const remoteParticipants = room?.remoteParticipants || room?.participants || lkClient?._remoteParticipants;

        if (remoteParticipants && typeof remoteParticipants.values === "function") {
            for (const participant of remoteParticipants.values()) {
                const uid = resolveUserIdFromLiveKitParticipant(participant, lkClient);
                if (!uid || uid === game.user?.id) continue;

                const allowed = canLocalUserCommunicateWith(uid, activeConf);
                const pubMaps = [
                    participant.trackPublications,
                    participant.audioTrackPublications,
                    participant.videoTrackPublications,
                    participant.tracks
                ].filter(m => m && typeof m.values === "function");

                for (const pubMap of pubMaps) {
                    for (const pub of pubMap.values()) {
                        const track = pub?.track || pub?.audioTrack || pub?.videoTrack;
                        if (!track) continue;

                        if (track.mediaStreamTrack && track.mediaStreamTrack.enabled !== allowed) {
                            track.mediaStreamTrack.enabled = allowed;
                        }

                        if (typeof track.setVolume === "function") {
                            if (!allowed) {
                                if (track._doSavedVolume === undefined && typeof track.volume === "number" && track.volume > 0) {
                                    track._doSavedVolume = track.volume;
                                }
                                try { track.setVolume(0); } catch {}
                            } else if (track._doSavedVolume !== undefined) {
                                try { track.setVolume(track._doSavedVolume); } catch {}
                                delete track._doSavedVolume;
                            }
                        }

                        if (Array.isArray(track.attachedElements)) {
                            track.attachedElements.forEach(el => {
                                applyMediaElementIsolation(el, allowed, false);
                            });
                        }
                    }
                }
            }
        }
    } catch (e) {}

    if (activeConf.privateActive) {
        for (const [uid, entry] of speakerMap.entries()) {
            if (!canLocalUserCommunicateWith(uid, activeConf) && (entry.speaking || entry.rawSpeaking)) {
                entry.rawSpeaking = false;
                entry.speaking = false;
                if (entry.activateTimeout) {
                    clearTimeout(entry.activateTimeout);
                    entry.activateTimeout = null;
                }
                if (entry.hideTimeout) {
                    clearTimeout(entry.hideTimeout);
                    entry.hideTimeout = null;
                }
                const camEl = document.querySelector(`#camera-views .camera-view[data-user="${uid}"]`);
                if (camEl) setClass(camEl, "do-is-speaking", false);
            }
        }
    }
}

function applyMediaElementIsolation(mediaEl, allowed, isSelf) {
    if (!mediaEl || isSelf) return;

    if (!allowed) {
        if (mediaEl.dataset.doPrivMuted !== "1") {
            mediaEl.dataset.doPrevMuted = mediaEl.muted ? "1" : "0";
            mediaEl.dataset.doPrevVol = String(mediaEl.volume ?? 1);
            mediaEl.dataset.doPrivMuted = "1";
        }
        if (!mediaEl.muted) mediaEl.muted = true;
        try {
            if (mediaEl.volume !== 0) mediaEl.volume = 0;
        } catch {}

        if (mediaEl.srcObject && typeof mediaEl.srcObject.getTracks === "function") {
            mediaEl.srcObject.getTracks().forEach(t => {
                if (t.enabled !== false) t.enabled = false;
            });
        }
    } else {
        if (mediaEl.dataset.doPrivMuted === "1") {
            mediaEl.muted = mediaEl.dataset.doPrevMuted === "1";
            const prevVol = parseFloat(mediaEl.dataset.doPrevVol);
            if (!isNaN(prevVol)) {
                try { mediaEl.volume = prevVol; } catch {}
            }
            delete mediaEl.dataset.doPrivMuted;
            delete mediaEl.dataset.doPrevMuted;
            delete mediaEl.dataset.doPrevVol;
        }
        if (mediaEl.srcObject && typeof mediaEl.srcObject.getTracks === "function") {
            mediaEl.srcObject.getTracks().forEach(t => {
                if (t.enabled !== true) t.enabled = true;
            });
        }
    }
}

/* ==========================================================================
   2. SINCRONIZACIÓN VISUAL DEL ESCENARIO Y LAS CÁMARAS (#camera-views)
   ========================================================================== */

function getCameraViewsElement() {
    return document.getElementById("camera-views");
}

function getVisibleCameraElements() {
    const camViews = getCameraViewsElement();
    if (!camViews) return [];
    return Array.from(camViews.querySelectorAll(".camera-container .camera-view")).filter(el => {
        if (el.classList.contains("hidden") || el.hidden) return false;
        if (el.classList.contains("do-cam-private-isolated")) return false;
        return true;
    });
}

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
 * y los botones de Destacar Orador (Pin) para el GM sobre cada cámara
 */
function ensureCameraContainerHelpers(conf) {
    const camViews = getCameraViewsElement();
    if (!camViews) return;

    const container = camViews.querySelector(".camera-container");
    if (!container) return;

    let flexBreak = container.querySelector(".do-cam-flex-break");
    if (!flexBreak) {
        flexBreak = document.createElement("div");
        flexBreak.className = "do-cam-flex-break";
        container.appendChild(flexBreak);
    }

    if (game.user?.isGM) {
        const pinnedSet = new Set(conf.pinnedUserIds || []);
        container.querySelectorAll(".camera-view[data-user]").forEach(viewEl => {
            const userId = viewEl.dataset.user;
            let pinBtn = viewEl.querySelector(".do-cam-pin-btn");
            if (!pinBtn) {
                pinBtn = document.createElement("button");
                pinBtn.type = "button";
                pinBtn.className = "do-cam-pin-btn";
                pinBtn.innerHTML = `<i class="fa-solid fa-star"></i>`;
                pinBtn.addEventListener("click", async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const additive = ev.ctrlKey || ev.shiftKey || ev.metaKey;
                    await selectSpotlightSpeaker(userId, additive);
                    const uName = game.users?.get(userId)?.name || "Jugador";
                    ui.notifications?.info(`Orador destacado en grande: ${uName}`);
                });
                viewEl.appendChild(pinBtn);
            }

            const isPinned = conf.layout === "spotlight" && !conf.spotlightAutoVoice && pinnedSet.has(userId);
            setClass(pinBtn, "is-pinned", isPinned);
            const expectedTitle = isPinned
                ? "Destacado en grande (Ctrl+Clic en otra cámara para poner 2 a la vez)"
                : "Poner esta cámara en grande en Modo Orador (Ctrl+Clic para añadir como 2º orador)";
            if (pinBtn.title !== expectedTitle) pinBtn.title = expectedTitle;
        });
    }
}

/**
 * Calcula qué cámara(s) deben ocupar el escenario principal en el modo Destacar Orador
 */
function updateCameraLayoutAndSpotlight() {
    const conf = getConfig();
    const camViews = getCameraViewsElement();
    if (!camViews) return;

    enforcePrivateRoomIsolation(conf);

    const visibleCams = getVisibleCameraElements();
    const count = Math.max(1, Math.min(12, visibleCams.length));
    setAttr(camViews, "data-cam-count", count);

    const is16x9 = conf.aspectRatio === "16/9";
    const desiredAspect = is16x9 ? "16 / 9" : "4 / 3";
    const desiredAspectNum = is16x9 ? "1.7778" : "1.3333";

    if (camViews.style.getPropertyValue("--do-cam-aspect") !== desiredAspect) {
        camViews.style.setProperty("--do-cam-aspect", desiredAspect);
    }
    if (camViews.style.getPropertyValue("--do-cam-ar") !== desiredAspectNum) {
        camViews.style.setProperty("--do-cam-ar", desiredAspectNum);
    }

    ensureCameraContainerHelpers(conf);
    enhanceCharacterPortraitsIfNeeded(conf);
    ensureNormalSidebarResizeHandle();

    camViews.querySelectorAll(".camera-view.do-cam-private-isolated.do-spotlight-main").forEach(el => {
        setClass(el, "do-spotlight-main", false);
    });

    if (!conf.active || conf.layout !== "spotlight" || visibleCams.length <= 1) {
        visibleCams.forEach(el => setClass(el, "do-spotlight-main", false));
        setAttr(camViews, "data-spotlight-count", "1");
        camViews.style.setProperty("--do-sec-count", "1");
        return;
    }

    const visibleIds = new Set(visibleCams.map(el => el.dataset.user).filter(Boolean));
    const spotlightUserIds = [];

    if (!conf.spotlightAutoVoice) {
        // MODO MANUAL DEL MÁSTER (Por defecto, estable y sin cambios automáticos por ruido/voz)
        for (const pid of (conf.pinnedUserIds || [])) {
            if (visibleIds.has(pid)) {
                spotlightUserIds.push(pid);
            }
        }
        // Si el GM aún no ha elegido a nadie (o el elegido no está visible), destacamos al GM o al primero
        if (spotlightUserIds.length === 0) {
            const gmCam = visibleCams.find(el => {
                const u = game.users?.get(el.dataset.user);
                return u?.isGM;
            });
            const fallbackId = gmCam?.dataset.user || visibleCams[0]?.dataset.user;
            if (fallbackId) spotlightUserIds.push(fallbackId);
        }
    } else {
        // MODO AUTOMÁTICO POR VOZ CON RETARDO DE ENTRADA Y SALIDA
        const activeTalking = [];
        for (const [uid, info] of speakerMap.entries()) {
            if (info.speaking && visibleIds.has(uid) && canLocalUserCommunicateWith(uid, conf)) {
                activeTalking.push({ uid, lastSpokeAt: info.lastSpokeAt || 0 });
            }
        }
        activeTalking.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);

        for (const item of activeTalking.slice(0, 2)) {
            spotlightUserIds.push(item.uid);
        }

        if (spotlightUserIds.length === 0) {
            if (lastActiveSpeakerId && visibleIds.has(lastActiveSpeakerId) && canLocalUserCommunicateWith(lastActiveSpeakerId, conf)) {
                spotlightUserIds.push(lastActiveSpeakerId);
            } else {
                const gmCam = visibleCams.find(el => {
                    const u = game.users?.get(el.dataset.user);
                    return u?.isGM;
                });
                const fallbackId = gmCam?.dataset.user || visibleCams[0]?.dataset.user;
                if (fallbackId) spotlightUserIds.push(fallbackId);
            }
        }
    }

    const spotlightSet = new Set(spotlightUserIds.slice(0, 2));
    visibleCams.forEach(el => {
        const uid = el.dataset.user;
        setClass(el, "do-spotlight-main", Boolean(uid && spotlightSet.has(uid)));
    });

    const spotCount = Math.max(1, Math.min(2, spotlightSet.size));
    const secCount = Math.max(1, visibleCams.length - spotCount);
    setAttr(camViews, "data-spotlight-count", spotCount);
    camViews.style.setProperty("--do-sec-count", String(secCount));
}

function syncConversationModeState() {
    if (!game.ready) return;

    const conf = getConfig();

    if (lastSeenNonce !== conf.forceSyncNonce) {
        if (conf.active) {
            localPlayerPeek = false;
            localFullscreen = true;
        }
        lastSeenNonce = conf.forceSyncNonce;
    }

    if (conf.active && !wasCenterActive) {
        wasCenterActive = true;
        localFullscreen = true;
        wasSidebarCollapsedBeforeCenter = isSidebarCollapsed();
        setSidebarCollapsed(true);
    } else if (!conf.active && wasCenterActive) {
        wasCenterActive = false;
        localPlayerPeek = false;
        localFullscreen = true;
        if (wasSidebarCollapsedBeforeCenter === false) {
            setSidebarCollapsed(false);
        }
        wasSidebarCollapsedBeforeCenter = null;
    }

    const effectivePeek = conf.active && localPlayerPeek && (conf.allowPlayerPeek || game.user?.isGM);

    const body = document.body;
    setClass(body, "do-cam-center-active", conf.active);
    setClass(body, "do-cam-player-peek", effectivePeek);
    setClass(body, "do-cam-fullscreen", conf.active && localFullscreen && !effectivePeek);
    setClass(body, "do-cam-private-active", conf.privateActive);

    setClass(body, "do-cam-layout-grid", conf.active && conf.layout === "grid");
    setClass(body, "do-cam-layout-spotlight", conf.active && conf.layout === "spotlight");

    setClass(body, "do-cam-bg-blur", conf.backgroundStyle === "blur");
    setClass(body, "do-cam-bg-dark", conf.backgroundStyle === "dark");
    setClass(body, "do-cam-bg-dim", conf.backgroundStyle === "dim");

    setClass(body, "do-cam-pause-dc", conf.active && conf.pauseDialogosCentrales);

    updateCameraLayoutAndSpotlight();
    renderOrUpdateTopBar(conf, effectivePeek);
    renderOrUpdatePrivateBanner(conf);
    renderOrUpdateGmBar(conf);
    refreshGmModalIfOpen(conf);
    refreshPrivateModalIfOpen(conf);
}

/* ==========================================================================
   3. DETECCIÓN DE VOZ (CON RETARDO DE ENTRADA Y SALIDA PARA EVITAR SALTOS)
   ========================================================================== */

function handleSpeakingEvent(userId, isSpeaking, fromSocket = false) {
    if (!game.ready || !userId) return;

    const conf = getConfig();
    const allowedInMyRoom = canLocalUserCommunicateWith(userId, conf);
    const speakingBool = allowedInMyRoom ? Boolean(isSpeaking) : false;

    let entry = speakerMap.get(userId);
    if (!entry) {
        entry = { rawSpeaking: false, speaking: false, lastSpokeAt: 0, activateTimeout: null, hideTimeout: null };
        speakerMap.set(userId, entry);
    }

    if (entry.rawSpeaking === speakingBool) {
        return;
    }
    entry.rawSpeaking = speakingBool;

    if (!fromSocket && userId === game.user?.id && game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "speaking",
            userId,
            isSpeaking: Boolean(isSpeaking)
        });
    }

    const camEl = document.querySelector(`#camera-views .camera-view[data-user="${userId}"]`);

    if (speakingBool) {
        // El borde luminoso de quien habla es inmediato
        if (camEl) setClass(camEl, "do-is-speaking", true);

        if (entry.hideTimeout) {
            clearTimeout(entry.hideTimeout);
            entry.hideTimeout = null;
        }

        // Si ya estaba promovido como orador activo, actualizamos su marca de tiempo
        if (entry.speaking) {
            entry.lastSpokeAt = Date.now();
            lastActiveSpeakerId = userId;
            return;
        }

        // Retardo de entrada antes de promover a alguien al escenario en modo automático por voz
        if (!entry.activateTimeout) {
            const activateMs = Math.max(200, conf.voiceActivateDelayMs || 1200);
            entry.activateTimeout = setTimeout(() => {
                entry.activateTimeout = null;
                if (!entry.rawSpeaking) return;
                entry.speaking = true;
                entry.lastSpokeAt = Date.now();
                lastActiveSpeakerId = userId;

                const curConf = getConfig();
                if (curConf.active && curConf.layout === "spotlight" && curConf.spotlightAutoVoice) {
                    updateCameraLayoutAndSpotlight();
                }
            }, activateMs);
        }
    } else {
        // Si dejó de hablar antes de cumplir el tiempo mínimo de entrada, cancelamos promoción
        if (entry.activateTimeout) {
            clearTimeout(entry.activateTimeout);
            entry.activateTimeout = null;
        }

        if (entry.hideTimeout) clearTimeout(entry.hideTimeout);
        const holdMs = Math.max(400, conf.holdDelayMs || 2400);
        entry.hideTimeout = setTimeout(() => {
            entry.speaking = false;
            entry.hideTimeout = null;
            const currentCamEl = document.querySelector(`#camera-views .camera-view[data-user="${userId}"]`);
            if (currentCamEl) setClass(currentCamEl, "do-is-speaking", false);
            const curConf = getConfig();
            if (curConf.active && curConf.layout === "spotlight" && curConf.spotlightAutoVoice) {
                updateCameraLayoutAndSpotlight();
            }
        }, holdMs);
    }
}

function installVoiceHooks() {
    if (voiceHooksInstalled) return;
    voiceHooksInstalled = true;

    const wrapWebRtc = () => {
        if (ui.webrtc && typeof ui.webrtc.setUserIsSpeaking === "function" && !ui.webrtc._doCamWrapped) {
            const orig = ui.webrtc.setUserIsSpeaking.bind(ui.webrtc);
            ui.webrtc.setUserIsSpeaking = function (userId, speaking) {
                const allowed = canLocalUserCommunicateWith(userId, getConfig());
                try {
                    handleSpeakingEvent(userId, allowed && Boolean(speaking));
                } catch (e) {}
                return orig(userId, allowed ? speaking : false);
            };
            ui.webrtc._doCamWrapped = true;
        }
    };

    const wrapLiveKit = (lkInstance) => {
        const lkClient = lkInstance || game.webrtc?.client?._liveKitClient;
        if (lkClient && typeof lkClient.onIsSpeakingChanged === "function" && !lkClient._doCamWrapped) {
            const origLk = lkClient.onIsSpeakingChanged.bind(lkClient);
            lkClient.onIsSpeakingChanged = function (userId, speaking) {
                const allowed = canLocalUserCommunicateWith(userId, getConfig());
                try {
                    handleSpeakingEvent(userId, allowed && Boolean(speaking));
                } catch (e) {}
                return origLk(userId, allowed ? speaking : false);
            };
            lkClient._doCamWrapped = true;
        }
    };

    wrapWebRtc();
    wrapLiveKit();
    setTimeout(wrapLiveKit, 2500);

    Hooks.on("liveKitClientAvailable", (lkClient) => {
        wrapLiveKit(lkClient);
        enforcePrivateRoomIsolation();
    });
    Hooks.on("liveKitClientInitialized", (lkClient) => {
        wrapLiveKit(lkClient);
        enforcePrivateRoomIsolation();
    });

    Hooks.on("renderCameraViews", () => {
        wrapWebRtc();
        wrapLiveKit();
        syncConversationModeState();
    });

    if (!privateIsolationInterval) {
        privateIsolationInterval = setInterval(() => {
            if (!game.ready) return;
            const c = getConfig();
            if (c.privateActive) {
                enforcePrivateRoomIsolation(c);
            }
        }, 1200);
    }
}

/* ==========================================================================
   4. BARRA SUPERIOR FLOTANTE Y BANNER DE SALA PRIVADA
   ========================================================================== */

function getPrivateParticipantNames(conf) {
    const names = [];
    for (const uid of (conf.privateUserIds || [])) {
        const u = game.users?.get(uid);
        if (u) {
            const label = u.character?.name ? `${u.name} (${u.character.name})` : u.name;
            names.push(label);
        }
    }
    return names;
}

function renderOrUpdatePrivateBanner(conf) {
    let banner = document.getElementById("do-cam-private-banner");

    if (!conf.privateActive) {
        if (banner) banner.remove();
        return;
    }

    if (!banner) {
        banner = document.createElement("div");
        banner.id = "do-cam-private-banner";
        document.body.appendChild(banner);
    }

    const isGM = Boolean(game.user?.isGM);
    const amIInPrivate = isUserInPrivateRoom(game.user?.id, conf);
    const participantNames = getPrivateParticipantNames(conf);
    const namesText = participantNames.length > 0 ? participantNames.join(", ") : "Solo Máster";

    banner.className = amIInPrivate ? "is-in-private" : "is-in-main";

    if (amIInPrivate) {
        banner.innerHTML = `
            <div class="do-cam-priv-banner-left">
                <span class="do-cam-priv-dot"></span>
                <span class="do-cam-priv-badge">
                    <i class="fa-solid fa-user-lock"></i>
                    SALA PRIVADA
                </span>
                <span class="do-cam-priv-info">
                    Máster + <strong>${namesText}</strong>
                    <small>(El resto sigue hablando en la Sala Principal)</small>
                </span>
            </div>
            ${isGM ? `
            <div class="do-cam-priv-banner-actions">
                <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-priv-edit-btn" title="Añadir o quitar jugadores de esta Sala Privada">
                    <i class="fa-solid fa-user-plus"></i>
                    <span>Jugadores</span>
                </button>
                <button type="button" class="do-cam-btn do-cam-btn-danger" id="do-cam-priv-end-btn" title="Finalizar el privado y devolver a todos a la Sala Principal">
                    <i class="fa-solid fa-unlock"></i>
                    <span>Finalizar Privado</span>
                </button>
            </div>
            ` : ""}
        `;
    } else {
        banner.innerHTML = `
            <div class="do-cam-priv-banner-left">
                <span class="do-cam-priv-badge is-main-room">
                    <i class="fa-solid fa-users"></i>
                    SALA PRINCIPAL
                </span>
                <span class="do-cam-priv-info">
                    El Máster está en privado con <strong>${namesText}</strong>.
                    <small>Podéis seguir hablando entre vosotros.</small>
                </span>
            </div>
        `;
    }

    if (isGM) {
        banner.querySelector("#do-cam-priv-edit-btn")?.addEventListener("click", () => {
            openPrivateRoomModal();
        });
        banner.querySelector("#do-cam-priv-end-btn")?.addEventListener("click", async () => {
            await endPrivateRoom();
        });
    }
}

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

    // Botones rápidos de selección de Orador para el GM cuando está en Modo Orador
    let gmSpeakerPillsHtml = "";
    if (isGM && conf.layout === "spotlight" && !effectivePeek) {
        const visibleCams = getVisibleCameraElements();
        const pinnedSet = new Set(conf.pinnedUserIds || []);
        // Si no hay ninguno fijado explícitamente y estamos en manual, marcamos el fallback (GM o primera cámara)
        if (!conf.spotlightAutoVoice && pinnedSet.size === 0 && visibleCams.length > 0) {
            const gmCam = visibleCams.find(el => game.users?.get(el.dataset.user)?.isGM);
            const fallbackId = gmCam?.dataset.user || visibleCams[0]?.dataset.user;
            if (fallbackId) pinnedSet.add(fallbackId);
        }

        const userButtons = visibleCams.map(el => {
            const uid = el.dataset.user;
            const u = game.users?.get(uid);
            if (!u) return "";
            const isSelected = !conf.spotlightAutoVoice && pinnedSet.has(uid);
            const shortName = u.character?.name || u.name;
            return `
                <button type="button" class="do-cam-btn do-cam-speaker-pill ${isSelected ? "do-cam-btn-amber is-active" : ""}" data-speaker-uid="${uid}" title="Clic: Poner a ${u.name} como Orador en grande para todos | Ctrl+Clic: Poner a 2 personas a la vez">
                    <i class="fa-solid ${u.isGM ? "fa-crown" : "fa-user"}"></i>
                    <span>${shortName}</span>
                </button>
            `;
        }).join("");

        gmSpeakerPillsHtml = `
            <span class="do-cam-sep"></span>
            <div class="do-cam-speaker-bar" title="Elige quién se ve en grande en el Modo Orador">
                <span class="do-cam-speaker-label"><i class="fa-solid fa-star"></i> En grande:</span>
                ${userButtons}
                <button type="button" class="do-cam-btn ${conf.spotlightAutoVoice ? "is-active" : ""}" id="do-cam-top-autovoice-btn" title="${conf.spotlightAutoVoice ? "Modo Voz Automático activo (con retardo). Pulsa para volver a elección manual del Máster" : "Activar cambio automático por voz (con retardo anti-saltos)"}">
                    <i class="fa-solid fa-microphone-lines"></i>
                    <span>Auto Voz</span>
                </button>
            </div>
        `;
    }

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
            <button type="button" class="do-cam-btn ${localFullscreen ? "is-active" : ""}" id="do-cam-fs-btn" title="${localFullscreen ? "Salir de Pantalla Completa y dejar espacio fijo a la barra derecha" : "Pantalla Completa (pliega la barra derecha, aunque puedes desplegarla encima)"}">
                <i class="fa-solid ${localFullscreen ? "fa-compress" : "fa-expand"}"></i>
                <span>${localFullscreen ? "Pantalla Completa" : "Con Barra Derecha"}</span>
            </button>
            ` : ""}

            ${isGM ? `
            <span class="do-cam-sep"></span>

            <button type="button" class="do-cam-btn ${conf.layout === "grid" ? "is-active" : ""}" id="do-cam-top-grid-btn" title="Modo Cuadrícula: Todas las cámaras del mismo tamaño">
                <i class="fa-solid fa-table-cells-large"></i>
                <span>Cuadrícula</span>
            </button>

            <button type="button" class="do-cam-btn ${conf.layout === "spotlight" ? "is-active" : ""}" id="do-cam-top-spot-btn" title="Modo Destacar Orador: El Máster elige quién se ve en grande arriba">
                <i class="fa-solid fa-person-rays"></i>
                <span>Orador</span>
            </button>

            ${gmSpeakerPillsHtml}

            <span class="do-cam-sep"></span>

            <button type="button" class="do-cam-btn ${conf.privateActive ? "do-cam-btn-amber is-active" : ""}" id="do-cam-top-priv-btn" title="Gestionar Sala Privada (llevar a X jugadores con el Máster)">
                <i class="fa-solid ${conf.privateActive ? "fa-user-lock" : "fa-lock"}"></i>
                <span>${conf.privateActive ? `Privado (${conf.privateUserIds.length})` : "Privado"}</span>
            </button>

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
        setSidebarCollapsed(localFullscreen);
        syncConversationModeState();
    });

    if (isGM) {
        topbar.querySelector("#do-cam-top-grid-btn")?.addEventListener("click", async () => {
            await updateConfig({ layout: "grid" });
        });

        topbar.querySelector("#do-cam-top-spot-btn")?.addEventListener("click", async () => {
            const patch = { layout: "spotlight" };
            if (!conf.pinnedUserIds || conf.pinnedUserIds.length === 0) {
                patch.pinnedUserIds = [game.user.id];
            }
            await updateConfig(patch);
        });

        topbar.querySelectorAll(".do-cam-speaker-pill").forEach(btn => {
            btn.addEventListener("click", async (ev) => {
                const uid = btn.dataset.speakerUid;
                const additive = ev.ctrlKey || ev.shiftKey || ev.metaKey;
                await selectSpotlightSpeaker(uid, additive);
            });
        });

        topbar.querySelector("#do-cam-top-autovoice-btn")?.addEventListener("click", async () => {
            const nextAuto = !conf.spotlightAutoVoice;
            await updateConfig({ spotlightAutoVoice: nextAuto });
            ui.notifications?.info(
                nextAuto
                    ? "Modo Orador: Cambio automático por voz activado (con retardo anti-saltos)."
                    : "Modo Orador: Control manual del Máster activado."
            );
        });

        topbar.querySelector("#do-cam-top-priv-btn")?.addEventListener("click", () => {
            openPrivateRoomModal();
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
   5. BARRA DEL MÁSTER FIJA ENCIMA DE LOS CONTROLES DE CÁMARA/MICRÓFONO
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

    if (userControls && bar.nextElementSibling !== userControls) {
        userControls.before(bar);
    } else if (!userControls && !bar.parentElement) {
        document.body.appendChild(bar);
    }

    setClass(bar, "is-center-active", conf.active);

    bar.innerHTML = `
        <button type="button" class="do-cam-btn do-cam-gm-bar-main ${conf.active ? "do-cam-btn-success" : ""}" id="do-cam-bar-toggle" title="${conf.active ? "Devolver cámaras a la barra normal (Alt+C)" : "Activar Modo Conversación en el centro para todos (Alt+C)"}">
            <i class="fa-solid ${conf.active ? "fa-users-viewfinder" : "fa-video"}"></i>
            <span>${conf.active ? "Centro" : "Al Centro"}</span>
        </button>
        <button type="button" class="do-cam-btn do-cam-gm-bar-priv ${conf.privateActive ? "do-cam-btn-amber is-active" : ""}" id="do-cam-bar-priv" title="${conf.privateActive ? "Sala Privada activa (clic para gestionar o finalizar)" : "Abrir Sala Privada con jugadores elegidos"}">
            <i class="fa-solid ${conf.privateActive ? "fa-user-lock" : "fa-lock"}"></i>
            <span>${conf.privateActive ? `Privado (${conf.privateUserIds.length})` : "Privado"}</span>
        </button>
        ${conf.privateActive ? `
        <button type="button" class="do-cam-btn do-cam-btn-danger do-cam-gm-bar-endpriv" id="do-cam-bar-end-priv" title="Finalizar Sala Privada y reunir a todos inmediatamente">
            <i class="fa-solid fa-unlock"></i>
        </button>
        ` : ""}
        <button type="button" class="do-cam-btn do-cam-gm-bar-cfg" id="do-cam-bar-settings" title="Configurar Modo Conversación, Orador y Tamaño de Barra">
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
                ? "Modo Conversación ACTIVADO: Cámaras en el centro (Pantalla Completa)."
                : "Modo Conversación DESACTIVADO: Cámaras en la barra normal."
        );
    });

    bar.querySelector("#do-cam-bar-priv")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openPrivateRoomModal();
    });

    bar.querySelector("#do-cam-bar-end-priv")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await endPrivateRoom();
    });

    bar.querySelector("#do-cam-bar-settings")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openGmModal();
    });
}

/* ==========================================================================
   6. MODAL DE SALA PRIVADA (SELECCIÓN DE JUGADORES PARA EL MÁSTER)
   ========================================================================== */

async function startPrivateRoom(userIds, alsoBringToCenter = false) {
    if (!game.user?.isGM) return;
    const cleanIds = Array.from(new Set((userIds || []).filter(Boolean)));
    const patch = {
        privateActive: true,
        privateUserIds: cleanIds
    };
    if (alsoBringToCenter) {
        patch.active = true;
    }
    await updateConfig(patch, alsoBringToCenter);
    const names = getPrivateParticipantNames({ privateUserIds: cleanIds });
    ui.notifications?.info(
        names.length
            ? `🔒 Sala Privada activa con: ${names.join(", ")}. El resto sigue en la Sala Principal.`
            : "🔒 Sala Privada activa (solo Máster). Los jugadores siguen en la Sala Principal."
    );
}

async function endPrivateRoom() {
    if (!game.user?.isGM) return;
    await updateConfig({
        privateActive: false,
        privateUserIds: []
    });
    ui.notifications?.info("🔓 Sala Privada finalizada: Todos los jugadores han vuelto a la Sala Principal.");
}

function openPrivateRoomModal() {
    if (!game.user?.isGM) return;

    let backdrop = document.getElementById("do-cam-priv-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "do-cam-priv-backdrop";
        backdrop.className = "do-cam-gm-backdrop";
        backdrop.addEventListener("click", (ev) => {
            if (ev.target === backdrop) backdrop.remove();
        });
        document.body.appendChild(backdrop);
    }

    renderPrivateModalContent(backdrop, getConfig());
}

function refreshPrivateModalIfOpen(conf) {
    const backdrop = document.getElementById("do-cam-priv-backdrop");
    if (backdrop) {
        renderPrivateModalContent(backdrop, conf || getConfig());
    }
}

function renderPrivateModalContent(backdrop, conf) {
    const players = Array.from(game.users || [])
        .filter(u => !u.isGM)
        .sort((a, b) => (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name));

    const selectedSet = new Set(conf.privateUserIds || []);

    const playersHtml = players.length === 0
        ? `<div class="do-cam-empty-msg">No hay jugadores creados en el mundo.</div>`
        : players.map(u => {
            const isSelected = selectedSet.has(u.id);
            const charName = u.character?.name || "";
            const avatarSrc = u.character?.img || u.avatar || "icons/svg/mystery-man.svg";
            return `
                <label class="do-cam-priv-user-card ${isSelected ? "is-selected" : ""} ${u.active ? "is-online" : "is-offline"}" data-user-id="${u.id}">
                    <input type="checkbox" class="do-cam-priv-user-cb" value="${u.id}" ${isSelected ? "checked" : ""} />
                    <img src="${avatarSrc}" alt="${u.name}" class="do-cam-priv-avatar" />
                    <div class="do-cam-priv-user-meta">
                        <div class="do-cam-priv-user-name">
                            <span class="do-cam-status-dot ${u.active ? "online" : "offline"}"></span>
                            <strong>${u.name}</strong>
                        </div>
                        <div class="do-cam-priv-user-sub">
                            ${charName ? `PJ: ${charName}` : (u.active ? "Conectado" : "Desconectado")}
                        </div>
                    </div>
                    <div class="do-cam-priv-check-icon">
                        <i class="fa-solid ${isSelected ? "fa-circle-check" : "fa-circle"}</i>
                    </div>
                </label>
            `;
        }).join("");

    backdrop.innerHTML = `
        <div class="do-cam-gm-modal">
            <div class="do-cam-gm-header">
                <div class="do-cam-gm-title">
                    <i class="fa-solid fa-user-lock"></i>
                    <span>SALA PRIVADA DE LIVEKIT / CÁMARAS</span>
                </div>
                <button type="button" class="do-cam-btn" id="do-cam-priv-modal-close">
                    <i class="fa-solid fa-xmark"></i>
                    <span>Cerrar</span>
                </button>
            </div>

            <div class="do-cam-gm-body">
                <div class="do-cam-gm-card" style="border-color: ${conf.privateActive ? "#f59e0b" : "#334155"};">
                    <div class="do-cam-gm-row">
                        <div class="do-cam-gm-row-text">
                            <strong>${conf.privateActive ? "🔒 Sala Privada EN CURSO" : "🔓 Todos en la Sala Principal"}</strong>
                            <span>Los jugadores seleccionados hablarán y se verán solo contigo. Los que queden fuera seguirán viéndose y hablando entre ellos sin oír el privado.</span>
                        </div>
                    </div>
                </div>

                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-users"></i> ELIGE QUÉ JUGADORES VIENEN CONTIGO AL PRIVADO</span>
                        <div style="display:flex; gap:6px;">
                            <button type="button" class="do-cam-btn" id="do-cam-priv-sel-online" title="Seleccionar todos los conectados">Conectados</button>
                            <button type="button" class="do-cam-btn" id="do-cam-priv-sel-none" title="Desmarcar todos">Ninguno</button>
                        </div>
                    </div>

                    <div class="do-cam-priv-user-grid">
                        ${playersHtml}
                    </div>
                </div>

                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-row">
                        <label for="do-cam-priv-center-cb" style="cursor:pointer;">
                            Activar también <strong>Cámaras en el Centro</strong> al entrar al privado
                        </label>
                        <input type="checkbox" id="do-cam-priv-center-cb" ${conf.active ? "checked" : ""} />
                    </div>
                </div>

                <div class="do-cam-gm-row" style="justify-content: flex-end; gap: 8px; margin-top: 2px;">
                    ${conf.privateActive ? `
                    <button type="button" class="do-cam-btn do-cam-btn-danger" id="do-cam-priv-modal-end" style="padding: 7px 12px; font-size: 12px;">
                        <i class="fa-solid fa-unlock"></i>
                        <span>Finalizar Privado y reunir a todos</span>
                    </button>
                    ` : ""}
                    <button type="button" class="do-cam-btn do-cam-btn-success" id="do-cam-priv-modal-apply" style="padding: 7px 14px; font-size: 12px;">
                        <i class="fa-solid fa-user-lock"></i>
                        <span>${conf.privateActive ? "Actualizar Sala Privada" : "Iniciar Sala Privada"}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    backdrop.querySelector("#do-cam-priv-modal-close")?.addEventListener("click", () => backdrop.remove());

    const syncCardUI = () => {
        backdrop.querySelectorAll(".do-cam-priv-user-card").forEach(card => {
            const cb = card.querySelector(".do-cam-priv-user-cb");
            const icon = card.querySelector(".do-cam-priv-check-icon i");
            const checked = Boolean(cb?.checked);
            setClass(card, "is-selected", checked);
            if (icon) {
                icon.className = `fa-solid ${checked ? "fa-circle-check" : "fa-circle"}`;
            }
        });
    };

    backdrop.querySelectorAll(".do-cam-priv-user-cb").forEach(cb => {
        cb.addEventListener("change", syncCardUI);
    });

    backdrop.querySelector("#do-cam-priv-sel-online")?.addEventListener("click", () => {
        backdrop.querySelectorAll(".do-cam-priv-user-card").forEach(card => {
            const cb = card.querySelector(".do-cam-priv-user-cb");
            if (cb) cb.checked = card.classList.contains("is-online");
        });
        syncCardUI();
    });

    backdrop.querySelector("#do-cam-priv-sel-none")?.addEventListener("click", () => {
        backdrop.querySelectorAll(".do-cam-priv-user-card").forEach(card => {
            const cb = card.querySelector(".do-cam-priv-user-cb");
            if (cb) cb.checked = false;
        });
        syncCardUI();
    });

    backdrop.querySelector("#do-cam-priv-modal-apply")?.addEventListener("click", async () => {
        const chosenIds = Array.from(backdrop.querySelectorAll(".do-cam-priv-user-cb:checked")).map(cb => cb.value);
        const bringToCenter = Boolean(backdrop.querySelector("#do-cam-priv-center-cb")?.checked);
        await startPrivateRoom(chosenIds, bringToCenter);
        backdrop.remove();
    });

    backdrop.querySelector("#do-cam-priv-modal-end")?.addEventListener("click", async () => {
        await endPrivateRoom();
        backdrop.remove();
    });
}

/* ==========================================================================
   7. MODAL DE CONFIGURACIÓN GENERAL DEL MÁSTER
   ========================================================================== */

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
    const users = Array.from(game.users || []).sort((a, b) => (Number(b.isGM) - Number(a.isGM)) || (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name));
    const pinnedSet = new Set(conf.pinnedUserIds || []);

    const speakerCardsHtml = users.map(u => {
        const isSelected = !conf.spotlightAutoVoice && pinnedSet.has(u.id);
        const charLabel = u.character?.name ? u.character.name : (u.isGM ? "Máster" : "");
        return `
            <button type="button" class="do-cam-btn ${isSelected ? "do-cam-btn-amber is-active" : ""}" data-modal-speaker="${u.id}" title="Clic: Destacar a ${u.name} | Ctrl+Clic: Destacar hasta 2 personas a la vez">
                <i class="fa-solid ${u.isGM ? "fa-crown" : "fa-user"}"></i>
                <span>${u.name}${charLabel ? ` (${charLabel})` : ""}</span>
            </button>
        `;
    }).join("");

    const currentNormalWidth = getNormalSidebarWidth();
    const privNames = getPrivateParticipantNames(conf);

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
                            <span>${conf.active ? "En el CENTRO (Pantalla Completa por defecto)" : "En la BARRA NORMAL de Foundry"}</span>
                        </div>
                        <div class="do-cam-gm-row-actions">
                            ${conf.active ? `
                            <button type="button" class="do-cam-btn" id="do-cam-force-sync-btn" title="Si algún jugador pulsó 'Ver Escena', vuelve a ponerle las cámaras en el centro a pantalla completa">
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

                <!-- 2. Sala Privada -->
                <div class="do-cam-gm-card" style="border-color: ${conf.privateActive ? "#f59e0b" : "#1e293b"};">
                    <div class="do-cam-gm-row">
                        <div class="do-cam-gm-row-text">
                            <strong>${conf.privateActive ? `🔒 Sala Privada Activa (${privNames.join(", ") || "Solo Máster"})` : "🔒 Sala Privada (Máster + Jugadores)"}</strong>
                            <span>Lleva a jugadores elegidos a una sala aparte contigo; el resto sigue hablando en la Sala Principal.</span>
                        </div>
                        <div class="do-cam-gm-row-actions">
                            ${conf.privateActive ? `
                            <button type="button" class="do-cam-btn do-cam-btn-danger" id="do-cam-modal-end-priv">
                                <i class="fa-solid fa-unlock"></i>
                                <span>Finalizar</span>
                            </button>
                            ` : ""}
                            <button type="button" class="do-cam-btn do-cam-btn-amber" id="do-cam-modal-open-priv">
                                <i class="fa-solid fa-user-lock"></i>
                                <span>${conf.privateActive ? "Editar Privado" : "Configurar Privado"}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 3. Elección de Diseño en el Centro: Cuadrícula vs Destacar Orador -->
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
                                Todas las cámaras iguales y autoajustadas al espacio.
                            </div>
                        </div>
                        <div class="do-cam-mode-option ${conf.layout === "spotlight" ? "is-selected" : ""}" data-layout="spotlight" role="button" tabindex="0">
                            <div class="do-cam-mode-title">
                                <i class="fa-solid fa-person-rays"></i>
                                <span>Destacar Orador</span>
                            </div>
                            <div class="do-cam-mode-desc">
                                El Máster elige a quién poner en grande para todos (1 o 2 personas).
                            </div>
                        </div>
                    </div>

                    ${conf.layout === "spotlight" ? `
                    <div style="margin-top: 4px; padding-top: 8px; border-top: 1px solid #1e293b; display:flex; flex-direction:column; gap:8px;">
                        <div class="do-cam-gm-row">
                            <span style="font-size:12px; color:#cbd5e1;"><strong>¿Quién se ve en grande arriba?</strong> <small style="color:#94a3b8;">(Ctrl+Clic para elegir 2)</small></span>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px;">
                            ${speakerCardsHtml}
                        </div>

                        <div class="do-cam-gm-row" style="margin-top: 4px; padding-top: 6px; border-top: 1px dashed #1e293b;">
                            <label for="do-cam-autovoice-cb" style="cursor:pointer;">
                                Cambio automático por voz <small style="color:#94a3b8;">(desactivado = solo cambia cuando el Máster lo indique)</small>
                            </label>
                            <input type="checkbox" id="do-cam-autovoice-cb" ${conf.spotlightAutoVoice ? "checked" : ""} />
                        </div>

                        ${conf.spotlightAutoVoice ? `
                        <div class="do-cam-gm-row">
                            <label title="Tiempo hablando seguido antes de poner a alguien en grande">Retardo al empezar a hablar: <strong id="do-cam-act-val" style="color:#38bdf8;">${conf.voiceActivateDelayMs}ms</strong></label>
                            <input type="range" id="do-cam-act-slider" min="300" max="3000" step="100" value="${conf.voiceActivateDelayMs}" style="width:150px;" />
                        </div>
                        <div class="do-cam-gm-row">
                            <label title="Tiempo tras callar antes de quitar a alguien">Retardo al callar: <strong id="do-cam-hold-val" style="color:#38bdf8;">${conf.holdDelayMs}ms</strong></label>
                            <input type="range" id="do-cam-hold-slider" min="500" max="4000" step="100" value="${conf.holdDelayMs}" style="width:150px;" />
                        </div>
                        ` : ""}
                    </div>
                    ` : ""}
                </div>

                <!-- 4. Tamaño de la Barra Izquierda en Modo Normal y Opciones Visuales -->
                <div class="do-cam-gm-card">
                    <div class="do-cam-gm-card-title">
                        <span><i class="fa-solid fa-sliders"></i> BARRA NORMAL Y OPCIONES VISUALES</span>
                    </div>

                    <div class="do-cam-gm-row">
                        <label title="También puedes arrastrar directamente el borde derecho de la columna de cámaras en Modo Normal">
                            Ancho de barra izquierda (Modo Normal): <strong id="do-cam-normw-val" style="color:#38bdf8;">${currentNormalWidth}px</strong>
                        </label>
                        <input type="range" id="do-cam-normw-slider" min="160" max="560" step="10" value="${currentNormalWidth}" style="width:160px;" />
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
        ui.notifications?.info("Todos los jugadores han vuelto a la vista central de cámaras (Pantalla Completa).");
    });

    backdrop.querySelector("#do-cam-modal-open-priv")?.addEventListener("click", () => {
        backdrop.remove();
        openPrivateRoomModal();
    });

    backdrop.querySelector("#do-cam-modal-end-priv")?.addEventListener("click", async () => {
        await endPrivateRoom();
    });

    backdrop.querySelectorAll(".do-cam-mode-option").forEach(card => {
        card.addEventListener("click", async () => {
            const chosenLayout = card.dataset.layout;
            const patch = { layout: chosenLayout };
            if (chosenLayout === "spotlight" && (!conf.pinnedUserIds || conf.pinnedUserIds.length === 0)) {
                patch.pinnedUserIds = [game.user.id];
            }
            await updateConfig(patch);
        });
    });

    backdrop.querySelectorAll("[data-modal-speaker]").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            const uid = btn.dataset.modalSpeaker;
            const additive = ev.ctrlKey || ev.shiftKey || ev.metaKey;
            await selectSpotlightSpeaker(uid, additive);
        });
    });

    backdrop.querySelector("#do-cam-autovoice-cb")?.addEventListener("change", async (ev) => {
        await updateConfig({ spotlightAutoVoice: ev.target.checked });
    });

    const actSlider = backdrop.querySelector("#do-cam-act-slider");
    const actVal = backdrop.querySelector("#do-cam-act-val");
    actSlider?.addEventListener("input", (ev) => {
        if (actVal) actVal.textContent = `${ev.target.value}ms`;
    });
    actSlider?.addEventListener("change", async (ev) => {
        await updateConfig({ voiceActivateDelayMs: Number(ev.target.value) });
    });

    const holdSlider = backdrop.querySelector("#do-cam-hold-slider");
    const holdVal = backdrop.querySelector("#do-cam-hold-val");
    holdSlider?.addEventListener("input", (ev) => {
        if (holdVal) holdVal.textContent = `${ev.target.value}ms`;
    });
    holdSlider?.addEventListener("change", async (ev) => {
        await updateConfig({ holdDelayMs: Number(ev.target.value) });
    });

    const normwSlider = backdrop.querySelector("#do-cam-normw-slider");
    const normwVal = backdrop.querySelector("#do-cam-normw-val");
    normwSlider?.addEventListener("input", (ev) => {
        const val = applyNormalSidebarWidth(ev.target.value, false);
        if (normwVal) normwVal.textContent = `${val}px`;
    });
    normwSlider?.addEventListener("change", (ev) => {
        const val = applyNormalSidebarWidth(ev.target.value, true);
        if (normwVal) normwVal.textContent = `${val}px`;
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
   8. HOOKS DE FOUNDRY VTT (INIT, READY, CONTROLES DE ESCENA, ATAJOS, API)
   ========================================================================== */

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Inicializando Modo Conversación de Cámaras y Salas Privadas...`);

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

    game.settings.register(MODULE_ID, "normalSidebarWidth", {
        name: "Ancho de la barra lateral de cámaras (Modo Normal)",
        hint: "Ancho en píxeles de la columna izquierda de cámaras cuando están en la barra normal (también puedes arrastrar su borde derecho).",
        scope: "client",
        config: true,
        type: Number,
        range: {
            min: 160,
            max: 560,
            step: 10
        },
        default: 250,
        onChange: (val) => {
            applyNormalSidebarWidth(val, false);
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
        openPrivateModal: () => openPrivateRoomModal(),
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
        pinSpeaker: (userId = "", additive = false) => selectSpotlightSpeaker(userId, additive),
        startPrivate: (userIds = [], bringToCenter = false) => startPrivateRoom(userIds, bringToCenter),
        endPrivate: () => endPrivateRoom()
    };
});

Hooks.on("getSceneControlButtons", (controls) => {
    const toolData = {
        name: "dorso-camaras-conversacion",
        title: "Modo Conversación de Cámaras y Sala Privada",
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
    applyNormalSidebarWidth(getNormalSidebarWidth(), false);
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

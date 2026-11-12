# Dorso Oscuro - Modo Conversación de Cámaras (`dorso-oscuro-camaras`)

Módulo para **Foundry VTT (v12 / v13 / v14)** que permite al Máster alternar en tiempo real las cámaras de vídeo y avatares (`#camera-views`) entre su **barra normal** y el **centro de la pantalla (Modo Conversación)**, crear **Salas Privadas instantáneas** con jugadores elegidos y redimensionar libremente la columna izquierda de cámaras.

Totalmente compatible con **LiveKit (`avclient-livekit`)**, WebRTC nativo de Foundry y módulos de retratos/avatares.

## Características principales

1. **Alternancia instantánea (Barra Normal ↔ Centro con Pantalla Completa por defecto):**
   - El Máster puede enviar las cámaras de todos los jugadores al centro o devolverlas a su barra normal desde el botón flotante inferior, la barra de herramientas de escena, la barra superior o el atajo `Alt + C`.
   - Al activarse, entra por defecto en **Pantalla Completa** plegando automáticamente el panel lateral derecho de Foundry (como si el usuario hubiera pulsado el botón de plegar), pero permitiendo desplegarlo encima en cualquier momento o cambiar al modo con hueco lateral fijo.
2. **Escalado exacto sin recortes (Container Queries) y Scroll de seguridad:**
   - Tanto en **Modo Cuadrícula** como en **Modo Destacar Orador (Spotlight)**, las cámaras calculan su tamaño real sobre el contenedor disponible (`cqw`/`cqh`) teniendo en cuenta la proporción (`4:3` o `16:9`) y si la barra derecha está abierta o cerrada, evitando que ninguna cámara quede cortada. Incluye además scroll vertical de respaldo.
3. **Sistema de Salas Privadas instantáneas (Máster + X jugadores):**
   - El Máster puede elegir a uno o varios jugadores y llevarlos a una **Sala Privada** con un clic (y finalizarla en cualquier momento para reunir a todos).
   - **Sin cortes ni reconexiones de LiveKit:** El grupo del Privado (Máster + elegidos) solo se ve y escucha entre sí, mientras que los jugadores que quedan fuera permanecen en la **Sala Principal** pudiendo seguir viéndose y hablando entre ellos sin escuchar nada del privado.
4. **Barra izquierda redimensionable en Modo Normal:**
   - En el modo normal de Foundry, incluye un tirador lateral de arrastre en el borde derecho de las cámaras (y un control deslizante en ajustes) para ampliar o reducir libremente el tamaño de la columna de cámaras (`160px` a `580px`) con scroll vertical.

## Instalación en Foundry VTT

URL del Manifiesto:
```text
https://raw.githubusercontent.com/meix13/dorso-oscuro-camaras/main/module.json
```

# Dorso Oscuro - Modo Conversación de Cámaras (`dorso-oscuro-camaras`)

Módulo para **Foundry VTT (v12 / v13 / v14)** que permite al Máster alternar en tiempo real las cámaras de vídeo y avatares (`#camera-views`) entre su **barra normal** y el **centro de la pantalla (Modo Conversación)**, tapando la escena actual pero manteniendo **fichas de personaje, diarios y chat siempre accesibles por encima**.

Totalmente compatible con **LiveKit (`avclient-livekit`)**, WebRTC nativo de Foundry y módulos de retratos/avatares.

## Características principales

1. **Alternancia instantánea (Barra Normal ↔ Centro):**
   - El Máster puede enviar las cámaras de todos los jugadores al centro o devolverlas a su barra normal en cualquier momento desde el botón flotante inferior, la barra de herramientas de escena, la barra superior o el atajo `Alt + C`.
2. **Dos modos de visualización en el Centro:**
   - **Modo Cuadrícula (Normal):** Todas las cámaras se muestran en grande con el mismo tamaño, adaptándose automáticamente al número de participantes conectados (`1` a `8+`) y resaltando con un borde luminoso a quien habla.
   - **Modo Destacar Orador (Escenario / Spotlight):** Quien habla por voz se sitúa en grande en la fila principal superior (soportando hasta 2 personas simultáneas en diálogos cruzados) y el resto de cámaras se alinean debajo.
     - **Sin saltos ni parpadeos:** Incluye retardo configurable al callar (`1400ms` por defecto) y **retención del último orador**, de modo que la cámara principal nunca da tirones durante las pausas al hablar.
     - **Fijar Orador (Pin 📌):** El Máster puede fijar manualmente a cualquier jugador o a sí mismo pasando el ratón sobre su cámara y pulsando el icono 📌 (o desde el selector del panel).
3. **Botón "Ver Escena" para los jugadores:**
   - Mientras el Modo Conversación está activo, los jugadores disponen de un botón superior **Ver Escena / Volver a Cámaras** para devolver temporalmente las cámaras a su barra normal en su propia pantalla si necesitan consultar el mapa, sin afectar al resto de la mesa.
   - El Máster cuenta además con el botón **Traer todos al centro** para resincronizar a todos cuando quiera.

## Instalación en Foundry VTT

URL del Manifiesto:
```text
https://raw.githubusercontent.com/meix13/dorso-oscuro-camaras/main/module.json
```

# Capturas de Zer0Code

Capturadas el **30 de octubre de 2026** desde las interfaces reales de **Zer0Code 1.6.1**, usando el servidor del paquete oficial con un directorio de datos y un usuario de demostración independientes.

- `app-desktop-dark.png` y `app-desktop-light.png`: nuevo hilo en ambos temas, con la cabecera propia, el botón Crear hilo compacto y la versión encima del perfil.
- `app-orchestrator.png`: ajustes reales del orquestador. Los modelos visibles dependen de las herramientas y cuentas disponibles en el entorno de captura.
- `app-execution-modes.png`: selector de autonomía del agente.
- `app-mobile-sidebar.png` y `app-mobile-settings.png`: barra lateral oscura y ajustes de app y notificaciones.
- `app-mobile.png`: composición de las dos vistas móviles.
- `app-overview.png`: composición del escritorio oscuro y la barra lateral móvil.
- `app-themes.png`: comparación de los temas de escritorio.

Las capturas individuales se exportan desde el DOM a PNG a escala 2×: escritorio de 1440 × 900 a **2880 × 1800** y móvil de 390 × 844 a **780 × 1688**. Se conservan los estilos e iconos de la aplicación. Las composiciones añaden márgenes y, en la comparación de temas, reducen las imágenes; no amplían capturas pequeñas ni usan fotogramas comprimidos del vídeo de la vista previa.

La versión mostrada en el escritorio procede de los metadatos del paquete oficial, suministrados al estado de la vista web porque esta captura no corre dentro de Electron. Los títulos de los hilos y el borrador sin enviar son ejemplos. No se ejecutaron agentes ni se simularon respuestas, revisiones o resultados. El diálogo móvil refleja los permisos del navegador de captura; su estado puede variar en otro dispositivo. El icono del banner usa los mismos trazos que `public/icon.svg`.

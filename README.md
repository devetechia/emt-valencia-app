# 🚌 EMT Valencia - Mapa Interactivo

Aplicación web PWA para estudiar el callejero de EMT Valencia mediante test interactivos.

## Modos disponibles:

### 1. Mapa
Ver el callejero vectorial de Valencia con todas las líneas de EMT (50 líneas, 1153 paradas). Selecciona una línea para ver su trazado superpuesto y listado de paradas. Toca una parada para ver sus datos.

### 2. Conducción (simulador)
Conduce un autobús con teclado (flechas/WASD) o ratón. La app valida que sigas el trazado correcto de la línea, que pares en cada parada en orden y cuenta los desvíos. HUD con velocidad, parada siguiente y desvíos.

### 3. Test
Preguntas generadas automáticamente a partir de los datos reales (líneas, cabeceras, destinos y paradas) con respuestas de opción múltiple.

## Funcionalidades:

- **PWA Installable**: "Añadir a pantalla de inicio" en móvil
- **Modo Offline**: Service Worker cachea archivos esenciales
- **Mapa interactivo**: pan/zoom/pinch, etiquetas con halo, hit-testing de paradas
- **Diseño adaptativo**: móvil y desktop

## Datos fuente:

- Plano vectorial: `PLANO CALLEJERO.pdf` (georeferenciado, residuo mediano 5.9 px)
- Red y horarios: GTFS oficial de EMT Valencia (feed 14-11-2026, vigente 2026-11-07 a 2026-12-09)
- Fuente: https://opendata.vlci.valencia.es/dataset/google-transit-lines-stops-bus-schedules

## Perfil usuario:

- Conductor bus desde sept 2026 en Mundobus ~5h/día
- Técnico Superior Prótesis Dentales
- Estudia para el examen CAP / operaciones conductor-perceptor de EMT Valencia

## Estado:

- App publicada en GitHub Pages: https://serpion7.github.io/emt-valencia-app/
- Mapa 2023 como referencia visual (las líneas pueden haber cambiado)
- Conceptos: líneas, cabeceras, paradas, distritos
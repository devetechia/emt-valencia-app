# 🚌 EMT València · Callejero y simulador

PWA para estudiar el callejero y las rutas de EMT València: mapa de líneas, simulador de conducción, dibujo de trazados y test.
Es una web estática (sin servidor ni build): `index.html` + `js/` + `css/` + `data/`.

## Modos

- **Mapa:** plano limpio; eliges una línea y solo ves su recorrido (con flechas de sentido), sus paradas y las calles de alrededor.
  Atajos en PC: `/` buscar, `+`/`-` zoom, `F` encuadrar, flechas mover, `Esc` volver.
- **Conducción:** conduces el autobús con el teclado (↑/W, ↓/S, ←→/AD). El ratón solo mueve el mapa. La app valida el trazado,
  el orden de las paradas y cuenta los desvíos. **🤖 Recorrido automático:** el bus hace el viaje solo (pausa `P`, velocidad ×1/×2/×4).
- **Trazar:** dibujas el recorrido de una línea haciendo clic sobre las calles y la app lo compara con el real (verde = acertaste,
  rojo = te faltó) y te dice qué paradas no cubriste.
- **Test:** preguntas generadas con los datos reales (líneas, cabeceras, destinos, paradas).

## Datos

- **Líneas, paradas y recorridos:** GTFS oficial de EMT València ([datos abiertos del Ayuntamiento](https://opendata.vlci.valencia.es/dataset/google-transit-lines-stops-bus-schedules)).
  La versión y su vigencia salen en el panel de la app (`data/meta.json`). Verificado contra el feed del 15-11-2026: 44 líneas (50 rutas), 1153 paradas.
- **Plano base:** `data/map.json`, vectorial de 2023, solo orientativo. Fuera de la página impresa se usa OpenStreetMap de fondo (necesita conexión).
- **Actualizar los datos** (el feed caduca y EMT publica cambios; p. ej. el rediseño de las líneas 8, 10 y 11, que pasan a 58, 50 y 51):

  ```bash
  python scripts/actualizar_datos.py --check   # compara sin escribir
  python scripts/actualizar_datos.py           # descarga el GTFS más reciente y regenera data/lines.json, stops.json y meta.json
  ```

  Después sube `VERSION` en `sw.js` para que los móviles refresquen la caché.

## Probar en local

```bash
python -m http.server 8765    # y abrir http://localhost:8765
```

## Publicación

GitHub Pages desde `main`: https://devetechia.github.io/emt-valencia-app/

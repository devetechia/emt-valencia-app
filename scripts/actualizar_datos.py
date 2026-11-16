#!/usr/bin/env python3
"""Regenera data/lines.json, data/stops.json y data/meta.json desde el GTFS oficial de EMT València.

Uso (desde la raíz del repo):
    python scripts/actualizar_datos.py                 # descarga el GTFS más reciente del portal de datos abiertos
    python scripts/actualizar_datos.py --zip fichero.zip   # usa un zip ya descargado
    python scripts/actualizar_datos.py --check         # no escribe nada: compara con lo que hay en data/

Fuente: https://opendata.vlci.valencia.es/dataset/google-transit-lines-stops-bus-schedules
Solo usa la biblioteca estándar de Python 3.9+. El plano base (data/map.json, 2023) no se toca.
"""
import argparse
import collections
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from datetime import date

PAGE = 'https://opendata.vlci.valencia.es/dataset/google-transit-lines-stops-bus-schedules'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')

# lon/lat -> coordenadas del plano (ajuste por mínimos cuadrados sobre las 1153 paradas; residuo mediano 0,04 u).
# Es la transformación con la que se generaron las coordenadas guardadas en data/*.json.
CX = (17324.839509939953, 79.08522013721928, 4184.4188125013425)
CY = (167.65328534851386, -21854.18438350673, 863405.1433757686)


def to_world(lon, lat):
    return round(CX[0] * lon + CX[1] * lat + CX[2], 1), round(CY[0] * lon + CY[1] * lat + CY[2], 1)


def find_zip_url():
    with urllib.request.urlopen(PAGE, timeout=60) as r:
        html = r.read().decode('utf-8', 'replace')
    links = re.findall(r'https://opendata\.vlci\.valencia\.es/[^"\']+/download/google_transit[0-9-]*\.zip', html)
    if not links:
        sys.exit('No encuentro el enlace al GTFS en ' + PAGE)
    return sorted(set(links))[-1]   # el nombre lleva la fecha: el último es el más reciente


def read_csv(z, name):
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline='')))


def build(z, old_lines):
    routes = read_csv(z, 'routes.txt')
    trips = read_csv(z, 'trips.txt')
    stops = {s['stop_id']: s for s in read_csv(z, 'stops.txt')}
    feed = read_csv(z, 'feed_info.txt')[0]

    # secuencias de paradas por viaje
    seqs = collections.defaultdict(list)
    with z.open('stop_times.txt') as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline='')):
            seqs[row['trip_id']].append((int(row['stop_sequence']), row['stop_id']))

    # patrones (secuencia de paradas) por ruta: nº de viajes, dirección y forma
    pats = collections.defaultdict(dict)
    for t in trips:
        lst = seqs.get(t['trip_id'])
        if not lst:
            continue
        key = tuple(s for _, s in sorted(lst))
        p = pats[t['route_id']].setdefault(key, {'n': 0, 'dir': t.get('direction_id', ''), 'shape': t['shape_id']})
        p['n'] += 1

    shapes = collections.defaultdict(list)
    for r in read_csv(z, 'shapes.txt'):
        shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))

    def sname(s):
        return stops[s]['stop_name'].strip()

    # colores: se conservan los que ya tenía cada línea; las nuevas reciben un tono libre
    old_color = {l['n']: l['color'] for l in old_lines}
    used = set(old_color.values())
    palette = iter(['#%02x%02x%02x' % rgb for rgb in (
        (0x23, 0xb9, 0xea), (0xea, 0x6d, 0x23), (0x8a, 0x23, 0xea), (0x23, 0xea, 0x6d), (0xea, 0xd2, 0x23),
        (0xea, 0x23, 0x6d), (0x23, 0x6d, 0xea), (0x6d, 0xea, 0x23), (0xb9, 0x23, 0xea), (0x23, 0xea, 0xd2))])

    def color_for(n):
        if n in old_color:
            return old_color[n]
        for c in palette:
            if c not in used:
                used.add(c)
                old_color[n] = c
                return c
        return '#9aa7b8'

    lines, used_stops = [], set()
    for r in routes:
        if r['route_id'] not in pats:
            continue   # ruta sin viajes en este feed (p. ej. un duplicado de C2)
        variants = []
        # orden estable: el que ya tenían los sentidos en la app; los nuevos, por dirección y nº de viajes
        prev = {v['shape']: i for i, v in enumerate(next((l['variants'] for l in old_lines if l['id'] == r['route_id']), []))}
        ordered = sorted(pats[r['route_id']].items(), key=lambda kv: (prev.get(kv[1]['shape'], 99), kv[1]['dir'], -kv[1]['n']))
        for seq, p in ordered:
            pts = [list(to_world(lo, la)) for _, la, lo in sorted(shapes[p['shape']])]
            variants.append({
                'shape': p['shape'],
                'pts': pts,
                'stops': [{'id': s, 'name': sname(s).split(' - ')[0].strip(), 'x': to_world(float(stops[s]['stop_lon']), float(stops[s]['stop_lat']))[0],
                           'y': to_world(float(stops[s]['stop_lon']), float(stops[s]['stop_lat']))[1]} for s in seq],
            })
            used_stops.update(seq)
        lines.append({'id': r['route_id'], 'n': r['route_short_name'], 'name': r['route_long_name'].strip(),
                      'color': color_for(r['route_short_name']), 'variants': variants})

    out_stops = []
    for sid, s in stops.items():
        lon, lat = float(s['stop_lon']), float(s['stop_lat'])
        x, y = to_world(lon, lat)
        full = s['stop_name'].strip()
        out_stops.append({'id': sid, 'name': full.split(' - ')[0].strip(), 'full': full, 'x': x, 'y': y, 'lon': lon, 'lat': lat})

    meta = {'feed_version': feed.get('feed_version'), 'start': feed.get('feed_start_date'), 'end': feed.get('feed_end_date'),
            'lines': len({l['n'] for l in lines}), 'stops': len(out_stops), 'generated': date.today().isoformat(),
            'source': PAGE}
    return lines, out_stops, meta


def load(name):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return []
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def canon(lines):
    """forma comparable: por ruta, conjunto de (secuencia de paradas, forma, nº de puntos)"""
    return {l['id']: {(tuple(s['id'] for s in v['stops']), v['shape'], len(v['pts'])) for v in l['variants']} for l in lines}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--zip', help='GTFS ya descargado (si no, se descarga el más reciente)')
    ap.add_argument('--check', action='store_true', help='solo comparar, sin escribir')
    a = ap.parse_args()

    if a.zip:
        data = open(a.zip, 'rb').read()
    else:
        url = find_zip_url()
        print('Descargando', url)
        with urllib.request.urlopen(url, timeout=300) as r:
            data = r.read()
    z = zipfile.ZipFile(io.BytesIO(data))

    old = load('lines.json')
    lines, stops, meta = build(z, old)
    print('GTFS versión %s (vigente %s a %s): %d líneas, %d rutas, %d paradas'
          % (meta['feed_version'], meta['start'], meta['end'], meta['lines'], len(lines), len(stops)))

    new_c, old_c = canon(lines), canon(old)
    added, removed = sorted(set(new_c) - set(old_c)), sorted(set(old_c) - set(new_c))
    changed = sorted(i for i in set(new_c) & set(old_c) if new_c[i] != old_c[i])
    print('Rutas nuevas:', added or '—', '| desaparecidas:', removed or '—', '| con recorrido distinto:', changed or '—')
    old_stops = {s['id'] for s in load('stops.json')}
    new_stops = {s['id'] for s in stops}
    print('Paradas nuevas:', len(new_stops - old_stops), '| desaparecidas:', len(old_stops - new_stops))

    if a.check:
        print('Modo --check: no se escribe nada.')
        return
    os.makedirs(DATA, exist_ok=True)
    for name, obj in (('lines.json', lines), ('stops.json', stops), ('meta.json', meta)):
        with open(os.path.join(DATA, name), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print('Escrito data/lines.json, data/stops.json y data/meta.json. Sube la versión de VERSION en sw.js para que los móviles se actualicen.')


if __name__ == '__main__':
    main()

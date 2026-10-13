"""Prepare supplied geographic road centre lines using GEOS noding.

Requires shapely==2.2.0. Original input is read only; outputs are atomically
replaced after the complete geometry and manifest have been prepared.
"""
import argparse
import hashlib
import heapq
import json
import math
import struct
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from shapely import constrained_delaunay_triangles, line_merge, set_precision, unary_union
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring

ROAD_WIDTH = 6.0  # User requested two lanes everywhere, independent of source WIDTH.


def write_glb(positions, normals, indices, materials, destination):
    binary = bytearray()
    views, accessors, primitives = [], [], []
    for vertices, directions, triangles, material in zip(positions, normals, indices, range(len(materials))):
        attributes = {}
        for name, values, kind, component, target in [
            ('POSITION', vertices, 'VEC3', 5126, 34962),
            ('NORMAL', directions, 'VEC3', 5126, 34962),
            ('indices', triangles, 'SCALAR', 5125, 34963),
        ]:
            packed = struct.pack('<' + ('f' if component == 5126 else 'I') * len(values), *values)
            views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(packed), 'target': target})
            binary.extend(packed)
            binary.extend(bytes((-len(binary)) % 4))
            accessor = {'bufferView': len(views) - 1, 'componentType': component, 'type': kind,
                        'count': len(values) // (3 if kind == 'VEC3' else 1)}
            if kind == 'VEC3':
                accessor['min'] = [min(values[axis::3]) for axis in range(3)]
                accessor['max'] = [max(values[axis::3]) for axis in range(3)]
            accessors.append(accessor)
            if name == 'indices':
                primitive = {'attributes': attributes, 'indices': len(accessors) - 1, 'material': material}
                primitives.append(primitive)
            else:
                attributes[name] = len(accessors) - 1
    gltf = {'asset': {'version': '2.0', 'generator': 'CCR supplied school roads'}, 'scene': 0,
            'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}], 'meshes': [{'primitives': primitives}],
            'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors,
            'materials': [{'doubleSided': True, 'pbrMetallicRoughness': {
                'baseColorFactor': [*color, 1], 'metallicFactor': 0, 'roughnessFactor': 1}} for color in materials]}
    encoded = json.dumps(gltf, separators=(',', ':')).encode()
    encoded += b' ' * ((-len(encoded)) % 4)
    result = struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(binary))
    result += struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
    result += struct.pack('<II', len(binary), 0x004E4942) + binary
    destination.write_bytes(result)


def compile_school(data, merge_distance=20, vehicle_count=60):
    if not math.isfinite(merge_distance) or merge_distance <= 0 or vehicle_count < 1:
        raise ValueError('Positive junction merge distance and vehicle count required')
    features = data.get('features')
    if data.get('type') != 'FeatureCollection' or not isinstance(features, list) or not features:
        raise ValueError('Expected non-empty geographic road FeatureCollection')
    for feature in features:
        points = feature.get('geometry', {}).get('coordinates', [])
        if feature.get('geometry', {}).get('type') != 'LineString' or len(points) < 2:
            raise ValueError('School roads require LineStrings')
        if any(len(p) < 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p[:2])
               or abs(p[0]) > 180 or abs(p[1]) > 90 for p in points):
            raise ValueError('Invalid geographic coordinates')
    coordinates = [p for feature in features for p in feature['geometry']['coordinates']]
    longitude = (min(p[0] for p in coordinates) + max(p[0] for p in coordinates)) / 2
    latitude = (min(p[1] for p in coordinates) + max(p[1] for p in coordinates)) / 2
    sx, sy = 111319.49079327358 * math.cos(math.radians(latitude)), 111319.49079327358
    project = lambda p: ((p[0] - longitude) * sx, (p[1] - latitude) * sy)
    geographic = lambda p: [longitude + p[0] / sx, latitude + p[1] / sy, 0.04]
    originals = [set_precision(LineString([project(p) for p in f['geometry']['coordinates']]), .01) for f in features]
    if any(line.is_empty or line.length < .01 for line in originals):
        raise ValueError('Degenerate source road')
    noded = unary_union(originals, grid_size=.01)
    merged = line_merge(noded)
    lines = list(merged.geoms) if merged.geom_type == 'MultiLineString' else [merged]
    # Split isolated rings into two connected open paths rather than a mixed self-loop.
    parts = []
    for line in lines:
        if line.is_ring:
            parts.extend([substring(line, 0, line.length / 2), substring(line, line.length / 2, line.length)])
        else:
            parts.append(line)
    node_ids, adjacency, roads = {}, defaultdict(list), []
    for index, line in enumerate(parts):
        endpoints = []
        for point in [line.coords[0], line.coords[-1]]:
            key = tuple(round(v, 4) for v in point)
            if key not in node_ids:
                node_ids[key] = len(node_ids)
            endpoints.append(node_ids[key])
        sources = [i for i, original in enumerate(originals)
                   if line.intersection(original.buffer(.025)).length > min(.05, line.length * .5)]
        if not sources:
            raise ValueError('Noded road lost its source attribution')
        road = {'index': index, 'line': line, 'a': endpoints[0], 'b': endpoints[1], 'sources': sources,
                'width': ROAD_WIDTH}
        roads.append(road)
        for endpoint in endpoints:
            adjacency[endpoint].append(index)
    points = {identifier: key for key, identifier in node_ids.items()}
    parents = list(range(len(points)))

    def root(node):
        while parents[node] != node:
            parents[node] = parents[parents[node]]
            node = parents[node]
        return node

    def join(a, b):
        a, b = root(a), root(b)
        if a != b:
            parents[max(a, b)] = min(a, b)

    for road in roads:
        if road['line'].length < merge_distance and len(adjacency[road['a']]) > 1 and len(adjacency[road['b']]) > 1:
            join(road['a'], road['b'])
    clusters = defaultdict(list)
    for node in points:
        clusters[root(node)].append(node)
    hubs = {cluster: min(nodes, key=lambda a: sum(math.dist(points[a], points[b]) for b in nodes))
            for cluster, nodes in clusters.items()}

    def path_to_hub(node):
        hub, group = hubs[root(node)], root(node)
        queue, seen = [(0, node, [points[node]])], set()
        while queue:
            distance, current, path = heapq.heappop(queue)
            if current in seen:
                continue
            seen.add(current)
            if current == hub:
                return path
            for edge in adjacency[current]:
                road = roads[edge]
                other = road['b'] if current == road['a'] else road['a']
                if root(other) != group:
                    continue
                route = list(road['line'].coords)
                if current == road['b']:
                    route.reverse()
                heapq.heappush(queue, (distance + road['line'].length, other, path + route[1:]))
        raise ValueError('Disconnected junction cluster')

    retained, internal, short_stubs = [], [], []
    for road in roads:
        if root(road['a']) == root(road['b']):
            internal.append(road['index'])
            continue
        route = list(reversed(path_to_hub(road['a']))) + list(road['line'].coords)[1:]
        route += path_to_hub(road['b'])[1:]
        line = LineString(route)
        if line.length < 11 and (len(adjacency[road['a']]) == 1 or len(adjacency[road['b']]) == 1):
            short_stubs.append(road['index'])
            continue
        retained.append({**road, 'path': line, 'from': root(road['a']), 'to': root(road['b'])})
    degrees = Counter(endpoint for road in retained for endpoint in [road['from'], road['to']])
    if not retained:
        raise ValueError('No driveable roads remain')
    lanes = []
    for road in retained:
        line, width = road['path'], road['width']
        sources = [features[i]['properties'].get('OBJECTID', i) for i in road['sources']]
        name = ' / '.join(dict.fromkeys(features[i]['properties'].get('NAME', '') for i in road['sources'] if features[i]['properties'].get('NAME')))
        offset = width / 4
        length = line.length
        sample_count = max(2, math.ceil(length / 2))
        for reverse in [False, True]:
            path = LineString(list(line.coords)[::-1]) if reverse else line
            sampled = []
            for index in range(sample_count + 1):
                distance = length * index / sample_count
                p = path.interpolate(distance)
                a, b = path.interpolate(max(0, distance - .5)), path.interpolate(min(length, distance + .5))
                dx, dy = b.x - a.x, b.y - a.y
                norm = math.hypot(dx, dy)
                lateral = offset * min(1, distance / 8, (length - distance) / 8)
                sampled.append(geographic((p.x + dy / norm * lateral, p.y - dx / norm * lateral)))
            start, end = (road['to'], road['from']) if reverse else (road['from'], road['to'])
            properties = {'from': f'n{start}', 'to': f'n{end}', 'name': name, 'width': width,
                          'sourceObjectIds': sources, 'spawn': degrees[start] == 1}
            lanes.append({'type': 'Feature', 'id': f'road-{road["index"]}-{"r" if reverse else "f"}',
                          'properties': properties, 'geometry': {'type': 'LineString', 'coordinates': sampled}})
    if not any(f['properties']['spawn'] for f in lanes):
        raise ValueError('No dead-end entries available; explicit entrance data required')
    # Distribute original cars across longest lanes, away from junctions.
    available = sorted(lanes, key=lambda f: -LineString([project(p) for p in f['geometry']['coordinates']]).length)
    vehicles = []
    for index in range(vehicle_count):
        lane = available[index % len(available)]
        length = LineString([project(p) for p in lane['geometry']['coordinates']]).length
        vehicles.append({'id': f'campus-car-{index + 1}', 'routeId': lane['id'],
                         'url': f'../traffic-assets/car-{["blue", "ivory", "orange"][index % 3]}.glb',
                         'speed': round(5 + (index * 7 % 25) * .2, 1), 'offset': length * .45,
                         'length': 4.3, 'width': 1.8})
    manifest = {'schemaVersion': 1, 'origin': {'longitude': longitude, 'latitude': latitude, 'height': 0},
                'preview': {'groundUrl': './roads.glb', 'title': '学校车流路网',
                            'range': max((max(p[0] for p in coordinates) - min(p[0] for p in coordinates)) * sx,
                                         (max(p[1] for p in coordinates) - min(p[1] for p in coordinates)) * sy) * 1.55,
                            'note': '使用提供的学校道路中心线，统一双车道；当前为平面高程预览。'},
                'network': {'type': 'FeatureCollection', 'features': lanes}, 'vehicles': vehicles}
    covered = set(i for road in roads for i in road['sources'])
    components, seen = [], set()
    for node in points:
        if node in seen:
            continue
        pending, component = [node], []
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current); component.append(current)
            for edge in adjacency[current]:
                pending.extend([roads[edge]['a'], roads[edge]['b']])
        components.append(len(component))
    report = {'sourceFeatures': len(features), 'sourceVertices': len(coordinates), 'sourceLengthMetres': sum(l.length for l in originals),
              'precisionGridMetres': .01, 'subCentimetreRoads': sum(line.length < .01 - 1e-8 for line in parts),
              'nodedRoads': len(parts), 'originalNodes': len(points), 'junctionMergeThresholdMetres': merge_distance,
              'junctionClusters': [{'nodes': nodes, 'hub': hubs[cluster]} for cluster, nodes in clusters.items() if len(nodes) > 1],
              'internalConnectorRoads': internal, 'shortTerminalRoadsNotDriven': short_stubs,
              'driveableRoads': len(retained), 'directedLanes': len(lanes), 'entryLanes': sum(f['properties']['spawn'] for f in lanes),
              'narrowSharedRoads': 0, 'roadWidthMetres': ROAD_WIDTH, 'laneWidthMetres': ROAD_WIDTH / 2,
              'widthPolicy': 'All roads have two lanes per user instruction; source WIDTH is ignored',
              'componentsNodeCounts': sorted(components, reverse=True),
              'sourceFeaturesAttributed': len(covered), 'sourceWidthCounts': dict(Counter(f['properties'].get('WIDTH') for f in features)),
              'assumptions': ['WGS84 longitude/latitude; source has no CRS declaration', 'Two 3-metre lanes on every road; source WIDTH ignored',
                              'All intersections treated as same-level; no bridge/layer metadata supplied',
                              'Flat ellipsoid-height preview only; no measured heights supplied',
                              'No one-way restrictions supplied; paired directions generated',
                              'Nearby junctions join along original short connector paths; source road drawing preserved']}
    if len(covered) != len(features):
        raise ValueError('Source roads missing from attribution')
    return manifest, report, originals, features, project


def road_preview(originals, features, destination):
    surface = unary_union([line.buffer(ROAD_WIDTH / 2, cap_style=2, join_style=2) for line in originals])
    minx, miny, maxx, maxy = surface.bounds
    floor = Polygon([(minx - 35, miny - 35), (maxx + 35, miny - 35),
                     (maxx + 35, maxy + 35), (minx - 35, maxy + 35)])
    positions, normals, indices = [], [], []
    for shape, height in [(floor, -.03), (surface, .015)]:
        vertices, directions, triangles = [], [], []
        for triangle in constrained_delaunay_triangles(shape).geoms:
            points = list(triangle.exterior.coords)[:3]
            a, b, c = points
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
                points.reverse()
            # Source ENU east/north -> glTF Z/X, with Y up.
            first = len(vertices) // 3
            for x, y in points:
                vertices.extend([y, height, x]); directions.extend([0, 1, 0])
            triangles.extend([first, first + 1, first + 2])
        positions.append(vertices); normals.append(directions); indices.append(triangles)
    write_glb(positions, normals, indices, [[.39, .48, .38], [.09, .115, .13]], destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'examples/campus-traffic')
    parser.add_argument('--merge-junctions', type=float, default=20)
    parser.add_argument('--vehicles', type=int, default=60)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    original = args.source.read_bytes()
    manifest, report, roads, features, _ = compile_school(json.loads(original), args.merge_junctions, args.vehicles)
    report.update({'sourceFile': str(args.source.resolve()), 'sourceSha256': hashlib.sha256(original).hexdigest()})
    args.output.mkdir(parents=True, exist_ok=True)
    preview = args.output / 'roads.glb.tmp'
    road_preview(roads, features, preview)
    files = {'traffic.json': json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
             'conversion-report.json': json.dumps(report, ensure_ascii=False, indent=2) + '\n',
             'source.geojson': original.decode('utf-8')}
    for name, contents in files.items():
        temporary = args.output / (name + '.tmp')
        if name == 'source.geojson':
            temporary.write_bytes(original)
        else:
            temporary.write_text(contents, encoding='utf-8', newline='\n')
    validated = subprocess.run([args.node, str(Path(__file__).with_name('validate-campus-traffic.mjs')),
                                str(args.output / 'traffic.json.tmp')], check=True, capture_output=True, text=True)
    report['validation'] = json.loads(validated.stdout)
    (args.output / 'conversion-report.json.tmp').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.source.read_bytes() != original:
        raise ValueError('Source file changed during conversion')
    preview.replace(args.output / 'roads.glb')
    for name in files:
        (args.output / (name + '.tmp')).replace(args.output / name)
    print(json.dumps({key: value for key, value in report.items() if key not in ['junctionClusters', 'assumptions']}, ensure_ascii=False))


if __name__ == '__main__':
    main()

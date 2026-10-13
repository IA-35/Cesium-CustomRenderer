import importlib.util
import json
import subprocess
import tempfile
import unittest
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('campus_traffic', ROOT / 'scripts/prepare-campus-traffic.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def road(identifier, points, width=3):
    return {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [
        [123 + x / 80000, 41 + y / 111000] for x, y in points]},
        'properties': {'OBJECTID': identifier, 'NAME': f'road-{identifier}', 'WIDTH': width}}


class PreparationTests(unittest.TestCase):
    def test_crossings_node_and_sources_remain_attributed(self):
        data = {'type': 'FeatureCollection', 'features': [road(1, [(-100, 0), (100, 0)]),
                road(2, [(0, -100), (0, 100)])]}
        before = json.dumps(data)
        manifest, report, *_ = MODULE.compile_school(data, vehicle_count=4)
        self.assertEqual(report['originalNodes'], 5)
        self.assertEqual(report['driveableRoads'], 4)
        self.assertEqual(report['directedLanes'], 8)
        self.assertEqual(report['sourceFeaturesAttributed'], 2)
        self.assertEqual(json.dumps(data), before)
        for a, b in zip(manifest['network']['features'][::2], manifest['network']['features'][1::2]):
            self.assertEqual(a['properties']['from'], b['properties']['to'])
            self.assertNotIn('corridor', a['properties'])
            self.assertEqual(a['properties']['width'], 6)

    def test_cluster_connections_follow_source_paths(self):
        data = {'type': 'FeatureCollection', 'features': [road(1, [(-100, 0), (100, 0)]),
                road(2, [(0, -100), (0, 100)]), road(3, [(10, -100), (10, 100)])]}
        manifest, report, originals, _, project = MODULE.compile_school(data, vehicle_count=4)
        self.assertTrue(report['junctionClusters'])
        self.assertEqual(report['shortTerminalRoadsNotDriven'], [])
        from shapely import unary_union
        from shapely.geometry import Point
        centre = unary_union(originals)
        for feature in manifest['network']['features']:
            for point in feature['geometry']['coordinates']:
                self.assertLess(centre.distance(Point(project(point))), 2.1)

    def test_failed_validation_does_not_replace_published_output(self):
        data = {'type': 'FeatureCollection', 'features': [road(1, [(-100, 0), (100, 0)])]}
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / 'source.json'
            source.write_text(json.dumps(data), encoding='utf-8')
            output = folder / 'output'
            output.mkdir()
            (output / 'traffic.json').write_text('previous valid manifest', encoding='utf-8')
            import sys
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-campus-traffic.py'), str(source),
                                     '--output', str(output), '--node', 'missing-validation-node-executable'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'FileNotFoundError', result.stderr)
            self.assertEqual((output / 'traffic.json').read_text(encoding='utf-8'), 'previous valid manifest')
            self.assertFalse((output / 'roads.glb').exists())

    def test_rejects_unusable_geometry_and_ignores_source_width(self):
        for feature in [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[1000,41],[1001,41]]}, 'properties': {}},
                        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [123, 41]}, 'properties': {'WIDTH': 4}}]:
            with self.assertRaises(ValueError):
                MODULE.compile_school({'type': 'FeatureCollection', 'features': [feature]})
        for width in [.5, 2, 5.5, 'not a road width', None]:
            manifest, report, *_ = MODULE.compile_school({'type': 'FeatureCollection', 'features': [road(1, [(-100,0),(100,0)], width)]})
            self.assertEqual(report['narrowSharedRoads'], 0)
            self.assertTrue(all(f['properties']['width'] == 6 and 'corridor' not in f['properties'] for f in manifest['network']['features']))

    def test_preview_triangles_face_up_with_their_normals(self):
        data = {'type': 'FeatureCollection', 'features': [road(1, [(-100, 0), (100, 0)])]}
        _, _, originals, features, _ = MODULE.compile_school(data, vehicle_count=2)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'roads.glb'
            MODULE.road_preview(originals, features, destination)
            raw = destination.read_bytes()
            json_length = struct.unpack_from('<I', raw, 12)[0]
            gltf = json.loads(raw[20:20 + json_length])
            base = 28 + json_length
            for primitive in gltf['meshes'][0]['primitives']:
                accessor = gltf['accessors'][primitive['attributes']['POSITION']]
                view = gltf['bufferViews'][accessor['bufferView']]
                positions = struct.unpack_from('<' + 'f' * accessor['count'] * 3, raw, base + view.get('byteOffset', 0))
                for first in range(0, len(positions), 9):
                    a, b, c = [positions[first + i:first + i + 3] for i in [0, 3, 6]]
                    normal_y = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])
                    self.assertGreater(normal_y, 0)

    def test_crossing_coordinates_remain_on_the_precision_grid(self):
        data = {'type': 'FeatureCollection', 'features': [
            road(1, [(-100,0),(100,7.013)]), road(2, [(0,-100),(0,100)]),
            road(3, [(-60,2.46),(60,2.46)])]}
        _, report, *_ = MODULE.compile_school(data, vehicle_count=4)
        self.assertEqual(report['precisionGridMetres'], .01)
        self.assertEqual(report['subCentimetreRoads'], 0)


if __name__ == '__main__':
    unittest.main()

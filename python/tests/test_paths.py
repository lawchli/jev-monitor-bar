import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import ntpath
import posixpath

from jev_monitor.paths import resolve_paths

_CASES = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'tests', 'fixtures', 'paths-cases.json'))


class PathCaseTest(unittest.TestCase):
    def test_shared_fixture_cases(self):
        with open(_CASES, 'r', encoding='utf-8') as handle:
            cases = json.load(handle)
        self.assertGreaterEqual(len(cases), 10)
        for item in cases:
            resolved = resolve_paths(
                platform=item['platform'],
                env=item['env'],
                homedir=item['homedir'],
                cwd=item.get('cwd'),
            )
            path_api = ntpath if item['platform'] == 'win32' else posixpath
            self.assertEqual(resolved['home'], item['expected']['home'], item['name'])
            self.assertEqual(resolved['session_file'], item['expected']['sessionFile'], item['name'])
            self.assertEqual(resolved['events_dir'], path_api.join(resolved['home'], 'events'), item['name'])
            self.assertEqual(
                resolved['window_state_file'],
                path_api.join(resolved['home'], 'window-state.json'),
                item['name'],
            )
            self.assertEqual(
                set(resolved),
                {'home', 'events_dir', 'session_file', 'window_state_file'},
                item['name'],
            )


if __name__ == '__main__':
    unittest.main()

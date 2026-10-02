import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import ntpath
import posixpath

from jev_monitor.paths import resolve_paths, resolve_session_file

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
            self.assertEqual(
                resolve_session_file(
                    platform=item['platform'], env=item['env'], homedir=item['homedir'], cwd=item.get('cwd'),
                ),
                item['expected']['sessionFile'],
                item['name'],
            )
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

    def test_cwd_is_read_only_for_relative_overrides(self):
        # The current directory may have been deleted (os.getcwd raises).
        with mock.patch('os.getcwd', side_effect=FileNotFoundError(2, 'No such file or directory')):
            linux = resolve_paths(platform='linux', env={}, homedir='/home/me')
            self.assertEqual(linux['session_file'], '/home/me/.local/state/jev-monitor-bar/session.json')
            absolute = resolve_paths(platform='linux', env={'JEV_MONITOR_HOME': '/data/jev'}, homedir='/home/me')
            self.assertEqual(absolute['session_file'], '/data/jev/session.json')
            windows = resolve_paths(platform='win32', env={'LOCALAPPDATA': 'C:\\L'}, homedir='C:\\Users\\me')
            self.assertEqual(windows['session_file'], 'C:\\L\\jev-monitor-bar\\session.json')
            given = resolve_paths(platform='linux', env={'JEV_MONITOR_HOME': 'rel'}, homedir='/home/me', cwd='/work')
            self.assertEqual(given['home'], '/work/rel')
            with self.assertRaises(FileNotFoundError):
                resolve_paths(platform='linux', env={'JEV_MONITOR_SESSION': 'rel/session.json'}, homedir='/home/me')

    def test_session_override_is_independent_of_relative_home(self):
        for platform, session, expected in (
            ('linux', '/data/jev/../session.json', '/data/session.json'),
            ('darwin', '/data/jev/../session.json', '/data/session.json'),
            ('win32', 'C:\\data\\jev\\..\\session.json', 'C:\\data\\session.json'),
        ):
            with self.subTest(platform=platform):
                env = {'JEV_MONITOR_HOME': 'relative-home', 'JEV_MONITOR_SESSION': session}
                with mock.patch('os.getcwd', side_effect=FileNotFoundError('deleted cwd')):
                    self.assertEqual(resolve_session_file(platform=platform, env=env), expected)
                    # The full data home is still unresolved: do not invent a fallback.
                    with self.assertRaises(FileNotFoundError):
                        resolve_paths(platform=platform, env=env, homedir='/home/me')


if __name__ == '__main__':
    unittest.main()

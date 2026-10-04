import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from jev_monitor.sender import MonitorSender, _read_session


class SessionReadTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='jev-session-read-')
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'session.json')

    def write(self, contents):
        with open(self.path, 'wb') as handle:
            handle.write(contents)

    def test_recursive_json_is_offline_and_does_not_raise(self):
        self.write(b'[' * 2000 + b']' * 2000)
        self.assertIsNone(_read_session(self.path))
        # Different Python decoders have different nesting limits.
        with mock.patch('jev_monitor.sender.json.loads', side_effect=RecursionError('nested')):
            self.assertIsNone(_read_session(self.path))

    def test_session_read_has_a_byte_budget(self):
        contents = json.dumps({'url': 'http://127.0.0.1:9', 'token': 'token', 'padding': 'x' * 20000}).encode()
        self.write(contents)
        self.assertIsNone(_read_session(self.path))
        reader = mock.mock_open(read_data=contents)
        with mock.patch('jev_monitor.sender.open', reader):
            self.assertIsNone(_read_session(self.path))
        reader().read.assert_called_once_with(16 * 1024 + 1)

    def test_only_bounded_printable_ascii_credentials_are_loaded(self):
        for token in ('', 'a' * 1025, 'line\nbreak', 'line\rbreak', 'tab\tvalue', 'space value', '\x00', '\x7f', '秘密'):
            with self.subTest(token=repr(token[:20])):
                self.write(json.dumps({'url': 'http://127.0.0.1:9', 'token': token}).encode())
                self.assertIsNone(_read_session(self.path))
        for token in ('token', 'a' * 1024, 'abc+/_~-.='):
            self.write(json.dumps({'url': 'http://127.0.0.1:9/', 'token': token}).encode())
            self.assertEqual(_read_session(self.path), {'url': 'http://127.0.0.1:9', 'token': token})

    def test_session_at_byte_boundary_and_invalid_utf8(self):
        base = json.dumps({'url': 'http://127.0.0.1:9', 'token': 'token'}).encode()
        self.write(base + b' ' * (16 * 1024 - len(base)))
        self.assertEqual(_read_session(self.path), {'url': 'http://127.0.0.1:9', 'token': 'token'})
        self.write(base + b' ' * (16 * 1024 + 1 - len(base)))
        self.assertIsNone(_read_session(self.path))
        self.write(b'\xff')
        self.assertIsNone(_read_session(self.path))

    def test_worker_keeps_queued_event_until_corrupt_session_is_replaced(self):
        self.write(json.dumps({'url': 'http://127.0.0.1:9', 'token': 'bad\nheader'}).encode())
        sent = []

        def accept(_sender, session, event):
            sent.append((session, event))
            return 200

        with mock.patch.object(MonitorSender, '_post', accept):
            sender = MonitorSender(session_file=self.path, heartbeat_interval=60)
            self.addCleanup(sender.close, timeout=0.5)
            self.assertTrue(sender.emit('progress.updated', {'summary': 'queued'}))
            time.sleep(0.1)
            self.assertTrue(sender._thread.is_alive())
            self.assertEqual(sender.stats()['sent'], 0)
            self.assertEqual(sender.stats()['dropped'], 0)
            self.write(json.dumps({'url': 'http://127.0.0.1:9', 'token': 'fixed'}).encode())
            deadline = time.monotonic() + 3
            while sender.stats()['sent'] < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(sender.stats()['sent'], 1)
            self.assertEqual(sender.stats()['dropped'], 0)
            self.assertEqual(sent[0][0]['token'], 'fixed')
            self.assertEqual(json.loads(sent[0][1]['body'])['payload']['summary'], 'queued')


if __name__ == '__main__':
    unittest.main()

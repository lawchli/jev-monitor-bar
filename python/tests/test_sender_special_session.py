import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from jev_monitor.sender import MonitorSender, _read_session


class SpecialSessionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='jev-special-session-')
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'session.json')
        self.valid = {'url': 'http://127.0.0.1:9', 'token': 'test-token'}

    def write(self, value):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(value, handle)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX FIFO requires os.mkfifo')
    def test_fifo_without_writer_is_rejected_with_a_process_timeout(self):
        os.mkfifo(self.path)
        script = (
            'import sys; '
            'sys.path.insert(0, sys.argv[1]); '
            'from jev_monitor.sender import _read_session; '
            'assert _read_session(sys.argv[2]) is None'
        )
        package = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        result = subprocess.run([sys.executable, '-c', script, package, self.path],
                                timeout=3, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX FIFO requires os.mkfifo')
    def test_worker_recovers_when_fifo_is_replaced_by_a_session(self):
        os.mkfifo(self.path)
        sent = []

        def accept(_sender, session, event):
            sent.append((session, event))
            return 200

        with mock.patch.object(MonitorSender, '_post', accept):
            sender = MonitorSender(session_file=self.path, heartbeat_interval=60)
            try:
                self.assertTrue(sender.emit('progress.updated', {'summary': 'queued'}))
                time.sleep(0.05)
                self.assertTrue(sender._thread.is_alive())
                self.assertEqual(sender.stats()['sent'], 0)
                self.assertEqual(sender.stats()['dropped'], 0)
                os.unlink(self.path)
                self.write(self.valid)
                deadline = time.monotonic() + 3
                while sender.stats()['sent'] == 0 and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(sender.stats()['sent'], 1)
                self.assertEqual(sender.stats()['dropped'], 0)
                self.assertEqual(sent[0][0], self.valid)
                self.assertEqual(json.loads(sent[0][1]['body'])['payload']['summary'], 'queued')
            finally:
                sender.close(timeout=0.5)
            self.assertFalse(sender._thread.is_alive())

    def test_directory_and_nonregular_descriptor_are_offline(self):
        self.assertIsNone(_read_session(self.directory.name))
        self.write(self.valid)
        real_stat = os.fstat

        def special(fd):
            value = list(real_stat(fd))
            value[0] = stat.S_IFIFO
            return os.stat_result(value)

        with mock.patch('jev_monitor.sender.os.fstat', side_effect=special):
            self.assertIsNone(_read_session(self.path))

    def test_open_descriptor_is_closed_when_stat_or_wrapping_fails(self):
        self.write(self.valid)
        real_open = os.open
        for target in ('os.fstat', 'os.fdopen'):
            with self.subTest(target=target):
                opened = []

                def track(*args):
                    fd = real_open(*args)
                    opened.append(fd)
                    return fd

                with mock.patch('jev_monitor.sender.os.open', side_effect=track), \
                     mock.patch('jev_monitor.sender.' + target, side_effect=OSError('test failure')):
                    self.assertIsNone(_read_session(self.path))
                self.assertEqual(len(opened), 1)
                with self.assertRaises(OSError):
                    os.fstat(opened[0])

    @unittest.skipUnless(os.name == 'posix', 'replacing an open file requires POSIX rename semantics')
    def test_path_replacement_does_not_change_the_opened_session(self):
        self.write(self.valid)
        real_open = os.open

        def replace_after_open(*args):
            fd = real_open(*args)
            os.rename(self.path, self.path + '.old')
            self.write({**self.valid, 'token': 'replacement'})
            return fd

        with mock.patch('jev_monitor.sender.os.open', side_effect=replace_after_open):
            self.assertEqual(_read_session(self.path), self.valid)
        self.assertEqual(_read_session(self.path)['token'], 'replacement')


if __name__ == '__main__':
    unittest.main()

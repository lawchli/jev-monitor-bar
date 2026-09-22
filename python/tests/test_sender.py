import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from jev_monitor.sender import MonitorSender


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(length) if length else b''
        server = self.server
        release = server.release
        if release is not None:
            release.wait(timeout=3)
        auth = self.headers.get('Authorization', '')
        with server.lock:
            server.posts += 1
            token_ok = auth == 'Bearer ' + server.token
        if not token_ok:
            self._send(401, b'{"error":"unauthorized"}')
            return
        if server.mode == 'conflict':
            self._send(409, b'{"accepted":false,"conflict":true}')
            return
        if server.mode == 'reject':
            self._send(400, b'{"error":"bad"}')
            return
        try:
            event = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            event = None
        with server.lock:
            server.events.append(event)
        accepted = b'{"accepted":false}' if event and event.get('_dup') else b'{"accepted":true}'
        self._send(200, accepted)

    def _send(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


class RecordingServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.events = []
        self.lock = threading.Lock()
        self.token = 'token'
        self.mode = 'ok'
        self.posts = 0
        self.release = None
        self._thread = threading.Thread(target=self.serve_forever, name='jev-fake-receiver', daemon=True)
        self._thread.start()

    @property
    def port(self):
        return self.server_address[1]

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def stop(self):
        if self.release is not None:
            self.release.set()
        self.shutdown()
        self.server_close()
        self._thread.join(timeout=2)


def write_session(path, port, token):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump({'url': f'http://127.0.0.1:{port}', 'token': token}, handle)
        handle.write('\n')


def wait_until(predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class SenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jev-sender-')
        self.session_path = os.path.join(self.tmp, 'session.json')
        self.server = None
        self.sender = None

    def tearDown(self):
        if self.sender is not None:
            self.sender.close(timeout=0.5)
        if self.server is not None:
            self.server.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _start_server(self):
        self.server = RecordingServer()
        write_session(self.session_path, self.server.port, self.server.token)
        return self.server

    def test_events_arrive_in_order_with_increasing_sequence(self):
        server = self._start_server()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=30, host_name='my host')
        count = 12
        for index in range(count):
            self.assertTrue(self.sender.emit('progress.updated', {'completed': index, 'phase': 'step'}))
        self.assertTrue(wait_until(lambda: len(server.snapshot()) >= count, timeout=5))
        events = server.snapshot()
        self.assertEqual(len(events), count)
        self.assertEqual([event['payload']['completed'] for event in events], list(range(count)))
        self.assertEqual([event['sequence'] for event in events], list(range(1, count + 1)))
        self.assertTrue(all(event['occurred_at'].endswith('Z') and '.' in event['occurred_at'] for event in events))
        self.assertEqual(len({event['event_id'] for event in events}), count)
        self.assertTrue(self.sender.producer_id.startswith(f'my-host-{os.getpid()}-'))
        self.assertFalse(self.sender.stats()['offline'])

    def test_emit_without_receiver_stays_under_100ms(self):
        missing = os.path.join(self.tmp, 'missing', 'session.json')
        self.sender = MonitorSender(session_file=missing, queue_size=2000, heartbeat_interval=60, timeout=0.2)
        started = time.perf_counter()
        for _ in range(1000):
            self.assertTrue(self.sender.emit('heartbeat'))
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 0.1)
        self.assertEqual(self.sender.stats()['dropped'], 0)
        self.assertTrue(self.sender.stats()['offline'])

    def test_queue_overflow_counts_dropped(self):
        missing = os.path.join(self.tmp, 'missing', 'session.json')
        self.sender = MonitorSender(session_file=missing, queue_size=10, heartbeat_interval=60)
        accepted = 0
        for index in range(15):
            if self.sender.emit('progress.updated', {'completed': index}):
                accepted += 1
        self.assertEqual(accepted, 10)
        self.assertEqual(self.sender.stats()['dropped'], 5)

    def test_rewritten_session_recovers_from_401(self):
        server = self._start_server()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60, timeout=0.5)
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'before'}))
        self.assertTrue(wait_until(lambda: len(server.snapshot()) == 1, timeout=4))
        server.token = 'rotated'
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'after'}))
        time.sleep(0.15)
        write_session(self.session_path, server.port, 'rotated')
        self.assertTrue(
            wait_until(lambda: any(event['payload'].get('summary') == 'after' for event in server.snapshot()), timeout=6)
        )
        summaries = [event['payload'].get('summary') for event in server.snapshot()]
        self.assertEqual(summaries, ['before', 'after'])

    def test_conflict_is_counted_once(self):
        server = self._start_server()
        server.mode = 'conflict'
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.assertTrue(self.sender.emit('heartbeat'))
        self.assertTrue(wait_until(lambda: self.sender.stats()['conflicts'] == 1, timeout=4))
        time.sleep(0.6)
        stats = self.sender.stats()
        self.assertEqual(stats['conflicts'], 1)
        self.assertEqual(stats['dropped'], 1)
        self.assertEqual(stats['sent'], 0)
        self.assertEqual(server.posts, 1)
        self.assertEqual(server.snapshot(), [])

    def test_recovery_sends_telemetry_dropped_first(self):
        server = RecordingServer()
        self.server = server
        self.sender = MonitorSender(session_file=self.session_path, queue_size=5, heartbeat_interval=60)
        for index in range(8):
            self.sender.emit('progress.updated', {'completed': index})
        self.assertEqual(self.sender.stats()['dropped'], 3)
        write_session(self.session_path, server.port, server.token)
        self.assertTrue(wait_until(lambda: len(server.snapshot()) >= 6, timeout=8))
        events = server.snapshot()
        self.assertGreaterEqual(len(events), 6)
        self.assertEqual(events[0]['type'], 'telemetry.dropped')
        self.assertEqual(events[0]['payload']['count'], 3)
        self.assertEqual([event['payload']['completed'] for event in events[1:6]], [0, 1, 2, 3, 4])

    def test_heartbeat_is_sent_on_interval(self):
        server = self._start_server()
        interval = 0.4
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=interval, timeout=0.5)
        time.sleep(interval * 0.5)
        self.assertEqual(server.snapshot(), [])
        self.assertTrue(wait_until(lambda: any(event['type'] == 'heartbeat' for event in server.snapshot()), timeout=2.5))
        first = next(event for event in server.snapshot() if event['type'] == 'heartbeat')
        self.assertEqual(first['payload'], {})
        self.assertGreaterEqual(first['sequence'], 1)

    def test_close_flushes_queued_events(self):
        server = self._start_server()
        server.release = threading.Event()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60, timeout=2.0)
        for index in range(6):
            self.assertTrue(self.sender.emit('progress.updated', {'completed': index}))
        time.sleep(0.15)
        self.assertEqual(server.snapshot(), [])
        server.release.set()
        self.sender.close(timeout=3)
        self.sender = None
        self.assertTrue(wait_until(lambda: len(server.snapshot()) >= 6, timeout=3))
        events = server.snapshot()
        self.assertEqual([event['payload']['completed'] for event in events], list(range(6)))
        self.assertEqual([event['sequence'] for event in events], list(range(1, 7)))

    def test_invalid_emit_returns_false_without_raising(self):
        missing = os.path.join(self.tmp, 'missing', 'session.json')
        self.sender = MonitorSender(session_file=missing, heartbeat_interval=60)
        self.assertFalse(self.sender.emit('not.a.type'))
        self.assertFalse(self.sender.emit('decision.started', {'kind': 'choice'}))
        self.assertFalse(self.sender.emit('action.selected', {'action': 'go'}, action_id='a'))
        self.assertGreaterEqual(self.sender.stats()['dropped'], 3)

    def test_disabled_sender_is_noop(self):
        self.sender = MonitorSender(enabled=False, session_file=self.session_path)
        self.assertTrue(self.sender.emit('heartbeat'))
        self.assertTrue(self.sender.run_started('x'))
        with self.sender:
            self.assertEqual(self.sender.stats()['sent'], 0)
            self.assertEqual(self.sender.stats()['dropped'], 0)
        self.assertFalse(self.sender.stats()['offline'])


if __name__ == '__main__':
    unittest.main()

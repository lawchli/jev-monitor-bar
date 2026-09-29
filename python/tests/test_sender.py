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

from jev_monitor.sender import MonitorSender, _encode_event, _loopback_origin, _snapshot_event


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        self._receive()

    def do_POST(self):
        self._receive()

    def _receive(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(length) if length else b''
        server = self.server
        release = server.release
        if release is not None:
            release.wait(timeout=3)
        auth = self.headers.get('Authorization', '')
        try:
            event = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            event = None
        with server.lock:
            server.posts += 1
            server.calls.append((self.command, self.path, auth))
            server.attempts.append(event)
            token_ok = auth == 'Bearer ' + server.token
            fail = server.fail_left > 0
            if fail:
                server.fail_left -= 1
                fail_code = server.fail_code
        if server.mode == 'redirect':
            self._send_redirect(server.redirect_code, server.redirect_to)
            return
        if not token_ok:
            self._send(401, b'{"error":"unauthorized"}')
            return
        if fail:
            self._send(fail_code, b'{}')
            return
        if server.mode == 'conflict':
            self._send(409, b'{"accepted":false,"conflict":true}')
            return
        if server.mode == 'reject':
            self._send(400, b'{"error":"bad"}')
            return
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

    def _send_redirect(self, code, location):
        self.send_response(code)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, fmt, *args):
        return


class RecordingServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.events = []
        self.attempts = []
        self.calls = []
        self.lock = threading.Lock()
        self.token = 'token'
        self.mode = 'ok'
        self.redirect_code = 302
        self.redirect_to = '/exfil'
        self.posts = 0
        self.fail_code = 400
        self.fail_left = 0
        self.release = None
        self._thread = threading.Thread(target=self.serve_forever, name='jev-fake-receiver', daemon=True)
        self._thread.start()

    @property
    def port(self):
        return self.server_address[1]

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def attempt_snapshot(self):
        with self.lock:
            return list(self.attempts)

    def call_snapshot(self):
        with self.lock:
            return list(self.calls)

    def stop(self):
        if self.release is not None:
            self.release.set()
        self.shutdown()
        self.server_close()
        self._thread.join(timeout=2)


def write_session(path, port, token):
    write_session_url(path, f'http://127.0.0.1:{port}', token)


def write_session_url(path, url, token):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump({'url': url, 'token': token}, handle)
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
        self.target = None
        self.sender = None

    def tearDown(self):
        if self.sender is not None:
            self.sender.close(timeout=0.5)
        if self.server is not None:
            self.server.stop()
        if self.target is not None:
            self.target.stop()
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
        self.assertTrue(self.sender._thread.is_alive())
        # Queue stays full while the session file is missing, so these emits
        # must count as drops and return without waiting on the worker.
        # Each drop also logs a warning. Windows CI measured 0.57s for these
        # 200 calls; blocking on the 0.5s HTTP timeout would be about 100s.
        started = time.perf_counter()
        for index in range(200):
            self.assertFalse(self.sender.emit('progress.updated', {'completed': 100 + index}))
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 2.0)
        self.assertEqual(self.sender.stats()['dropped'], 205)
        self.assertTrue(self.sender._thread.is_alive())

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
        self.assertTrue(wait_until(lambda: server.posts >= 2, timeout=4))
        time.sleep(0.6)
        stats = self.sender.stats()
        attempts = server.attempt_snapshot()
        self.assertEqual([item['type'] for item in attempts], ['heartbeat', 'telemetry.dropped'])
        self.assertEqual(attempts[1]['payload']['count'], 1)
        self.assertEqual(sum(item['type'] == 'heartbeat' for item in attempts), 1)
        self.assertEqual(stats['conflicts'], 2)
        self.assertEqual(stats['dropped'], 2)
        self.assertEqual(stats['sent'], 0)
        self.assertEqual(server.posts, 2)
        self.assertEqual(server.snapshot(), [])

    def test_terminal_reject_is_reported_before_later_events(self):
        server = self._start_server()
        server.fail_code = 409
        server.fail_left = 1
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'lost'}))
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'kept'}))
        self.assertTrue(wait_until(lambda: len(server.snapshot()) >= 2, timeout=4))
        events = server.snapshot()
        self.assertEqual(events[0]['type'], 'telemetry.dropped')
        self.assertEqual(events[0]['payload']['count'], 1)
        self.assertEqual(events[1]['payload']['summary'], 'kept')
        self.assertTrue(all(event['payload'].get('summary') != 'lost' for event in events))
        self.assertEqual(self.sender.stats()['conflicts'], 1)
        self.assertEqual(self.sender.stats()['rejected'], 0)

        self.sender.close(timeout=1)
        self.sender = None
        server.fail_code = 400
        server.fail_left = 1
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'bad'}))
        self.assertTrue(wait_until(lambda: any(event['type'] == 'telemetry.dropped' for event in server.snapshot()[len(events):]), timeout=4))
        later = server.snapshot()[len(events):]
        self.assertEqual(later[0]['type'], 'telemetry.dropped')
        self.assertEqual(later[0]['payload']['count'], 1)
        self.assertEqual(self.sender.stats()['rejected'], 1)

    def test_invalid_emit_is_not_a_telemetry_drop(self):
        server = RecordingServer()
        self.server = server
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.assertFalse(self.sender.emit('not.a.type'))
        write_session(self.session_path, server.port, server.token)
        time.sleep(0.6)
        self.assertEqual(server.posts, 0)
        self.assertEqual(self.sender.stats()['dropped'], 1)

    def test_loopback_origin_rejects_non_local_urls(self):
        self.assertEqual(_loopback_origin('http://127.0.0.1:9'), 'http://127.0.0.1:9')
        self.assertEqual(_loopback_origin('http://127.0.0.1:9/'), 'http://127.0.0.1:9')
        self.assertEqual(_loopback_origin('http://127.0.0.1'), 'http://127.0.0.1')
        for url in (
            'http://evil.example/events',
            'http://localhost:9',
            'https://127.0.0.1:9',
            'http://user:secret@127.0.0.1:9',
            'http://127.0.0.1:9@evil.example/',
            'http://127.0.0.1:9/events',
            'http://127.0.0.1:9?x=1',
            'http://127.0.0.1:9#frag',
            'http://127.0.0.1:99999',
            'http://[::1]:9',
            'http://127.0.0.1:0',
        ):
            self.assertIsNone(_loopback_origin(url), url)

    def test_session_url_must_be_http_loopback(self):
        server = RecordingServer()
        self.server = server
        port = server.port
        rejected = [
            'http://evil.example/events',
            f'http://localhost:{port}',
            f'https://127.0.0.1:{port}',
            f'http://user:secret@127.0.0.1:{port}',
            f'http://127.0.0.1:{port}@evil.example/',
            f'http://127.0.0.1:{port}/events',
            f'http://127.0.0.1:{port}?x=1',
            f'http://127.0.0.1:{port}#frag',
            'http://127.0.0.1:99999',
            f'http://[::1]:{port}',
        ]
        write_session_url(self.session_path, rejected[0], server.token)
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.assertTrue(self.sender.emit('heartbeat'))
        time.sleep(0.25)
        self.assertEqual(server.posts, 0)
        self.assertTrue(self.sender.stats()['offline'])
        for url in rejected[1:]:
            time.sleep(0.02)
            write_session_url(self.session_path, url, server.token)
        time.sleep(0.4)
        self.assertEqual(server.posts, 0)
        write_session_url(self.session_path, f'http://127.0.0.1:{port}/', server.token)
        self.assertTrue(wait_until(lambda: len(server.snapshot()) == 1, timeout=6))
        self.assertEqual(server.snapshot()[0]['type'], 'heartbeat')
        self.assertEqual(server.posts, 1)

    def test_non_positive_limits_raise(self):
        for kwargs in (
            {'queue_size': 0},
            {'queue_size': -3},
            {'queue_size': True},
            {'timeout': 0},
            {'timeout': -0.1},
            {'heartbeat_interval': 0},
            {'heartbeat_interval': -1},
        ):
            with self.assertRaises(ValueError):
                MonitorSender(enabled=False, session_file=self.session_path, **kwargs)

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

    def test_close_timeout_counts_unsent_events_as_dropped(self):
        missing = os.path.join(self.tmp, 'missing', 'session.json')
        self.sender = MonitorSender(session_file=missing, queue_size=3, heartbeat_interval=60, timeout=0.2)
        results = [self.sender.emit('progress.updated', {'completed': index}) for index in range(5)]
        self.assertEqual(results, [True, True, True, False, False])
        self.assertEqual(self.sender.stats()['dropped'], 2)
        thread = self.sender._thread
        self.sender.close(timeout=0.3)
        self.assertTrue(wait_until(lambda: not thread.is_alive(), timeout=2))
        # Every emitted event is either sent or dropped; none disappears silently.
        stats = self.sender.stats()
        self.assertEqual(stats['sent'], 0)
        self.assertEqual(stats['dropped'], 5)
        self.sender = None

    def test_bad_payload_does_not_stop_the_sender(self):
        server = self._start_server()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        cycle = {}
        cycle['self'] = cycle
        bad_payloads = (
            {'tags': {1, 2}},
            cycle,
            {'summary': 'bad\ud800'},
            {'summary': 'x' * 70000},
        )
        for payload in bad_payloads:
            self.assertFalse(self.sender.emit('progress.updated', payload))
        self.assertTrue(self.sender._thread.is_alive())
        nested = {'n': 1}
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'ok', 'nested': nested}))
        nested['n'] = 2
        self.assertTrue(wait_until(lambda: self.sender.stats()['sent'] == 1 and len(server.snapshot()) == 1, timeout=4))
        event = server.snapshot()[0]
        self.assertEqual(event['type'], 'progress.updated')
        self.assertEqual(event['sequence'], 1)
        self.assertEqual(event['payload'], {'summary': 'ok', 'nested': {'n': 1}})
        self.assertEqual(self.sender.stats()['dropped'], len(bad_payloads))
        self.assertEqual(self.sender.stats()['sent'], 1)
        self.assertTrue(self.sender._thread.is_alive())
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'later'}))
        self.assertTrue(wait_until(lambda: len(server.snapshot()) == 2, timeout=4))
        self.assertEqual(server.snapshot()[1]['payload']['summary'], 'later')
        self.assertEqual(server.snapshot()[1]['sequence'], 2)

    def test_unsendable_queued_event_does_not_stop_the_worker(self):
        server = self._start_server()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60)
        self.sender._queue.put_nowait({'type': 'progress.updated', 'sequence': 99, 'payload': {'tags': {1}}})
        self.assertTrue(self.sender.emit('progress.updated', {'summary': 'after'}))
        self.assertTrue(
            wait_until(
                lambda: self.sender.stats()['sent'] == 1
                and any(event['payload'].get('summary') == 'after' for event in server.snapshot()),
                timeout=4,
            )
        )
        self.assertTrue(self.sender._thread.is_alive())
        events = server.snapshot()
        self.assertEqual([event['payload'].get('summary') for event in events], ['after'])
        self.assertEqual(events[0]['sequence'], 1)
        self.assertEqual(self.sender.stats()['dropped'], 1)
        self.assertEqual(self.sender.stats()['sent'], 1)

    def test_snapshot_rejects_events_over_64kib(self):
        under = {'payload': {'summary': ''}}
        over = {'payload': {'summary': ''}}
        low = 0
        high = 70000
        while low < high:
            mid = (low + high) // 2
            under['payload']['summary'] = 'a' * mid
            if len(_encode_event(under)) <= 65536:
                low = mid + 1
            else:
                high = mid
        under['payload']['summary'] = 'a' * (low - 1)
        over['payload']['summary'] = 'a' * low
        self.assertLessEqual(len(_encode_event(under)), 65536)
        self.assertGreater(len(_encode_event(over)), 65536)
        self.assertEqual(_snapshot_event(under), _encode_event(under))
        with self.assertRaises(ValueError):
            _snapshot_event(over)

    def test_event_post_does_not_follow_redirects(self):
        server = self._start_server()
        self.target = RecordingServer()
        self.sender = MonitorSender(session_file=self.session_path, heartbeat_interval=60, timeout=0.5)
        for index, code in enumerate((301, 302, 303, 307, 308)):
            self.assertTrue(wait_until(lambda i=index: self.sender.stats()['sent'] == i, timeout=4))
            server.mode = 'redirect'
            server.redirect_code = code
            if code == 302:
                server.redirect_to = '/exfil'
                self.assertTrue(server.redirect_to.startswith('/'))
            else:
                server.redirect_to = f'http://127.0.0.1:{self.target.port}/exfil'
                self.assertTrue(server.redirect_to.startswith('http://'))
            summary = f'code-{code}'
            before = server.posts
            with self.assertLogs('jev_monitor', level='WARNING') as captured:
                self.assertTrue(self.sender.emit('progress.updated', {'summary': summary}))
                self.assertTrue(
                    wait_until(
                        lambda c=code: any(f'retrying status={c}' in line for line in captured.output),
                        timeout=4,
                    )
                )
            self.assertGreater(server.posts, before)
            self.assertEqual(self.target.posts, 0)
            self.assertEqual(self.target.call_snapshot(), [])
            self._assert_location_has_no_bearer(server, self.target)
            event_auths = [
                auth for method, path, auth in server.call_snapshot() if method == 'POST' and path == '/events'
            ]
            self.assertTrue(event_auths)
            self.assertTrue(all(auth == 'Bearer ' + server.token for auth in event_auths))
            self.assertTrue(all(method == 'POST' and path == '/events' for method, path, _auth in server.call_snapshot()))
            self.assertEqual(self.sender.stats()['sent'], index)
            self.assertTrue(self.sender._thread.is_alive())
            server.mode = 'ok'
            self.assertTrue(
                wait_until(
                    lambda s=summary: any(event['payload'].get('summary') == s for event in server.snapshot()),
                    timeout=6,
                )
            )
        self.assertEqual(self.target.posts, 0)
        self.assertTrue(wait_until(lambda: self.sender.stats()['sent'] == 5, timeout=4))
        self.assertEqual(
            [event['payload']['summary'] for event in server.snapshot()],
            ['code-301', 'code-302', 'code-303', 'code-307', 'code-308'],
        )
        self._assert_location_has_no_bearer(server, self.target)
        self.assertTrue(all(method == 'POST' and path == '/events' for method, path, _auth in server.call_snapshot()))
        self.assertTrue(self.sender._thread.is_alive())
        self.assertEqual(self.sender.stats()['sent'], 5)

    def _assert_location_has_no_bearer(self, *servers):
        forwarded = [
            (method, path, auth)
            for server in servers
            for method, path, auth in server.call_snapshot()
            if path == '/exfil' and 'Bearer' in auth
        ]
        self.assertEqual(forwarded, [])

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

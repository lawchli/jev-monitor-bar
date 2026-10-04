import io
import os
import sys
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from jev_monitor.sender import MonitorSender


class HeldResponseHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(self.server.status)
        self.send_header('Content-Length', str(1024 * 1024 * 1024))
        self.end_headers()
        self.wfile.flush()
        self.server.headers_sent.set()
        # Send neither the body nor EOF until the test releases this handler.
        self.server.release.wait(5)
        self.close_connection = True

    def log_message(self, *args):
        pass


class ResponseTest(unittest.TestCase):
    def test_status_does_not_wait_for_unused_response_body(self):
        for status in (200, 401, 409, 413, 503, 307):
            with self.subTest(status=status):
                server = ThreadingHTTPServer(('127.0.0.1', 0), HeldResponseHandler)
                server.daemon_threads = True
                server.status = status
                server.headers_sent = threading.Event()
                server.release = threading.Event()
                serving = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
                serving.start()
                sender = MonitorSender(enabled=False, timeout=5)
                done = threading.Event()
                result = []

                def post():
                    try:
                        result.append(sender._post(
                            {'url': f'http://127.0.0.1:{server.server_port}', 'token': 'test-token'},
                            {'type': 'heartbeat', 'body': b'{}'},
                        ))
                    finally:
                        done.set()

                posting = threading.Thread(target=post, daemon=True)
                posting.start()
                try:
                    self.assertTrue(server.headers_sent.wait(2), 'receiver did not send headers')
                    self.assertTrue(done.wait(1), 'sender waited for the unused response body')
                    self.assertEqual(result, [status])
                finally:
                    server.release.set()
                    posting.join(2)
                    server.shutdown()
                    server.server_close()
                    serving.join(2)

    def test_success_and_error_response_handles_are_closed_without_reading(self):
        sender = MonitorSender(enabled=False)
        session = {'url': 'http://127.0.0.1:9', 'token': 'test-token'}
        event = {'type': 'heartbeat', 'body': b'{}'}
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.getcode.return_value = 200
        with mock.patch.object(sender._opener, 'open', return_value=response):
            self.assertEqual(sender._post(session, event), 200)
        response.read.assert_not_called()
        response.__exit__.assert_called_once()

        for status in (401, 409, 413, 503, 307):
            with self.subTest(status=status):
                body = io.BytesIO(b'unused response')
                error = urllib.error.HTTPError(session['url'], status, 'test', {}, body)
                with mock.patch.object(sender._opener, 'open', side_effect=error):
                    self.assertEqual(sender._post(session, event), status)
                self.assertTrue(body.closed)


if __name__ == '__main__':
    unittest.main()

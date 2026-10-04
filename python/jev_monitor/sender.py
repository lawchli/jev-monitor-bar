"""Non-blocking monitor sender. Python 3.9+, standard library only."""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import secrets
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Optional

from .paths import resolve_paths

EVENT_TYPES = frozenset(
    {
        'run.started',
        'run.completed',
        'run.failed',
        'run.cancelled',
        'decision.started',
        'decision.resolved',
        'decision.failed',
        'action.selected',
        'action.started',
        'action.completed',
        'action.failed',
        'action.cancelled',
        'verification.completed',
        'progress.updated',
        'heartbeat',
        'telemetry.dropped',
    }
)
ID_FIELDS = ('decision_id', 'request_id', 'question_id', 'action_id', 'attempt_id')
REQUIRED_IDS = {
    'decision.started': ('decision_id', 'request_id', 'question_id'),
    'decision.resolved': ('decision_id', 'request_id', 'question_id'),
    'decision.failed': ('decision_id', 'request_id', 'question_id'),
    'action.selected': ('action_id', 'attempt_id'),
    'action.started': ('action_id', 'attempt_id'),
    'action.completed': ('action_id', 'attempt_id'),
    'action.failed': ('action_id', 'attempt_id'),
    'action.cancelled': ('action_id', 'attempt_id'),
    'verification.completed': ('action_id', 'attempt_id'),
}
# Statuses that mean the receiver will not accept this event. Anything else
# (including connection failures) keeps the event and retries.
TERMINAL_REJECT = frozenset({400, 413})
_HOST_UNSAFE = re.compile(r'[^A-Za-z0-9_.:/-]')
_BACKOFF_START = 0.5
_BACKOFF_MAX = 5.0
# Same byte cap as the receiver (`Content-Length` / body > 64 KiB is 413).
_MAX_EVENT_BYTES = 65536
# A session contains an origin and a credential, not event data. Read one
# extra byte to detect growth as well as files that already exceed the cap.
_MAX_SESSION_BYTES = 16 * 1024
_MAX_SESSION_TOKEN = 1024
# Returned by `_post` when this event cannot be sent and must be dropped.
_UNSENDABLE = object()


class _RejectRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect on the event POST.

    stdlib `HTTPRedirectHandler` turns 301/302/303 into a GET and copies
    `Authorization` onto `Location`. A local service that redirects could
    send the bearer token off this request. Missing `Location` is refused too.
    """

    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'


def _default_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    return f'run-{stamp}-{secrets.token_hex(3)}'


def _producer_id(host_name: str) -> str:
    host = _HOST_UNSAFE.sub('-', host_name)
    suffix = f'-{os.getpid()}-{secrets.token_hex(4)}'
    if not host:
        host = 'host'
    max_host = 160 - len(suffix)
    if max_host < 1:
        return ('host' + suffix)[:160]
    if len(host) > max_host:
        host = host[:max_host]
    if not host:
        host = 'h'
    return host + suffix


def _omit_none(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if value is not None}


def _encode_event(event: dict) -> bytes:
    """JSON snapshot. Raises TypeError, ValueError, UnicodeError, or RecursionError."""
    return json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def _snapshot_event(event: dict) -> bytes:
    """Immutable UTF-8 JSON body, or raise if it cannot be sent."""
    body = _encode_event(event)
    if len(body) > _MAX_EVENT_BYTES:
        raise ValueError('event exceeds 64 KiB')
    return body


def _loopback_origin(url: str) -> Optional[str]:
    """Accept only `http://127.0.0.1` with an optional port and no extra parts.

    `localhost`, other addresses, userinfo, a query, a fragment, and any path
    other than `/` are rejected so a session file cannot send the bearer token
    off the machine.
    """
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != 'http':
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.query or parts.fragment:
        return None
    if parts.hostname != '127.0.0.1':
        return None
    if port is not None and not 1 <= port <= 65535:
        return None
    if parts.path not in ('', '/'):
        return None
    if port is None:
        return 'http://127.0.0.1'
    return f'http://127.0.0.1:{port}'


def _read_session(path: str) -> Optional[dict]:
    fd = None
    try:
        # A FIFO must not block the sender before its byte-limited read starts.
        # Validate and read the same descriptor so a path replacement is safe.
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        with os.fdopen(fd, 'rb') as handle:
            fd = None  # The file object owns the descriptor from here.
            raw = handle.read(_MAX_SESSION_BYTES + 1)
        if len(raw) > _MAX_SESSION_BYTES:
            return None
        data = json.loads(raw.decode('utf-8'))
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
    if not isinstance(data, dict):
        return None
    url = data.get('url')
    token = data.get('token')
    if not isinstance(url, str) or not isinstance(token, str) or not url or not token:
        return None
    # Invalid header values must leave queued events offline, rather than
    # reaching Request and being counted as unsendable events.
    if len(token) > _MAX_SESSION_TOKEN or any(ord(char) < 33 or ord(char) > 126 for char in token):
        return None
    origin = _loopback_origin(url)
    if origin is None:
        logging.getLogger('jev_monitor').warning('ignoring session file; url must be http://127.0.0.1[:port]')
        return None
    return {'url': origin, 'token': token}


def _require_queue_size(queue_size: int) -> None:
    if isinstance(queue_size, bool) or not isinstance(queue_size, int) or queue_size < 1:
        raise ValueError('queue_size must be an integer >= 1')


def _require_positive(name: str, value: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f'{name} must be > 0')


class MonitorSender:
    """Queue events on the caller thread and POST them from a daemon thread.

    `emit` uses `put_nowait`: it never blocks and never raises. `enabled=False`
    turns every method into a no-op that reports success without counting a drop.
    """

    def __init__(
        self,
        run_id: Optional[str] = None,
        host_name: str = 'host',
        *,
        session_file: Optional[str] = None,
        queue_size: int = 1000,
        timeout: float = 0.5,
        heartbeat_interval: float = 5.0,
        enabled: bool = True,
    ) -> None:
        _require_queue_size(queue_size)
        _require_positive('timeout', timeout)
        _require_positive('heartbeat_interval', heartbeat_interval)
        self.enabled = enabled
        self.run_id = run_id if run_id else _default_run_id()
        self.producer_id = _producer_id(host_name if host_name is not None else '')
        self.session_file = session_file if session_file is not None else resolve_paths()['session_file']
        self.timeout = timeout
        self.heartbeat_interval = heartbeat_interval
        self._queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._closed = False
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._sequence = 0
        self._stats = {'sent': 0, 'dropped': 0, 'conflicts': 0, 'rejected': 0}
        self._offline = bool(enabled)
        self._unreported = 0
        self._backoff = _BACKOFF_START
        self._last_sent = time.monotonic()
        self._session_mtime = object()
        self._session: Optional[dict] = None
        self._logger = logging.getLogger('jev_monitor')
        # Session URL is limited to 127.0.0.1. Also ignore proxies, and refuse
        # redirects so Authorization is not copied to a Location.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RejectRedirect)
        self._thread: Optional[threading.Thread] = None
        if enabled:
            self._thread = threading.Thread(target=self._loop, name='jev-monitor-sender', daemon=True)
            self._thread.start()

    def emit(self, type: str, payload: Optional[dict] = None, **ids: object) -> bool:
        if not self.enabled:
            return True
        try:
            return self._emit(type, payload, ids)
        except Exception:
            self._logger.warning('emit failed type=%s', type, exc_info=True)
            self._note_drop('emit failed', overflow=False)
            return False

    def stats(self) -> dict:
        with self._lock:
            return {
                'sent': self._stats['sent'],
                'dropped': self._stats['dropped'],
                'conflicts': self._stats['conflicts'],
                'rejected': self._stats['rejected'],
                'offline': self._offline,
            }

    def close(self, timeout: float = 2.0) -> None:
        if not self.enabled:
            return
        self._closed = True
        self._wake.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)
            self._stop.set()
            self._wake.set()
            # Events still queued when the timeout ends are never sent. Count them as dropped.
            self._discard_queued()

    def _discard_queued(self) -> None:
        discarded = 0
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
            discarded += 1
        if discarded:
            with self._lock:
                self._stats['dropped'] += discarded
            self._logger.warning('dropped %d queued events: close timed out', discarded)

    def __enter__(self) -> 'MonitorSender':
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.close()
        return False

    def run_started(self, name: str, simulated: bool = False) -> bool:
        return self.emit('run.started', {'name': name, 'simulated': simulated})

    def run_completed(self) -> bool:
        return self.emit('run.completed')

    def run_failed(self, reason: str) -> bool:
        return self.emit('run.failed', {'reason': reason})

    def run_cancelled(self, reason: str) -> bool:
        return self.emit('run.cancelled', {'reason': reason})

    def decision_started(
        self,
        decision_id: str,
        request_id: str,
        question_id: str,
        kind: str,
        question: str,
        candidates: Optional[dict] = None,
        summary: Optional[str] = None,
    ) -> bool:
        return self.emit(
            'decision.started',
            {'kind': kind, 'question': question, 'candidates': candidates, 'summary': summary},
            decision_id=decision_id,
            request_id=request_id,
            question_id=question_id,
        )

    def decision_resolved(
        self,
        decision_id: str,
        request_id: str,
        question_id: str,
        kind: str,
        *,
        choice: Optional[str] = None,
        score: Optional[float] = None,
        noul: Optional[float] = None,
        probabilities: Optional[dict] = None,
        confidence: Optional[float] = None,
        model: Optional[str] = None,
        latency_ms: Optional[float] = None,
        legend: Optional[dict] = None,
        explanation: Optional[str] = None,
        explanation_source: Optional[str] = None,
    ) -> bool:
        return self.emit(
            'decision.resolved',
            {
                'kind': kind,
                'choice': choice,
                'score': score,
                'noul': noul,
                'probabilities': probabilities,
                'confidence': confidence,
                'model': model,
                'latency_ms': latency_ms,
                'legend': legend,
                'explanation': explanation,
                'explanation_source': explanation_source,
            },
            decision_id=decision_id,
            request_id=request_id,
            question_id=question_id,
        )

    def decision_failed(self, decision_id: str, request_id: str, question_id: str, kind: str, reason: str) -> bool:
        return self.emit(
            'decision.failed',
            {'kind': kind, 'reason': reason},
            decision_id=decision_id,
            request_id=request_id,
            question_id=question_id,
        )

    def action_selected(
        self,
        action_id: str,
        attempt_id: str,
        action: str,
        source: str,
        decision_id: Optional[str] = None,
        rule: Optional[str] = None,
        rule_source: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> bool:
        return self.emit(
            'action.selected',
            {'action': action, 'source': source, 'rule': rule, 'rule_source': rule_source, 'reason': reason},
            action_id=action_id,
            attempt_id=attempt_id,
            decision_id=decision_id,
        )

    def action_started(
        self,
        action_id: str,
        attempt_id: str,
        decision_id: Optional[str] = None,
        reason: Optional[str] = None,
        retry: Optional[int] = None,
    ) -> bool:
        return self._action('action.started', action_id, attempt_id, decision_id, reason, retry)

    def action_completed(
        self,
        action_id: str,
        attempt_id: str,
        decision_id: Optional[str] = None,
        reason: Optional[str] = None,
        retry: Optional[int] = None,
    ) -> bool:
        return self._action('action.completed', action_id, attempt_id, decision_id, reason, retry)

    def action_failed(
        self,
        action_id: str,
        attempt_id: str,
        decision_id: Optional[str] = None,
        reason: Optional[str] = None,
        retry: Optional[int] = None,
    ) -> bool:
        return self._action('action.failed', action_id, attempt_id, decision_id, reason, retry)

    def action_cancelled(
        self,
        action_id: str,
        attempt_id: str,
        decision_id: Optional[str] = None,
        reason: Optional[str] = None,
        retry: Optional[int] = None,
    ) -> bool:
        return self._action('action.cancelled', action_id, attempt_id, decision_id, reason, retry)

    def verification(
        self,
        action_id: str,
        attempt_id: str,
        result: str,
        checks: list,
        decision_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> bool:
        return self.emit(
            'verification.completed',
            {'result': result, 'checks': checks, 'reason': reason},
            action_id=action_id,
            attempt_id=attempt_id,
            decision_id=decision_id,
        )

    def progress(
        self,
        phase: Optional[str] = None,
        completed: Optional[int] = None,
        total: Optional[int] = None,
        summary: Optional[str] = None,
    ) -> bool:
        return self.emit('progress.updated', {'phase': phase, 'completed': completed, 'total': total, 'summary': summary})

    def _action(self, event_type: str, action_id: str, attempt_id: str, decision_id, reason, retry) -> bool:
        return self.emit(
            event_type,
            {'reason': reason, 'retry': retry},
            action_id=action_id,
            attempt_id=attempt_id,
            decision_id=decision_id,
        )

    def _emit(self, event_type: str, payload: Optional[dict], ids: dict) -> bool:
        if not isinstance(event_type, str) or event_type not in EVENT_TYPES:
            self._note_drop(f'unknown event type: {event_type}', overflow=False)
            return False
        if payload is None:
            body: dict = {}
        elif isinstance(payload, dict):
            body = _omit_none(payload)
        else:
            self._note_drop(f'payload is not an object: {event_type}', overflow=False)
            return False
        clean_ids = {}
        for key in ID_FIELDS:
            if key not in ids:
                continue
            value = ids[key]
            if value is None or value == '':
                continue
            if not isinstance(value, str):
                self._note_drop(f'id {key} is not a string for {event_type}', overflow=False)
                return False
            clean_ids[key] = value
        for key in REQUIRED_IDS.get(event_type, ()):
            if key not in clean_ids:
                self._note_drop(f'missing {key} for {event_type}', overflow=False)
                return False
        event = {
            'schema_version': 1,
            'event_id': uuid.uuid4().hex,
            'run_id': self.run_id,
            'producer_id': self.producer_id,
            'occurred_at': _now_iso(),
            'type': event_type,
            'payload': body,
        }
        event.update(clean_ids)
        encode_error = None
        with self._lock:
            if self._closed:
                self._stats['dropped'] += 1
                queued = False
                overflow = False
            else:
                event['sequence'] = self._sequence + 1
                try:
                    # Freeze nested objects here. A later mutation, a set, a cycle,
                    # a lone surrogate, or a body over 64 KiB must not reach `_post`.
                    raw = _snapshot_event(event)
                except (TypeError, ValueError, RecursionError) as exc:
                    encode_error = exc
                    self._stats['dropped'] += 1
                    queued = False
                    overflow = False
                else:
                    try:
                        self._queue.put_nowait({'type': event_type, 'sequence': event['sequence'], 'body': raw})
                        self._sequence += 1
                        queued = True
                        overflow = False
                    except queue.Full:
                        self._stats['dropped'] += 1
                        self._unreported += 1
                        queued = False
                        overflow = True
        if queued:
            return True
        if encode_error is not None:
            self._logger.warning('dropped %s: %s', event_type, encode_error)
            return False
        reason = 'queue full' if overflow else 'sender closed'
        self._logger.warning('dropped %s: %s', event_type, reason)
        return False

    def _note_drop(self, reason: str, *, overflow: bool) -> None:
        with self._lock:
            self._stats['dropped'] += 1
            if overflow:
                self._unreported += 1
        self._logger.warning('%s', reason)

    def _loop(self) -> None:
        pending = None
        telemetry = None
        while not self._stop.is_set():
            if self._closed and pending is None and telemetry is None and self._queue.empty():
                break
            session = self._load_session()
            if session is None:
                self._set_offline(True)
                self._sleep_backoff()
                continue
            if telemetry is None:
                count = self._reserve_unreported()
                if count > 0:
                    telemetry = self._make_event('telemetry.dropped', {'count': count})
            if telemetry is not None:
                event = telemetry
                kind = 'telemetry'
            elif pending is not None:
                event = pending
                kind = 'pending'
            else:
                event = self._pull()
                if event is None:
                    if self._closed:
                        break
                    if self._heartbeat_due():
                        try:
                            event = self._queue.get_nowait()
                        except queue.Empty:
                            event = self._make_event('heartbeat', {})
                    else:
                        continue
                pending = event
                kind = 'pending'
            try:
                status = self._post(session, event)
            except Exception:
                self._logger.warning('dropping event after unexpected send error type=%s', event.get('type'), exc_info=True)
                status = _UNSENDABLE
            if status is _UNSENDABLE:
                # A bad queued body must not end the worker. Drop it and keep going.
                self._drop_unsendable(event)
                if kind == 'telemetry':
                    telemetry = None
                else:
                    pending = None
                if event.get('type') == 'heartbeat':
                    self._last_sent = time.monotonic()
                continue
            if status == 200:
                self._mark(sent=1)
                self._set_offline(False)
                self._backoff = _BACKOFF_START
                self._last_sent = time.monotonic()
                if kind == 'telemetry':
                    telemetry = None
                else:
                    pending = None
                continue
            if status == 409 or status in TERMINAL_REJECT:
                # A rejected telemetry report must not schedule another one, or a
                # receiver that always returns 409/400 would loop.
                self._mark_terminal(conflict=status == 409, report=kind != 'telemetry')
                if status == 409:
                    self._logger.warning('conflict type=%s sequence=%s', event.get('type'), event.get('sequence'))
                else:
                    self._logger.warning('rejected status=%s type=%s', status, event.get('type'))
                self._set_offline(False)
                self._backoff = _BACKOFF_START
                if kind == 'telemetry':
                    telemetry = None
                else:
                    pending = None
                if event.get('type') == 'heartbeat':
                    self._last_sent = time.monotonic()
                continue
            if status == 401:
                self._set_offline(True)
                refreshed = self._load_session(force=True)
                if refreshed is not None and refreshed['token'] != session['token']:
                    continue
                self._sleep_backoff()
                continue
            # Connection error, or a status the spec does not classify (403/404/415/503/5xx).
            self._set_offline(True)
            if status is not None:
                self._logger.warning('retrying status=%s type=%s', status, event.get('type'))
            self._sleep_backoff()
        if pending is not None:
            # close() timed out before this event was delivered.
            self._drop_unsendable(pending)

    def _pull(self):
        remaining = self.heartbeat_interval - (time.monotonic() - self._last_sent)
        if self._closed:
            timeout = 0.05
        elif remaining <= 0:
            timeout = 0
        else:
            timeout = min(remaining, 0.2)
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def _heartbeat_due(self) -> bool:
        return time.monotonic() - self._last_sent >= self.heartbeat_interval

    def _make_event(self, event_type: str, payload: dict) -> dict:
        event = {
            'schema_version': 1,
            'event_id': uuid.uuid4().hex,
            'run_id': self.run_id,
            'producer_id': self.producer_id,
            'occurred_at': _now_iso(),
            'type': event_type,
            'payload': payload,
        }
        with self._lock:
            self._sequence += 1
            event['sequence'] = self._sequence
        return event

    def _load_session(self, force: bool = False) -> Optional[dict]:
        try:
            mtime = os.stat(self.session_file).st_mtime_ns
        except OSError:
            mtime = None
        if not force and mtime == self._session_mtime:
            return self._session
        self._session_mtime = mtime
        self._session = _read_session(self.session_file) if mtime is not None else None
        return self._session

    def _drop_unsendable(self, event: dict) -> None:
        with self._lock:
            self._stats['dropped'] += 1
        self._logger.warning('dropped unsendable type=%s sequence=%s', event.get('type'), event.get('sequence'))

    def _post(self, session: dict, event: dict):
        body = event.get('body')
        if not isinstance(body, bytes):
            try:
                body = _snapshot_event(event)
            except (TypeError, ValueError, RecursionError):
                return _UNSENDABLE
        request = urllib.request.Request(
            session['url'] + '/events',
            data=body,
            method='POST',
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session['token'],
            },
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                # Only the HTTP status is used. Reading an unbounded or stalled
                # response body would delay the queue and could exhaust memory.
                return response.getcode()
        except urllib.error.HTTPError as exc:
            try:
                exc.close()
            except Exception:
                pass
            return exc.code
        except Exception:
            return None

    def _mark(self, **delta: int) -> None:
        with self._lock:
            for key, value in delta.items():
                self._stats[key] += value

    def _mark_terminal(self, *, conflict: bool, report: bool) -> None:
        with self._lock:
            self._stats['dropped'] += 1
            self._stats['conflicts' if conflict else 'rejected'] += 1
            if report:
                self._unreported += 1

    def _set_offline(self, offline: bool) -> None:
        with self._lock:
            self._offline = offline

    def _reserve_unreported(self) -> int:
        with self._lock:
            count = self._unreported
            if count <= 0:
                return 0
            self._unreported = 0
            return count

    def _sleep_backoff(self) -> None:
        delay = 0.05 if self._closed else self._backoff
        end = time.monotonic() + delay
        while time.monotonic() < end:
            if self._stop.is_set():
                return
            self._wake.wait(min(0.05, end - time.monotonic()))
        if not self._closed:
            self._backoff = min(self._backoff * 2, _BACKOFF_MAX)

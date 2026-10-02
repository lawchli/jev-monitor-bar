"""Data-directory rules shared with src/paths.ts.

`win32` uses `ntpath`; every other platform uses `posixpath`, so the same cases
run on any host. Results are `normpath`'d, which matches the Node helper that
strips a trailing separator.
"""

from __future__ import annotations

import ntpath
import os
import posixpath
import sys
from pathlib import Path
from typing import Mapping, Optional

APP_DIR = 'jev-monitor-bar'


def resolve_paths(
    platform: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    homedir: Optional[str] = None,
    cwd: Optional[str] = None,
) -> dict:
    """Return home, events_dir, session_file, and window_state_file.

    The current directory is read only for a relative override. A deleted
    current directory then raises `FileNotFoundError`; other inputs do not
    depend on it.
    """
    system = sys.platform if platform is None else platform
    values: Mapping[str, str] = os.environ if env is None else env
    home_dir = str(Path.home()) if homedir is None else homedir
    path_api = ntpath if system == 'win32' else posixpath
    home = _resolve_home(path_api, system, values, home_dir, cwd)
    session_override = values.get('JEV_MONITOR_SESSION')
    if _nonempty(session_override):
        session_file = _resolve_input(path_api, cwd, session_override)
    else:
        session_file = path_api.normpath(path_api.join(home, 'session.json'))
    return {
        'home': home,
        'events_dir': path_api.normpath(path_api.join(home, 'events')),
        'session_file': session_file,
        'window_state_file': path_api.normpath(path_api.join(home, 'window-state.json')),
    }


def resolve_session_file(
    platform: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    homedir: Optional[str] = None,
    cwd: Optional[str] = None,
) -> str:
    """Resolve only the sender's session path.

    An explicit session override is independent of the data home. Resolving
    the full path set still requires a valid cwd for a relative home.
    """
    system = sys.platform if platform is None else platform
    values: Mapping[str, str] = os.environ if env is None else env
    override = values.get('JEV_MONITOR_SESSION')
    if _nonempty(override):
        path_api = ntpath if system == 'win32' else posixpath
        return _resolve_input(path_api, cwd, override)
    return resolve_paths(platform=system, env=values, homedir=homedir, cwd=cwd)['session_file']


def _nonempty(value: Optional[str]) -> bool:
    return bool(value)


def _resolve_input(path_api, cwd: Optional[str], value: str) -> str:
    if path_api.isabs(value):
        return path_api.normpath(value)
    base = os.getcwd() if cwd is None else cwd
    return path_api.normpath(path_api.join(base, value))


def _resolve_home(path_api, system: str, env: Mapping[str, str], homedir: str, cwd: Optional[str]) -> str:
    override = env.get('JEV_MONITOR_HOME')
    if _nonempty(override):
        return _resolve_input(path_api, cwd, override)
    # Windows：未实机验证
    if system == 'win32':
        local_app_data = env.get('LOCALAPPDATA')
        if _nonempty(local_app_data):
            return path_api.normpath(path_api.join(local_app_data, APP_DIR))
        return path_api.normpath(path_api.join(homedir, 'AppData', 'Local', APP_DIR))
    # macOS：未实机验证
    if system == 'darwin':
        return path_api.normpath(path_api.join(homedir, 'Library', 'Application Support', APP_DIR))
    # Linux 及其他：未实机验证。XDG_STATE_HOME 只在非空绝对路径时采用。
    state_home = env.get('XDG_STATE_HOME')
    if _nonempty(state_home) and path_api.isabs(state_home):
        return path_api.normpath(path_api.join(state_home, APP_DIR))
    return path_api.normpath(path_api.join(homedir, '.local', 'state', APP_DIR))

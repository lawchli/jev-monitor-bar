"""Stdlib client for the local JEV monitor receiver."""

from .paths import resolve_paths
from .sender import MonitorSender

__all__ = ['MonitorSender', 'resolve_paths']

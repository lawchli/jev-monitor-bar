import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {WindowMode} from '../ipc';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState {
  version: 1;
  mode: WindowMode;
  pinned: boolean;
  bounds: {compact: Rect; expanded: Rect};
  displayId?: number;
  scaleFactor?: number;
}

export interface DisplayWorkArea {
  id: number;
  workArea: Rect;
  scaleFactor: number;
}

const TOP_STRIP_PX = 32;
const MIN_HORIZONTAL_OVERLAP_PX = 64;
const RENAME_RETRIES = 5;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function defaultWindowState(
  bounds: {compact: Rect; expanded: Rect} = {
    compact: {x: 0, y: 0, width: 400, height: 132},
    expanded: {x: 0, y: 0, width: 440, height: 640},
  },
): SavedWindowState {
  return {
    version: 1,
    mode: 'compact',
    pinned: true,
    bounds: {
      compact: {x: bounds.compact.x, y: bounds.compact.y, width: bounds.compact.width, height: bounds.compact.height},
      expanded: {
        x: bounds.expanded.x,
        y: bounds.expanded.y,
        width: bounds.expanded.width,
        height: bounds.expanded.height,
      },
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRect(value: unknown): Rect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rect = value as Rect;
  if (![rect.x, rect.y, rect.width, rect.height].every(isFiniteNumber)) return undefined;
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function parseWindowState(value: unknown): SavedWindowState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as SavedWindowState;
  if (state.version !== 1) return undefined;
  if (state.mode !== 'compact' && state.mode !== 'expanded') return undefined;
  if (typeof state.pinned !== 'boolean') return undefined;
  const compact = parseRect(state.bounds?.compact);
  const expanded = parseRect(state.bounds?.expanded);
  if (!compact || !expanded) return undefined;
  if (state.displayId !== undefined && !isFiniteNumber(state.displayId)) return undefined;
  if (state.scaleFactor !== undefined && !isFiniteNumber(state.scaleFactor)) return undefined;
  const parsed: SavedWindowState = {version: 1, mode: state.mode, pinned: state.pinned, bounds: {compact, expanded}};
  if (state.displayId !== undefined) parsed.displayId = state.displayId;
  if (state.scaleFactor !== undefined) parsed.scaleFactor = state.scaleFactor;
  return parsed;
}

export function loadWindowState(file: string): SavedWindowState | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseWindowState(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return '';
}

function sleepMs(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/** Atomic replace. Rename retries match the session file writer: 5 times, wait 20×n ms before attempt n. */
export function saveWindowState(file: string, state: SavedWindowState): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, {mode: 0o600});
  for (let attempt = 0; attempt <= RENAME_RETRIES; attempt += 1) {
    if (attempt > 0) sleepMs(20 * attempt);
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (error) {
      if (!RETRYABLE.has(errnoCode(error)) || attempt === RENAME_RETRIES) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // The temp file may already be gone.
        }
        throw error;
      }
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is meaningless on Windows and must not fail the save.
  }
}

function overlap(a: Rect, b: Rect): {x: number; y: number} {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function clampInside(rect: Rect, area: Rect): Rect {
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, Math.min(rect.width, area.width, right - rect.x)),
    height: Math.max(0, Math.min(rect.height, area.height, bottom - rect.y)),
  };
}

function centerIn(rect: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(0, rect.width), area.width);
  const height = Math.min(Math.max(0, rect.height), area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Keep a window whose top 32px strip still meets a work area (64px across, any vertical overlap).
 * Otherwise center it on the primary work area. Coordinates stay in DIP; scaleFactor is ignored.
 */
export function fitToDisplays(rect: Rect, displays: DisplayWorkArea[], primaryId: number): Rect {
  const strip: Rect = {x: rect.x, y: rect.y, width: rect.width, height: Math.min(TOP_STRIP_PX, rect.height)};
  let match: DisplayWorkArea | undefined;
  let best = 0;
  for (const display of displays) {
    const hit = overlap(strip, display.workArea);
    if (hit.y > 0 && hit.x >= MIN_HORIZONTAL_OVERLAP_PX && hit.x > best) {
      match = display;
      best = hit.x;
    }
  }
  if (match) return clampInside(rect, match.workArea);
  const primary = displays.find(display => display.id === primaryId) ?? displays[0];
  if (!primary) return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  return centerIn(rect, primary.workArea);
}

/** Store the live bounds under the current mode, then switch. The other mode's rect is left as it was. */
export function switchMode(state: SavedWindowState, next: WindowMode, currentBounds: Rect): SavedWindowState {
  return {
    ...state,
    mode: next,
    bounds: {
      ...state.bounds,
      [state.mode]: {x: currentBounds.x, y: currentBounds.y, width: currentBounds.width, height: currentBounds.height},
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';

// The renderer has its own origin instead of file:// (AUDIT L2). CSP 'self' now matches app://renderer only.
// This module does not import electron so tests can load it; src/main/index.ts wires it to `protocol`.
export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'renderer';
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;
export const RENDERER_URL = `${RENDERER_ORIGIN}/index.html`;

/** Relative URLs need `standard`; no CSP bypass, fetch API, service workers or streaming privileges. */
export const RENDERER_SCHEME_PRIVILEGES = Object.freeze({standard: true, secure: true});

/** The complete renderer build output, including development-only source maps. No arbitrary local paths. */
const RENDERER_FILES: Readonly<Record<string, string>> = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'app.js.map': 'application/json; charset=utf-8',
  'app.css.map': 'application/json; charset=utf-8',
});

type PathApi = Pick<typeof path, 'join' | 'relative' | 'isAbsolute' | 'sep'>;

export interface RendererFile {
  file: string;
  mimeType: string;
}

/** `pathApi` lets tests check Windows path semantics on any host. Query and fragment do not change the file. */
export function resolveRendererFile(
  root: string,
  requestUrl: string,
  pathApi: PathApi = path,
): RendererFile | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST || url.username || url.password) {
    return undefined;
  }
  const name = url.pathname.slice(1);
  if (!url.pathname.startsWith('/') || !Object.hasOwn(RENDERER_FILES, name)) return undefined;
  return {file: pathApi.join(root, name), mimeType: RENDERER_FILES[name]};
}

export type ReadRendererFile = (file: string) => Promise<Uint8Array<ArrayBuffer>>;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}

function diskReader(root: string): ReadRendererFile {
  return async file => {
    // Even an allowlisted file in an unpacked development build may be a symlink. Node fs also resolves ASAR paths.
    const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
    if (!inside(realRoot, realFile)) throw new Error('Renderer file escapes its directory');
    return new Uint8Array(await fs.promises.readFile(realFile));
  };
}

function empty(status: number): Response {
  return new Response(null, {
    status,
    headers: {'x-content-type-options': 'nosniff', ...(status === 405 ? {allow: 'GET, HEAD'} : {})},
  });
}

/**
 * Handler for `protocol.handle`. Node fs in the main process reads inside app.asar without using file://,
 * so release packages can disable GrantFileProtocolExtraPrivileges.
 */
export function createRendererHandler(root: string, read: ReadRendererFile = diskReader(root)) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405);
    const target = resolveRendererFile(root, request.url);
    if (!target) return empty(404);
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await read(target.file);
    } catch {
      return empty(404);
    }
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {'content-type': target.mimeType, 'x-content-type-options': 'nosniff'},
    });
  };
}

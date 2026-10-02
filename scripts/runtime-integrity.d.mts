import type {Buffer} from 'node:buffer';

export function supportsAsarIntegrity(platform: string): boolean;
export function harmlessMainTamper(source: Buffer): {offset: number; before: number; after: number};
export function integrityRejected(result: {
  exited: object | null | undefined;
  started: boolean;
  output: string;
}): boolean;

import type { MediaKind } from '@bilhanah/contracts';
import sharp from 'sharp';

/** Rendition widths per kind; renditions wider than the upload are skipped. */
export const RENDITION_WIDTHS: Record<MediaKind, number[]> = {
  LOGO: [128, 256, 512],
  ITEM: [320, 640, 1280],
  COVER: [640, 1280, 1920],
  // One rendition, large enough to read a transfer receipt.
  PAYMENT_PROOF: [1600],
  // Diners' review photos: a thumbnail and a full view.
  REVIEW: [320, 640, 1280],
};

// About 8000 x 5000; larger inputs are rejected before decoding (decompression bombs).
const MAX_INPUT_PIXELS = 40_000_000;

/** JPEG, PNG or WebP, identified from the file's first bytes rather than its name or declared type. */
export function sniffImageType(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

export type Rendition = { width: number; height: number; data: Buffer };

export type ProcessedImage = { width: number; height: number; renditions: Rendition[] };

/** The widths to render: every target narrower than the upload, plus the upload's own width when it is smaller than the largest target. */
export function renditionWidths(kind: MediaKind, sourceWidth: number): number[] {
  const targets = RENDITION_WIDTHS[kind];
  const widths = targets.filter((width) => width < sourceWidth);
  if (sourceWidth <= targets.at(-1)!) widths.push(sourceWidth);
  return widths;
}

/**
 * Applies EXIF orientation, then writes WebP renditions. Output carries no
 * metadata, so camera details and GPS location are dropped. Throws for
 * files that cannot be decoded.
 */
export async function processImage(input: Buffer, kind: MediaKind): Promise<ProcessedImage> {
  const source = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions');
  // EXIF orientations 5-8 rotate by 90 degrees.
  const quarterTurn = (metadata.orientation ?? 1) >= 5;
  const width = quarterTurn ? metadata.height : metadata.width;
  const height = quarterTurn ? metadata.width : metadata.height;

  const renditions = await Promise.all(
    renditionWidths(kind, width).map(async (target) => {
      const { data, info } = await source
        .clone()
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data };
    }),
  );
  return { width, height, renditions };
}

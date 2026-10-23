import { z } from 'zod';

export const MEDIA_ERROR_CODES = {
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  IMAGE_TOO_SMALL: 'IMAGE_TOO_SMALL',
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
} as const;

/** Upload limit for a single image. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
/** Images narrower or shorter than this are rejected as unusable. */
export const MEDIA_MIN_DIMENSION = 200;
export const MEDIA_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const mediaKindSchema = z.enum(['LOGO', 'COVER', 'ITEM', 'PAYMENT_PROOF']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const uploadMediaQuerySchema = z.strictObject({ kind: mediaKindSchema });

/** A processed image: WebP renditions to use in `srcset`, smallest first. */
export type ImageSet = {
  id: string;
  width: number;
  height: number;
  sources: { width: number; url: string }[];
  /** The largest rendition. */
  url: string;
};

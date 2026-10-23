import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type ImageSet,
  MEDIA_ERROR_CODES,
  MEDIA_MIN_DIMENSION,
  type MediaKind,
  RESTAURANT_ERROR_CODES,
} from '@bilhanah/contracts';
import type { Media } from '@bilhanah/database';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { processImage, sniffImageType } from './image-processing.js';

const unsupported = () =>
  new BadRequestException({
    code: MEDIA_ERROR_CODES.UNSUPPORTED_IMAGE,
    message: 'Upload a JPEG, PNG or WebP image.',
  });

export const mediaNotFound = () =>
  new NotFoundException({ code: MEDIA_ERROR_CODES.MEDIA_NOT_FOUND, message: 'Image not found.' });

/** Uploaded images. Each belongs to one restaurant and is only usable for its kind. */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async upload(ownerId: string, kind: MediaKind, file: Buffer | undefined): Promise<ImageSet> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      select: { id: true, status: true },
    });
    if (!restaurant) {
      throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    }
    if (restaurant.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: RESTAURANT_ERROR_CODES.RESTAURANT_SUSPENDED,
        message: 'This restaurant is suspended. Please contact Bilhanah support.',
      });
    }
    if (!file?.length || !sniffImageType(file)) throw unsupported();

    let processed;
    try {
      processed = await processImage(file, kind);
    } catch {
      throw unsupported();
    }
    if (processed.width < MEDIA_MIN_DIMENSION || processed.height < MEDIA_MIN_DIMENSION) {
      throw new BadRequestException({
        code: MEDIA_ERROR_CODES.IMAGE_TOO_SMALL,
        message: `Use an image at least ${MEDIA_MIN_DIMENSION} pixels wide and tall.`,
      });
    }

    const id = randomUUID();
    const storageKey = `restaurants/${restaurant.id}/media/${id}`;
    await Promise.all(
      processed.renditions.map((rendition) =>
        this.storage.put(`${storageKey}/${rendition.width}.webp`, rendition.data, 'image/webp'),
      ),
    );
    try {
      const media = await this.prisma.media.create({
        data: {
          id,
          restaurantId: restaurant.id,
          kind,
          storageKey,
          width: processed.width,
          height: processed.height,
          variantWidths: processed.renditions.map((rendition) => rendition.width),
          bytes: processed.renditions.reduce((sum, rendition) => sum + rendition.data.length, 0),
        },
      });
      return this.toImageSet(media);
    } catch (error) {
      await this.storage.deletePrefix(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /** Checks that `mediaId` is an image of `kind` uploaded for this restaurant. */
  async assertUsable(restaurantId: string, mediaId: string, kind: MediaKind): Promise<void> {
    const media = await this.prisma.media.findFirst({ where: { id: mediaId, restaurantId, kind }, select: { id: true } });
    if (!media) throw mediaNotFound();
  }

  toImageSet(media: Pick<Media, 'id' | 'storageKey' | 'width' | 'height' | 'variantWidths'>): ImageSet {
    const sources = media.variantWidths.map((width) => ({
      width,
      url: this.storage.publicUrl(`${media.storageKey}/${width}.webp`),
    }));
    return { id: media.id, width: media.width, height: media.height, sources, url: sources.at(-1)?.url ?? '' };
  }

  /** Deletes images no longer used by any restaurant or menu item, once they are older than `olderThan`. */
  async purgeUnused(olderThan: Date): Promise<number> {
    const unused = await this.prisma.media.findMany({
      where: { createdAt: { lt: olderThan }, logoFor: { none: {} }, coverFor: { none: {} }, menuItems: { none: {} } },
      select: { id: true, storageKey: true },
      take: 500,
    });
    for (const media of unused) {
      try {
        await this.storage.deletePrefix(media.storageKey);
        await this.prisma.media.delete({ where: { id: media.id } });
      } catch (error) {
        this.logger.warn({ err: error, mediaId: media.id }, 'Could not delete unused image');
      }
    }
    return unused.length;
  }
}

import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SUPPORT_ERROR_CODES, type TicketAttachment } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { PRIVATE_PREFIX, StorageService } from '../../../infrastructure/storage/storage.service.js';
import { processImage, sniffImageType } from '../../media/image-processing.js';

export const attachmentNotFound = () =>
  new NotFoundException({ code: SUPPORT_ERROR_CODES.ATTACHMENT_NOT_FOUND, message: 'Attachment not found.' });
const unsupported = () =>
  new BadRequestException({ code: SUPPORT_ERROR_CODES.ATTACHMENT_UNSUPPORTED, message: 'Attach a JPEG, PNG or WebP image.' });

/** Who reads an attachment: a restaurant user (only their restaurant's, never on internal notes) or an agent. */
export type AttachmentReader = { userId: string; restaurantId: string | null; agent: boolean };

/**
 * Screenshots on tickets. Uploads are checked by their bytes, re-encoded as WebP (dropping metadata),
 * stored privately and streamed only to whoever may see the ticket. An upload is linked to a ticket or a
 * reply when it is sent; unlinked ones are purged after a day.
 */
@Injectable()
export class SupportAttachmentsService {
  private readonly logger = new Logger(SupportAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async upload(uploader: { userId: string; restaurantId: string | null }, file: { buffer: Buffer; originalname?: string } | undefined, urlBase: string): Promise<TicketAttachment> {
    if (!file?.buffer.length || !sniffImageType(file.buffer)) throw unsupported();
    let processed;
    try {
      processed = await processImage(file.buffer, 'PAYMENT_PROOF');
    } catch {
      throw unsupported();
    }
    const rendition = processed.renditions.at(-1)!;
    const id = randomUUID();
    const storageKey = `${PRIVATE_PREFIX}/support/${id}`;
    await this.storage.put(`${storageKey}/image.webp`, rendition.data, 'image/webp');
    const fileName = (file.originalname ?? 'image').replace(/[^\p{L}\p{N}._ -]+/gu, '').slice(0, 80).replace(/\.[^.]*$/, '') || 'image';
    try {
      const row = await this.prisma.supportAttachment.create({
        data: {
          id, uploaderId: uploader.userId, restaurantId: uploader.restaurantId, storageKey, fileName: `${fileName}.webp`,
          contentType: 'image/webp', bytes: rendition.data.length, width: rendition.width, height: rendition.height,
        },
      });
      return this.toAttachment(row, urlBase);
    } catch (error) {
      await this.storage.deletePrefix(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /** Links the uploader's own, not yet linked uploads to a ticket (and reply). */
  async claim(tx: Prisma.TransactionClient, uploaderId: string, ids: string[], ticketId: string, messageId: string | null): Promise<void> {
    if (!ids.length) return;
    const result = await tx.supportAttachment.updateMany({ where: { id: { in: ids }, uploaderId, ticketId: null }, data: { ticketId, messageId } });
    if (result.count !== ids.length) throw attachmentNotFound();
  }

  async read(id: string, reader: AttachmentReader): Promise<{ data: Buffer; contentType: string; fileName: string }> {
    const row = await this.prisma.supportAttachment.findUnique({ where: { id }, include: { ticket: { select: { restaurantId: true } }, message: { select: { internal: true } } } });
    if (!row) throw attachmentNotFound();
    const allowed = reader.agent
      || row.uploaderId === reader.userId
      || (row.ticket !== null && row.ticket.restaurantId === reader.restaurantId && !row.message?.internal);
    if (!allowed) throw attachmentNotFound();
    const data = await this.storage.get(`${row.storageKey}/image.webp`);
    if (!data) throw attachmentNotFound();
    return { data, contentType: row.contentType, fileName: row.fileName };
  }

  /** Uploads never sent with a ticket or reply. */
  async purgeUnlinked(olderThan: Date): Promise<number> {
    const rows = await this.prisma.supportAttachment.findMany({ where: { ticketId: null, createdAt: { lt: olderThan } }, select: { id: true, storageKey: true }, take: 500 });
    for (const row of rows) {
      try {
        await this.storage.deletePrefix(row.storageKey);
        await this.prisma.supportAttachment.delete({ where: { id: row.id } });
      } catch (error) {
        this.logger.warn({ err: error, attachmentId: row.id }, 'Could not delete an unlinked support attachment');
      }
    }
    return rows.length;
  }

  toAttachment(row: Pick<Prisma.SupportAttachmentGetPayload<object>, 'id' | 'fileName' | 'contentType' | 'bytes' | 'width' | 'height'>, urlBase: string): TicketAttachment {
    return { id: row.id, fileName: row.fileName, contentType: row.contentType, bytes: row.bytes, width: row.width, height: row.height, url: `${urlBase}/${row.id}` };
  }
}

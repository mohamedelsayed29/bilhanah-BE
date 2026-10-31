import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type bulkCreateTablesSchema,
  type createTableSchema,
  normalizeSubdomain,
  ORDER_ERROR_CODES,
  ORDER_LIMITS,
  type PublicTable,
  RESTAURANT_ERROR_CODES,
  type RestaurantTable,
  type updateTableSchema,
} from '@bilhanah/contracts';
import type { Table } from '@bilhanah/database';
import type { z } from 'zod';
import type { Env } from '../../config/env.schema.js';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const tableNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_NOT_FOUND, message: 'Table not found.' });
const labelTaken = () =>
  new ConflictException({ code: ORDER_ERROR_CODES.TABLE_LABEL_TAKEN, message: 'Another table already has this name.' });

/** 64 random bits, URL-safe; printed in the table's QR code. */
const newPublicCode = () => randomBytes(8).toString('base64url');

/** Dining tables and their QR codes. Owner operations are scoped to the caller's restaurant. */
@Injectable()
export class TablesService {
  private readonly urlTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTemplate = config.get('RESTAURANT_URL_TEMPLATE', { infer: true });
  }

  async list(ownerId: string): Promise<RestaurantTable[]> {
    const restaurant = await this.restaurantFor(ownerId);
    const tables = await this.prisma.table.findMany({ where: { restaurantId: restaurant.id }, orderBy: { sortOrder: 'asc' } });
    return tables.map((table) => this.toView(table, restaurant.subdomain));
  }

  async create(ownerId: string, input: z.output<typeof createTableSchema>): Promise<RestaurantTable> {
    const restaurant = await this.restaurantFor(ownerId);
    const { _count, _max } = await this.prisma.table.aggregate({ where: { restaurantId: restaurant.id }, _count: true, _max: { sortOrder: true } });
    if (_count >= ORDER_LIMITS.tables) throw this.limitReached();
    try {
      const table = await this.prisma.table.create({
        data: { restaurantId: restaurant.id, ...input, publicCode: newPublicCode(), sortOrder: (_max.sortOrder ?? -1) + 1 },
      });
      return this.toView(table, restaurant.subdomain);
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
  }

  /** Creates {prefix}{from} ... {prefix}{to}, all of one shape and size; labels that already exist are skipped. */
  async createRange(ownerId: string, input: z.output<typeof bulkCreateTablesSchema>): Promise<RestaurantTable[]> {
    const restaurant = await this.restaurantFor(ownerId);
    const existing = await this.prisma.table.findMany({ where: { restaurantId: restaurant.id }, select: { label: true, sortOrder: true } });
    const taken = new Set(existing.map((table) => table.label));
    // "Table" + 5 → "Table 5" and "طاولة" + 5 → "طاولة 5"; "T-" + 5 → "T-5".
    const separator = /[\p{L}\p{N}]$/u.test(input.prefix) ? ' ' : '';
    const labels = Array.from({ length: input.to - input.from + 1 }, (_, index) => `${input.prefix}${separator}${input.from + index}`).filter(
      (label) => !taken.has(label),
    );
    if (existing.length + labels.length > ORDER_LIMITS.tables) throw this.limitReached();
    const start = Math.max(-1, ...existing.map((table) => table.sortOrder)) + 1;
    await this.prisma.table.createMany({
      data: labels.map((label, index) => ({
        restaurantId: restaurant.id,
        label,
        shape: input.shape,
        seats: input.seats,
        publicCode: newPublicCode(),
        sortOrder: start + index,
      })),
      skipDuplicates: true,
    });
    return this.list(ownerId);
  }

  async update(ownerId: string, tableId: string, input: z.output<typeof updateTableSchema>): Promise<RestaurantTable> {
    const restaurant = await this.restaurantFor(ownerId);
    try {
      const updated = await this.prisma.table.updateMany({ where: { id: tableId, restaurantId: restaurant.id }, data: input });
      if (updated.count === 0) throw tableNotFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw labelTaken();
      throw error;
    }
    return this.toView(await this.prisma.table.findUniqueOrThrow({ where: { id: tableId } }), restaurant.subdomain);
  }

  /** Past orders keep the table's name. */
  async remove(ownerId: string, tableId: string): Promise<void> {
    const restaurant = await this.restaurantFor(ownerId);
    const deleted = await this.prisma.table.deleteMany({ where: { id: tableId, restaurantId: restaurant.id } });
    if (deleted.count === 0) throw tableNotFound();
  }

  /** A new QR code for the table; codes already printed stop working. */
  async regenerateCode(ownerId: string, tableId: string): Promise<RestaurantTable> {
    const restaurant = await this.restaurantFor(ownerId);
    const updated = await this.prisma.table.updateMany({ where: { id: tableId, restaurantId: restaurant.id }, data: { publicCode: newPublicCode() } });
    if (updated.count === 0) throw tableNotFound();
    return this.toView(await this.prisma.table.findUniqueOrThrow({ where: { id: tableId } }), restaurant.subdomain);
  }

  /** The table a diner scanned, so the menu can show "Table 5". */
  async findPublic(rawSubdomain: string, code: string): Promise<PublicTable> {
    const table = await this.prisma.table.findFirst({
      where: { publicCode: code, isActive: true, restaurant: { subdomain: normalizeSubdomain(rawSubdomain) } },
      select: { label: true },
    });
    if (!table) throw tableNotFound();
    return table;
  }

  private toView(table: Table, subdomain: string): RestaurantTable {
    return {
      id: table.id,
      label: table.label,
      shape: table.shape,
      seats: table.seats,
      publicCode: table.publicCode,
      isActive: table.isActive,
      qrUrl: `${this.urlTemplate.replace('{subdomain}', subdomain)}/?t=${table.publicCode}`,
      createdAt: table.createdAt.toISOString(),
    };
  }

  private limitReached() {
    return new ConflictException({
      code: ORDER_ERROR_CODES.TABLE_LIMIT_REACHED,
      message: `A restaurant can have at most ${ORDER_LIMITS.tables} tables.`,
      details: { limit: ORDER_LIMITS.tables },
    });
  }

  private async restaurantFor(ownerId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId }, select: { id: true, subdomain: true } });
    if (!restaurant) {
      throw new NotFoundException({ code: RESTAURANT_ERROR_CODES.RESTAURANT_NOT_FOUND, message: 'Restaurant not found.' });
    }
    return restaurant;
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type createTableAreaSchema,
  type deleteTableAreaQuerySchema,
  ORDER_ERROR_CODES,
  ORDER_LIMITS,
  TABLE_OCCUPANCY_HOURS,
  type TableArea,
  type updateTableAreaSchema,
} from '@bilhanah/contracts';
import type { TableArea as TableAreaRow } from '@bilhanah/database';
import type { z } from 'zod';
import { isUniqueViolation } from '../../infrastructure/database/prisma-errors.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { BranchScopeService } from '../branches/branch-scope.service.js';

export const tableAreaNotFound = () => new NotFoundException({ code: ORDER_ERROR_CODES.TABLE_AREA_NOT_FOUND, message: 'Table area not found.' });
const nameTaken = () => new ConflictException({ code: ORDER_ERROR_CODES.TABLE_AREA_NAME_TAKEN, message: 'Another area already has this name.' });

/**
 * Seating areas of a branch (Main hall, Garden, Rooftop, VIP). Each is indoor or outdoor, and its
 * tables take that location. Owners manage every branch's areas, managers their own branch's.
 */
@Injectable()
export class TableAreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BranchScopeService,
  ) {}

  /** One branch's areas, or every area the caller may see when no branch is given. */
  async list(userId: string, branchId?: string, now = new Date()): Promise<TableArea[]> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope, branchId);
    const areas = await this.prisma.tableArea.findMany({ where, orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }] });
    return this.toViews(areas, now);
  }

  async create(userId: string, input: z.output<typeof createTableAreaSchema>): Promise<TableArea> {
    const scope = await this.scopes.resolve(userId);
    const branch = await this.scopes.branch(scope, input.branchId);
    const { _count, _max } = await this.prisma.tableArea.aggregate({ where: { branchId: branch.id }, _count: true, _max: { sortOrder: true } });
    if (_count >= ORDER_LIMITS.tableAreas) {
      throw new ConflictException({
        code: ORDER_ERROR_CODES.TABLE_AREA_LIMIT_REACHED,
        message: `A branch can have at most ${ORDER_LIMITS.tableAreas} areas.`,
        details: { limit: ORDER_LIMITS.tableAreas },
      });
    }
    try {
      const area = await this.prisma.tableArea.create({
        data: {
          restaurantId: scope.restaurant.id,
          branchId: branch.id,
          name: input.name,
          location: input.location,
          theme: input.theme ?? (input.location === 'OUTDOOR' ? 'TERRACE' : 'HALL'),
          sortOrder: (_max.sortOrder ?? -1) + 1,
        },
      });
      return (await this.toViews([area]))[0]!;
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** A new location moves every table in the area with it. */
  async update(userId: string, areaId: string, input: z.output<typeof updateTableAreaSchema>): Promise<TableArea> {
    const area = await this.find(userId, areaId);
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.tableArea.update({ where: { id: area.id }, data: input });
        if (input.location) await tx.table.updateMany({ where: { areaId: area.id }, data: { location: input.location } });
        return row;
      });
      return (await this.toViews([updated]))[0]!;
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /**
   * Deletes the area. While it has tables the caller must say where they go: another area of the
   * same branch (they take its location) or "none" (they keep theirs). Their orders stay with them.
   */
  async remove(userId: string, areaId: string, input: z.output<typeof deleteTableAreaQuerySchema>, now = new Date()): Promise<void> {
    const area = await this.find(userId, areaId);
    const target = input.moveTo && input.moveTo !== 'none'
      ? await this.prisma.tableArea.findFirst({ where: { id: input.moveTo, branchId: area.branchId, NOT: { id: area.id } } })
      : null;
    if (input.moveTo && input.moveTo !== 'none' && !target) throw tableAreaNotFound();
    await this.prisma.$transaction(async (tx) => {
      const tables = await tx.table.findMany({ where: { areaId: area.id }, select: { id: true } });
      if (tables.length > 0 && !input.moveTo) {
        const activeOrders = await tx.order.count({ where: this.activeOrdersWhere(tables.map((table) => table.id), now) });
        throw new ConflictException({
          code: ORDER_ERROR_CODES.TABLE_AREA_NOT_EMPTY,
          message: 'Move the tables of this area to another area, or out of any area, before deleting it.',
          details: { tables: tables.length, activeOrders },
        });
      }
      if (tables.length > 0) {
        await tx.table.updateMany({
          where: { areaId: area.id },
          data: target ? { areaId: target.id, location: target.location } : { areaId: null },
        });
      }
      await tx.tableArea.delete({ where: { id: area.id } });
    });
  }

  /** An area the caller may change. */
  private async find(userId: string, areaId: string): Promise<TableAreaRow> {
    const scope = await this.scopes.resolve(userId);
    const where = await this.scopes.branchWhere(scope);
    const area = await this.prisma.tableArea.findFirst({ where: { id: areaId, ...where } });
    if (!area) throw tableAreaNotFound();
    return area;
  }

  /** Unpaid dine-in orders on these tables, as the floor plan counts them. */
  private activeOrdersWhere(tableIds: string[], now: Date) {
    return {
      tableId: { in: tableIds },
      type: 'DINE_IN' as const,
      paidAt: null,
      status: { notIn: ['REJECTED' as const, 'CANCELLED' as const] },
      placedAt: { gte: new Date(now.getTime() - TABLE_OCCUPANCY_HOURS * 60 * 60 * 1000) },
    };
  }

  private async toViews(areas: TableAreaRow[], now = new Date()): Promise<TableArea[]> {
    if (areas.length === 0) return [];
    const ids = areas.map((area) => area.id);
    const tables = await this.prisma.table.findMany({ where: { areaId: { in: ids } }, select: { id: true, areaId: true } });
    const open = tables.length
      ? await this.prisma.order.findMany({ where: this.activeOrdersWhere(tables.map((table) => table.id), now), select: { tableId: true } })
      : [];
    const areaOf = new Map(tables.map((table) => [table.id, table.areaId]));
    return areas.map((area) => ({
      id: area.id,
      branchId: area.branchId,
      name: area.name,
      location: area.location,
      theme: area.theme,
      tableCount: tables.filter((table) => table.areaId === area.id).length,
      activeOrders: open.filter((order) => order.tableId && areaOf.get(order.tableId) === area.id).length,
      createdAt: area.createdAt.toISOString(),
    }));
  }
}

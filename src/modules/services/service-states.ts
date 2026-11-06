import { ALL_SERVICES_ON, type ServiceStates } from '@bilhanah/contracts';
import type { Prisma } from '@bilhanah/database';

type Db = Pick<Prisma.TransactionClient, 'restaurantService'>;

/** Which services the restaurant has on; a service it never chose is on. */
export async function readServiceStates(db: Db, restaurantId: string): Promise<ServiceStates> {
  const rows = await db.restaurantService.findMany({ where: { restaurantId }, select: { service: true, enabled: true } });
  const states: ServiceStates = { ...ALL_SERVICES_ON };
  for (const row of rows) states[row.service] = row.enabled;
  return states;
}

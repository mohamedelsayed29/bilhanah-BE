import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, signUpOwner, DASHBOARD_ORIGIN, type TestApp } from './test-app.js';
import { reportQuerySchema } from '@bilhanah/contracts';
import { csvReport } from '../src/modules/reports/report-template.js';

let t:TestApp;
const http=()=>request(t.app.getHttpServer());
const auth=(token:string)=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{t=await createTestApp();});
afterAll(async()=>{await t.app.close();});
beforeEach(async()=>{await t.reset();});
async function fixture(email='owner@reports.test',subdomain='reports-demo') {
  const token=await signUpOwner(t,email);
  await http().post('/v1/restaurants').set(auth(token)).send({name:'مطعم بالهنا',contactName:'Ali',phone:'01012345678',city:'Cairo',address:'Test address',subdomain}).expect(201);
  const r=await t.prisma.restaurant.findUniqueOrThrow({where:{subdomain}});
  const b=await t.prisma.branch.findFirstOrThrow({where:{restaurantId:r.id}});
  const c=await t.prisma.category.create({data:{restaurantId:r.id,nameAr:'رئيسي',nameEn:'Main',sortOrder:0}});
  const item=await t.prisma.menuItem.create({data:{restaurantId:r.id,categoryId:c.id,nameAr:'=صيغة ضارة',nameEn:'Koshary',sortOrder:0}});
  const add=(number:number,status:'COMPLETED'|'CANCELLED'|'REJECTED'|'ACCEPTED',branchId=b.id,day='2026-11-01')=>t.prisma.order.create({data:{restaurantId:r.id,branchId,number,businessDay:new Date(day),status,type:'PICKUP',customerName:'Guest',subtotalPiastres:10000,totalPiastres:10000,idempotencyKey:randomUUID(),items:{create:[{menuItemId:item.id,nameAr:item.nameAr,nameEn:'Koshary',quantity:2,unitPricePiastres:5000,sortOrder:0}]}}});
  return {token,r,b,c,item,add};
}
const period='from=2026-11-01&to=2026-11-30';
describe('restaurant reports',()=>{
  it('groups overview hours by actual placement, fills zeros, and respects Cairo DST day lengths',async()=>{
    const r=await fixture();
    const first=await r.add(1,'COMPLETED');
    const second=await r.add(2,'COMPLETED');
    const late=await r.add(3,'COMPLETED');
    const outside=await r.add(4,'COMPLETED',r.b.id,'2026-11-02');
    await t.prisma.order.update({where:{id:first.id},data:{placedAt:new Date('2026-11-01T09:15:00Z')}});
    await t.prisma.order.update({where:{id:second.id},data:{placedAt:new Date('2026-11-01T09:45:00Z')}});
    await t.prisma.order.update({where:{id:late.id},data:{placedAt:new Date('2026-11-01T21:59:00Z')}});
    await t.prisma.order.update({where:{id:outside.id},data:{placedAt:new Date('2026-11-01T22:00:00Z')}});
    const data=(await http().get('/v1/reports/overview?from=2026-11-01&to=2026-11-01&period=day').set(auth(r.token)).expect(200)).body;
    expect(data.days).toHaveLength(24);
    expect(data.summary).toMatchObject({orders:3,net:30000});
    expect(data.days.find((d:{date:string})=>d.date==='2026-11-01T09:00:00Z')).toMatchObject({orders:2,net:20000});
    expect(data.days.reduce((s:number,d:{orders:number})=>s+d.orders,0)).toBe(3);
    const spring=(await http().get('/v1/reports/overview?from=2026-04-24&to=2026-04-24&period=day').set(auth(r.token)).expect(200)).body;
    expect(spring.days).toHaveLength(23);
    const autumn=(await http().get('/v1/reports/overview?from=2026-10-29&to=2026-10-29&period=day').set(auth(r.token)).expect(200)).body;
    expect(autumn.days).toHaveLength(25);
    await http().get('/v1/reports/overview?from=2026-11-01&to=2026-11-02&period=day').set(auth(r.token)).expect(400);
    await http().get('/v1/reports/overview?from=2026-11-01&to=2026-11-01&period=day').expect(401);
  });
  it('aggregates and exports all filtered rows, rejects invalid dates and scopes every id',async()=>{
    const r=await fixture();
    await r.add(1,'COMPLETED');await r.add(2,'CANCELLED');await r.add(3,'ACCEPTED');
    // A local business day at the boundary is included independently of UTC placement time.
    await r.add(4,'COMPLETED',r.b.id,'2026-10-31');
    const result=(await http().get(`/v1/reports?${period}&type=products&pageSize=1`).set(auth(r.token)).expect(200)).body;
    expect(result.summary).toMatchObject({gross:20000,net:20000,orders:3,completed:1,cancelled:1,pending:1,discounts:0,average:10000});
    expect(result.rows[0]).toMatchObject({units:4,gross:20000,net:20000,contribution:100});
    const orders=(await http().get(`/v1/reports?${period}&type=orders&pageSize=1`).set(auth(r.token)).expect(200)).body;
    expect(orders.total).toBe(3);expect(orders.rows).toHaveLength(1);
    const csv=await http().get(`/v1/reports/export?${period}&type=orders&pageSize=1&format=csv`).set(auth(r.token)).expect(200);
    expect(csv.text.split('\r\n')).toHaveLength(4); // headers and every order (not one page)
    const safe=csvReport({...result,filters:{...result.filters,language:'ar'}});
    expect(safe).toContain("'=صيغة ضارة");expect(safe.charCodeAt(0)).toBe(0xfeff);
    const other=await fixture('other@reports.test','other-reports');
    await http().get(`/v1/reports?${period}&branchId=${other.b.id}`).set(auth(r.token)).expect(404);
    await http().get(`/v1/reports?${period}&categoryId=${other.c.id}`).set(auth(r.token)).expect(404);
    await http().get(`/v1/reports/export?${period}&format=csv&productId=${other.item.id}`).set(auth(r.token)).expect(404);
    expect((await http().get(`/v1/reports?${period}`).set(auth(other.token)).expect(200)).body.summary.orders).toBe(0);
    for(const invalid of ['from=2026-02-30&to=2026-03-01','from=2026-11-30&to=2026-11-01','from=2024-01-01&to=2026-01-01']) await http().get(`/v1/reports?${invalid}`).set(auth(r.token)).expect(400);
    await http().get(`/v1/reports?${period}`).expect(401);
    // Complimentary lines are sold units too; cancelled kitchen lines are not.
    await t.prisma.order.create({data:{restaurantId:r.r.id,branchId:r.b.id,number:5,businessDay:new Date('2026-11-01'),status:'COMPLETED',type:'PICKUP',customerName:'Guest',subtotalPiastres:35000,totalPiastres:35000,idempotencyKey:randomUUID(),items:{create:[
      {menuItemId:r.item.id,nameAr:'هدية',quantity:3,unitPricePiastres:0,sortOrder:0},
      {menuItemId:r.item.id,nameAr:'ملغي',quantity:7,unitPricePiastres:5000,prepStatus:'CANCELLED',sortOrder:1},
    ]}}});
    const units=(await http().get(`/v1/reports?${period}&type=categories&status=COMPLETED`).set(auth(r.token)).expect(200)).body;
    expect(units.rows[0]).toMatchObject({units:5,gross:10000,net:10000});
  });
  it('handles recorded cash reversals once, respects branch and financial permissions, and generates branded PDFs',async()=>{
    const r=await fixture();
    const branch=await t.prisma.branch.create({data:{restaurantId:r.r.id,name:'Second branch',slug:'second',phone:'01012345678',city:'Cairo',address:'Second',sortOrder:1}});
    const order=await r.add(1,'ACCEPTED');await r.add(1,'COMPLETED',branch.id);
    await http().post('/v1/cash/shifts').set(auth(r.token)).send({openingPiastres:0}).expect(201);
    await http().patch(`/v1/orders/${order.id}/payment`).set(auth(r.token)).send({paid:true,method:'CASH'}).expect(200);
    await http().patch(`/v1/orders/${order.id}/payment`).set(auth(r.token)).send({paid:false}).expect(200);
    let data=(await http().get(`/v1/reports?${period}&branchId=${r.b.id}`).set(auth(r.token)).expect(200)).body;
    expect(data.summary).toMatchObject({gross:10000,net:0,refunds:10000,refundedOrders:1});
    await t.prisma.order.update({where:{id:order.id},data:{status:'CANCELLED'}});
    data=(await http().get(`/v1/reports?${period}`).set(auth(r.token)).expect(200)).body;
    expect(data.summary).toMatchObject({gross:10000,net:10000,refunds:10000,cancelled:1});
    const filtered=(await http().get(`/v1/reports?${period}&productId=${r.item.id}&categoryId=${r.c.id}&branchId=${branch.id}&status=COMPLETED&paymentMethod=UNPAID`).set(auth(r.token)).expect(200)).body;
    expect(filtered.summary).toMatchObject({orders:1,net:10000});
    await http().post('/v1/kitchen-accounts').set(auth(r.token)).send({fullName:'Branch manager',email:'manager@reports.test',password:'staff-password',role:'MANAGER',branchId:r.b.id}).expect(201);
    const login=await http().post('/v1/auth/login').set('Origin',DASHBOARD_ORIGIN).send({email:'manager@reports.test',password:'staff-password'}).expect(200);
    const manager=login.body.accessToken;
    expect((await http().get(`/v1/reports?${period}`).set(auth(manager)).expect(200)).body.summary.orders).toBe(1);
    await http().get(`/v1/reports?${period}&branchId=${branch.id}`).set(auth(manager)).expect(403);
    await t.prisma.user.update({where:{email:'manager@reports.test'},data:{permissionGrants:['analytics.view']}});
    // Role defaults can include financial permission; explicit role change gives the denied path.
    await t.prisma.user.update({where:{email:'manager@reports.test'},data:{role:'WAITER',permissionGrants:['analytics.view']}});
    await http().get(`/v1/reports/export?${period}&format=csv`).set(auth(manager)).expect(403);
    const pdf=await http().get(`/v1/reports/export?${period}&format=pdf&language=ar`).set(auth(r.token)).buffer(true).parse((res,done)=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>done(null,Buffer.concat(chunks)));}).expect(200);
    expect(pdf.body.subarray(0,5).toString()).toBe('%PDF-');
    const preview=await http().get(`/v1/reports/export?${period}&format=html&language=en`).set(auth(r.token)).expect(200);
    expect(preview.text).toContain('data:image/svg+xml;base64,');expect(preview.text).toContain('dir="ltr"');
  },60000);
  it('validates leap days and the full-year limit',()=>{
    expect(reportQuerySchema.safeParse({from:'2024-02-29',to:'2024-02-29'}).success).toBe(true);
    expect(reportQuerySchema.safeParse({from:'2026-02-29',to:'2026-02-29'}).success).toBe(false);
    expect(reportQuerySchema.safeParse({from:'2024-01-01',to:'2024-12-31'}).success).toBe(true);
  });
});

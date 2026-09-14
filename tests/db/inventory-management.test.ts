import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminServiceClient, anonClient, identity, rpcFails, rpcOk, signIn } from './support/harness';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InventoryPage, PersonRecord, ManagedDevice } from '../../src/lib/inventory/types';
let tech: SupabaseClient;
let admin: SupabaseClient;
const studentData = { kind:'student',displayName:'Synthetic Directory Student',externalId:'009991234',email:'student@school.example',guardianName:'Synthetic Guardian',guardianPhone:'(555) 123-4567',address:'10 Example Street',notes:'Synthetic profile note',classOf:'2030',studentStatus:'current' };
const staffData = { kind:'staff',displayName:'Synthetic Directory Staff',externalId:'forged-id',email:'Sample.Staff@school.example',department:'Science' };
let student: PersonRecord;
let staff: PersonRecord;
const deviceData = {deviceType:'Synthetic tablet',manufacturer:'Example',model:'New Model',serialNumber:`SYN-MANAGE-${randomUUID()}`,status:'Assigned',notes:'Initial synthetic device note'};
let device: ManagedDevice;
beforeAll(async()=>{
  tech=await signIn('owner'); admin=await signIn('admin');
  const s=await rpcOk<string>(tech,'app_save_person',{p_id:null,p_version:null,p_data:studentData});
  const f=await rpcOk<string>(admin,'app_save_person',{p_id:null,p_version:null,p_data:staffData});
  student=await rpcOk(tech,'app_get_person',{p_id:s}); staff=await rpcOk(tech,'app_get_person',{p_id:f});
  const d=await rpcOk<string>(tech,'app_save_inventory_device',{p_id:null,p_version:null,p_data:{...deviceData,assignedRequesterId:s}});
  device=await rpcOk(tech,'app_get_inventory_device',{p_id:d});
});
describe('shared inventory management',()=>{
  it('creates through both roles, preserves leading-zero OSIS, and derives the staff identifier from email',async()=>{
    expect(student.externalId).toBe('009991234'); expect(staff.externalId).toBe('sample.staff');
    expect(staff.email).toBe('sample.staff@school.example');
    expect(student.guardianName).toBe('Synthetic Guardian'); expect(student.address).toBe('10 Example Street');
  });
  it('lists and searches profiles and assigned devices without returning the entire directory',async()=>{
    const rows=await rpcOk<InventoryPage<PersonRecord>>(tech,'app_list_people',{p_kind:'student',p_query:'Synthetic Guardian',p_page:1});
    expect(rows.rows.map(r=>r.id)).toContain(student.id); expect(rows.rows[0].deviceCount).toBe(1); expect(rows.pageSize).toBe(50);
    expect((await rpcOk<InventoryPage<PersonRecord>>(tech,'app_list_people',{p_kind:'staff',p_query:'009991234'})).rows).toHaveLength(0);
    const devices=await rpcOk<InventoryPage<ManagedDevice>>(tech,'app_list_inventory',{p_query:'',p_page:1,p_requester:student.id});
    expect(devices.total).toBe(1); expect(devices.rows[0].assignedName).toBe(student.displayName);
    expect((await rpcOk<InventoryPage<ManagedDevice>>(tech,'app_list_inventory',{p_query:'',p_page:1,p_requester:staff.id})).total).toBe(0);
    const literal=await rpcOk<InventoryPage<PersonRecord>>(tech,'app_list_people',{p_kind:'student',p_query:'%_'}); expect(literal.total).toBe(0);
  });
  it('validates email, numeric OSIS, phone, year and required device fields on the database boundary',async()=>{
    for(const patch of [{email:'invalid'},{externalId:'ABC'},{guardianPhone:'call me'},{classOf:'GRAD'},{displayName:''}]) {
      await rpcFails(tech,'app_save_person',{p_id:null,p_version:null,p_data:{...studentData,...patch}});
    }
    await rpcFails(tech,'app_save_person',{p_id:null,p_version:null,p_data:{...staffData,email:''}});
    await rpcFails(tech,'app_save_person',{p_id:null,p_version:null,p_data:studentData});
    for(const field of ['deviceType','manufacturer','model','serialNumber']) await rpcFails(tech,'app_save_inventory_device',{p_id:null,p_version:null,p_data:{...deviceData,[field]:''}});
    await rpcFails(tech,'app_save_inventory_device',{p_id:null,p_version:null,p_data:{...deviceData,serialNumber:device.serialNumber.toLowerCase()}});
  });
  it('edits staff email without breaking stable person identity, and rejects stale edits',async()=>{
    await rpcOk(tech,'app_save_person',{p_id:staff.id,p_version:staff.version,p_data:{...staffData,email:'renamed.staff@school.example'}});
    const changed=await rpcOk<PersonRecord>(tech,'app_get_person',{p_id:staff.id}); expect(changed.externalId).toBe('renamed.staff'); expect(changed.id).toBe(staff.id);
    const stale=await rpcFails(admin,'app_save_person',{p_id:staff.id,p_version:staff.version,p_data:staffData}); expect(stale.message).toMatch(/changed since/);
    await rpcFails(tech,'app_save_person',{p_id:staff.id,p_version:changed.version,p_data:studentData});
    staff=changed;
  });
  it('updates assignments and catalog while keeping ticket device history unchanged',async()=>{
    const ticket=await rpcOk<string>(tech,'app_create_ticket',{p_title:'Synthetic inventory snapshot',p_issue:'',p_channel:'walk_in',p_requester_id:student.id,p_devices:[{deviceType:device.deviceType,inventoryDeviceId:device.id}]});
    await rpcOk(tech,'app_save_inventory_device',{p_id:device.id,p_version:device.version,p_data:{...deviceData,model:'Revised Model',serialNumber:device.serialNumber+'-EDIT',assignedRequesterId:staff.id}});
    const stale=await rpcFails(tech,'app_save_inventory_device',{p_id:device.id,p_version:device.version,p_data:deviceData}); expect(stale.message).toMatch(/changed since/);
    const old=await adminServiceClient().from('device_observations').select('serial_number,model').eq('ticket_id',ticket).single();
    expect(old.error).toBeNull(); expect(old.data?.serial_number).toBe(device.serialNumber); expect(old.data?.model).toBe('New Model');
    const assigned=await rpcOk<PersonRecord>(tech,'app_get_person',{p_id:staff.id}); expect(assigned.deviceCount).toBe(1);
    expect((await rpcOk<PersonRecord>(tech,'app_get_person',{p_id:student.id})).deviceCount).toBe(0);
    const catalog=await rpcOk<{model:string}[]>(tech,'app_device_catalog'); expect(catalog.some(r=>r.model==='Revised Model')).toBe(true);
  });
  it('records the actor and before/after values, with no direct client writes or audit access',async()=>{
    const events=await adminServiceClient().from('inventory_events').select('actor_id,before_record,after_record').eq('entity_id',staff.id);
    expect(events.error).toBeNull(); expect(events.data?.length).toBe(2); expect(events.data?.some(r=>r.actor_id===identity('owner').id)).toBe(true);
    expect((await tech.from('inventory_events').select('*')).error).not.toBeNull();
    expect((await tech.from('inventory_devices').update({serial_number:'FORGED'}).eq('id',device.id)).error).not.toBeNull();
  });
  it('refuses anonymous and restricted sessions for both reads and edits',async()=>{
    for(const actor of [anonClient(),await signIn('inactive'),await signIn('pending')]) {
      await rpcFails(actor,'app_list_people',{p_kind:'student'});
      await rpcFails(actor,'app_get_person',{p_id:student.id});
      await rpcFails(actor,'app_list_inventory',{});
      await rpcFails(actor,'app_save_person',{p_id:null,p_version:null,p_data:studentData});
      await rpcFails(actor,'app_save_inventory_device',{p_id:null,p_version:null,p_data:deviceData});
    }
  });
});

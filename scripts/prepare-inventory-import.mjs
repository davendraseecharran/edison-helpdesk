#!/usr/bin/env node
/** Read a private, minimal Google Sheets snapshot and prepare a reviewable import.
 * No network, credentials, or database writes. Output contains school records and
 * must stay in .private/. Conflicting IDs are quarantined, never guessed.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const text = value => String(value ?? '').trim();
const sql = value => value == null || value === '' ? 'null' : "'" + String(value).replaceAll("'", "''") + "'";
export function prepareImport(source) {
  const report = { staff: 0, students: 0, inventory: 0, catalog: 0,
    duplicateDeviceRows: [], unresolvedAssignments: [], incompleteDevices: [] };
  const people = [];
  for (const [sheet, kind] of [['Staff','staff'], ['Students','student']]) {
    const seen = new Set();
    for (const [index, row] of source[sheet].entries()) {
      if (!index || !row.some(v => text(v))) continue;
      const externalId = text(row[0]);
      const displayName = kind === 'staff' ? [row[1],row[2]].map(text).filter(Boolean).join(' ') : text(row[1]);
      if (!externalId || !displayName || displayName.length > 120 || seen.has(externalId)) {
        throw new Error(`Invalid or duplicate ${sheet} identity at source row ${index + 1}.`);
      }
      seen.add(externalId);
      people.push({ externalId, displayName, kind });
      report[kind === 'staff' ? 'staff' : 'students']++;
    }
  }
  const peopleKeys = new Set(people.map(p => `${p.kind}:${p.externalId}`));
  const counts = new Map();
  const rows = source.Master_Inventory.slice(1);
  for (const row of rows) {
    const key = text(row[0]);
    if (row.some(v => text(v))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const devices = [];
  for (const [index,row] of rows.entries()) {
    if (!row.some(v => text(v))) continue;
    const externalId = text(row[0]);
    if (!externalId || counts.get(externalId) > 1) {
      report.duplicateDeviceRows.push(index + 2); continue;
    }
    let assignedKind = text(row[10]) ? 'student' : text(row[12]) ? 'staff' : null;
    let assignedId = assignedKind === 'student' ? text(row[10]) : assignedKind === 'staff' ? text(row[12]) : null;
    if ((text(row[10]) && text(row[12])) || (assignedId && !peopleKeys.has(`${assignedKind}:${assignedId}`))) {
      report.unresolvedAssignments.push(index + 2); assignedId = null; assignedKind = null;
    }
    const d = { externalId, deviceType:text(row[1]), manufacturer:text(row[2]), model:text(row[3]),
      osVersion:text(row[4]), serialNumber:text(row[5]), assetTag:text(row[6]), status:text(row[7]),
      location:text(row[9]), assignedId, assignedKind };
    if (!d.deviceType || !d.manufacturer || !d.model || !d.serialNumber) report.incompleteDevices.push(index + 2);
    devices.push(d);
  }
  const catalog = [...new Map([...source.DeviceSheet.slice(1).map(r => r.slice(0,3).map(text)),
    ...devices.map(d => [d.deviceType,d.manufacturer,d.model])]
    .filter(row => row.every(Boolean)).map(row => [JSON.stringify(row),row])).values()];
  report.inventory = devices.length; report.catalog = catalog.length;
  let script = `begin;\nset local standard_conforming_strings = on;\nselect pg_advisory_xact_lock(1162103123,1);\n`;
  // An initial import cannot silently become an overwrite on a future rerun.
  script += `do $$ begin\nif exists(select 1 from public.requesters where external_id is not null) or exists(select 1 from public.inventory_devices) then raise exception 'Directory already imported; prepare a reviewed refresh instead.'; end if;\nif not exists(select 1 from public.app_accounts where role='admin' and status='active') then raise exception 'An active administrator is required.'; end if;\nend $$;\n`;
  const chunks = (arr,size=200) => Array.from({length:Math.ceil(arr.length/size)},(_,i)=>arr.slice(i*size,(i+1)*size));
  for (const chunk of chunks(people)) script += `insert into public.requesters(display_name,kind,external_id,created_by) select v.name,v.kind,v.external_id,(select id from public.app_accounts where role='admin' and status='active' order by created_at,id limit 1) from (values\n${chunk.map(p => `(${sql(p.displayName)},${sql(p.kind)},${sql(p.externalId)})`).join(',\n')}) as v(name,kind,external_id);\n`;
  for (const chunk of chunks(catalog)) script += `insert into public.device_catalog(device_type,manufacturer,model) values\n${chunk.map(r => '('+r.map(sql).join(',')+')').join(',\n')} on conflict do nothing;\n`;
  for (const chunk of chunks(devices)) script += `insert into public.inventory_devices(external_id,device_type,manufacturer,model,os_version,serial_number,asset_tag,status,location,assigned_requester_id) select v.external_id,v.device_type,v.manufacturer,v.model,v.os_version,v.serial_number,v.asset_tag,v.status,v.location,r.id from (values\n${chunk.map(d => '('+[d.externalId,d.deviceType,d.manufacturer,d.model,d.osVersion,d.serialNumber,d.assetTag,d.status,d.location,d.assignedKind,d.assignedId].map(sql).join(',')+')').join(',\n')}) as v(external_id,device_type,manufacturer,model,os_version,serial_number,asset_tag,status,location,assigned_kind,assigned_id) left join public.requesters r on r.kind=v.assigned_kind and r.external_id=v.assigned_id;\n`;
  script += 'commit;\n';
  return { report, script };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/prepare-inventory-import.mjs <private snapshot.json> <.private/import.sql>');
  const root = resolve('.private');
  for (const file of [input,output]) {
    const r = relative(root,resolve(file));
    if (r.startsWith('..') || r === '') throw new Error('Source and output must be inside .private/.');
  }
  const {report,script} = prepareImport(JSON.parse(readFileSync(input,'utf8')));
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  writeFileSync(output,script,{mode:0o600}); chmodSync(output,0o600);
  writeFileSync(output+'.report.json',JSON.stringify(report,null,2),{mode:0o600}); chmodSync(output+'.report.json',0o600);
  console.log(JSON.stringify({...report,duplicateDeviceRows:report.duplicateDeviceRows.length,
    unresolvedAssignments:report.unresolvedAssignments.length,incompleteDevices:report.incompleteDevices.length}));
}

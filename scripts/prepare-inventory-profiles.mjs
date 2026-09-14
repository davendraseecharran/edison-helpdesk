#!/usr/bin/env node
/** Prepare a private additive profile enrichment. Never reimports people or
 * devices, changes UUIDs/assignments, or overwrites records already edited.
 */
import { readFileSync,writeFileSync,chmodSync } from 'node:fs';
import { resolve,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const str=v=>String(v??'').trim();
const quote=v=>v==null||v===''?'null':"'"+String(v).replaceAll("'","''")+"'";
const chunks=(a,n=150)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));
export function prepareProfiles(source,inventoryNotes) {
  const report={students:0,staff:0,graduated:0,otherStatus:0,staffWithoutEmail:0,deviceNotes:0,conflictingDeviceRows:0};
  const profiles=[];
  const seen=new Set();
  for(const [sheet,kind] of [['Students','student'],['Staff','staff']]) {
    for(const row of source[sheet].slice(1)) {
      if(!row.some(v=>str(v))) continue;
      const id=str(row[0]);
      if(!id||seen.has(`${kind}:${id}`)) throw Error(`Missing or duplicate source ID in ${sheet}.`);
      seen.add(`${kind}:${id}`);
      const student=kind==='student';
      const email=str(row[student?4:3]).toLowerCase();
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error(`Invalid source email in ${sheet}; review the private source.`);
      const designation=student?str(row[8]):'';
      const year=/^[0-9]{4}$/.test(designation)?designation:'';
      const status=designation.toUpperCase()==='GRAD'?'graduated':(!designation||year)?'current':'other';
      let notes=student?str(row[11]):'';
      if(student&&status==='other') notes=[notes,`Source class designation: ${designation}`].filter(Boolean).join('\n');
      if(student){report.students++; if(status==='graduated')report.graduated++; if(status==='other')report.otherStatus++;}
      else{report.staff++;if(!email)report.staffWithoutEmail++;}
      profiles.push([kind,id,str(row[student?2:1]),str(row[student?3:2]),email,
        student?'':str(row[4]),student?'':str(row[5]),student?'':str(row[6]),
        year,student?status:null,student?str(row[9]):'',student?str(row[5]):'',
        student?str(row[6]):'',student?str(row[7]):'',student?str(row[10]):'',notes]);
    }
  }
  const counts=new Map();
  for(const row of inventoryNotes.slice(1)){const id=str(row[0]);if(id)counts.set(id,(counts.get(id)??0)+1);}
  const notes=[];
  for(const row of inventoryNotes.slice(1)){
    const id=str(row[0]); if(!id)continue;
    if(counts.get(id)>1){report.conflictingDeviceRows++;continue;}
    if(str(row[1]))notes.push([id,str(row[1])]);
  }
  report.deviceNotes=notes.length;
  let sql="begin;\nset local standard_conforming_strings = on;\nselect pg_advisory_xact_lock(1162103123,1);\n";
  sql+="do $$ begin if not exists(select 1 from public.requesters where source_external_id is not null) then raise exception 'The initial directory import must exist before enrichment.'; end if; if not exists(select 1 from public.app_accounts where role='admin' and status='active') then raise exception 'An active administrator is required.'; end if; end $$;\n";
  sql+='create temporary table enrichment_counts(entity text, changed bigint) on commit drop;\n';
  const actor="(select id from public.app_accounts where role='admin' and status='active' order by created_at,id limit 1)";
  for(const batch of chunks(profiles)){
    sql+=`with input(kind,source_id,first_name,last_name,email,school_dbn,department,staff_role,class_of,student_status,official_class,guardian_name,guardian_phone,home_phone,address,notes) as (values\n${batch.map(r=>'('+r.map(quote).join(',')+')').join(',\n')}), before_rows as materialized (select r.id,to_jsonb(r) as original from public.requesters r join input i on i.kind=r.kind and i.source_id=r.source_external_id where r.version=1 for update of r), changed as (update public.requesters r set first_name=i.first_name,last_name=i.last_name,email=i.email,school_dbn=i.school_dbn,department=i.department,staff_role=i.staff_role,class_of=i.class_of,student_status=i.student_status,official_class=i.official_class,guardian_name=i.guardian_name,guardian_phone=i.guardian_phone,home_phone=i.home_phone,address=i.address,notes=i.notes,external_id=case when r.kind='staff' and i.email is not null then split_part(i.email,'@',1) else r.external_id end from input i,before_rows b where r.id=b.id and r.kind=i.kind and r.source_external_id=i.source_id returning r.*), audited as (insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) select c.kind,c.id,${actor},b.original,to_jsonb(c) from changed c join before_rows b on b.id=c.id returning entity) insert into enrichment_counts select entity,count(*) from audited group by entity;\n`;
  }
  for(const batch of chunks(notes)){
    sql+=`with input(external_id,notes) as (values\n${batch.map(r=>'('+r.map(quote).join(',')+')').join(',\n')}), before_rows as materialized (select d.id,to_jsonb(d) original from public.inventory_devices d join input i on i.external_id=d.external_id where d.version=1 for update of d), changed as (update public.inventory_devices d set notes=i.notes from input i,before_rows b where d.id=b.id and d.external_id=i.external_id returning d.*), audited as (insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) select 'device',c.id,${actor},b.original,to_jsonb(c) from changed c join before_rows b on b.id=c.id returning entity) insert into enrichment_counts select entity,count(*) from audited group by entity;\n`;
  }
  sql+='select entity,sum(changed) as updated_records from enrichment_counts group by entity;\ncommit;\n';
  return {report,sql};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [sourcePath,notesPath,output]=process.argv.slice(2);
  if(!sourcePath||!notesPath||!output)throw Error('Usage: prepare-inventory-profiles.mjs <private profiles.json> <private notes.json> <private output.sql>');
  for(const p of [sourcePath,notesPath,output])if(relative(resolve('.private'),resolve(p)).startsWith('..'))throw Error('All files must be in .private/.');
  const {report,sql}=prepareProfiles(JSON.parse(readFileSync(sourcePath,'utf8')),JSON.parse(readFileSync(notesPath,'utf8')));
  writeFileSync(output,sql,{mode:0o600});chmodSync(output,0o600);
  writeFileSync(output+'.report.json',JSON.stringify(report,null,2),{mode:0o600});chmodSync(output+'.report.json',0o600);
  console.log(JSON.stringify(report));
}
